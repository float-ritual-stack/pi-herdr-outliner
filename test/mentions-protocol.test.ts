import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutlinerStore} from '../src/store';
import {OutlinerServer} from '../src/server';
import {OutlinerClient} from '../src/client';
import type {MentionCollection,MentionReceipt} from '../src/mentions-types';
import type {Block} from '../src/types';
test('host-neutral mention RPC preserves selection and round-trips save, identity conflicts and workspace guard',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mentions-rpc-'));
 const store=new OutlinerStore(join(root,'db.sqlite'),{workspaceRoot:root}),server=new OutlinerServer(store,join(root,'rpc.sock'));
 await server.start();const client=new OutlinerClient(join(root,'rpc.sock'));
 try{
  const note=await client.request<Block>({action:'create',text:'Protocol mention [page::rpc-mention]'});
  const before=await client.request<unknown>({action:'selection.get'});
  const message={workspaceRoot:root,agent:'test-host',sessionId:'test-session',messageId:'one',text:'See [[rpc-mention]].'};
  const receipt=await client.request<MentionReceipt>({action:'mentions.ingest',message});
  expect((await client.request<MentionCollection>({action:'mentions.list'})).entries[0]?.block?.id).toBe(note.id);
  expect(await client.request<unknown>({action:'selection.get'})).toEqual(before);
  expect((await client.request<MentionReceipt>({action:'mentions.ingest',message})).deduplicated).toBe(true);
  await expect(client.request({action:'mentions.ingest',message:{...message,text:'Other text'}})).rejects.toThrow('different text');
  await expect(client.request({action:'mentions.ingest',message:{...message,workspaceRoot:'/unrelated'}})).rejects.toThrow('workspace');
  await client.request({action:'mentions.save',messageKey:receipt.messageKey});
  await client.request({action:'mentions.clear'});
  expect((await client.request<MentionCollection>({action:'mentions.list'})).entries).toHaveLength(0);
  await expect(client.request({action:'mentions.message',messageKey:receipt.messageKey})).rejects.toThrow('expired');
  expect((await client.request<Block>({action:'get',blockId:note.id})).text).toBe(note.text);
 }finally{await server.close();store.close();rmSync(root,{recursive:true,force:true});}
});
