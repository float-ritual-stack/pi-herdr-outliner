import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutlinerStore} from '../src/store';
import {InboxRepository} from '../src/inbox-repository';
import {NoteAssistanceRepository} from '../src/note-assistance-repository';
import {searchInboxHistory,visibleInboxSearch} from '../src/inbox-search';
import {rankSearchWithJev} from '../src/search-ranking';
import {OutlinerServer} from '../src/server';

const fixtures:Array<{store:OutlinerStore;dir:string}>=[];
function fixture(){const dir=mkdtempSync(join(tmpdir(),'inbox-search-'));const store=new OutlinerStore(join(dir,'outline.sqlite'));fixtures.push({dir,store});new NoteAssistanceRepository(store);return{store,dir,repo:new InboxRepository(store)};}
afterEach(()=>{for(const{store,dir}of fixtures.splice(0)){store.close();rmSync(dir,{recursive:true,force:true});}});

test('searches both histories beyond thirty receipts, original and current content, with distinct attempts',()=>{
 const{store,repo}=fixture();
 const capture=store.capture('original','so what is stopping me from\nA dynamic TUI idea','cli').block;
 const first=repo.apply('first-attempt',capture,{summary:'Cleaned the design idea',source:{disposition:'file',text:'Dynamically generated TUI views\nQueries compose interactive content.'},notes:[{text:'Rendering examples\nA cobalt control panel.'},{text:'Interaction examples\nA chartreuse button.'}],tasks:[],updates:[]});
 repo.fail('second-attempt',store.require(capture.id),'A distinct retry failed');
 for(let i=0;i<45;i++)repo.fail('noise-'+i,store.capture('capture-'+i,'Unrelated receipt '+i,'cli').block,'Fixture');
 const seq=store.sequence;
 expect(repo.results().some(r=>r.id==='first-attempt')).toBe(false);
 for(const query of ['what is stopping me','Dynamically generated TUI views','chartreuse button']){
  expect(searchInboxHistory(store,query).matches.some(m=>m.result.id===first.id)).toBe(true);
 }
 expect(searchInboxHistory(store,'Dynamically generated TUI views').matches.filter(m=>m.result.sourceId===capture.id).map(m=>m.result.id).sort()).toEqual(['first-attempt','second-attempt']);
 expect(searchInboxHistory(store,'first-attempt').matches[0]).toMatchObject({exact:true,result:{id:first.id,outputIds:first.outputIds}});
 expect(store.sequence).toBe(seq);
 const assistance=new NoteAssistanceRepository(store);assistance.initialize();
 const ordinary=store.create('Older note outside Inbox\nMeteorite catalogue.');
 assistance.apply('ordinary-attempt',assistance.candidateFor(ordinary.id)!,{summary:'Organized meteorites',tags:['geology'],type:'note'});
 expect(searchInboxHistory(store,'meteorite').matches[0]!.result.id).toBe('ordinary-attempt');
});

test('bounds results honestly and never indexes diagnostic transcripts or trashed output text',()=>{
 const{store,repo}=fixture();
 const source=store.capture('diagnostic','Readable note','cli').block;
 repo.fail('diagnostic-attempt',source,'Fixture',{provider:'fixture',model:'fixture',inputTokens:0,outputTokens:0,cost:0,jevCalls:0,elapsedMs:0,piSessions:[{id:'private-session-needle',path:'/private/secret-transcript-needle.jsonl',startedAt:'2026-09-23',phase:'fixture',outcome:'failed'}]});
 expect(searchInboxHistory(store,'secret-transcript-needle').matches).toHaveLength(0);
 const item=repo.apply('output-attempt',store.capture('separate','Separate readable note','cli').block,{summary:'Separated',source:{disposition:'file',text:'Readable note'},notes:[{text:'Deleted output\nUniquely cobaltaceous'}],tasks:[],updates:[]});
 store.delete(item.outputIds[0]!);
 expect(searchInboxHistory(store,'cobaltaceous').matches).toHaveLength(0);
 for(let i=0;i<85;i++)repo.fail('common-'+i,store.capture('common-source-'+i,'Common receipt '+i,'cli').block,'Fixture');
 const candidates=searchInboxHistory(store,'common');
 expect(candidates.matches).toHaveLength(80);expect(candidates.completeness.kind).toBe('truncated');
 expect(visibleInboxSearch(candidates)).toMatchObject({matches:expect.any(Array),completeness:{kind:'truncated',limit:30}});
 expect(visibleInboxSearch(candidates).matches).toHaveLength(30);
 expect(searchInboxHistory(store,'no-matching-vocabulary-here').matches).toHaveLength(0);
});

test('Jev failure retains typed receipt targets and exact matches bypass ranking',async()=>{
 const{store,repo}=fixture();const source=store.capture('source','Terminal drawing idea','cli').block;repo.fail('attempt',source,'Fixture');
 const candidates=searchInboxHistory(store,'terminal');
 const ranked=await rankSearchWithJev('terminal',candidates,{apiKey:'fixture',fetch:async()=>{throw new Error('provider private content');}});
 expect(ranked.matches).toEqual(candidates.matches);expect(ranked.semantic.status).toBe('unavailable');expect(JSON.stringify(ranked.semantic)).not.toContain('private content');
 const exact=searchInboxHistory(store,'attempt');
 expect(await rankSearchWithJev('attempt',exact,{apiKey:'fixture',fetch:async()=>{throw new Error('must not rank');}})).toEqual(exact);
});

test('production RPC validates queries and returns whole-history receipt search without mutation',async()=>{
 const{store,repo,dir}=fixture();const source=store.capture('capture','A searchable receipt','cli').block;repo.fail('attempt',source,'Fixture');
 const server=new OutlinerServer(store,join(dir,'socket'));
 try{
 const sequence=store.sequence;
 const response=await server.handleAsync({id:'search',action:'inbox.search',query:'searchable',semantic:false});
 expect(response).toMatchObject({ok:true,result:{matches:[{result:{id:'attempt'}}]}});
 expect(store.sequence).toBe(sequence);
 expect(await server.handleAsync({id:'invalid',action:'inbox.search',query:'a'.repeat(501)})).toMatchObject({ok:false});
 }finally{await server.close();}
});
