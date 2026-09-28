import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initTheme} from '@earendil-works/pi-coding-agent';
import {OutlinerStore} from '../src/store';
import {OutlinerServer} from '../src/server';
import {OutlinerClient} from '../src/client';
import {isBlockTreeRow} from '../src/tree-rows';
import {createTreeController} from '../src/tree-controller';
import {serviceTreeNavigation} from '../src/navigation-routes';
import type {OutlinerEvent,VirtualBranchOrder} from '../src/types';
initTheme(undefined,false);
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();});

async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'outliner-branch-filter-'));
 const store=new OutlinerStore(join(dir,'outline.sqlite'));
 const server=new OutlinerServer(store,join(dir,'outline.sock'));await server.start();
 cleanups.push(async()=>{await server.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const client=new OutlinerClient(join(dir,'outline.sock'));
 const branch=store.create('Candidates [type::virtual-branch] [query::lane=next] [limit::100] [child-depth::2] [expanded::false]');
 const items=Array.from({length:80},(_,i)=>store.create(`Issue DEM-${300+i} [lane::next]`));
 const child=store.create('Detail\n\nA copper teapot needs repair.',items[0]!.id);
 const other=store.create('Elsewhere [type::virtual-branch] [query::lane=next] [limit::100]');
 store.reorderVirtualOccurrences(branch.id,items.map(b=>b.id));
 const copies:string[]=[];
 let changed:ReturnType<typeof Promise.withResolvers<OutlinerEvent>>|undefined;
 const open=async(owner:string)=>{
  const connected=Promise.withResolvers<void>();const watcher=client.watch({client:{clientId:owner,contextId:owner,role:'tree'},onConnect:connected.resolve,onEvent(e){if(e.domain==='content')changed?.resolve(e);}});await connected.promise;cleanups.push(()=>watcher.stop());
  const c=createTreeController({clientId:owner,browsingContextId:owner,workspaceRoot:dir,request:i=>client.request(i),navigation:serviceTreeNavigation(client,owner,owner),createDetailPane:async()=>{},openCapturePopup:async()=>{},openVirtualBranchNavigator:async()=>{},focusSelf(){},stop(){},invalidate(){},terminalWidth:()=>90,terminalHeight:()=>35,copyText:t=>copies.push(t)});await c.initialize();return c;
 };
 const notify=async(c:Awaited<ReturnType<typeof open>>,action:()=>Promise<unknown>)=>{changed=Promise.withResolvers<OutlinerEvent>();await action();await c.handleServiceEvent(await changed.promise);changed=undefined;};
 return {store,client,branch,items,child,other,copies,open,notify};
}

test('branch filter searches live as typed, finds collapsed descendant bodies and restores origin without changing another Tree',async()=>{
 const f=await fixture(),c=await f.open('one'),second=await f.open('two');
 const origin=c.view().rows.find(r=>r.kind==='physical'&&r.canonicalId===f.branch.id)!;
 await c.handleRowClick(origin.rowId);
 const before=c.view().rows.map(r=>r.rowId),otherBefore=second.view().rows.map(r=>r.rowId);
 await c.handleKeypress('/',{},'pass');await c.handlePaste('cpr teapot');
 expect(c.view().rows.some(r=>r.kind==='occurrence'&&r.canonicalId===f.child.id)).toBe(true);
 expect(c.view().rows.some(r=>r.kind==='occurrence'&&r.viewId===f.other.id)).toBe(false);
 expect(c.view().rows.filter(r=>r.kind==='occurrence').map(r=>r.canonicalId)).toEqual([f.items[0]!.id,f.child.id]);
 expect(second.view().rows.map(r=>r.rowId)).toEqual(otherBefore);
 await c.handleKeypress('',{name:'return'},'pass');
 expect(c.mode).toBe('browse');
 await c.handleKeypress('',{name:'escape'},'pass');
 expect(c.view().rows.map(r=>r.rowId)).toEqual(before);
 expect(c.view().rows[c.view().selectedIndex]?.rowId).toBe(origin.rowId);
});

test('filtered selected placement uses full rank order and leaves hidden items and canonical content intact',async()=>{
 const f=await fixture(),c=await f.open('rank');
 const original=f.items.map(b=>({id:b.id,text:b.text,parentId:b.parentId}));
 await c.handleRowClick(f.branch.id);await c.handleKeypress('/',{},'pass');await c.handlePaste('DEM-37');await c.handleKeypress('',{name:'return'},'pass');
 const matches=c.view().rows.filter(r=>r.kind==='occurrence');expect(matches.map(r=>r.canonicalId)).toEqual(f.items.slice(70).map(b=>b.id));
 await c.handleRowClick(matches[9]!.rowId);await c.handleKeypress('x',{name:'x'},'pass');
 await c.handleAction('tree.selection.copy-references');expect(f.copies.at(-1)).toBe(`((${f.items[79]!.id}))`);
 await c.handleAction('tree.selection.move-before');await c.handlePaste('DEM-370');await c.handleKeypress('',{name:'return'},'pass');
 const order=await f.client.request<VirtualBranchOrder>({action:'virtual.occurrences.order',viewId:f.branch.id});
 expect(order.blockIds).toEqual([...f.items.slice(0,70),f.items[79]!,...f.items.slice(70,79)].map(b=>b.id));
 await c.handleAction('tree.reorder.up');
 const nudged=await f.client.request<VirtualBranchOrder>({action:'virtual.occurrences.order',viewId:f.branch.id});
 expect(nudged.blockIds).toEqual([...f.items.slice(0,69),f.items[79]!,...f.items.slice(69,79)].map(b=>b.id));
 expect(c.view().status).toContain('including hidden items');
 await c.handleAction('tree.filter.clear');expect(c.view().rows.some(r=>r.kind==='physical'&&r.canonicalId===f.other.id)).toBe(true);
 for(const b of original){const current=f.store.get(b.id)!;expect({text:current.text,parentId:current.parentId}).toEqual({text:b.text,parentId:b.parentId});}
});


test('zero matches, bounded projection and disappearing roots stay explicit and clearable',async()=>{
 const f=await fixture(),c=await f.open('empty');
 let bounded:any; await f.notify(c,async()=>{bounded=await f.client.request({action:'create',text:'Bounded [type::virtual-branch] [query::lane=next] [limit::2]'});});
 await c.handleRowClick(bounded.id);
 await c.handleKeypress('/',{},'pass');await c.handlePaste('no such copper');
 expect(c.view().branchFilterCue).toContain('0 matches');expect(c.view().branchFilterCue).toContain('PARTIAL');
 expect(c.view().rows.map(r=>r.rowId)).toEqual([bounded.id]);
 await c.handleKeypress('',{name:'escape'},'pass');expect(c.view().rows[c.view().selectedIndex]?.rowId).toBe(bounded.id);
 await c.handleRowClick(f.branch.id);await c.handleKeypress('/',{},'pass');await c.handlePaste('DEM-37');await c.handleKeypress('',{name:'return'},'pass');
 await f.notify(c,()=>f.client.request({action:'delete',blockId:f.branch.id}));
 expect(c.view().branchFilterCue).toContain('Root no longer available');expect(c.view().rows).toHaveLength(0);
 await c.handleAction('tree.filter.clear');expect(c.view().branchFilterCue).toBeUndefined();expect(c.view().rows.length).toBeGreaterThan(0);
 expect(c.view().status).toContain('original occurrence is no longer available');
});

test('filter controls preserve an open writing draft',async()=>{
 const f=await fixture(),c=await f.open('draft');
 await c.handleRowClick(f.branch.id);await c.handleKeypress('/',{},'pass');await c.handlePaste('DEM-37');await c.handleKeypress('',{name:'return'},'pass');
 await c.handleKeypress('e',{name:'e'},'pass');await c.handlePaste(' unsaved writing');
 const draft=c.view().quickInput;expect(c.mode).toBe('edit');
 await c.handleAction('tree.filter.clear');expect(c.mode).toBe('edit');expect(c.view().quickInput).toBe(draft);
 await c.handleAction('tree.filter');expect(c.mode).toBe('edit');expect(c.view().quickInput).toBe(draft);
 await c.handleAction('tree.selection.place:before:'+f.items[0]!.id);expect(c.mode).toBe('edit');expect(c.view().quickInput).toBe(draft);
});

test('filtered date-sorted branches explain unavailable placement before opening an anchor picker',async()=>{
 const f=await fixture();
 await f.client.request({action:'update',mutation:{author:'user'},blockId:f.branch.id,expectedRevision:f.branch.revision,text:f.branch.text+' [sort::updated]'});
 const c=await f.open('sorted');await c.handleRowClick(f.branch.id);
 await c.handleKeypress('/',{},'pass');await c.handlePaste('DEM-37');await c.handleKeypress('',{name:'return'},'pass');
 await c.handleKeypress('x',{name:'x'},'pass');
 await c.handleAction('tree.selection.move-before');
 expect(c.mode).toBe('browse');expect(c.view().status).toContain('manual reorder is disabled');
 await c.handleAction('tree.selection.place:after:'+f.items[71]!.id);
 expect(c.view().status).toContain('manual reorder is disabled');
 await c.handleAction('tree.reorder.up');expect(c.view().status).toContain('manual reorder is disabled');
 await f.notify(c,()=>f.client.request({action:'update',mutation:{author:'user'},blockId:f.branch.id,expectedRevision:f.store.get(f.branch.id)!.revision,text:f.branch.text}));
 await c.handleAction('tree.selection.inspect');expect(c.mode).toBe('action-menu');
 await f.notify(c,()=>f.client.request({action:'update',mutation:{author:'user'},blockId:f.branch.id,expectedRevision:f.store.get(f.branch.id)!.revision,text:f.branch.text+' [sort::updated]'}));
 await c.handleAction('tree.selection.move-after');
 expect(c.mode).toBe('browse');expect(c.view().status).toContain('manual reorder is disabled');
});

test('branch search is independent of a prior property query and restores that query on Clear',async()=>{
 const f=await fixture();
 const parent=f.store.create('Parent [group::folder]');const child=f.store.create('copper teapot',parent.id);
 const c=await f.open('properties');await c.handleAction('tree.filter.properties');await c.handlePaste('group=folder');await c.handleKeypress('',{name:'return'},'pass');
 await c.handleRowClick(parent.id);await c.handleKeypress('/',{},'pass');await c.handlePaste('copper');
 expect(c.view().rows.filter(isBlockTreeRow).map(r=>r.canonicalId)).toContain(child.id);
 await c.handleAction('tree.filter.clear');expect(c.view().activeFilter).toBe('group=folder');expect(c.view().rows.filter(isBlockTreeRow).map(r=>r.canonicalId)).not.toContain(child.id);
});

test('filter restoration includes expanded document state and its viewport',async()=>{
 const f=await fixture();await f.client.request({action:'update',mutation:{author:'user'},blockId:f.branch.id,expectedRevision:f.branch.revision,text:f.branch.text+'\n\n'+Array.from({length:35},(_,i)=>`Origin line ${i}`).join('\n')});
 const c=await f.open('viewport');await c.handleRowClick(f.branch.id);await c.handleKeypress('.',{name:'.'},'modified-enter');
 const {renderTreeFrame}=await import('../src/tree-renderer');
 const render=()=>{const frame=renderTreeFrame({...c.view(),localPreview:null},70,16,0,{clearScreen:false});c.setViewportStart(frame.scrollStartEntryIndex,frame.expandedPage);};
 render();await c.handleKeypress('',{name:'pagedown'},'pass');render();const offset=c.view().expandedBlockOffset;expect(offset).toBeGreaterThan(0);
 await c.handleKeypress('/',{},'pass');await c.handlePaste('DEM-37');await c.handleKeypress('',{name:'return'},'pass');
 const match=c.view().rows[c.view().selectedIndex]!.rowId;await c.handleKeypress('.',{name:'.'},'modified-enter');
 await c.handleAction('tree.filter.clear');expect(c.view().expandedBlockOffset).toBe(offset);
 expect(c.view().rows.filter(isBlockTreeRow).find(r=>r.rowId===match)?.multilineExpanded).toBe(false);
 expect(c.view().rows.filter(isBlockTreeRow).find(r=>r.rowId===f.branch.id)?.multilineExpanded).toBe(true);
 await c.handleKeypress('/',{},'pass');
 await f.notify(c,()=>f.client.request({action:'delete',blockId:f.branch.id}));
 await c.handleAction('tree.filter.clear');expect(c.view().expandedBlockOffset).toBe(0);
});

test('a removed filtered target explains the focus change and explicit workspace navigation exits search',async()=>{
 const f=await fixture(),c=await f.open('membership');await c.handleRowClick(f.branch.id);
 await c.handleKeypress('/',{},'pass');await c.handlePaste('DEM-37');await c.handleKeypress('',{name:'return'},'pass');
 await f.notify(c,()=>f.client.request({action:'delete',blockId:f.items[70]!.id}));
 expect(c.view().status).toContain('DEM-370');expect(c.view().status).toContain('no longer');
 await c.handleAction('tree.root.workspace');expect(c.view().branchFilterCue).toBeUndefined();expect(c.view().rows.some(r=>r.kind==='physical'&&r.canonicalId===f.other.id)).toBe(true);
});

test('Advanced property filter evaluates OR, NOT, groups and ranges through the service while clause lists keep their meaning',async()=>{
 const f=await fixture();
 const open=f.store.create('Alpha [status::open]'),review=f.store.create('Beta [status::review]'),done=f.store.create('Gamma [status::done]');
 const c=await f.open('expression');
 const own=new Set([open.id,review.id,done.id]);
 const matched=()=>new Set(c.view().rows.filter(isBlockTreeRow).map(r=>r.canonicalId).filter(id=>own.has(id)));
 const submit=async(query:string)=>{await c.handleAction('tree.filter.properties');for(const _ of c.view().activeFilter)await c.handleKeypress('',{name:'backspace'},'pass');await c.handlePaste(query);await c.handleKeypress('',{name:'return'},'pass');};
 await submit('status=open');expect(matched()).toEqual(new Set([open.id]));
 await submit('status=open OR status=review');expect(matched()).toEqual(new Set([open.id,review.id]));
 await submit('status NOT status=open');expect(matched()).toEqual(new Set([review.id,done.id]));
 await submit('(status=done OR status=open) created>=-1d');expect(matched()).toEqual(new Set([open.id,done.id]));
 await submit('status=open OR');
 expect(c.view().mode).toBe('filter');expect(c.view().status).toMatch(/^Invalid filter: .* at character \d+$/);
 await c.handleKeypress('',{name:'escape'},'pass');
 expect(c.view().activeFilter).toBe('(status=done OR status=open) created>=-1d');expect(matched()).toEqual(new Set([open.id,done.id]));
});
