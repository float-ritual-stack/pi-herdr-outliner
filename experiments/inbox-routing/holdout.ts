import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {OutlinerStore} from '../../src/store';
import {InboxWorker} from '../../src/inbox-worker';
import {createNoteModel} from '../../src/note-assistance-model';
if(!process.argv.includes('--live'))throw Error('Pass --live to send synthetic holdout notes to Jev');
const root=await mkdtemp(join(tmpdir(),'inbox-routing-holdout-'));console.log(root);
const cases=JSON.parse(await readFile(new URL('./holdout.json',import.meta.url),'utf8')) as Array<{id:string;text:string;expected:string[];useful:boolean}>;
const rows:unknown[]=[];
for(const item of cases){
 const store=new OutlinerStore(join(root,item.id+'.sqlite'));let escalated=false;
 const worker=new InboxWorker(store,async({source})=>{escalated=true;return {plan:{summary:'Holdout: Pi route observed, no Pi invocation',source:{text:source.text,disposition:'file'},notes:[],tasks:[],updates:[]},usage:{provider:'fixture',model:'no-Pi-holdout',inputTokens:0,outputTokens:0,jevCalls:0,elapsedMs:0,cost:0}};},()=>{},{settleMs:1,noteModel:createNoteModel({workspaceRoot:root,stream:()=>{throw Error('Unexpected executable request in synthetic holdout');}})});
 const source=store.capture(item.id,item.text,'cli').block;
 try{
  worker.wake();for(let i=0;i<200;i++){if(worker.repository.results().length&&!worker.status().current)break;await Bun.sleep(100);}
  const result=worker.repository.results()[0];const row={...item,escalated,state:result?.state,error:result?.error,routing:result?.routing,usage:result?.usage?{...result.usage,promptRevisions:result.usage.promptRevisions?.map(({text,...p})=>p)}:null};rows.push(row);console.log(JSON.stringify({id:item.id,state:row.state,route:row.routing?.route}));
 }finally{await worker.stop();store.close();}
 await writeFile(join(root,'results.json'),JSON.stringify(rows,null,2));
}
