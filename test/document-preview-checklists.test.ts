import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initTheme} from '@earendil-works/pi-coding-agent';
import {stripTerminalSequences,visibleWidth} from '@earendil-works/pi-tui';
import {OutlinerStore} from '../src/store';
import {OutlinerServer} from '../src/server';
import {OutlinerClient,type RequestInput} from '../src/client';
import {DocumentPreview} from '../src/document-preview';
import {DocumentPreviewInput} from '../src/document-preview-input';
import {documentPreviewLinks,documentPreviewLines,renderDocumentPreview} from '../src/document-preview-renderer';
import type {AnnotationThread,Block,ChecklistCollection,ChecklistUpdateReceipt} from '../src/types';

async function fixture(run:(client:OutlinerClient)=>Promise<void>){
  initTheme(undefined,false);
  const directory=mkdtempSync(join(tmpdir(),'preview-checklist-'));
  const store=new OutlinerStore(join(directory,'outline.sqlite'));
  const server=new OutlinerServer(store,join(directory,'outliner.sock'));
  await server.start();
  try {await run(new OutlinerClient(join(directory,'outliner.sock')));}
  finally {await server.close();store.close();rmSync(directory,{recursive:true,force:true});}
}
const noDetail=async()=>{throw Error('Checklist interaction must stay in Preview');};
const links=(reader:DocumentPreview,width=44)=>documentPreviewLinks(reader.state!.document,width);
const tasks=(reader:DocumentPreview,width=44)=>links(reader,width).filter(link=>link.uri.includes('/checklist/'));
const paint=(reader:DocumentPreview,width=44)=>documentPreviewLines(reader.state!.document,width).map(stripTerminalSequences).join('\n');
const click=async(reader:DocumentPreview,uri:string)=>reader.action('preview.link:'+encodeURIComponent(uri),noDetail);

test('live checklist views use correlated canonical matches, shared controls and honest limits',async()=>fixture(async client=>{
  const plan=await client.request<Block>({action:'create',text:'# Release [project::demo]\n\nRead these instructions first.\n\n- [ ] Prepare [owner::alex]\n- [~] Deploy [owner::sam] ^deploy\n  - Context\n    - [!] Check [owner::alex] ^check'});
  const view=await client.request<Block>({action:'create',text:'# My steps\n[type::checklist-view] [plans::project=demo] [query::owner=alex] [exclude-status::done] [limit::10]'});
  const host=await client.request<Block>({action:'create',text:`# Dashboard\n\n!((${view.id}))\n\nAfter the view\n\n- [ ] Local ^local`});
  const reader=new DocumentPreview(client,()=>{});
  await reader.load({kind:'block',blockId:view.id});reader.focus();
  expect(tasks(reader)).toHaveLength(2);
  expect(paint(reader)).toContain('2 matched steps');
  expect(paint(reader)).not.toContain('Deploy');
  expect(links(reader).some(link=>link.uri.includes(plan.id))).toBe(true);
  expect(await client.request<Block>({action:'get',blockId:plan.id})).toEqual(plan);
  await click(reader,tasks(reader)[0]!.uri);await reader.key({name:'return'},44,12,noDetail);
  expect(paint(reader)).toContain('1 matched step');
  expect(tasks(reader)).toHaveLength(1);
  expect((await client.request<Block>({action:'get',blockId:plan.id})).text).toMatch(/- \[x\] Prepare \[owner::alex\] \^task-/);
  expect(await client.request<Block>({action:'get',blockId:view.id})).toEqual(view);
  await reader.key({name:'z',ctrl:true},44,12,noDetail);
  expect(tasks(reader)).toHaveLength(2);
  await reader.load({kind:'block',blockId:host.id});reader.focus();
  expect(tasks(reader)).toHaveLength(3);
  // An authored task after the generated results must still target its own source.
  const local=tasks(reader).find(link=>link.uri.includes(host.id))!;
  await click(reader,local.uri);await reader.key({name:'return'},44,12,noDetail);
  expect((await client.request<Block>({action:'get',blockId:host.id})).text).toBe(host.text.replace('[ ] Local','[x] Local'));
  const limited=await client.request<Block>({action:'update',mutation:{author:'user'},blockId:view.id,text:view.text.replace('limit::10','limit::1'),expectedRevision:view.revision});
  await reader.load({kind:'block',blockId:view.id});
  expect(paint(reader)).toContain('LIMITED');
  expect(tasks(reader)).toHaveLength(1);
  await client.request({action:'update',mutation:{author:'user'},blockId:view.id,text:limited.text.replace('limit::1','limit::oops'),expectedRevision:limited.revision});
  await reader.load({kind:'block',blockId:view.id});
  expect(paint(reader)).toContain('Checklist view unavailable');
  expect(paint(reader)).not.toContain('No matching');
  expect(tasks(reader)).toHaveLength(0);
}));

