import {loadDetailDraftPreview} from '../src/detail-read-preview';
import {observeDocument} from '../src/document-provenance';
import {annotationFrameCells} from '../src/annotation-frame';
import {projectDetailRead} from '../src/detail-embeds';
import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initTheme} from '@earendil-works/pi-coding-agent';
import {stripTerminalSequences,visibleWidth} from '@earendil-works/pi-tui';
import {OutlinerStore} from '../src/store';
import {InboxRepository} from '../src/inbox-repository';
import {OutlinerServer} from '../src/server';
import {OutlinerClient,type RequestInput} from '../src/client';
import {DocumentPreview} from '../src/document-preview';
import {DocumentPreviewInput} from '../src/document-preview-input';
import {blockAnnotationRepresentation} from '../src/annotation-representations';
import {documentPreviewLinks,documentPreviewLines,renderDocumentPreview} from '../src/document-preview-renderer';
import type {AnnotationThread,Block,ChecklistCollection,ChecklistUpdateReceipt} from '../src/types';

async function fixture(run:(client:OutlinerClient,store:OutlinerStore)=>Promise<void>){
  initTheme(undefined,false);
  const directory=mkdtempSync(join(tmpdir(),'preview-checklist-'));
  const store=new OutlinerStore(join(directory,'outline.sqlite'));
  const server=new OutlinerServer(store,join(directory,'outliner.sock'));
  await server.start();
  try {await run(new OutlinerClient(join(directory,'outliner.sock')),store);}
  finally {await server.close();store.close();rmSync(directory,{recursive:true,force:true});}
}
const noDetail=async()=>{throw Error('Checklist interaction must stay in Preview');};
const links=(reader:DocumentPreview,width=44)=>documentPreviewLinks(reader.state!.document,width);
const tasks=(reader:DocumentPreview,width=44)=>links(reader,width).filter(link=>link.uri.includes('/checklist/'));
const paint=(reader:DocumentPreview,width=44)=>documentPreviewLines(reader.state!.document,width).map(stripTerminalSequences).join('\n');
const click=async(reader:DocumentPreview,uri:string)=>reader.action('preview.link:'+encodeURIComponent(uri),noDetail);

