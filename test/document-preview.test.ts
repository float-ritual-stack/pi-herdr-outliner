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

test('Preview link labels use their own display columns, including wide and combining glyphs',async()=>{
 const {initTheme}=await import('@earendil-works/pi-coding-agent');initTheme(undefined,false);
 const {documentPreviewLinks,renderDocumentPreview}=await import('../src/document-preview-renderer');
 const {stripTerminalSequences}=await import('@earendil-works/pi-tui');
 const reader=new DocumentPreview({async request<T>():Promise<T>{throw Error('not used');}},()=>{});
 await reader.loadText({kind:'block',blockId:'source'},'Source',Promise.resolve('See 界 [Read 界 e\u0301](https://example.com/first) then [Other](https://example.com/second) before continuing.'));
 const links=documentPreviewLinks(reader.state!.document,120);
 expect(links.map(link=>link.label)).toEqual(['Read 界 e\u0301','Other']);
 expect(links[0]!.row).toBe(links[1]!.row);
 reader.focus();
 for(const label of ['Read 界 e\u0301','Other']){
  reader.cycleLink(1,120,17);
  expect(reader.state?.activeLinkLabel).toBe(label);
  const frame=renderDocumentPreview(reader.state!,{x:0,y:0,width:120,height:20},'help');
  expect(stripTerminalSequences(frame.lines.at(-1)!).trim()).toBe(`Enter follow · ${label}`);
 }
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

test('newest link intent wins regardless of page-resolution response order',async()=>{
 const first=Promise.withResolvers<unknown>(),second=Promise.withResolvers<unknown>();
 const reader=new DocumentPreview({async request<T>(input:RequestInput):Promise<T>{
  if(input.action==='pages.resolve')return await (input.address==='First'?first:second).promise as T;
  if(input.action==='get')return block(input.blockId,input.blockId) as T;
  if(input.action==='references.resolve')return {text:input.text,workIdPrefix:null} as T;
  throw Error('unexpected '+input.action);
 }},()=>{});
 await reader.load({kind:'block',blockId:'origin'});
 const a=reader.action('preview.link:'+encodeURIComponent('pi-outliner://page/First'),async()=>{});
 const b=reader.action('preview.link:'+encodeURIComponent('pi-outliner://page/Second'),async()=>{});
 first.resolve({block:block('first','First')});await a;
 second.resolve({block:block('second','Second')});await b;
 expect(reader.state?.target).toEqual({kind:'block',blockId:'second'});
 await reader.action('preview.back',async()=>{});expect(reader.state?.target).toEqual({kind:'block',blockId:'origin'});
});

test('Forward reloads a visit interrupted by Back instead of restoring a loading placeholder',async()=>{
 const pending=Promise.withResolvers<Block>();let reads=0;
 const reader=new DocumentPreview({async request<T>(input:RequestInput):Promise<T>{
  if(input.action==='get'){
   if(input.blockId==='bbbbbbbb'&&++reads===1)return await pending.promise as T;
   return block(input.blockId,'Resolved '+input.blockId) as T;
  }
  if(input.action==='references.resolve')return {text:input.text,workIdPrefix:null} as T;
  throw Error('unexpected '+input.action);
 }},()=>{});
 await reader.load({kind:'block',blockId:'aaaaaaaa'});
 const following=reader.action('preview.link:'+encodeURIComponent('pi-outliner://block/bbbbbbbb'),async()=>{});
 await reader.action('preview.back',async()=>{});
 expect(reader.state?.target).toEqual({kind:'block',blockId:'aaaaaaaa'});
 await reader.action('preview.forward',async()=>{});
 expect(reader.state?.document.projectedText).toBe('Resolved bbbbbbbb');
 pending.resolve(block('bbbbbbbb','Stale'));await following;
 expect(reader.state?.document.projectedText).toBe('Resolved bbbbbbbb');
});

test('narrow Preview preserves clickable navigation ahead of optional layout controls',async()=>{
 const {initTheme}=await import('@earendil-works/pi-coding-agent');initTheme(undefined,false);
 const {treePreviewFrame}=await import('../src/tree-preview');
 const reader=new DocumentPreview({async request<T>():Promise<T>{throw Error('not used');}},()=>{});
 await reader.loadText({kind:'block',blockId:'source'},'Source',Promise.resolve('Body'));
 for(const sideFraction of [.55,.8]){
  const frame=treePreviewFrame({...reader.state!,canBack:true,canForward:true},60,40,'',{enabled:true,dock:'right',sideFraction,bottomFraction:.5});
  expect(frame.controls?.map(control=>control.action)).toEqual(expect.arrayContaining(['preview.back','preview.forward','preview.open']));
  expect(frame.controls?.every(control=>control.rect.x+control.rect.width<=frame.rect.x+frame.rect.width)).toBe(true);
 }
});
