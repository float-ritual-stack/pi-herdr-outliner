import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OutlinerStore} from '../src/store';
import {MentionRepository,MENTION_MESSAGE_LIMIT} from '../src/mentions';
import {codexMentionMessage} from '../src/mentions-codex';
import {MentionsNavigator} from '../src/mentions-navigator';
import type {RequestInput} from '../src/client';
import type {MentionMessage} from '../src/mentions-types';
const cleanup:Array<()=>void>=[];afterEach(()=>{while(cleanup.length)cleanup.pop()!();});
function setup(){
 const root=mkdtempSync(join(tmpdir(),'mentions-'));let store=new OutlinerStore(join(root,'db.sqlite'),{workspaceRoot:root});
 cleanup.push(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 let repo=new MentionRepository(store,root);
 const message=(text:string,messageId='one',sessionId='session'):MentionMessage=>({workspaceRoot:root,agent:'codex',sessionId,messageId,text});
 return{root,get store(){return store;},get repo(){return repo;},message,reopen(){store.close();store=new OutlinerStore(join(root,'db.sqlite'),{workspaceRoot:root});repo=new MentionRepository(store,root);}};
}
test('mentions resolve canonical references, deduplicate targets and delivery, retain context and do not mutate notes',()=>{
 const f=setup();f.store.configureWorkIdPrefix('PIE');
 const a=f.store.create('Alpha [page::alpha]'),b=f.store.create('Beta');f.store.allocateWorkId(a.id,a.revision);
 const before=f.store.queryBlocks({limit:1000}).blocks.length;
 const receipt=f.repo.ingest(f.message(`Read [[alpha]], PIE-001 and ((${a.id})); also ${b.id}, and [[missing]].`));
 expect(f.repo.list().entries.map(e=>e.block?.id??e.address)).toEqual([a.id,b.id,'missing']);
 expect(f.repo.ingest(f.message(`Read [[alpha]], PIE-001 and ((${a.id})); also ${b.id}, and [[missing]].`)).deduplicated).toBe(true);
 expect(()=>f.repo.ingest(f.message('Different'))).toThrow('different text');
 f.repo.ingest(f.message(b.id,'two'));expect(f.repo.list().entries[0]?.block?.id).toBe(b.id);
 expect(f.repo.message(receipt.messageKey).text).toContain('Read [[alpha]]');
 expect(f.store.queryBlocks({limit:1000}).blocks.length).toBe(before);expect(f.store.get(a.id)?.text).toContain('Alpha');
});
test('workspace and conversation scope, retention, restart, clear and explicit save',()=>{
 const f=setup(),a=f.store.create('Alpha');
 expect(()=>f.repo.ingest({...f.message(a.id),workspaceRoot:'/another-workspace'})).toThrow('workspace');
 f.repo.ingest(f.message(a.id,'one','older'));
 for(let i=0;i<MENTION_MESSAGE_LIMIT;i++)f.repo.ingest(f.message(a.id,`next-${i}`,'newer'));
 expect(f.repo.list().retention.messages).toBe(MENTION_MESSAGE_LIMIT);
 expect(f.repo.list({agent:'codex',sessionId:'older'}).entries).toHaveLength(0);
 f.reopen();const latest=f.repo.list().entries[0]!;
 const save=f.repo.save(latest.messageKey);expect(save.block.text).toContain(a.id);expect(f.repo.save(latest.messageKey).deduplicated).toBe(true);
 expect(f.repo.clear({agent:'codex',sessionId:'newer'}).removed).toBe(MENTION_MESSAGE_LIMIT);
 expect(f.repo.list().entries).toHaveLength(0);expect(f.store.get(a.id)).not.toBeNull();
});
test('empty answers are not retained; missing, deleted and truncated results stay visible',()=>{
 const f=setup();f.repo.ingest(f.message('No references here'));expect(f.repo.list().retention.messages).toBe(0);
 const a=f.store.create('Alpha');f.repo.ingest(f.message(a.id,'target'));f.store.delete(a.id);
 expect(f.repo.list().entries[0]?.unavailableReason).toBeDefined();
 f.repo.ingest(f.message(Array.from({length:110},(_,i)=>`[[missing-${i}]]`).join(' '),'bounded'));
 const found=f.repo.list(undefined,10);expect(found.entries).toHaveLength(10);expect(found.completeness.kind).toBe('truncated');expect(found.notChecked.length).toBe(1);
});
test('Codex adapters admit only completed responses in explicitly enabled workspaces',()=>{
 const payload={type:'agent-turn-complete',cwd:'/workspace','thread-id':'session','turn-id':'turn','last-assistant-message':'[[alpha]]'};
 expect(codexMentionMessage(payload,['/workspace'])).toMatchObject({agent:'codex',messageId:'turn',text:'[[alpha]]'});
 expect(codexMentionMessage(payload,['/elsewhere'])).toBeNull();
 expect(codexMentionMessage({...payload,type:'tool_call'},['/workspace'])).toBeNull();
 expect(codexMentionMessage({hook_event_name:'Stop',cwd:'/workspace',session_id:'session',turn_id:'turn',last_assistant_message:'[[alpha]]'},['/workspace'])).toMatchObject({messageId:'turn'});
});
test('mention navigator uses canonical Preview and has explicit context, scope and save controls',async()=>{
 const f=setup(),a=f.store.create('Alpha\n\nActual body');f.repo.ingest(f.message(a.id));
 const navigator=new MentionsNavigator({async request<T>(input:RequestInput):Promise<T>{
  if(input.action==='mentions.list')return f.repo.list(input.scope,input.limit) as T;
  if(input.action==='mentions.message')return f.repo.message(input.messageKey) as T;
  if(input.action==='mentions.clear')return f.repo.clear(input.scope) as T;
  if(input.action==='mentions.save')return f.repo.save(input.messageKey) as T;
  if(input.action==='get')return f.store.get(input.blockId) as T;
  if(input.action==='references.resolve')return f.store.resolveBlockReferences(input.text) as T;
  if(input.action==='pages.resolve')return f.store.resolvePageAddress(input.address) as T;
  throw Error(input.action);
 }});
 const projection=await navigator.projection(),row=projection.rows[0]!;
 await navigator.commands.find(c=>c.key==='m')!.run(row);
 expect((await navigator.preview(row)).document.projectedText).toContain('Completed message');
 expect((await navigator.preview(row)).target?.target).toEqual({kind:'block',blockId:a.id});
 await navigator.commands.find(c=>c.key==='s')!.run(row);expect((await navigator.projection()).title).toContain('codex conversation');
 await navigator.commands.find(c=>c.key==='v')!.run(row);expect(f.store.queryBlocks({limit:1000}).blocks.some(b=>b.text.startsWith('Conversation excerpt'))).toBe(true);
});

test('bare unrelated UUIDs are ignored and unresolved page mentions resolve after registration',()=>{
 const f=setup();f.repo.ingest(f.message('Session 00000000-0000-0000-0000-000000000001'));
 expect(f.repo.list().entries).toHaveLength(0);
 f.repo.ingest(f.message('See [[later-page]]','later'));
 expect(f.repo.list().entries[0]?.block).toBeNull();
 const target=f.store.create('Later [page::later-page]');
 expect(f.repo.list().entries[0]?.block?.id).toBe(target.id);
});