// Tree Preview owns viewport offsets and pointer geometry separately from Detail.
// Exercise that boundary through its real renderer/input and the service, rather
// than supplying preassembled selection evidence to the composer.
test('Tree Preview captures transformed text in the selected transclusion occurrence',async()=>fixture(async client=>{
  const source=await client.request<Block>({action:'create',text:'# Shared\n\n**Rock &amp; roll**'});
  const host=await client.request<Block>({action:'create',text:`# Host\n\n!((${source.id}))\n\nBetween\n\n!((${source.id}))`});
  const input=new DocumentPreviewInput(),copied:string[]=[];
  const reader=new DocumentPreview(client,()=>{},'preview-reader',undefined,input);
  await reader.load({kind:'block',blockId:host.id});reader.focus();
  const frame=renderDocumentPreview(reader.state!,{x:8,y:3,width:48,height:30},'');
  const lines=[...Array(3).fill(''),...frame.lines.map(line=>' '.repeat(8)+line)];
  input.render(lines,frame,reader.state);
  const row=lines.map((line,index)=>stripTerminalSequences(line).includes('Rock & roll')?index:-1).filter(index=>index>=0).at(-1)!;
  const start=stripTerminalSequences(lines[row]!).indexOf('Rock & roll');
  expect(row).toBeGreaterThan(frame.content.y);
  const actions={focus(){reader.focus();},scroll(){},resize(){},async invoke(action:string){await reader.action(action,noDetail);}};
  const send=(phase:'down'|'drag'|'up',column:number)=>input.handle(`\x1b[<${phase==='drag'?32:0};${column+1};${row+1}${phase==='up'?'m':'M'}`,actions,text=>copied.push(text),()=>{});
  send('down',start);send('drag',start+11);send('up',start+11);
  expect(copied).toEqual(['Rock & roll']);
  reader.beginComment();
  const target=reader.state!.comment!.target!;
  expect(target.passage?.quote).toBe('Rock & roll');
  const fragments=target.passage!.fragments.filter(fragment=>fragment.kind==='source');
  expect(fragments.map(fragment=>fragment.slices.map(slice=>target.passage!.documents[slice.document]!.text.slice(slice.anchor.start!,slice.anchor.end!)).join('')).join('')).toBe('Rock &amp; roll');
  expect(fragments.every(fragment=>fragment.occurrence?.host.anchor.start===host.text.lastIndexOf('!(('))).toBe(true);
  reader.paste('Discuss this use');await reader.key({name:'s',ctrl:true},48,27,noDetail);
  expect(reader.state!.notice).toBe('Comment saved');
  expect(reader.state!.comment).toBeUndefined();
  const threads=await client.request<AnnotationThread[]>({action:'annotations.list',query:{subject:{kind:'block',blockId:host.id},includeResolved:true}});
  expect(threads).toHaveLength(1);
  expect(threads[0]!.originalTarget.passage).toEqual(target.passage);
  expect((await client.request<Block>({action:'get',blockId:source.id})).text).toBe(source.text);
  // Collapse the two identical embedded sections, then navigate to the comment.
  paint(reader,48);
  const folds=reader.state!.document.previewRegions!.regions.filter(region=>region.kind==='document-fold'&&region.sourceSpan&&
    reader.state!.document.projectedText.split('\n')[region.sourceSpan.startLine]?.includes('# Shared'));
  expect(folds).toHaveLength(2);
  for(const fold of folds)reader.state!.document.previewRegions!.disclosureOverrides.set(fold.id,false);
  expect(paint(reader,48)).not.toContain('Rock & roll');
  await reader.key({name:']'},48,27,noDetail);
  expect(paint(reader,48).match(/Rock & roll/g)).toHaveLength(1);
  expect(reader.state!.document.previewRegions!.disclosureOverrides.get(folds[0]!.id)).toBe(false);
  expect(reader.state!.document.previewRegions!.disclosureOverrides.get(folds[1]!.id)).toBe(true);
}));

test('saved Preview versions place passage comments against their displayed observation',async()=>fixture(async client=>{
  const before=await client.request<Block>({action:'create',text:'# Plan\n\nOriginal words'});
  const input=new DocumentPreviewInput();
  const reader=new DocumentPreview(client,()=>{},'history-reader',undefined,input);
  await reader.load({kind:'block',blockId:before.id});reader.focus();
  const frame=renderDocumentPreview(reader.state!,{x:0,y:0,width:48,height:20},'');
  input.render(frame.lines,frame,reader.state);
  const row=frame.lines.findIndex(line=>stripTerminalSequences(line).includes('Original words'));
  const actions={focus(){},scroll(){},resize(){},async invoke(){}};
  for(const [button,column,phase] of [[0,0,'M'],[32,14,'M'],[0,14,'m']] as const)
    input.handle(`\x1b[<${button};${column+1};${row+1}${phase}`,actions,()=>{},()=>{});
  reader.beginComment();reader.paste('Historical discussion');await reader.key({name:'s',ctrl:true},48,17,noDetail);
  expect(reader.state!.comment).toBeUndefined();
  const updated=await client.request<Block>({action:'update',blockId:before.id,expectedRevision:before.revision,text:'# Plan\n\nReplacement words',mutation:{author:'user'}});
  await client.request({action:'annotations.reconcile',input:{subject:{kind:'block',blockId:before.id},newRepresentation:blockAnnotationRepresentation(updated)}});
  await reader.load({kind:'block',blockId:before.id});
  expect(paint(reader)).toContain('Unpositioned comments');
  await reader.loadText({kind:'block',blockId:before.id},'Before editing',async()=>before);reader.focus();
  await reader.key({name:']'},48,17,noDetail);
  const historical=paint(reader,48);
  expect(historical).not.toContain('Unpositioned comments');
  expect(historical.split('\n').find(line=>line.includes('Original words'))).toStartWith('− ');
  expect(historical).toContain('Historical discussion');
  expect(reader.state!.document.canonicalText).toBe(before.text);
}));

