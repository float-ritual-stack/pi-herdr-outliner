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
import type {Block, OutlinerEvent, OutlinerServiceStatus} from "../src/types";

initTheme(undefined,false);
const cleanups: (() => Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});

async function service(texts:string[]) {
  const dir=mkdtempSync(join(tmpdir(),"outliner-tree-feed-"));
  const store=new OutlinerStore(join(dir,"outline.sqlite"));
  const server=new OutlinerServer(store,join(dir,"outline.sock"));
  await server.start();
  cleanups.push(async()=>{await server.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const client=new OutlinerClient(join(dir,"outline.sock"));
  return {dir,store,client,notes:texts.map(text=>store.create(text))};
}

async function fixture(options:{unsupported?:string;withheldCapability?:string}={}) {
  const {dir,client,notes}=await service(Array.from("ABC",letter=>`Fictional note ${letter}`));
  // Tree's requests go to `target`, which a test may point at another service.
  let target: OutlinerClient|null=client;
  const requests: string[]=[];
  // Events are held until the test delivers them, as Tree's ordered work queue would.
  const pending: OutlinerEvent[]=[];
  const connected=Promise.withResolvers<void>();
  const watcher=client.watch({client:{clientId:"tree",contextId:"tree-context",role:"tree"},onConnect:connected.resolve,
    onEvent(event){if(event.domain==="content")pending.push(event);}});
  cleanups.push(()=>watcher.stop());
  await connected.promise;
  const request=<T,>(input:RequestInput):Promise<T>=>{requests.push(input.action);
    if(!target)return Promise.reject(new Error("Workspace service unavailable"));
    if(input.action===options.unsupported)return Promise.reject(new Error(`Unknown action: ${input.action}`));
    if(input.action==="ping"&&options.withheldCapability)return client.request<OutlinerServiceStatus>(input).then(status=>
      ({...status,capabilities:status.capabilities?.filter(capability=>capability!==options.withheldCapability)}) as never);
    return target.request<T>(input);};
  const controller=createTreeController({clientId:"tree",browsingContextId:"tree-context",workspaceRoot:dir,request,
    navigation:serviceTreeNavigation({request},"tree","tree-context"),
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
  const connectTo=(next:OutlinerClient|null)=>{target=next;};
  return {client,controller,notes,indexReads,settle,labels,requests,connectTo};
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

test("Tree reloads on reconnect, without asking the feed, when the service lacks the changes.since capability",async()=>{
  const f=await fixture({withheldCapability:"changes.since"});
  const before=f.indexReads();
  f.controller.handleDisconnect();
  await f.controller.handleConnect();
  expect(f.requests).toContain("ping");
  expect(f.requests).not.toContain("changes.since");
  expect(f.indexReads()-before).toBe(1);
});

test("Tree reloads on reconnect when a changes.since request fails",async()=>{
  // A failed feed read is doubt, and doubt means a full reload.
  const f=await fixture({unsupported:"changes.since"});
  const before=f.indexReads();
  f.controller.handleDisconnect();
  await f.controller.handleConnect();
  expect(f.requests).toContain("changes.since");
  expect(f.indexReads()-before).toBe(1);
});

test("Tree refreshes authored links, without reloading, after Resource catalog activity while away",async()=>{
  const f=await fixture();
  await f.controller.handleAction("tree.authored-links.toggle");
  const linkReads=()=>f.requests.filter(action=>action==="blocks.authored-links").length;
  expect(linkReads()).toBe(1);

  f.controller.handleDisconnect();
  let before={index:f.indexReads(),links:linkReads()};
  await f.controller.handleConnect();
  expect({index:f.indexReads()-before.index,links:linkReads()-before.links}).toEqual({index:0,links:0});

  f.controller.handleDisconnect();
  await f.client.request({action:"resources.retention.configure",input:{
    retainNewestSourceSnapshots:1,retainNewestRepresentationsPerAdapter:1,minimumAgeMs:0,purgeGraceMs:0}});
  before={index:f.indexReads(),links:linkReads()};
  await f.controller.handleConnect();
  expect({index:f.indexReads()-before.index,links:linkReads()-before.links}).toEqual({index:0,links:1});
});

test("Tree refetches rows on reconnect after a view change failed while disconnected",async()=>{
  const f=await fixture();
  await f.client.request({action:"create",text:"Fictional task\nstatus:: open"});
  await f.settle(1);
  await f.controller.handleAction("tree.filter.properties");
  await f.controller.handlePaste("status=open");
  await f.controller.handleKeypress("",{name:"return"},"pass");
  expect(f.labels()).toContain("Fictional task");
  expect(f.labels()).not.toContain("Fictional note A");

  // Clearing the filter while the service is down updates local state, but its row fetch fails.
  f.controller.handleDisconnect();
  f.connectTo(null);
  await f.controller.handleAction("tree.filter.properties");
  expect(f.controller.view().quickInput).toBe("status=open");
  for(let i=0;i<"status=open".length;i++)await f.controller.handleKeypress("",{name:"backspace"},"pass");
  expect(f.controller.view().quickInput).toBe("");
  await f.controller.handleKeypress("",{name:"return"},"pass").catch(()=>{});
  expect(f.controller.view().activeFilter).toBe("");
  expect(f.labels()).toContain("Fictional task");
  expect(f.labels()).not.toContain("Fictional note A");

  // No writes happened, yet the rows no longer match the view: reconnect refetches them.
  f.connectTo(f.client);
  const before=f.indexReads();
  await f.controller.handleConnect();
  expect(f.indexReads()-before).toBe(1);
  expect(f.labels()).toEqual(expect.arrayContaining(["Fictional note A","Fictional note B","Fictional note C","Fictional task"]));

  // With the rows current again, an unchanged reconnect is back on the fast path.
  f.controller.handleDisconnect();
  const after=f.indexReads();
  await f.controller.handleConnect();
  expect(f.indexReads()-after).toBe(0);
});

test("Tree reloads on reconnect when the service now uses a different database",async()=>{
  const f=await fixture();
  // Another database whose sequence matches the first one's, so the feed alone would report nothing missed.
  const other=await service(["Other note X","Other note Y","Other note Z"]);
  const [first,second]=await Promise.all([f.client,other.client].map(client=>client.request<{sequence:number}>({action:"changes.since",sequence:0,limit:1})));
  expect(second!.sequence).toBe(first!.sequence);

  f.controller.handleDisconnect();
  // Tree registers with whichever service it reconnects to.
  const registered=Promise.withResolvers<void>();
  const watcher=other.client.watch({client:{clientId:"tree",contextId:"tree-context",role:"tree"},onConnect:registered.resolve,onEvent(){}});
  cleanups.push(()=>watcher.stop());
  await registered.promise;
  f.connectTo(other.client);
  const before=f.indexReads();
  await f.controller.handleConnect();
  expect(f.requests).toContain("ping");
  expect(f.indexReads()-before).toBe(1);
  expect(f.labels()).toEqual(expect.arrayContaining(["Other note X","Other note Y","Other note Z"]));
  expect(f.labels()).not.toContain("Fictional note A");

  // The same database again: the fast path applies.
  f.controller.handleDisconnect();
  const after=f.indexReads();
  await f.controller.handleConnect();
  expect(f.indexReads()-after).toBe(0);
});
