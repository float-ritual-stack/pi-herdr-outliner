/** Opt-in live comparison: private stores, synthetic notes, normal configured Jev/Pi. */
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {OutlinerStore} from '../../src/store';
import {InboxWorker} from '../../src/inbox-worker';
import {createInboxModel} from '../../src/inbox-model';
import {createNoteModel} from '../../src/note-assistance-model';
import type {InboxResult} from '../../src/inbox-types';

if(!process.argv.includes('--live'))throw Error('Pass --live to spend configured Jev/Pi tokens on the synthetic cases');
const cases=JSON.parse(await readFile(new URL('./cases.json',import.meta.url),'utf8')) as Array<{id:string;text:string;expected:string[];useful:boolean}>;
const evidenceDirectory=process.env.ROUTING_EVIDENCE_DIR?resolve(process.env.ROUTING_EVIDENCE_DIR):tmpdir();
await mkdir(evidenceDirectory,{recursive:true});
const directory=await mkdtemp(join(evidenceDirectory,'inbox-routing-live-'));console.log(directory);
const results:unknown[]=[];
for(const item of cases.filter(item=>!process.env.ROUTING_CASE||item.id===process.env.ROUTING_CASE)){
 await Promise.all(['baseline','trial'].map(async variant=>{
  const root=join(directory,`${item.id}-${variant}`);await mkdir(root,{recursive:true});
  const store=new OutlinerStore(join(root,'outline.sqlite'),{workspaceRoot:root});
  store.configureWorkIdPrefix('PIE');store.create('Work queue [type::work-queue] [project::pi-outliner]');
  const requests:unknown[]=[];
  const options={workspaceRoot:root,sessionDirectory:join(root,'sessions'),fetch:async(url:string,init:RequestInit)=>{
   const response=await fetch(url,init);const body=await response.clone().json();requests.push({request:JSON.parse(String(init.body)),response:body});return response;
  }};
  const note=createNoteModel(options);const editor=createInboxModel(options);let pi=0;
  const worker=new InboxWorker(store,async context=>{pi++;return editor(context);},()=>{},{settleMs:1,noteModel:context=>note(variant==='baseline'?{...context,routeInbox:undefined}:context)});
  const source=store.capture(item.id,item.text,'cli').block;const started=performance.now();
  try{
   worker.wake();let receipt:InboxResult|undefined;
   for(let i=0;i<1800;i++){
    const status=worker.status();receipt=worker.repository.results(30).find(result=>result.sourceId===source.id);
    if(receipt&&!status.current)break;await Bun.sleep(200);
   }
   if(!receipt)throw Error('No receipt within six minutes');
   const final=store.require(source.id);const destination=final.parentId?store.require(final.parentId).text:null;
   const output=receipt.outputIds.map(id=>store.require(id).text);
   const usage=receipt.usage?{...receipt.usage,promptRevisions:receipt.usage.promptRevisions?.map(({text,...revision})=>revision)}:undefined;
   const row={id:item.id,variant,expected:item.expected,useful:item.useful,pi,elapsedMs:Math.round(performance.now()-started),state:receipt.state,error:receipt.error,summary:receipt.summary,routing:receipt.routing,usage,finalText:final.text,destination,output};
   results.push(row);await writeFile(join(root,'judgments.json'),JSON.stringify(requests,null,2));
   console.log(JSON.stringify({id:item.id,variant,state:receipt.state,route:receipt.routing?.route,pi,ms:row.elapsedMs,cost:usage?.cost}));
  }finally{await worker.stop();store.close();}
 }));
 await writeFile(join(directory,'results.json'),JSON.stringify(results,null,2));
}
