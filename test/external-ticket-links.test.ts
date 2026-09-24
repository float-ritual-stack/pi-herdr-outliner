import {expect,test} from 'bun:test';
import type {RequestInput} from '../src/client';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getOsc8LinkAtColumn} from '@earendil-works/pi-tui';
import {OutlinerStore} from '../src/store';
import {readAuthoredLinks} from '../src/authored-links';
import {MentionRepository} from '../src/mentions';
import {outlinerReferenceOccurrences} from '../src/reference-occurrences';
import {createOutlinerTextLinker,outlinerLinkUri,parseOutlinerLinkUri,resolveOutlinerLinkTarget} from '../src/outliner-links';
import {ticketKeyReferences,workIdReferences} from '../src/work-ids';

test('external keys preserve provider spelling without widening allocator recognition',()=>{
 const text='PC-7 PC-515 ABC-1234 HUB-001 HUB-7 HUB-0001 PC-0 pc-42 foo_PC-515 PC-515_bar éPC-8 PC-8é PC-9007199254740992';
 expect(ticketKeyReferences(text,'HUB').map(r=>r.workId)).toEqual(['PC-7','PC-515','ABC-1234','HUB-001']);
 expect(workIdReferences(text,'HUB').map(r=>r.workId)).toEqual(['HUB-001']);
 expect(ticketKeyReferences('PC-7').map(r=>r.workId)).toEqual(['PC-7']);
 const uri=outlinerLinkUri('work','PC-7');
 expect(parseOutlinerLinkUri(uri)).toEqual({kind:'work',value:'PC-7'});
});

test('shared link recognition respects Markdown and property boundaries',()=>{
 const text='PC-7 `PC-8` [link](https://example.test/PC-9) [jira::PC-10] [[PC-11]]\n```\nPC-12\n```\nPC-13';
 expect(outlinerReferenceOccurrences(text,'HUB').map(r=>r.kind==='block'?r.blockId:r.address)).toEqual(['PC-7','PC-11','PC-13']);
 const linker=createOutlinerTextLinker([],()=>false,'HUB');
 expect(getOsc8LinkAtColumn(linker.link('PC-7'),2)).toBe(outlinerLinkUri('work','PC-7'));
});

test('HUB outline resolves PC aliases in outlinks, backlinks, mentions and explicit navigation without mutation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'external-ticket-'));
 const store=new OutlinerStore(join(root,'db.sqlite'),{workspaceRoot:root});
 try{
  store.configureWorkIdPrefix('HUB');
  const pc=store.create('Jira notes [page::PC-7]');
  const own=store.create('Own task');
  const allocated=store.allocateWorkId(own.id,own.revision);
  const source=store.create('Compare PC-7 with HUB-001; also PC-99.');
  const before=store.sequence;
  const links=readAuthoredLinks(store,source.id);
  if(links.kind!=='ready')throw Error(links.kind);
  expect(links.outlinks.entries.map(e=>e.resolution.kind==='ready'?e.resolution.target.blockId:null)).toEqual([pc.id,own.id,null]);
  expect(store.queryBacklinks({targetBlockId:pc.id,limit:100}).sources.map(s=>s.blockId)).toContain(source.id);
  const requester={async request<T>(request:RequestInput):Promise<T>{
   if(request.action==='pages.resolve')return store.resolvePageAddress(request.address) as T;
   throw Error('Unexpected mutating request: '+request.action);
  }};
  expect((await resolveOutlinerLinkTarget(requester,{kind:'work',value:'PC-7'})).block.id).toBe(pc.id);
  await expect(resolveOutlinerLinkTarget(requester,{kind:'work',value:'PC-99'})).rejects.toThrow('unresolved');
  expect(store.sequence).toBe(before);
  const mentions=new MentionRepository(store,root);
  mentions.ingest({workspaceRoot:root,agent:'test',sessionId:'session',messageId:'turn',text:'PC-7 and HUB-001; `PC-888`'});
  expect(mentions.list().entries.map(e=>e.block?.id)).toEqual([pc.id,own.id]);
  expect(store.workIdAllocatorStatus().prefix).toBe('HUB');
  expect(store.get(allocated.block.id)?.properties.find(p=>p.key==='work-id')?.value).toBe('HUB-001');
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
