import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OutlinerStore} from '../src/store';
import {InboxRepository} from '../src/inbox-repository';
import {captureHistoryResource,captureOriginalResources} from '../src/capture-history';
import {OutlinerServer} from '../src/server';
import {OutlinerClient} from '../src/client';
import {TUI_RESOURCE_PRESENTATION_CONTEXT} from '../src/resource-presentation';
import {authoredResourceReferenceOccurrences} from '../src/resource-references';
import {DocumentPreview} from '../src/document-preview';
import {documentPreviewLinks,documentPreviewLines} from '../src/document-preview-renderer';
import {initTheme} from '@earendil-works/pi-coding-agent';
import type {Block} from '../src/types';
import type {InboxPlan} from '../src/inbox-types';
const fixtures:Array<{root:string,store:OutlinerStore}>=[];
function fixture(){const root=mkdtempSync(join(tmpdir(),'capture-history-')),store=new OutlinerStore(join(root,'db.sqlite'),{workspaceRoot:root});const f={root,store};fixtures.push(f);return f;}
afterEach(()=>{for(const f of fixtures.splice(0)){f.store.close();rmSync(f.root,{recursive:true,force:true});}});
const plan=(changes:Partial<InboxPlan>={}):InboxPlan=>({summary:'Rewritten',source:{disposition:'file',text:'Clean note\n\nUseful content'},notes:[],tasks:[],updates:[],...changes});
const refs=(b:Block,key='raw-capture')=>b.properties.filter(p=>p.key===key).map(p=>p.value);
async function original(store:OutlinerStore,id:string){await store.resources.executeComputedResource(id,true);return store.resources.describe(id,true).computed?.markdown;}

test('rewrite and split share the exact long capture without producing new active notes; survives restart and undo',async()=>{
 const f=fixture();let repository=new InboxRepository(f.store);
 const raw='Original ramble [tag::example]\n\n'+('Some long original wording 日本語\n'.repeat(400));
 const source=f.store.capture('capture',raw,'cli').block;
 const result=repository.apply('first',source,plan({notes:[{text:'First idea'},{text:'Second idea'}]}));
 const cleaned=f.store.require(source.id),id=refs(cleaned)[0]!;
 expect(refs(cleaned,'before-rewrite')).toEqual([id]);
 for(const output of result.outputIds)expect(refs(f.store.require(output))).toEqual([id]);
 expect(await original(f.store,id)).toBe(source.text);
 expect(repository.pending()).toEqual([]);
 expect(f.store.queryBlocks({filters:[{key:'type',value:'capture'}],limit:100}).blocks).toHaveLength(1);
 f.store.close();f.store=new OutlinerStore(join(f.root,'db.sqlite'),{workspaceRoot:f.root});repository=new InboxRepository(f.store);
 expect(await original(f.store,id)).toBe(source.text);
 repository.undo(result.id);
 expect(f.store.require(source.id).text).toBe(source.text);
 expect(await original(f.store,id)).toBe(source.text);
 for(const output of result.outputIds)expect(refs(f.store.require(output))).toEqual([id]);
});

test('a second rewrite keeps original identity and exposes the separate before-image',async()=>{
 const {store}=fixture(),repository=new InboxRepository(store);
 const source=store.capture('capture','Rough thought','cli').block;
 repository.apply('first',source,plan());
 let current=store.require(source.id);const first=refs(current)[0]!;
 current=store.update(current.id,current.text.replace('[status::processed]',''),current.revision);
 store.move(current.id,store.queryBlocks({filters:[{key:"system-view",value:"inbox"}],limit:1}).blocks[0]!.id);current=store.require(current.id);
 repository.apply('second',current,plan({source:{disposition:'file',text:'Better note'}}));
 const rewritten=store.require(current.id),before=refs(rewritten,'before-rewrite')[0]!;
 expect(refs(rewritten)).toEqual([first]);expect(before).not.toBe(first);
 expect(await original(store,first)).toBe(source.text);
 expect(await original(store,before)).toBe(current.text);
});

test('merging preserves both originals and the target before-image',async()=>{
 const {store}=fixture(),repository=new InboxRepository(store);
 const first=store.capture('a','First rough source','cli').block;repository.apply('first',first,plan());
 const target=store.require(first.id),firstOriginal=refs(target)[0]!;
 const incoming=store.capture('b','Second rough source','cli').block;
 repository.apply('merge',incoming,plan({source:{disposition:'archive',text:'Filed into combined note'},updates:[{blockId:target.id,expectedRevision:target.revision,text:'Combined useful content'}]}));
 const merged=store.require(target.id),origins=refs(merged);
 expect(origins).toHaveLength(2);expect(origins).toContain(firstOriginal);
 expect(await Promise.all(origins.map(id=>original(store,id)))).toEqual([first.text,incoming.text]);
 expect(await original(store,refs(merged,'before-rewrite')[0]!)).toBe(target.text);
 expect(refs(store.require(incoming.id))).toEqual([origins[1]!]);
});

test('missing evidence stays visibly unavailable; preserved Resource addresses cannot be retargeted',async()=>{
 const {store}=fixture();new InboxRepository(store);
 const id=captureHistoryResource(store.database,store.resources,'missing','unknown-block');
 await store.resources.executeComputedResource(id,true);
 expect(store.resources.describe(id,true).computedFailure?.message).toContain('No preserved capture');
 const resource=store.resources.get(id)!;expect(resource.provider).toBe('computed');
 if(resource.provider!=='computed')throw Error('Unexpected provider');
 expect(()=>store.resources.reviseComputedInvocation({invocationId:resource.address.invocationId,expectedVersion:1,inputs:{attemptId:'other',blockId:'other'},dependencies:[]})).toThrow('immutable');
});

