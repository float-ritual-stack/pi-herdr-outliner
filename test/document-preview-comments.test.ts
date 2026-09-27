import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initTheme} from '@earendil-works/pi-coding-agent';
import {stripTerminalSequences} from '@earendil-works/pi-tui';
import {annotationSourceHash, createTextQuoteAnchor} from '../src/annotations';
import {DocumentPreview} from '../src/document-preview';
import {DocumentPreviewInput} from '../src/document-preview-input';
import {documentPreviewLines, documentPreviewLinks, renderDocumentPreview} from '../src/document-preview-renderer';
import {OutlinerStore} from '../src/store';
import {InboxRepository} from '../src/inbox-repository';
import type {RequestInput} from '../src/client';
import type {AnnotationRepresentation} from '../src/types';

test('local Preview reveals canonical passage and general threads without opening Detail', async () => {
  initTheme(undefined, false);
  const directory = mkdtempSync(join(tmpdir(), 'preview-comments-'));
  const store = new OutlinerStore(join(directory, 'outline.sqlite'));
  try {
    const block = store.capture('source','Review\n\nA passage to discuss. More words make this sentence wrap in a narrow reader.\n\n## Next\nKeep reading.','cli').block;
    const contentHash = annotationSourceHash(block.text);
    const representation: AnnotationRepresentation = {
      id: `block:${block.id}:${contentHash}`, subject: {kind:'block', blockId:block.id},
      sourceSnapshot: {kind:'block', blockId:block.id, updatedAt:block.updatedAt, contentHash},
      adapter: {id:'outliner.block-text', version:1}, mediaType:'text/markdown', contentHash, capturedAt:block.updatedAt,
    };
    const start = block.text.indexOf('A passage');
    const passage = store.createAnnotation('passage', {source:'user', body:'Passage feedback', target:{representation,
      anchor:createTextQuoteAnchor(block.text, start, start + 'A passage to discuss.'.length)}}).annotations[0]!;
    store.createAnnotation('general', {source:'user', body:'Overall feedback', target:{representation, anchor:{kind:'whole-subject'}}});
    const pointer=new DocumentPreviewInput();
    const reader = new DocumentPreview({async request<T>(input:RequestInput):Promise<T> {
      if(input.action==='get') return store.get(input.blockId) as T;
      if(input.action==='references.resolve') return store.resolveBlockReferences(input.text) as T;
      if(input.action==='annotations.list') return store.listAnnotationThreads(input.query) as T;
      if(input.action==='annotations.create') return store.createAnnotation(input.requestId,input.input,input.author) as T;
      if(input.action==='annotations.reply') return store.replyToAnnotation(input.requestId,input.input,input.author) as T;
      if(input.action==='annotations.lifecycle') return store.setAnnotationLifecycle(input.input,input.mutation) as T;
      throw Error('Unexpected Preview request '+input.action);
    }}, () => {}, 'preview-test', undefined, pointer);
    await reader.load({kind:'block', blockId:block.id});
    reader.focus();
    const paint = (width:number) => documentPreviewLines(reader.state!.document, width).map(stripTerminalSequences).join('\n');
    expect(paint(64)).toContain('Note comments (1)');
    expect(paint(64)).not.toContain('Passage feedback');
    const gutter = documentPreviewLinks(reader.state!.document, 64).find(link => link.uri.includes('annotation-toggle') && !link.uri.includes('general'))!;
    expect(gutter).toBeDefined();
    const noDetail = async () => { throw Error('Comments must remain in Preview'); };
    await reader.action('preview.link:'+encodeURIComponent(gutter.uri), noDetail);
    expect(paint(64)).toContain('Passage feedback');
    expect(await reader.key({}, 30, 12, noDetail, ']')).toBe(true);
    expect(reader.state!.document.annotations?.selectedAnnotationId).toBe(passage.block.id);
    await reader.key({}, 30, 12, noDetail, ']');
    expect(paint(30)).toContain('Overall feedback');
    expect(reader.state!.offset).toBeGreaterThan(0);
    const offset=reader.state!.offset;
    await reader.key({name:'c'},30,12,noDetail);
    expect(reader.state!.comment?.target?.anchor.kind).toBe('whole-subject');
    reader.paste('Another overall comment');
    expect(await reader.load({kind:'block',blockId:store.create('Another note').id})).toBe(false);
    expect(reader.clear()).toBe(false);
    expect(reader.state!.comment!.buffer.text).toBe('Another overall comment');
    await reader.key({name:'s',ctrl:true},30,12,noDetail);
    expect(reader.state!.comment).toBeUndefined();
    expect(reader.state!.target).toEqual({kind:'block',blockId:block.id});
    expect(reader.state!.offset).toBe(offset);
    const general=store.listAnnotationThreads({subject:{kind:'block',blockId:block.id}}).find(thread=>thread.body==='Another overall comment')!;
    expect(general.originalTarget.representation.contentHash).toBe(contentHash);
    await reader.key({},30,12,noDetail,']');
    const replyLink=documentPreviewLinks(reader.state!.document,30).find(link=>link.uri.includes('annotation-thread-reply'))!;
    expect(replyLink).toBeDefined();
    await reader.action('preview.link:'+encodeURIComponent(replyLink.uri),noDetail);
    const replyTo=reader.state!.comment!.annotationId!;
    reader.paste('Reply from Preview');
    await reader.key({name:'s',ctrl:true},30,12,noDetail);
    expect(store.listAnnotationThreads({subject:{kind:'block',blockId:block.id}}).find(thread=>thread.block.id===replyTo)!.replies.map(reply=>reply.body)).toEqual(['Reply from Preview']);
    expect(paint(30)).toContain('Reply from Preview');
    expect(reader.state!.canBack).toBe(false);
    expect(store.get(block.id)!.text).toBe(block.text);
    expect(store.listAnnotationThreads({subject:representation.subject as {kind:'block';blockId:string}})).toHaveLength(3);

    // Inbox before-images must keep their captured identity after the live note changes.
    const inbox=new InboxRepository(store);
    const attempt=inbox.apply('processed',block,{summary:'Filed note',source:{disposition:'file',text:'New current text'},notes:[],tasks:[],updates:[]});
    const currentText=store.get(block.id)!.text;
    const historicalRepresentation={...representation,sourceSnapshot:{...representation.sourceSnapshot,inboxAttemptId:attempt.id}};
    await reader.loadText({kind:'block',blockId:block.id}, 'Before assistance', async () => ({
      id:block.id, text:block.text, revision:block.revision, updatedAt:block.updatedAt, inboxAttemptId:attempt.id,
    }));
    expect(reader.state!.document.canonicalText).toBe(block.text);
    await reader.key({name:'c'},64,12,noDetail);
    expect(reader.state!.comment?.target?.representation.sourceSnapshot).toEqual(historicalRepresentation.sourceSnapshot);
    let unwantedLoads=0;
    expect(await reader.loadText({kind:'block',blockId:block.id},'Another attempt',async()=>{unwantedLoads++;return 'wrong';})).toBe(false);
    expect(unwantedLoads).toBe(0);
    reader.paste('Feedback on the saved original');
    await reader.key({name:'s',ctrl:true},64,12,noDetail);
    expect(reader.state!.comment).toBeUndefined();
    const historical = store.listAnnotationThreads({subject:{kind:'block',blockId:block.id}})
      .find(thread=>thread.body==='Feedback on the saved original')!;
    expect(historical.originalTarget.representation).toEqual(historicalRepresentation);
    expect(reader.state!.document.canonicalText).toBe(block.text);
    expect(store.get(block.id)!.text).toBe(currentText);
    for(const [inboxAttemptId,updatedAt,contentHash] of [
      ['missing',block.updatedAt,representation.contentHash],
      [attempt.id,'2000-01-01T00:00:00.000Z',representation.contentHash],
      [attempt.id,block.updatedAt,annotationSourceHash('Not the original')],
    ]) {
      expect(()=>store.createAnnotation(crypto.randomUUID(),{body:'Invalid evidence',source:'user',target:{
        representation:{...historicalRepresentation,sourceSnapshot:{kind:'block',blockId:block.id,inboxAttemptId:inboxAttemptId!,updatedAt:updatedAt!,contentHash:contentHash!}},
        anchor:{kind:'whole-subject'},
      }})).toThrow();
    }
    expect(()=>store.createAnnotation('stale-live',{body:'Must not bypass live checks',source:'user',target:{representation,anchor:{kind:'whole-subject'}}})).toThrow('snapshot is stale');
    await reader.loadText({kind:'block',blockId:block.id},'Legacy before',async()=>({id:block.id,text:block.text,revision:block.revision}));
    reader.beginComment();
    expect(reader.state!.comment).toBeUndefined();
    expect(reader.state!.notice).toContain('No captured source');
    await reader.loadText({kind:'block',blockId:block.id},'Before',async()=>({...block,inboxAttemptId:attempt.id}));
    const frame=renderDocumentPreview(reader.state!,{x:0,y:0,width:36,height:22},'help');
    pointer.render(frame.lines,frame,reader.state);
    const row=frame.lines.findIndex(line=>stripTerminalSequences(line).includes('A passage'));
    expect(row).toBeGreaterThanOrEqual(frame.content.y);
    let copied='';
    const actions={focus:()=>reader.focus(),scroll:()=>{},resize:()=>{},invoke:(action:string)=>reader.action(action,noDetail)};
    pointer.handle(`\x1b[<0;${frame.content.x+1};${row+1}M`,actions,text=>copied=text,()=>{});
    pointer.handle(`\x1b[<32;${frame.content.x+20};${row+2}M`,actions,text=>copied=text,()=>{});
    pointer.handle(`\x1b[<0;${frame.content.x+20};${row+2}m`,actions,text=>copied=text,()=>{});
    expect(copied).toContain('A passage to discuss.');
    expect(copied).toContain('\n');
    expect(await reader.key({},36,18,noDetail,'c')).toBe(true);
    expect(reader.state!.comment!.target!.anchor.kind).toBe('text-quote');
    await reader.key({name:'escape'},36,18,noDetail);
    pointer.handle(`\x1b[<0;${frame.content.x+1};${row+1}M`,actions,()=>{},()=>{});
    pointer.handle(`\x1b[<0;${frame.content.x+20};${row+2}m`,actions,()=>{},()=>{});
    const commentControl=frame.controls!.find(control=>control.action==='preview.comment')!;
    pointer.handle(`\x1b[<0;${commentControl.rect.x+1};${commentControl.rect.y+1}M`,actions,()=>{},()=>{});
    expect(reader.state!.comment!.target!.anchor).toEqual({kind:'text-quote',start:null,end:null,exact:copied,prefix:'',suffix:''});
    expect(renderDocumentPreview(reader.state!,frame.rect,'help').lines.map(stripTerminalSequences).join('\n')).toContain('Comment on passage');
    reader.paste('Wrapped passage feedback');
    await reader.key({name:'s',ctrl:true},36,18,noDetail);
    expect(reader.state!.comment).toBeUndefined();
    const wrapped=store.listAnnotationThreads({subject:{kind:'block',blockId:block.id}}).find(thread=>thread.body==='Wrapped passage feedback')!;
    expect(wrapped.originalTarget.anchor).toEqual({kind:'text-quote',start:null,end:null,exact:copied,prefix:'',suffix:''});
    expect(wrapped.originalTarget.representation.observation).toMatchObject({validation:'preview-selection',quote:copied,readerId:'preview-test',representationId:representation.id,projection:'canonical'});
    expect(wrapped.originalTarget.representation.sourceSnapshot).toEqual(historicalRepresentation.sourceSnapshot);
    expect(paint(36)).toContain('Unpositioned comments');
    const observation=wrapped.originalTarget.representation.observation;
    if(observation?.validation!=='preview-selection')throw Error('Expected pointer observation');
    expect(()=>store.createAnnotation('wrong-observation',{body:'Wrong source',source:'user',target:{...wrapped.originalTarget,
      representation:{...wrapped.originalTarget.representation,observation:{...observation,representationId:'another-representation'}},
    }})).toThrow('does not belong');

    await reader.loadText({kind:'block',blockId:block.id},'Before',async()=>({...block,inboxAttemptId:attempt.id}));
    reader.focus();
    const keyboardFrame=renderDocumentPreview(reader.state!,{x:0,y:0,width:36,height:22},'help');
    pointer.render(keyboardFrame.lines,keyboardFrame,reader.state);
    expect(await reader.key({name:'v'},36,18,noDetail,'v')).toBe(true);
    await reader.key({name:'end',shift:true},36,18,noDetail);
    await reader.key({name:'c'},36,18,noDetail,'c');
    expect(reader.state!.comment?.target?.anchor).toMatchObject({kind:'text-quote',exact:'Review'});
    reader.paste('Keyboard passage feedback');
    await reader.key({name:'s',ctrl:true},36,18,noDetail);
    const keyboard=store.listAnnotationThreads({subject:{kind:'block',blockId:block.id}}).find(thread=>thread.body==='Keyboard passage feedback')!;
    expect(keyboard.originalTarget.anchor).toMatchObject({kind:'text-quote',exact:'Review'});
    expect(keyboard.originalTarget.representation.observation).toMatchObject({input:'keyboard',quote:'Review'});
    expect(store.get(block.id)!.text).toBe(currentText);



  } finally { store.close(); rmSync(directory, {recursive:true, force:true}); }
});
