import {afterEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initTheme} from "@earendil-works/pi-coding-agent";
import {OutlinerClient} from "../src/client";
import {OutlinerServer} from "../src/server";
import {OutlinerStore} from "../src/store";
import {serviceTreeNavigation} from "../src/navigation-routes";
import {createTreeController} from "../src/tree-controller";
import {renderTreeFrame} from "../src/tree-renderer";
import {stripTerminalSequences} from "@earendil-works/pi-tui";
import type {TreeController} from "../src/tree-controller";
import type {VirtualBranchOrder, WorkingSelection} from "../src/types";

initTheme(undefined,false);
const cleanups: (() => Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});

async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"outliner-tree-selection-"));
  const store=new OutlinerStore(join(dir,"outline.sqlite"));
  const server=new OutlinerServer(store,join(dir,"outline.sock"));
  await server.start();
  cleanups.push(async()=>{await server.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const client=new OutlinerClient(join(dir,"outline.sock"));
  const view=store.create("Candidates [type::virtual-branch] [query::lane=todo]");
  const blocks=Array.from("ABCDE",letter=>store.create(`Candidate ${letter} [lane::todo] [page::candidate-${letter}]`));
  const ids=blocks.map(b=>b.id);
  store.reorderVirtualOccurrences(view.id,ids);
  const copies:string[]=[];
  const open=async(owner:string)=>{
    const connected=Promise.withResolvers<void>();
    const watcher=client.watch({client:{clientId:owner,contextId:owner+"-context",role:"tree"},onConnect:connected.resolve,onEvent(){}});
    await connected.promise;
    const controller=createTreeController({clientId:owner,browsingContextId:owner+"-context",workspaceRoot:dir,
      request:input=>client.request(input),navigation:serviceTreeNavigation(client,owner,owner+"-context"),
      createDetailPane:async()=>{},openCapturePopup:async()=>{},openVirtualBranchNavigator:async()=>{},
      focusSelf(){},stop(){},invalidate(){},terminalWidth:()=>100,terminalHeight:()=>40,copyText:text=>copies.push(text)});
    await controller.initialize();
    const close=async()=>{await controller.handleKeypress("",{ctrl:true,name:"q"},"pass");await watcher.stop();};
    cleanups.push(close);
    return {controller,close};
  };
  const row=(controller:TreeController,id:string)=>controller.view().rows.find(r=>r.kind==="occurrence"&&r.viewId===view.id&&r.canonicalId===id)!;
  return {client,store,view,blocks,ids,copies,open,row};
}

test("Tree collects with keys and pointer actions, preserves focus, ranks and copies the displayed set",async()=>{
  const f=await fixture();
  const {controller:c}=await f.open("tree-one");
  await c.handleRowClick(f.row(c,f.ids[4]!).rowId);
  await c.handleKeypress("x",{name:"x"},"pass");
  const focus=c.view().rows[c.view().selectedIndex]!.rowId;
  for(const index of [0,2])await c.handleAction(`tree.selection.toggle:${encodeURIComponent(f.row(c,f.ids[index]!).rowId)}`);
  expect(c.view().rows[c.view().selectedIndex]!.rowId).toBe(focus);
  expect(c.view().selectionCue).toBe("3 selected");
  const rendered=renderTreeFrame({...c.view(),localPreview:null},100,40,0,{clearScreen:false}).frame;
  expect(stripTerminalSequences(rendered)).toContain("[Clear]");
  expect(rendered).toContain(`pi-outliner-action:tree.selection.toggle:${encodeURIComponent(focus)}`);
  expect(stripTerminalSequences(rendered)).toContain("[x] Candidate A");
  await c.handleKeypress("X",{name:"x",shift:true},"pass");
  expect(c.mode).toBe("action-menu");
  expect(c.view().actionMenuItems?.filter(item=>item.id.startsWith("tree.selection.read:")).map(item=>item.label)).toEqual([
    "Read · Candidate A", "Read · Candidate C", "Read · Candidate E",
  ]);
  await c.handleAction("tree.selection.copy-pages");
  expect(f.copies.at(-1)).toBe("[[candidate-A]]\n[[candidate-C]]\n[[candidate-E]]");
  await c.handleAction("tree.selection.move-top");
  const order=await f.client.request<VirtualBranchOrder>({action:"virtual.occurrences.order",viewId:f.view.id});
  expect(order.blockIds).toEqual([f.ids[0]!,f.ids[2]!,f.ids[4]!,f.ids[1]!,f.ids[3]!]);
  await c.handleAction("tree.selection.copy-references");
  expect(f.copies.at(-1)).toBe([0,2,4].map(i=>`((${f.ids[i]}))`).join("\n"));
  await c.handleKeypress("X",{name:"x",shift:true},"pass");
  await c.handlePaste("Read · Candidate C");
  expect(c.view().actionMenuItems?.[0]?.label).toBe("Read · Candidate C");
  await c.handleKeypress("",{name:"return"},"pass");
  expect(c.view().localPreview?.target).toEqual({kind:"block",blockId:f.ids[2]!});
  expect(c.view().collectedIds?.size).toBe(3);
  await c.handleAction("tree.selection.clear");
  expect(c.view().collectedIds?.size).toBe(0);
  expect(await f.client.request({action:"working-selection.get",ownerClientId:"tree-one"})).toBeNull();
});

test("Tree exposes explicit recovery and preserves unavailable targets until the user removes them",async()=>{
  const f=await fixture();
  const first=await f.open("old-tree");
  await first.controller.handleAction(`tree.selection.toggle:${encodeURIComponent(f.row(first.controller,f.ids[0]!).rowId)}`);
  await first.close();
  const {controller:c}=await f.open("new-tree");
  expect(c.view().collectedIds?.size).toBe(0);
  expect(c.view().recoverableSelections).toBe(1);
  await c.handleAction("tree.selection.inspect");
  const recover=c.view().actionMenuItems!.find(item=>item.id.startsWith("tree.selection.resume:"))!;
  await c.handleAction(recover.id);
  expect(c.view().selectionCue).toContain("Recovered · 1 selected");
  // A change made through the service while this Tree was disconnected.
  await f.client.request({action:"delete",blockId:f.ids[0]!});
  await c.handleConnect();
  expect(c.view().selectionCue).toContain("1 outside this view");
  await c.handleAction("tree.selection.copy-ids");
  expect(f.copies).toEqual([]);
  expect(c.view().status).toContain("unavailable");
  await c.handleAction("tree.selection.inspect");
  expect(c.view().actionMenuItems?.some(item=>item.id===`tree.selection.remove:${f.ids[0]}`)).toBe(true);
  await c.handleAction(`tree.selection.remove:${f.ids[0]}`);
  expect(c.view().status).not.toContain("unavailable");
  expect(c.view().collectedIds?.size).toBe(0);
  expect(await f.client.request<WorkingSelection|null>({action:"working-selection.get",ownerClientId:"new-tree"})).toBeNull();
});

test("Tree refuses a bulk action after its saved selection changes elsewhere",async()=>{
  const f=await fixture();
  const {controller:c}=await f.open("tree-one");
  await c.handleAction(`tree.selection.toggle:${encodeURIComponent(f.row(c,f.ids[4]!).rowId)}`);
  const original=await f.client.request<WorkingSelection>({action:"working-selection.get",ownerClientId:"tree-one"});
  await f.client.request({action:"working-selection.save",input:{ownerClientId:"tree-one",expected:original,targets:[]}});
  await c.handleAction("tree.selection.move-top");
  expect(c.view().status).toContain("Selection changed");
  expect((await f.client.request<VirtualBranchOrder>({action:"virtual.occurrences.order",viewId:f.view.id})).blockIds).toEqual(f.ids);
  await c.handleAction("tree.selection.copy-ids");
  expect(f.copies).toEqual([]);
  await c.handleAction("tree.selection.inspect");
  expect(c.view().collectedIds?.size).toBe(0);
});

test("Tree deduplicates repeated appearances but rejects mixed appearance ranking",async()=>{
  const f=await fixture();
  f.store.update(f.view.id,f.view.text+' [fixture-view::selection]',f.view.revision,{author:'user'});
  f.store.create('Another appearance [type::virtual-branch] [query::fixture-view=selection]');
  const {controller:c}=await f.open('tree-one');
  const appearances=(id:string)=>c.view().rows.filter(r=>r.kind==='occurrence'&&r.canonicalId===id&&r.viewId===f.view.id);
  const a=appearances(f.ids[0]!);const e=appearances(f.ids[4]!);
  expect(a.length).toBe(2);expect(e.length).toBe(2);
  const toggle=(rowId:string)=>c.handleAction(`tree.selection.toggle:${encodeURIComponent(rowId)}`);
  await toggle(a[0]!.rowId);await toggle(a[1]!.rowId);
  expect(c.view().collectedIds?.size).toBe(0);
  await toggle(a[0]!.rowId);await toggle(e[1]!.rowId);
  await c.handleAction('tree.selection.move-top');
  expect(c.view().status).toContain('one virtual branch appearance');
  expect((await f.client.request<VirtualBranchOrder>({action:'virtual.occurrences.order',viewId:f.view.id})).blockIds).toEqual(f.ids);
  await c.handleAction('tree.selection.clear');
  await toggle(a[1]!.rowId);await toggle(e[1]!.rowId);
  await c.handleAction('tree.selection.move-top');
  expect((await f.client.request<VirtualBranchOrder>({action:'virtual.occurrences.order',viewId:f.view.id})).blockIds).toEqual([f.ids[0]!,f.ids[4]!,...f.ids.slice(1,4)]);
});

test("Tree exposes recovery truncation rather than claiming an exhaustive count",async()=>{
  const f=await fixture();
  for(let i=0;i<101;i++)await f.client.request({action:'working-selection.save',input:{ownerClientId:`closed-${i}`,expected:null,targets:[{blockId:f.ids[0]!,rowId:f.ids[0]!}]}});
  const {controller:c}=await f.open('new-tree');
  const rendered=renderTreeFrame({...c.view(),localPreview:null},100,40,0,{clearScreen:false}).frame;
  expect(stripTerminalSequences(rendered)).toContain('100+ retained selections');
  await c.handleAction('tree.selection.inspect');
  const recoveries=c.view().actionMenuItems!.filter(item=>item.id.startsWith('tree.selection.resume:'));
  expect(recoveries.length).toBe(100);
  expect(recoveries[0]!.description).toContain('newest 100');
});
