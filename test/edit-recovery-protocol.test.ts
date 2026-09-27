import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OutlinerStore} from "../src/store";
import {OutlinerServer} from "../src/server";
import {OutlinerClient} from "../src/client";
import type {EditRecovery} from "../src/edit-recovery";
import type {Block} from "../src/types";
import {EditRecoveryClient} from "../src/edit-recovery-client";

test("retained writing requires an explicit current-revision item-ID removal and preserves undo history", async () => {
  const root=mkdtempSync(join(tmpdir(),"checklist-recovery-rpc-"));
  const store=new OutlinerStore(join(root,"db.sqlite"),{workspaceRoot:root}),server=new OutlinerServer(store,join(root,"rpc.sock"));
  await server.start();const client=new OutlinerClient(join(root,"rpc.sock"));
  const recovery=new EditRecoveryClient(client,root);
  try {
    const base=await client.request<Block>({action:"create",text:"# Plan\n\n- [ ] First ^first"});
    const text="# Plan\n\nWork was cancelled.";
    const record=await recovery.retain({id:crypto.randomUUID(),blockId:base.id,baseText:base.text,baseRevision:base.revision,
      prelaunchText:base.text,draftText:text,source:"external-editor"});
    await expect(recovery.commit(record,text)).rejects.toThrow("List-item IDs would be removed");
    expect((await recovery.list(base.id))[0]!.draftText).toBe(text);
    const saved=await recovery.commit(record,text,[{kind:"remove",itemId:"first"}]);
    expect(saved.text).toBe(text);
    const history=(await recovery.list(base.id,true))[0]!;
    expect(history.state).toBe("applied");
    const restored=await recovery.restore(history,"before-save");
    expect(restored.draftText).toBe(base.text);
    const undo=await recovery.commit(restored,restored.draftText);
    expect(undo.text).toBe(base.text);
  } finally {await server.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test("recovery RPC retains writing, rejects stale saves and separates without copying Work-ID ownership",async()=>{
  const root=mkdtempSync(join(tmpdir(),"recovery-rpc-"));
  const store=new OutlinerStore(join(root,"db.sqlite"),{workspaceRoot:root}),server=new OutlinerServer(store,join(root,"rpc.sock"));
  await server.start();const client=new OutlinerClient(join(root,"rpc.sock"));
  const mutation={author:"user" as const,actorId:"detail"};
  try {
    const base=await client.request<Block>({action:"create",text:"Same title\n\nOriginal"});
    await client.request({action:"create",text:base.text});
    const input={id:crypto.randomUUID(),blockId:base.id,baseText:base.text,baseRevision:base.revision,prelaunchText:base.text,draftText:"Same title [work-id::PIE-1]\n\nReturned\n```\ncode\n```",source:"external-editor" as const};
    const record=await client.request<EditRecovery>({action:"edit-recovery.start",input});
    expect(await client.request<EditRecovery>({action:"edit-recovery.start",input})).toEqual(record);
    const latest=await client.request<Block>({action:"update",blockId:base.id,text:"Newest writer",expectedRevision:base.revision,mutation});
    await expect(client.request({action:"edit-recovery.commit",recoveryId:record.id,expectedRevision:record.revision,text:"My draft",basedOnRevision:base.revision,mutation})).rejects.toThrow();
    expect((await client.request<Block>({action:"get",blockId:base.id})).text).toBe(latest.text);
    const separate=await client.request<Block>({action:"edit-recovery.separate",recoveryId:record.id,expectedRevision:record.revision,mutation});
    expect(separate.text).toContain(input.draftText);
    expect(separate.properties.some(property=>property.key==="work-id")).toBe(false);
    expect((await client.request<EditRecovery>({action:"edit-recovery.get",recoveryId:record.id})).originalDraft).toBe(input.draftText);
    expect(await client.request<EditRecovery[]>({action:"edit-recovery.list",blockId:base.id})).toEqual([]);
  } finally {await server.close();store.close();rmSync(root,{recursive:true,force:true});}
});
