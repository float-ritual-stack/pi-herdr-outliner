import {expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OutlinerClient} from "../src/client";
import {OutlinerServer} from "../src/server";
import {OutlinerStore} from "../src/store";
import {blockAnnotationRepresentation} from "../src/annotation-representations";
import {createBlockComment} from "../src/block-comments";
import type {AnnotationBatchReceipt, AnnotationRecord, AnnotationThread, Block, BlockCommentInput, SelectionContext, WorkspaceSnapshot} from "../src/types";

async function fixture(run: (client: OutlinerClient, root: string, socket: string) => Promise<void>) {
  const root=mkdtempSync(join(tmpdir(),"block-comments-")), socket=join(root,"service.sock");
  const store=new OutlinerStore(join(root,"outline.sqlite"));const server=new OutlinerServer(store,socket);
  await server.start();
  try {await run(new OutlinerClient(socket),root,socket);}
  finally {await server.close();store.close();rmSync(root,{recursive:true,force:true});}
}

// Service is the owner of atomic revision admission and idempotency. No generated
// target or mock receipt is supplied: the new public request must produce them.
test("block comments retain exact evidence and provenance, and retry safely after assigning a checklist identity",()=>fixture(async c=>{
  const block=await c.request<Block>({action:"create",text:"# Plan\n\n- [ ] Inspect café 🧭\n- [ ] Ship ^ship"});
  const input:BlockCommentInput={blockId:block.id,expectedRevision:block.revision,body:"Check this first",source:"agent",passage:{quote:"Inspect café 🧭"}};
  await c.request({action:"selection.set",blockId:block.id});
  const selected=await c.request<SelectionContext>({action:"selection.get"});
  const request={requestId:"comment-step",input,author:"agent" as const,provenance:{actorId:"test-agent",sessionId:"test-session",taskId:"test-task"}};
  const receipt=await createBlockComment(c,request),annotation=receipt.annotations[0]!;
  expect(receipt.deduplicated).toBe(false);
  expect(annotation.originalTarget.anchor).toMatchObject({kind:"text-quote",exact:input.passage!.quote,start:block.text.indexOf(input.passage!.quote)});
  expect(annotation.originalTarget.listItemId).toBeTruthy();
  expect(annotation.currentResolution.status).toBe("resolved");
  expect([annotation.block.author,annotation.block.actorId,annotation.block.sessionId,annotation.block.taskId]).toEqual(["agent","test-agent","test-session","test-task"]);
  const after=await c.request<Block>({action:"get",blockId:block.id});
  expect(after.revision).toBe(block.revision+1);
  expect(after.text).toContain("^"+annotation.originalTarget.listItemId);
  const retry=await createBlockComment(c,request);
  expect([retry.deduplicated,retry.annotations[0]!.block.id]).toEqual([true,annotation.block.id]);
  expect((await c.request<SelectionContext>({action:"selection.get"})).selected?.id).toBe(selected.selected?.id);
  await expect(createBlockComment(c,{...request,input:{...input,body:"Different"}})).rejects.toThrow("different input");
  await expect(createBlockComment(c,{...request,requestId:"new-stale"})).rejects.toThrow("revision is stale");
  const changed=await c.request<Block>({action:"update",blockId:block.id,expectedRevision:after.revision,text:after.text.replace("Inspect café 🧭","Review results"),mutation:{author:"user"}});
  await c.request({action:"annotations.reconcile",input:{subject:{kind:"block",blockId:block.id},newRepresentation:blockAnnotationRepresentation(changed),content:changed.text}});
  const record=await c.request<AnnotationRecord>({action:"annotations.get",annotationId:annotation.block.id});
  expect(record.originalTarget).toEqual(annotation.originalTarget);
  expect(record.resolvedTarget?.anchor).toMatchObject({kind:"list-item",itemId:annotation.originalTarget.listItemId});
  const current=await createBlockComment(c,{requestId:"stable-step",author:"user",input:{blockId:block.id,expectedRevision:changed.revision,source:"user",body:"Now clear",passage:{quote:"Review results",itemId:annotation.originalTarget.listItemId}}});
  expect(current.annotations[0]!.originalTarget.listItemId).toBe(annotation.originalTarget.listItemId);
  const threads=await c.request<AnnotationThread[]>({action:"annotations.list",query:{subject:{kind:"block",blockId:block.id},includeResolved:true}});
  expect(threads.length).toBe(2);
}));

