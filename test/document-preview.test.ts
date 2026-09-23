import {expect,test} from 'bun:test';
import {DocumentPreview} from '../src/document-preview';
import type {RequestInput} from '../src/client';
import type {Block} from '../src/types';

const block=(id:string,text:string)=>({id,text,revision:1} as Block);
test('late reads and failures cannot replace the newly selected preview',async()=>{
  const older=Promise.withResolvers<Block>();
  const reader=new DocumentPreview({async request<T>(input:RequestInput):Promise<T>{
    if(input.action==='get')return (input.blockId==='old'?await older.promise:block(input.blockId,'New current note')) as T;
    if(input.action==='references.resolve')return {text:input.text,workIdPrefix:null} as T;
    throw new Error('unexpected request');
  }},()=>{});
  const pending=reader.load({kind:'block',blockId:'old'});
  await reader.load({kind:'block',blockId:'new'});
  older.reject(new Error('obsolete failure'));await pending;
  expect(reader.state?.title).toBe('New current note');
  expect(reader.state?.document.projectedText).toBe('New current note');
});
test('closing invalidates an in-flight preview; current failures remain readable',async()=>{
  const pending=Promise.withResolvers<Block>();
  const reader=new DocumentPreview({async request<T>():Promise<T>{return await pending.promise as T;}},()=>{});
  const load=reader.load({kind:'block',blockId:'a'});reader.clear();pending.reject(new Error('failed after close'));await load;
  expect(reader.state).toBeNull();
  await reader.load({kind:'block',blockId:'b'});
  expect(reader.state?.document.projectedText).toContain('failed after close');
});