test('commenting on an Inbox before-image preserves its attempt and never assigns live checklist IDs',async()=>fixture(async(client,store)=>{
  const {block:before}=await client.request<{block:Block}>({action:'capture.create',requestId:'capture-plan',text:'# Plan\n\n- [ ] Prepare release',source:'cli'});
  const attempt=new InboxRepository(store).apply('file-plan',before,{
    summary:'Filed plan',source:{disposition:'file',text:'# Filed plan'},notes:[],tasks:[],updates:[],
  });
  const filed=await client.request<Block>({action:'get',blockId:before.id});
  // Identical bytes are not permission to edit the live note from history.
  const live=await client.request<Block>({action:'update',blockId:before.id,expectedRevision:filed.revision,
    text:before.text,mutation:{author:'user'}});
  const input=new DocumentPreviewInput();
  const reader=new DocumentPreview(client,()=>{},'inbox-history-reader',undefined,input);
  await reader.loadText({kind:'block',blockId:before.id},'Before assistance',async()=>({...before,inboxAttemptId:attempt.id}));
  reader.focus();
  const frame=renderDocumentPreview(reader.state!,{x:0,y:0,width:48,height:20},'');
  input.render(frame.lines,frame,reader.state);
  const row=frame.lines.findIndex(line=>stripTerminalSequences(line).includes('Prepare release'));
  const column=stripTerminalSequences(frame.lines[row]!).indexOf('Prepare release');
  const actions={focus(){},scroll(){},resize(){},async invoke(){}};
  for(const [button,end,phase] of [[0,column,'M'],[32,column+15,'M'],[0,column+15,'m']] as const)
    input.handle(`\x1b[<${button};${end+1};${row+1}${phase}`,actions,()=>{},()=>{});
  reader.beginComment();reader.paste('Discuss the saved plan');
  await reader.key({name:'s',ctrl:true},48,17,noDetail);
  expect(reader.state!.notice).toBe('Comment saved');
  expect(await client.request<Block>({action:'get',blockId:before.id})).toEqual(live);
  const [thread]=await client.request<AnnotationThread[]>({action:'annotations.list',query:{subject:{kind:'block',blockId:before.id}}});
  expect(thread!.originalTarget.passage!.documents[0]).toMatchObject({
    text:before.text,revision:before.revision,inbox:{attemptId:attempt.id,updatedAt:before.updatedAt},
  });
  expect(thread!.originalTarget.passage!.fragments.filter(fragment=>fragment.kind==='source')
    .flatMap(fragment=>fragment.slices).every(slice=>!slice.listItemId)).toBe(true);
  for(const inbox of [{attemptId:'missing',updatedAt:before.updatedAt},
    {attemptId:attempt.id,updatedAt:'2000-01-01T00:00:00.000Z'}]) {
    const passage=thread!.originalTarget.passage!;
    await expect(client.request({action:'annotations.create',requestId:crypto.randomUUID(),input:{source:'user',body:'Forged history',
      target:{...thread!.originalTarget,passage:{...passage,documents:passage.documents.map(document=>({...document,inbox}))}},
    }})).rejects.toThrow('saved Inbox passage is unavailable or mismatched');
  }
  expect((await client.request<AnnotationThread[]>({action:'annotations.list',query:{subject:{kind:'block',blockId:before.id}}}))).toHaveLength(1);
  expect(await client.request<Block>({action:'get',blockId:before.id})).toEqual(live);
}));