test("ambiguous, absent and mismatched comment passages fail without writing; explicit context and whole-block intent work",()=>fixture(async(c,root,socket)=>{
  const block=await c.request<Block>({action:"create",text:"# Notes\n\nFirst: repeated\nSecond: repeated\n\n- [ ] repeated ^task"});
  const input:BlockCommentInput={blockId:block.id,expectedRevision:block.revision,body:"Feedback",source:"user",passage:{quote:"repeated"}};
  const before=await c.request<WorkspaceSnapshot>({action:"workspace.snapshot"});
  for(const [passage,error] of [[{quote:"repeated"},"ambiguous"],[{quote:"missing"},"not found"],[{quote:""},"non-empty"],[{quote:"repeated",start:0},"not found"],[{quote:"repeated",itemId:"absent"},"missing or ambiguous"]] as const){
    await expect(createBlockComment(c,{requestId:crypto.randomUUID(),input:{...input,passage}})).rejects.toThrow(error);
  }
  expect(await c.request<WorkspaceSnapshot>({action:"workspace.snapshot"})).toEqual(before);
  const context=await createBlockComment(c,{requestId:"context",input:{...input,passage:{quote:"repeated",prefix:"Second: ",suffix:"\n\n"}}});
  expect(context.annotations[0]!.originalTarget.anchor).toMatchObject({kind:"text-quote",start:block.text.indexOf("Second: ")+8});
  const item=await createBlockComment(c,{requestId:"item",input:{...input,passage:{quote:"repeated",itemId:"task"}}});
  expect(item.annotations[0]!.originalTarget.listItemId).toBe("task");
  const whole=await createBlockComment(c,{requestId:"whole",input:{...input,passage:undefined}});
  expect(whole.annotations[0]!.originalTarget.anchor).toEqual({kind:"whole-subject"});
  const args=[process.execPath,"run","src/cli.ts","comment","--id",block.id,"--expected",String(block.revision),"--request-id","cli-comment","--quote","repeated","--start",String(block.text.indexOf("repeated")),"--text","CLI feedback"];
  const invoke=async()=>{
    const proc=Bun.spawn(args,{cwd:join(import.meta.dir,".."),env:{...process.env,OUTLINER_WORKSPACE_ROOT:root,OUTLINER_REMOTE:"1",OUTLINER_SOCKET_PATH:socket},stdout:"pipe",stderr:"pipe"});
    const stdout=await new Response(proc.stdout).text(),stderr=await new Response(proc.stderr).text();expect(await proc.exited,stderr).toBe(0);return JSON.parse(stdout) as AnnotationBatchReceipt;
  };
  const cli=await invoke();expect(cli.annotations[0]!.body).toBe("CLI feedback");expect((await invoke()).deduplicated).toBe(true);
}));

test("block-comment convenience remains atomic with other annotation operations",()=>fixture(async c=>{
  const block=await c.request<Block>({action:"create",text:"- [ ] Check"});
  const before=await c.request<WorkspaceSnapshot>({action:"workspace.snapshot"});
  await expect(c.request({action:"annotations.batch",requestId:"atomic",operations:[
    {operationId:"first",type:"block-comment",input:{blockId:block.id,expectedRevision:block.revision,body:"Valid",source:"user",passage:{quote:"Check"}}},
    {operationId:"second",type:"block-comment",input:{blockId:block.id,expectedRevision:block.revision+1,body:"Stale",source:"user",passage:{quote:"Check"}}},
  ]})).rejects.toThrow("revision is stale");
  expect(await c.request<WorkspaceSnapshot>({action:"workspace.snapshot"})).toEqual(before);
}));

// These failures crossed quote admission and checklist attachment; service proof
// owns the regression rather than repeating it in every adapter.
test("disambiguated checklist passages survive ID assignment and later movement",()=>fixture(async c=>{
  for(const identified of [false,true]) {
    const block=await c.request<Block>({action:"create",text:"- [ ] Earlier\n- [ ] Repeat then Repeat"+(identified?" ^task":"")});
    const start=block.text.lastIndexOf("Repeat");
    const result=await c.request<AnnotationBatchReceipt>({action:"annotations.batch",requestId:crypto.randomUUID(),operations:[
      {operationId:"earlier",type:"block-comment",input:{blockId:block.id,expectedRevision:block.revision,body:"Earlier comment",source:"user",passage:{quote:"Earlier"}}},
      {operationId:"repeat",type:"block-comment",input:{blockId:block.id,expectedRevision:block.revision,body:"Second occurrence",source:"user",passage:{quote:"Repeat",start}}},
    ]});
    const record=result.annotations[1]!, current=await c.request<Block>({action:"get",blockId:block.id});
    expect(record.originalTarget.anchor).toMatchObject({kind:"text-quote",start,exact:"Repeat"});
    expect(record.resolvedTarget?.anchor).toMatchObject({kind:"text-quote",start:current.text.lastIndexOf("Repeat"),exact:"Repeat"});
    const changed=await c.request<Block>({action:"update",blockId:block.id,expectedRevision:current.revision,text:"# Changed heading\n\n"+current.text,mutation:{author:"user"}});
    await c.request({action:"annotations.reconcile",input:{subject:{kind:"block",blockId:block.id},newRepresentation:blockAnnotationRepresentation(changed),content:changed.text}});
    const moved=await c.request<AnnotationRecord>({action:"annotations.get",annotationId:record.block.id});
    expect(moved.resolvedTarget?.anchor).toMatchObject({kind:"text-quote",start:changed.text.lastIndexOf("Repeat"),exact:"Repeat"});
  }
}));

test("explicit parent checklist scope rejects child passages without writing",()=>fixture(async c=>{
  const nested=await c.request<Block>({action:"create",text:"- [ ] Parent ^parent\n  - [ ] Child quote ^child"});
  const before=await c.request<WorkspaceSnapshot>({action:"workspace.snapshot"});
  await expect(createBlockComment(c,{requestId:"wrong-owner",input:{blockId:nested.id,expectedRevision:nested.revision,body:"Wrong parent",source:"user",passage:{quote:"Child quote",itemId:"parent"}}})).rejects.toThrow("not found");
  expect(await c.request<WorkspaceSnapshot>({action:"workspace.snapshot"})).toEqual(before);
}));