test('nested fragment readers preserve interactive steps and continuation Markdown',async()=>fixture(async client=>{
  const plan=await client.request<Block>({action:'create',text:'# Plan\n\n- [ ] Parent ^parent\n    - [~] Nested ^nested\n      Continued **instructions**'});
  const host=await client.request<Block>({action:'create',text:`# Dashboard\n\n!((${plan.id}^nested))`});
  const reader=new DocumentPreview(client,()=>{});
  for(const target of [{kind:'block' as const,blockId:host.id},{kind:'block' as const,blockId:plan.id,fragmentId:'nested'}]){
    await reader.load(target);reader.focus();
    expect(tasks(reader)).toHaveLength(1);
    expect(paint(reader)).not.toContain('**instructions**');
    expect(paint(reader)).not.toContain('outliner-preview');
    await click(reader,tasks(reader)[0]!.uri);await reader.action('preview.checklist.choose:done',noDetail);
    expect((await client.request<Block>({action:'get',blockId:plan.id})).text).toBe(plan.text.replace('[~] Nested','[x] Nested'));
    await reader.key({name:'z',ctrl:true},44,12,noDetail);
  }
  expect(await client.request<Block>({action:'get',blockId:host.id})).toEqual(host);
}));

test('same-target background loads preserve an opened embedded status picker',async()=>fixture(async client=>{
  const plan=await client.request<Block>({action:'create',text:'# Plan\n\n1. [~] Prepare ^prepare\n   - [~] Dependency ^dependency'});
  const host=await client.request<Block>({action:'create',text:`# Dashboard\n\n!((${plan.id}^prepare))\n\nAgain\n\n!((${plan.id}^prepare))`});
  const input=new DocumentPreviewInput();
  let frame:ReturnType<typeof renderDocumentPreview>;
  const draw=()=>{if(reader.state){frame=renderDocumentPreview(reader.state,{x:0,y:0,width:90,height:35},'',undefined,'compact');input.render(frame.lines,frame,reader.state);}};
  const reader=new DocumentPreview(client,draw,undefined,undefined,input);
  await reader.load({kind:'block',blockId:host.id});reader.focus();draw();
  const rows=frame!.lines.map(stripTerminalSequences);
  const row=rows.findIndex(line=>line.includes('Prepare')&&line.includes('[~]'));
  const column=visibleWidth(rows[row]!.slice(0,rows[row]!.indexOf('[~]')));
  const pending:Promise<void>[]=[];
  const actions={focus:()=>reader.focus(),scroll:()=>{},resize:()=>{},invoke:(id:string)=>{const run=reader.action(id,noDetail);pending.push(run);return run;}};
  for(const suffix of ['M','m'])input.handle(`\x1b[<0;${column+1};${row+1}${suffix}`,actions,()=>{},draw);
  await Promise.all(pending);
  expect(reader.state!.checklistPicker?.control.item.itemId).toBe('prepare');
  await reader.load({kind:'block',blockId:host.id});
  expect(reader.state!.checklistPicker?.control.item.itemId).toBe('prepare');
  const refreshing=reader.load({kind:'block',blockId:host.id});
  await reader.key({name:'down'},90,35,noDetail);
  await refreshing;
  expect(reader.state!.checklistPicker?.index).toBe(1);
  const cancelling=reader.load({kind:'block',blockId:host.id});
  await reader.key({name:'escape'},90,35,noDetail);
  await cancelling;
  expect(reader.state!.checklistPicker).toBeUndefined();
  expect(await client.request<Block>({action:'get',blockId:plan.id})).toEqual(plan);
}));