test('live checklist views use correlated canonical matches, shared controls and honest limits',async()=>fixture(async client=>{
  const plan=await client.request<Block>({action:'create',text:'# Release [project::demo]\n\nRead these instructions first.\n\n- [ ] Prepare [owner::alex]\n- [~] Deploy [owner::sam] ^deploy\n  - Context\n    - [!] Check [owner::alex] ^check'});
  const view=await client.request<Block>({action:'create',text:'# My steps\n[type::checklist-view] [plans::project=demo] [query::owner=alex] [exclude-status::done] [limit::10]'});
  const host=await client.request<Block>({action:'create',text:`# Dashboard\n\n!((${view.id}))\n\nAfter the view\n\n- [ ] Local ^local`});
  for(const source of [view,host]) {
    const projected=await projectDetailRead(client,source.text,{hostBlockId:source.id});
    expect(projected.provenance!.text).toBe(projected.text);
    const canonical=projected.provenance!.runs.flatMap(run=>run.origin.kind==='source'?run.origin.slices:[])
      .filter(slice=>slice.document.subject.kind==='block'&&slice.document.subject.blockId===plan.id);
    expect(canonical.map(slice=>plan.text.slice(slice.start,slice.end)).filter(value=>value.trim())).toEqual([
      '- [ ] Prepare [owner::alex]','- [!] Check [owner::alex]',
    ]);
  }
  const reader=new DocumentPreview(client,()=>{});
  await reader.load({kind:'block',blockId:view.id});reader.focus();
  expect(tasks(reader)).toHaveLength(2);
  expect(paint(reader)).toContain('2 matched steps');
  expect(paint(reader)).not.toContain('Deploy');
  expect(links(reader).some(link=>link.uri.includes(plan.id))).toBe(true);
  expect(await client.request<Block>({action:'get',blockId:plan.id})).toEqual(plan);
  await click(reader,tasks(reader)[0]!.uri);await reader.key({name:'return'},44,12,noDetail);
  expect(paint(reader)).toContain('1 matched step');
  expect(tasks(reader)).toHaveLength(1);
  expect((await client.request<Block>({action:'get',blockId:plan.id})).text).toMatch(/- \[x\] Prepare \[owner::alex\] \^t-[0-9a-f]{6,}$/m);
  expect(await client.request<Block>({action:'get',blockId:view.id})).toEqual(view);
  await reader.key({name:'z',ctrl:true},44,12,noDetail);
  expect(tasks(reader)).toHaveLength(2);
  await reader.load({kind:'block',blockId:host.id});reader.focus();
  expect(tasks(reader)).toHaveLength(3);
  // An authored task after the generated results must still target its own source.
  const local=tasks(reader).find(link=>link.uri.includes(host.id))!;
  await click(reader,local.uri);await reader.key({name:'return'},44,12,noDetail);
  expect((await client.request<Block>({action:'get',blockId:host.id})).text).toBe(host.text.replace('[ ] Local','[x] Local'));
  const limited=await client.request<Block>({action:'update',mutation:{author:'user'},blockId:view.id,text:view.text.replace('limit::10','limit::1'),expectedRevision:view.revision});
  await reader.load({kind:'block',blockId:view.id});
  expect(paint(reader)).toContain('LIMITED');
  expect(tasks(reader)).toHaveLength(1);
  await client.request({action:'update',mutation:{author:'user'},blockId:view.id,text:limited.text.replace('limit::1','limit::oops'),expectedRevision:limited.revision});
  await reader.load({kind:'block',blockId:view.id});
  expect(paint(reader)).toContain('Checklist view unavailable');
  expect(paint(reader)).not.toContain('No matching');
  expect(tasks(reader)).toHaveLength(0);
}));

