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
import {documentPreviewLinks,documentPreviewLines,renderDocumentPreview} from '../src/document-preview-renderer';
import type {Block,ChecklistCollection,ChecklistUpdateReceipt} from '../src/types';

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