test('a saved item comment cannot select its thread in a newly opened note',async()=>fixture(async client=>{
  const source=await client.request<Block>({action:'create',text:'# Plan\n\n- [ ] Prepare ^prepare'});
  const destination=await client.request<Block>({action:'create',text:'# Another note'});
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  let holdRefresh=false;
  const reader=new DocumentPreview({async request<T>(input:RequestInput):Promise<T>{
    if(input.action==='get'&&input.blockId===source.id&&holdRefresh){entered.resolve();await release.promise;}
    const result=await client.request<T>(input);
    if(input.action==='annotations.create')holdRefresh=true;
    return result;
  }},()=>{});
  await reader.load({kind:'block',blockId:source.id});reader.focus();
  await click(reader,tasks(reader)[0]!.uri);await reader.key({name:'escape'},44,12,noDetail);
  await reader.key({name:'c'},44,12,noDetail);reader.paste('Keep this comment with the step');
  const saving=reader.key({name:'s',ctrl:true},44,12,noDetail);
  try {
    await entered.promise;
    expect(reader.state!.comment).toBeUndefined();
    await reader.load({kind:'block',blockId:destination.id});
  } finally {release.resolve();await saving;}
  expect(reader.state!.target).toEqual({kind:'block',blockId:destination.id});
  expect(reader.state!.document.annotations!.selectedAnnotationId).toBeUndefined();
  const comments=await client.request<AnnotationThread[]>({action:'annotations.list',query:{subject:{kind:'block',blockId:source.id}}});
  expect(comments).toHaveLength(1);
  expect(comments[0]!.body).toBe('Keep this comment with the step');
  expect(reader.state!.document.annotations!.annotationThreads).toHaveLength(0);
}));

test('embedded steps keep occurrence focus while edits, copy and undo reach the canonical plan',async()=>fixture(async client=>{
  const plan=await client.request<Block>({action:'create',text:'# Release [project::demo]\n\nRead the instructions first.\n\n- [ ] Prepare\n- [~] Verify ^verify'});
  const host=await client.request<Block>({action:'create',text:`# Dashboard [type::note]\n\n- [ ] Local task\n\n!((${plan.id}^verify))\n\n!((${plan.id}))\n\n!((${plan.id}^verify))`});
  const copied:string[]=[];
  const reader=new DocumentPreview(client,()=>{},undefined,undefined,undefined,undefined,text=>{copied.push(text);});
  await reader.load({kind:'block',blockId:host.id});reader.focus();
  expect(tasks(reader)).toHaveLength(5);
  expect(new Set(tasks(reader).map(link=>link.uri)).size).toBe(5);
  const last=tasks(reader).at(-1)!;
  reader.restoreOffset(3);await click(reader,last.uri);await reader.key({name:'return'},44,10,noDetail);
  expect((await client.request<Block>({action:'get',blockId:plan.id})).text).toContain('- [x] Verify ^verify');
  expect(await client.request<Block>({action:'get',blockId:host.id})).toEqual(host);
  expect(reader.state!.target).toEqual({kind:'block',blockId:host.id});
  expect(reader.state!.offset).toBe(3);
  await reader.refreshContent();
  expect(reader.state!.activeLink).toBe(tasks(reader).at(-1)!.uri);
  expect(paint(reader).match(/\[x\] Verify/g)).toHaveLength(3);
  await reader.key({name:'return'},44,10,noDetail);await reader.action('preview.checklist.choose:copy-link',noDetail);
  expect(copied).toEqual([`((${plan.id}^verify))`]);
  await reader.key({name:'c'},44,10,noDetail);reader.paste('Comment on the original step');
  await reader.key({name:'s',ctrl:true},44,10,noDetail);
  const comments=await client.request<AnnotationThread[]>({action:'annotations.list',query:{subject:{kind:'block',blockId:plan.id},includeResolved:true}});
  expect(comments).toHaveLength(1);
  expect(comments[0]!.originalTarget.listItemId).toBe('verify');
  expect(await client.request<AnnotationThread[]>({action:'annotations.list',query:{subject:{kind:'block',blockId:host.id},includeResolved:true}})).toHaveLength(0);
  await reader.key({name:'z',ctrl:true},44,10,noDetail);
  expect((await client.request<Block>({action:'get',blockId:plan.id})).text).toContain('- [~] Verify ^verify');
  expect(reader.state!.activeLink).toBe(tasks(reader).at(-1)!.uri);
  await click(reader,tasks(reader)[2]!.uri);await reader.action('preview.checklist.choose:address',noDetail);
  const addressed=await client.request<Block>({action:'get',blockId:plan.id});
  expect(addressed.text).toMatch(/Prepare \^task-/);
  expect(await client.request<Block>({action:'get',blockId:host.id})).toEqual(host);
  expect(paint(reader)).not.toContain('^task-');
  // A fragment-only Preview still edits the full source at the original offset.
  await reader.load({kind:'block',blockId:plan.id,fragmentId:'verify'});reader.focus();
  expect(tasks(reader)).toHaveLength(1);
  expect(paint(reader)).not.toContain('Read the instructions');
  await click(reader,tasks(reader)[0]!.uri);await reader.action('preview.checklist.choose:problem',noDetail);
  expect((await client.request<Block>({action:'get',blockId:plan.id})).text).toBe(addressed.text.replace('[~] Verify','[!] Verify'));
  await reader.key({name:'z',ctrl:true},44,10,noDetail);
  expect((await client.request<Block>({action:'get',blockId:plan.id})).text).toBe(addressed.text);
}));