test('comments distinguish nested checklist results from each other and canonical text',async()=>fixture(async client=>{
  const plan=await client.request<Block>({action:'create',text:'# Plan [project::nested-results]\n\n- [ ] Parent [owner::alex]\n  - [ ] Child [owner::alex]'});
  const view=await client.request<Block>({action:'create',text:'# Steps ^heading\n[type::checklist-view] [plans::project=nested-results] [query::owner=alex]'});
  const host=await client.request<Block>({action:'create',text:`# Dashboard\n\n!((${view.id}))`});
  const draft={...observeDocument({kind:'block' as const,blockId:view.id},view.text+'\nUnsaved',view.revision),draft:true as const};
  const draftProjection=await loadDetailDraftPreview(client,draft);
  const draftHosts=draftProjection.provenance.runs.flatMap(run=>run.origin.kind==='source'&&run.origin.occurrence?[run.origin.occurrence.host]:[]);
  expect(draftHosts.length).toBeGreaterThan(0);
  for(const host of draftHosts) {
    expect(host.document).toEqual(draft);
    expect(host.document.text.slice(host.start,host.end)).toBe('[query::owner=alex]');
  }
  for(const source of [view,host])for(const occurrence of [0,1]) {
    const input=new DocumentPreviewInput();
    const reader=new DocumentPreview(client,()=>{},'checklist-result-reader',undefined,input);
    await reader.load({kind:'block',blockId:source.id});reader.focus();
    const frame=renderDocumentPreview(reader.state!,{x:0,y:0,width:80,height:60},'');
    input.render(frame.lines,frame,reader.state);
    const rows=frame.lines.map(stripTerminalSequences);
    const copies=rows.flatMap((line,row)=>line.includes('Child')?[row]:[]);
    expect(copies).toHaveLength(2);
    const row=copies[occurrence]!,column=rows[row]!.indexOf('Child');
    const actions={focus(){},scroll(){},resize(){},async invoke(){}};
    for(const [button,end,phase] of [[0,column,'M'],[32,column+5,'M'],[0,column+5,'m']] as const)
      input.handle(`\x1b[<${button};${end+1};${row+1}${phase}`,actions,()=>{},()=>{});
    expect(input.captureSelection()?.quote).toBe('Child');
    reader.beginComment();
    const body=`Discuss result ${occurrence} in ${source.id}`;
    reader.paste(body);await reader.key({name:'s',ctrl:true},80,57,noDetail);
    expect(reader.state!.comment).toBeUndefined();
    const threads=await client.request<AnnotationThread[]>({action:'annotations.list',query:{subject:{kind:'block',blockId:source.id}}});
    const thread=threads.find(thread=>thread.body===body)!;
    expect(thread).toBeDefined();
    // A fresh read and different wraps must keep the gutter on just this result.
    await reader.load({kind:'block',blockId:source.id});
    for(const width of [80,32]) {
      const rendered=renderDocumentPreview(reader.state!,{x:0,y:0,width,height:80},'').documentFrame!;
      const matches=annotationFrameCells(thread,rendered);
      expect(matches.map(cell=>cell.text).join('')).toBe('Child');
      const childRows=rendered.lines.flatMap((line,row)=>stripTerminalSequences(line).includes('Child')?[row]:[]);
      expect(new Set(matches.map(cell=>cell.row))).toEqual(new Set([childRows[occurrence]]));
    }
    await reader.load({kind:'block',blockId:plan.id});
    const canonical=renderDocumentPreview(reader.state!,{x:0,y:0,width:80,height:60},'').documentFrame!;
    expect(annotationFrameCells(thread,canonical)).toHaveLength(0);
  }
  const updated=await client.request<Block>({action:'get',blockId:plan.id});
  expect(updated.text.replace(/ \^t-[0-9a-f]{6,}/g,'')).toBe(plan.text);
  expect(updated.revision).toBe(plan.revision+1);
}));

