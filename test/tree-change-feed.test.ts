import {afterEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initTheme} from "@earendil-works/pi-coding-agent";
import {OutlinerClient, type RequestInput} from "../src/client";
import {OutlinerServer} from "../src/server";
import {OutlinerStore} from "../src/store";
import {serviceTreeNavigation} from "../src/navigation-routes";
import {createTreeController} from "../src/tree-controller";
import type {Block, OutlinerEvent} from "../src/types";

initTheme(undefined,false);
const cleanups: (() => Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});

async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"outliner-tree-feed-"));
  const store=new OutlinerStore(join(dir,"outline.sqlite"));
  const server=new OutlinerServer(store,join(dir,"outline.sock"));
  await server.start();
  cleanups.push(async()=>{await server.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const client=new OutlinerClient(join(dir,"outline.sock"));
  const notes=Array.from("ABC",letter=>store.create(`Fictional note ${letter}`));
  const requests: string[]=[];
  // Events are held until the test delivers them, as Tree's ordered work queue would.
  const pending: OutlinerEvent[]=[];
  const connected=Promise.withResolvers<void>();
  const watcher=client.watch({client:{clientId:"tree",contextId:"tree-context",role:"tree"},onConnect:connected.resolve,
    onEvent(event){if(event.domain==="content")pending.push(event);}});
  cleanups.push(()=>watcher.stop());
  await connected.promise;
  const controller=createTreeController({clientId:"tree",browsingContextId:"tree-context",workspaceRoot:dir,
    request:(input:RequestInput)=>{requests.push(input.action);return client.request(input);},
    navigation:serviceTreeNavigation(client,"tree","tree-context"),
    createDetailPane:async()=>{},openCapturePopup:async()=>{},openVirtualBranchNavigator:async()=>{},
    focusSelf(){},stop(){},invalidate(){},terminalWidth:()=>100,terminalHeight:()=>40,copyText(){}});
  await controller.initialize();
  cleanups.push(async()=>{await controller.handleKeypress("",{ctrl:true,name:"q"},"pass");});
  const indexReads=()=>requests.filter(action=>action==="tree.index").length;
  const settle=async(count:number)=>{
    const deadline=Date.now()+2_000;
    while(pending.length<count){if(Date.now()>deadline)throw Error("Timed out waiting for events");await Bun.sleep(5);}
    for(const event of pending.splice(0))await controller.handleServiceEvent(event);
  };
  const labels=()=>controller.view().rows.flatMap(row=>"block" in row&&row.block&&"preview" in row.block?[String(row.block.preview)]:[]);
  return {client,controller,notes,indexReads,settle,labels,requests};
}

test("Tree reads the index once for a burst of queued content events",async()=>{
  const f=await fixture();
  const before=f.indexReads();
  let block: Block=f.notes[0]!;
  for(let edit=1;edit<=10;edit++){
    block=await f.client.request<Block>({action:"update",blockId:block.id,text:`Fictional note A, edit ${edit}`,
      expectedRevision:block.revision,mutation:{author:"user"}});
  }
  await f.settle(10);
  // The first event's reload reads the final state; the other nine are already reflected.
  expect(f.indexReads()-before).toBe(1);
  expect(f.labels()).toContain("Fictional note A, edit 10");
});

test("Tree still reloads for each change it has not read yet",async()=>{
  const f=await fixture();
  const before=f.indexReads();
  for(const [index,note] of f.notes.entries()){
    await f.client.request({action:"update",blockId:note.id,text:`Revised note ${index}`,expectedRevision:note.revision,mutation:{author:"user"}});
    await f.settle(1);
  }
  expect(f.indexReads()-before).toBe(3);
  expect(f.labels()).toEqual(expect.arrayContaining(["Revised note 0","Revised note 1","Revised note 2"]));
});

test("Tree reconnects without reloading when the feed reports no outline change",async()=>{
  const f=await fixture();
  let before=f.indexReads();
  f.controller.handleDisconnect();
  await f.controller.handleConnect();
  expect(f.requests).toContain("changes.since");
  expect(f.indexReads()-before).toBe(0);

  f.controller.handleDisconnect();
  const created=await f.client.request<Block>({action:"create",text:"Written while Tree was away"});
  before=f.indexReads();
  await f.controller.handleConnect();
  expect(f.indexReads()-before).toBe(1);
  expect(f.labels()).toContain("Written while Tree was away");
  // The delayed live event for that change is already reflected.
  await f.settle(1);
  expect(f.indexReads()-before).toBe(1);
  expect(created.id).toBeTruthy();
});