// Reader boundary: real rendered hit targets and keyboard selection must mutate the
// canonical item through RPC. Parser/store tests cannot catch wrong painted targets.
test('Preview task controls preserve Markdown, folds, clipboard identity and keyboard undo',async()=>fixture(async client=>{
  const source=['# Release plan [project::demo]','','[x] done · [~] waiting · [!] problem · [ ] to do','',
    '1. [ ] Prepare','   Keep [instructions](https://example.test/guide) nearby.',
    '   - [~] Check dependency ^dependency','2. [x] Build, next: deploy ^build',
    '3. [!] Inspect ^inspect','4. [ ] Deploy ^deploy','5. [ ] Observe ^observe',
    '6. [ ] Close ^close','7. [ ] Record ^record','','Then:','- Ordinary follow-up','',
    '```markdown','- [ ] Literal example','```','','> - [ ] Quoted task ^quoted'].join('\n');
  const block=await client.request<Block>({action:'create',text:source});
  const copied:string[]=[];
  const reader=new DocumentPreview(client,()=>{},undefined,undefined,undefined,undefined,text=>{copied.push(text);});
  await reader.load({kind:'block',blockId:block.id});reader.focus();
  expect(tasks(reader)).toHaveLength(9);
  expect(paint(reader)).toContain('[~]');
  expect(links(reader).some(link=>link.uri==='https://example.test/guide')).toBe(true);
  expect((await client.request<Block>({action:'get',blockId:block.id})).revision).toBe(block.revision);
  const first=tasks(reader)[0]!;
  const initialFold=links(reader).find(link=>link.uri.includes('document-control')&&link.row===first.row)!;
  await click(reader,initialFold.uri);
  expect(paint(reader)).not.toContain('Check dependency');
  await click(reader,first.uri);
  const menu=renderDocumentPreview(reader.state!,{x:4,y:2,width:28,height:10},'help');
  expect(menu.lines.map(stripTerminalSequences).join('\n')).toContain('> [x] Mark done');
  expect(menu.lines.every(line=>visibleWidth(line)<=28)).toBe(true);
  await reader.key({name:'escape'},28,8,noDetail);
  expect((await client.request<Block>({action:'get',blockId:block.id})).text).toBe(source);
  reader.restoreOffset(2);
  await reader.key({name:'return'},44,10,noDetail);
  await reader.key({name:'return'},44,10,noDetail);
  const changed=await client.request<Block>({action:'get',blockId:block.id});
  const items=await client.request<ChecklistCollection>({action:'checklist.query',blockId:block.id,query:{limit:20}});
  const id=items.items[0]!.itemId!;
  expect(id).toBeTruthy();
  expect(changed.text).toBe(source.replace('1. [ ] Prepare',`1. [x] Prepare ^${id}`));
  expect(paint(reader)).not.toContain('Check dependency');
  const assignedFold=links(reader).find(link=>link.uri.includes('document-control')&&link.row===tasks(reader)[0]!.row)!;
  await click(reader,assignedFold.uri);
  expect(paint(reader)).toContain('Check dependency');
  await click(reader,tasks(reader)[0]!.uri);await reader.key({name:'escape'},44,10,noDetail);

  expect(reader.state!.offset).toBe(2);
  expect(reader.state!.activeLink).toContain(encodeURIComponent(`^${id}`));
  expect(paint(reader)).not.toContain(`^${id}`);
  await reader.key({name:'space'},44,10,noDetail);
  expect((await client.request<Block>({action:'get',blockId:block.id})).text).toContain('1. [ ] Prepare');
  await reader.key({name:'z',ctrl:true},44,10,noDetail);
  expect((await client.request<Block>({action:'get',blockId:block.id})).text).toContain('1. [x] Prepare');
  await reader.key({name:'return'},44,10,noDetail);
  const copy=renderDocumentPreview(reader.state!,{x:0,y:0,width:24,height:9},'help').controls!.find(control=>control.action.endsWith(':copy-link'))!;
  await reader.action(copy.action,noDetail);
  expect(copied).toEqual([`((${block.id}^${id}))`]);
  const fold=links(reader).find(link=>link.uri.includes('document-control')&&link.row===tasks(reader)[0]!.row)!;
  expect(fold).toBeDefined();
  await click(reader,fold.uri);
  expect(paint(reader)).not.toContain('Check dependency');
  expect(tasks(reader)).toHaveLength(8);
  expect(tasks(reader).some(link=>link.uri.includes(encodeURIComponent(`^${id}`)))).toBe(true);
  await click(reader,tasks(reader)[0]!.uri);await reader.key({name:'escape'},44,10,noDetail);
  await reader.key({name:'space'},44,10,noDetail);
  expect(paint(reader)).not.toContain('Check dependency');
  await reader.key({name:'z',ctrl:true},44,10,noDetail);
  expect(paint(reader)).not.toContain('Check dependency');
  await click(reader,fold.uri);
  expect(paint(reader)).toContain('dependency');
  await click(reader,fold.uri);
  // The wrapped lead paragraph remains readable; only its nested list folds.
  expect(links(reader).some(link=>link.uri==='https://example.test/guide')).toBe(true);
  await reader.key({name:'return'},22,6,noDetail);
  expect(paint(reader,22)).toContain('dependency');
  await reader.loadText({kind:'block',blockId:block.id},'Saved before-image',Promise.resolve(source));
  expect(tasks(reader)).toHaveLength(0);
}));