test('nested fragment readers preserve interactive steps and continuation Markdown',async()=>fixture(async client=>{
  const plan=await client.request<Block>({action:'create',text:'# Plan\n\n- [ ] Parent ^parent\n    - [~] Nested ^nested\n      Continued **instructions**'});
  const host=await client.request<Block>({action:'create',text:`# Dashboard\n\n!((${plan.id}^nested))`});
  const reader=new DocumentPreview(client,()=>{});
  for(const target of [{kind:'block' as const,blockId:host.id},{kind:'block' as const,blockId:plan.id,fragmentId:'nested'}]){
    await reader.load(target);reader.focus();
    expect(tasks(reader)).toHaveLength(1);
    expect(paint(reader)).not.toContain('**instructions**');
    expect(paint(reader)).not.toContain('outliner-preview');
    await click(reader,tasks(reader)[0]!.uri);await reader.action('preview.checklist.choose:done',noDetail);
    expect((await client.request<Block>({action:'get',blockId:plan.id})).text).toBe(plan.text.replace('[~] Nested','[x] Nested'));
    await reader.key({name:'z',ctrl:true},44,12,noDetail);
  }
  expect(await client.request<Block>({action:'get',blockId:host.id})).toEqual(host);
}));

test('same-target background loads preserve an opened embedded status picker',async()=>fixture(async client=>{
  const plan=await client.request<Block>({action:'create',text:'# Plan\n\n1. [~] Prepare ^prepare\n   - [~] Dependency ^dependency'});
  const host=await client.request<Block>({action:'create',text:`# Dashboard\n\n!((${plan.id}^prepare))\n\nAgain\n\n!((${plan.id}^prepare))`});
  const input=new DocumentPreviewInput();
  let frame:ReturnType<typeof renderDocumentPreview>;
  const draw=()=>{if(reader.state){frame=renderDocumentPreview(reader.state,{x:0,y:0,width:90,height:35},'',undefined,'compact');input.render(frame.lines,frame,reader.state);}};
  const reader=new DocumentPreview(client,draw,undefined,undefined,input);
  await reader.load({kind:'block',blockId:host.id});reader.focus();draw();
  const rows=frame!.lines.map(stripTerminalSequences);
  const row=rows.findIndex(line=>line.includes('Prepare')&&line.includes('[~]'));
  const column=visibleWidth(rows[row]!.slice(0,rows[row]!.indexOf('[~]')));
  const pending:Promise<void>[]=[];
  const actions={focus:()=>reader.focus(),scroll:()=>{},resize:()=>{},invoke:(id:string)=>{const run=reader.action(id,noDetail);pending.push(run);return run;}};
  for(const suffix of ['M','m'])input.handle(`\x1b[<0;${column+1};${row+1}${suffix}`,actions,()=>{},draw);
  await Promise.all(pending);
  expect(reader.state!.checklistPicker?.control.item.itemId).toBe('prepare');
  await reader.load({kind:'block',blockId:host.id});
  expect(reader.state!.checklistPicker?.control.item.itemId).toBe('prepare');
  const refreshing=reader.load({kind:'block',blockId:host.id});
  await reader.key({name:'down'},90,35,noDetail);
  await refreshing;
  expect(reader.state!.checklistPicker?.index).toBe(1);
  const cancelling=reader.load({kind:'block',blockId:host.id});
  await reader.key({name:'escape'},90,35,noDetail);
  await cancelling;
  expect(reader.state!.checklistPicker).toBeUndefined();
  expect(await client.request<Block>({action:'get',blockId:plan.id})).toEqual(plan);
}));