test('registered Preview follows Original capture through the service, preserves metadata, and returns to clean text',async()=>{
 initTheme(undefined,false);
 const {root,store}=fixture(),repository=new InboxRepository(store),server=new OutlinerServer(store,join(root,'rpc.sock'));
 const source=store.capture('capture','Raw wording [tag::original]\n\nUntidy body','cli').block;
 repository.apply('first',source,plan());const cleaned=store.require(source.id);
 const occurrences=authoredResourceReferenceOccurrences(cleaned.text);
 expect(occurrences.flatMap(o=>o.kind==='authored-resource'&&o.reference.kind==='resource'?[o.label]:[])).toEqual(['Original capture','Before this rewrite']);
 await server.start();const client=new OutlinerClient(join(root,'rpc.sock')),ready=Promise.withResolvers<void>();
 const watcher=client.watch({client:{clientId:'history-reader',role:'detail',contextId:'history',resourcePresentation:TUI_RESOURCE_PRESENTATION_CONTEXT},onConnect:ready.resolve,onEvent(){},onError:ready.reject});
 try {
  await ready.promise;const reader=new DocumentPreview(client,()=>{},'history-reader');
  await reader.load({kind:'block',blockId:source.id});
  const link=documentPreviewLinks(reader.state!.document,100).find(link=>link.label==='Original capture');
  expect(link).toBeDefined();
  await reader.action('preview.link:'+link!.uri,async()=>{});
  expect(reader.state?.document.canonicalText).toBe(source.text);
  expect(documentPreviewLines(reader.state!.document,100).join('\n')).toContain('tag::original');
  await reader.action('preview.back',async()=>{});
  expect(reader.state?.document.canonicalText).toBe(cleaned.text);
 }finally{watcher.stop();await server.close();}
});


test('legacy applied attempts without a before-image never relabel current text as the original',async()=>{
 const {store}=fixture(),repository=new InboxRepository(store);
 const source=store.capture('capture','Actual old wording','cli').block;
 repository.apply('legacy',source,plan());
 store.database.query('UPDATE inbox_agent_results SET recovery_json=NULL WHERE id=?').run('legacy');
 let current=store.require(source.id);
 current=store.update(current.id,current.text.replace(/\s*\[(?:raw-capture|before-rewrite|status)::[^\]]+\]/g,''),current.revision);
 store.move(current.id,store.queryBlocks({filters:[{key:'system-view',value:'inbox'}],limit:1}).blocks[0]!.id);
 current=store.require(current.id);
 repository.apply('new',current,plan());
 const cleaned=store.require(current.id),id=refs(cleaned)[0]!;
 expect(await original(store,id)).toBeUndefined();
 expect(store.resources.describe(id,true).computedFailure?.message).toContain('No preserved capture');
 expect(await original(store,refs(cleaned,'before-rewrite')[0]!)).toBe(current.text);
});


test('legacy split and later merge recover the raw source through saved output lineage',async()=>{
 const {store}=fixture(),repository=new InboxRepository(store);
 const source=store.capture('a','RAW ORIGINAL','cli').block;
 const first=repository.apply('old-split',source,plan({notes:[{text:'SPLIT OUTPUT'}]}));
 let target=store.require(first.outputIds[0]!);
 target=store.update(target.id,target.text.replace(/\s*\[(?:raw-capture|before-rewrite)::[^\]]+\]/g,''),target.revision);
 const incoming=store.capture('b','SECOND RAW SOURCE','cli').block;
 repository.apply('new-merge',incoming,plan({updates:[{blockId:target.id,expectedRevision:target.revision,text:'Combined useful result'}]}));
 const originals=await Promise.all(refs(store.require(target.id)).map(id=>original(store,id)));
 expect(originals).toEqual([source.text,incoming.text]);
});

test('branching legacy lineage reports incomplete evidence before reaching the depth limit',async()=>{
 const {store}=fixture();new InboxRepository(store);
 let previous=[store.create('First original'),store.create('Second original')];
 // Each historical split and merge shares both older ancestors. Eight levels
 // remain below the depth limit but exceed the total receipt inspection budget.
 for(let level=1;level<=8;level++){
  const next=[store.create(`Left ${level}`),store.create(`Right ${level}`)];
  for(const [index,source] of previous.entries()){
   store.database.query('INSERT INTO inbox_agent_results (id,source_id,payload_hash,result_json,recovery_json,created_at) VALUES (?,?,?,?,?,?)')
    .run(`legacy-${level}-${index}`,source.id,'fixture',JSON.stringify({state:'applied',outputIds:next.map(block=>block.id)}),
     JSON.stringify({before:[source,...next],createdIds:index===0?next.map(block=>block.id):[]}),String(level));
  }
  previous=next;
 }
 const originals=captureOriginalResources(store.database,store.resources,previous[0]!,'current');
 const descriptions=await Promise.all(originals.map(async id=>{await original(store,id);return store.resources.describe(id,true);}));
 expect(descriptions.some(description=>description.computedFailure?.code==='lineage-limit')).toBe(true);
 expect(descriptions.find(description=>description.computedFailure?.code==='lineage-limit')?.computedFailure?.message).toContain('not fully identified');
 expect(store.require(previous[0]!.id).text).toBe('Left 8');
});
