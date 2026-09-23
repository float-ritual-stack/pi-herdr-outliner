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

test('scrolling starts from the visible clamped offset after enlargement',async()=>{
 const {initTheme}=await import('@earendil-works/pi-coding-agent');initTheme(undefined,false);
 const {renderDocumentPreview}=await import('../src/document-preview-renderer');
 const reader=new DocumentPreview({async request<T>(input:RequestInput):Promise<T>{
  if(input.action==='get')return block('long',Array.from({length:100},(_,i)=>`Paragraph ${i}\n`).join('\n')) as T;
  if(input.action==='references.resolve')return {text:input.text,workIdPrefix:null} as T;
  throw new Error('unexpected');
 }},()=>{});
 await reader.load({kind:'block',blockId:'long'});reader.scroll(10000,60,5);
 const frame=renderDocumentPreview(reader.state!,{x:0,y:0,width:60,height:33},'help');
 reader.scroll(-1,frame.content.width,frame.content.height);
 expect(reader.state?.offset).toBe(frame.offset-1);
});

test('saved text never resolves live projections and cannot replace a later current selection',async()=>{
 const pending=Promise.withResolvers<string>();let requests=0;
 const reader=new DocumentPreview({async request<T>(input:RequestInput):Promise<T>{requests++;throw Error('unexpected '+input.action);}},()=>{});
 const old=reader.loadText({kind:'block',blockId:'old'},'Before',pending.promise);
 await reader.loadText({kind:'block',blockId:'new'},'New before',Promise.resolve('Saved ((reference))\n```query\nold\n```'));
 pending.resolve('late before');await old;
 expect(requests).toBe(0);expect(reader.state!.document.projectedText).toContain('Saved ((reference))');
 expect(reader.state!.target).toEqual({kind:'block',blockId:'new'});
});

test('Preview follows rendered links without writes, restores history and opens its actual current target',async()=>{
 const {initTheme}=await import('@earendil-works/pi-coding-agent');initTheme(undefined,false);
 const {renderDocumentPreview}=await import('../src/document-preview-renderer');
 const requests:string[]=[];const opens:unknown[]=[];
 const a='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 const reader=new DocumentPreview({async request<T>(input:RequestInput):Promise<T>{
  requests.push(input.action);
  if(input.action==='get')return block(input.blockId,input.blockId===a?`Origin\n\n[Read target](pi-outliner://block/${b})\n\n${'Long paragraph\n\n'.repeat(20)}`:'Destination\n\nTarget body') as T;
  if(input.action==='references.resolve')return {text:input.text,workIdPrefix:null} as T;
  throw Error('unexpected '+input.action);
 }},()=>{});
 const open=async(target:unknown)=>{opens.push(target);};
 await reader.load({kind:'block',blockId:a});reader.focus();
 const frame=renderDocumentPreview(reader.state!,{x:20,y:3,width:60,height:20},'help');
 expect(frame.links?.some(link=>link.uri===`pi-outliner://block/${b}`)).toBe(true);
 expect(frame.lines.join('\n')).not.toContain('\x1b]8;');
 reader.cycleLink(-1,60,17);expect(reader.state?.activeLink).toBe(`pi-outliner://block/${b}`);
 reader.restoreOffset(3);
 await reader.key({name:'return'},60,17,open);
 expect(reader.state?.target).toEqual({kind:'block',blockId:b});
 await reader.action('preview.open',open);expect(opens).toEqual([{kind:'block',blockId:b}]);
 await reader.action('preview.back',open);expect(reader.state?.offset).toBe(3);expect(reader.state?.target).toEqual({kind:'block',blockId:a});
 await reader.key({name:'right',meta:true},60,17,open);expect(reader.state?.target).toEqual({kind:'block',blockId:b});
 await reader.load({kind:'block',blockId:a});await reader.action('preview.back',open);expect(reader.state?.target).toEqual({kind:'block',blockId:a});
 expect(requests.every(action=>action==='get'||action==='references.resolve')).toBe(true);
});

test('a late link resolution cannot navigate a newly selected Preview; unresolved pages never create notes',async()=>{
 const resolution=Promise.withResolvers<unknown>();
 const reader=new DocumentPreview({async request<T>(input:RequestInput):Promise<T>{
  if(input.action==='pages.resolve')return await resolution.promise as T;
  if(input.action==='get')return block(input.blockId,'Current') as T;
  if(input.action==='references.resolve')return {text:input.text,workIdPrefix:null} as T;
  throw Error('unexpected '+input.action);
 }},()=>{});
 await reader.load({kind:'block',blockId:'old'});
 const following=reader.action(`preview.link:${encodeURIComponent('pi-outliner://page/Somewhere')}`,async()=>{});
 await reader.load({kind:'block',blockId:'new'});
 resolution.resolve({block:block('resolved','Late')});await following;
 expect(reader.state?.target).toEqual({kind:'block',blockId:'new'});
 await reader.action(`preview.link:${encodeURIComponent('https://example.com')}`,async()=>{});
 expect(reader.state?.notice).toContain('Unsupported link');
});