test('a saved item comment cannot select its thread in a newly opened note',async()=>fixture(async client=>{
  const source=await client.request<Block>({action:'create',text:'# Plan\n\n- [ ] Prepare ^prepare'});
  const destination=await client.request<Block>({action:'create',text:'# Another note'});
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  let holdRefresh=false;
  const reader=new DocumentPreview({async request<T>(input:RequestInput):Promise<T>{
    if(input.action==='get'&&input.blockId===source.id&&holdRefresh){entered.resolve();await release.promise;}
    const result=await client.request<T>(input);
    if(input.action==='annotations.create')holdRefresh=true;
    return result;
  }},()=>{});
  await reader.load({kind:'block',blockId:source.id});reader.focus();
  await click(reader,tasks(reader)[0]!.uri);await reader.key({name:'escape'},44,12,noDetail);
  await reader.key({name:'c'},44,12,noDetail);reader.paste('Keep this comment with the step');
  const saving=reader.key({name:'s',ctrl:true},44,12,noDetail);
  try {
    await entered.promise;
    expect(reader.state!.comment).toBeUndefined();
    await reader.load({kind:'block',blockId:destination.id});
  } finally {release.resolve();await saving;}
  expect(reader.state!.target).toEqual({kind:'block',blockId:destination.id});
  expect(reader.state!.document.annotations!.selectedAnnotationId).toBeUndefined();
  const comments=await client.request<AnnotationThread[]>({action:'annotations.list',query:{subject:{kind:'block',blockId:source.id}}});
  expect(comments).toHaveLength(1);
  expect(comments[0]!.body).toBe('Keep this comment with the step');
  expect(reader.state!.document.annotations!.annotationThreads).toHaveLength(0);
}));

test('embedded steps keep occurrence focus while edits, copy and undo reach the canonical plan',async()=>fixture(async client=>{
  const plan=await client.request<Block>({action:'create',text:'# Release [project::demo]\n\nRead the instructions first.\n\n- [ ] Prepare\n- [~] Verify ^verify'});
  const host=await client.request<Block>({action:'create',text:`# Dashboard [type::note]\n\n- [ ] Local task\n\n!((${plan.id}^verify))\n\n!((${plan.id}))\n\n!((${plan.id}^verify))`});
  const copied:string[]=[];
  const reader=new DocumentPreview(client,()=>{},undefined,undefined,undefined,undefined,text=>{copied.push(text);});
  await reader.load({kind:'block',blockId:host.id});reader.focus();
  expect(tasks(reader)).toHaveLength(5);
  expect(new Set(tasks(reader).map(link=>link.uri)).size).toBe(5);
  const last=tasks(reader).at(-1)!;
  reader.restoreOffset(3);await click(reader,last.uri);await reader.key({name:'return'},44,10,noDetail);
  expect((await client.request<Block>({action:'get',blockId:plan.id})).text).toContain('- [x] Verify ^verify');
  expect(await client.request<Block>({action:'get',blockId:host.id})).toEqual(host);
  expect(reader.state!.target).toEqual({kind:'block',blockId:host.id});
  expect(reader.state!.offset).toBe(3);
  await reader.refreshContent();
  expect(reader.state!.activeLink).toBe(tasks(reader).at(-1)!.uri);
  expect(paint(reader).match(/\[x\] Verify/g)).toHaveLength(3);
  await reader.key({name:'return'},44,10,noDetail);await reader.action('preview.checklist.choose:copy-link',noDetail);
  expect(copied).toEqual([`((${plan.id}^verify))`]);
  await reader.key({name:'c'},44,10,noDetail);reader.paste('Comment on the original step');
  await reader.key({name:'s',ctrl:true},44,10,noDetail);
  const comments=await client.request<AnnotationThread[]>({action:'annotations.list',query:{subject:{kind:'block',blockId:plan.id},includeResolved:true}});
  expect(comments).toHaveLength(1);
  expect(comments[0]!.originalTarget.listItemId).toBe('verify');
  expect(await client.request<AnnotationThread[]>({action:'annotations.list',query:{subject:{kind:'block',blockId:host.id},includeResolved:true}})).toHaveLength(0);
  await reader.key({name:'z',ctrl:true},44,10,noDetail);
  expect((await client.request<Block>({action:'get',blockId:plan.id})).text).toContain('- [~] Verify ^verify');
  expect(reader.state!.activeLink).toBe(tasks(reader).at(-1)!.uri);
  await click(reader,tasks(reader)[2]!.uri);await reader.action('preview.checklist.choose:address',noDetail);
  const addressed=await client.request<Block>({action:'get',blockId:plan.id});
  expect(addressed.text).toMatch(/Prepare \^t-[0-9a-f]{6,}$/m);
  expect(await client.request<Block>({action:'get',blockId:host.id})).toEqual(host);
  expect(paint(reader)).not.toContain('^t-');
  // A fragment-only Preview still edits the full source at the original offset.
  await reader.load({kind:'block',blockId:plan.id,fragmentId:'verify'});reader.focus();
  expect(tasks(reader)).toHaveLength(1);
  expect(paint(reader)).not.toContain('Read the instructions');
  await click(reader,tasks(reader)[0]!.uri);await reader.action('preview.checklist.choose:problem',noDetail);
  expect((await client.request<Block>({action:'get',blockId:plan.id})).text).toBe(addressed.text.replace('[~] Verify','[!] Verify'));
  await reader.key({name:'z',ctrl:true},44,10,noDetail);
  expect((await client.request<Block>({action:'get',blockId:plan.id})).text).toBe(addressed.text);
}));

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
  const initialFold=links(reader).find(link=>link.uri.includes('document-control')&&link.row===first.row)!;
  await click(reader,initialFold.uri);
  expect(paint(reader)).not.toContain('Check dependency');
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
  expect(paint(reader)).not.toContain('Check dependency');
  const assignedFold=links(reader).find(link=>link.uri.includes('document-control')&&link.row===tasks(reader)[0]!.row)!;
  await click(reader,assignedFold.uri);
  expect(paint(reader)).toContain('Check dependency');
  await click(reader,tasks(reader)[0]!.uri);await reader.key({name:'escape'},44,10,noDetail);

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
  await click(reader,tasks(reader)[0]!.uri);await reader.key({name:'escape'},44,10,noDetail);
  await reader.key({name:'space'},44,10,noDetail);
  expect(paint(reader)).not.toContain('Check dependency');
  await reader.key({name:'z',ctrl:true},44,10,noDetail);
  expect(paint(reader)).not.toContain('Check dependency');
  await click(reader,fold.uri);
  expect(paint(reader)).toContain('dependency');
  await click(reader,fold.uri);
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