// Async reader lifetime is separate from service conflict semantics: an admitted
// mutation may finish, but its receipt must never replace the user's newer note.
test('Preview ignores late checklist receipts after navigation and refuses stale-item undo',async()=>fixture(async client=>{
  const a=await client.request<Block>({action:'create',text:'# Plan\n\n- [ ] Prepare ^prepare\n- [ ] Verify ^verify'});
  const b=await client.request<Block>({action:'create',text:'# Another note\n\nKeep this in view.'});
  const held=Promise.withResolvers<ChecklistUpdateReceipt>();
  const started=Promise.withResolvers<void>();
  let hold=true;
  const reader=new DocumentPreview({async request<T>(input:RequestInput):Promise<T>{
    if(input.action==='checklist.update'&&hold){
      const receipt=await client.request<ChecklistUpdateReceipt>(input);started.resolve();
      await held.promise;return receipt as T;
    }
    return client.request<T>(input);
  }},()=>{});
  await reader.load({kind:'block',blockId:a.id});reader.focus();
  await click(reader,tasks(reader)[0]!.uri);
  const save=reader.key({name:'return'},44,10,noDetail);
  await started.promise;
  await reader.load({kind:'block',blockId:b.id});
  held.resolve({} as ChecklistUpdateReceipt);await save;hold=false;
  expect(reader.state!.target).toEqual({kind:'block',blockId:b.id});
  expect(paint(reader)).toContain('Keep this in view.');
  expect(reader.state!.notice).toBeUndefined();
  const saved=await client.request<Block>({action:'get',blockId:a.id});
  expect(saved.text).toContain('- [x] Prepare ^prepare');
  await client.request({action:'update',blockId:a.id,mutation:{author:'user'},expectedRevision:saved.revision,text:saved.text.replace('Prepare','Prepare differently')});
  await reader.load({kind:'block',blockId:a.id});
  await reader.key({name:'z',ctrl:true},44,10,noDetail);
  expect(reader.state!.notice).toContain('Checklist item changed');
  expect((await client.request<Block>({action:'get',blockId:a.id})).text).toContain('- [x] Prepare differently ^prepare');
  await click(reader,tasks(reader)[0]!.uri);
  const current=await client.request<Block>({action:'get',blockId:a.id});
  await client.request({action:'update',blockId:a.id,mutation:{author:'user'},expectedRevision:current.revision,text:current.text.replace('Verify','Verify independently')});
  await reader.action('preview.checklist.choose:waiting',noDetail);
  const merged=await client.request<Block>({action:'get',blockId:a.id});
  expect(merged.text).toContain('- [~] Prepare differently ^prepare');
  expect(merged.text).toContain('Verify independently');
}));