// Legacy long generated anchors and new short ones both address the step, open by
// fragment and stay out of the painted text.
test('Preview hides legacy and short generated checklist anchors while addressing both',async()=>fixture(async client=>{
  const legacy='task-0b7c3f4e-2d1a-4c55-9e8f-1a2b3c4d5e6f';
  const plan=await client.request<Block>({action:'create',text:`# Garden\n\n- [ ] Water tomatoes ^${legacy}\n- [ ] Weed beds ^t-5e1f0a`});
  const reader=new DocumentPreview(client,()=>{});
  await reader.load({kind:'block',blockId:plan.id});reader.focus();
  expect(tasks(reader)).toHaveLength(2);
  expect(paint(reader)).toContain('Water tomatoes');
  expect(paint(reader)).not.toContain('^task-');
  expect(paint(reader)).not.toContain('^t-');
  const fragment=new DocumentPreview(client,()=>{});
  await fragment.load({kind:'block',blockId:plan.id,fragmentId:legacy});fragment.focus();
  expect(tasks(fragment)).toHaveLength(1);
  expect(paint(fragment)).not.toContain('Weed beds');
  expect(paint(fragment)).not.toContain('^task-');
  await click(fragment,tasks(fragment)[0]!.uri);await fragment.action('preview.checklist.choose:done',noDetail);
  expect((await client.request<Block>({action:'get',blockId:plan.id})).text).toContain(`- [x] Water tomatoes ^${legacy}`);
}));
