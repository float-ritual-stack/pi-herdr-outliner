import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createAssistantMessageEventStream,type AssistantMessage} from '@earendil-works/pi-ai';
import {OutlinerStore} from '../../src/store';
import {OutlinerServer} from '../../src/server';
import {OutlinerClient} from '../../src/client';
import {createInboxModel} from '../../src/inbox-model';
import type {InboxStatus} from '../../src/inbox-types';
import type {CaptureReceipt} from '../../src/types';
import {runHerdrScenario} from './herdr-runner';

const result=await runHerdrScenario({name:'inbox-plan-repair',async prepare(projectRoot,paths){
 await mkdir(paths.stateDir,{recursive:true});const agentDir=join(paths.stateDir,'agent');await mkdir(agentDir);
 await writeFile(join(agentDir,'settings.json'),JSON.stringify({defaultProvider:'openai',defaultModel:'gpt-4.1',defaultThinkingLevel:'off'}));
 await writeFile(join(agentDir,'auth.json'),JSON.stringify({openai:{type:'api_key',key:'fixture-only'}}));
 const store=new OutlinerStore(paths.database,{workspaceRoot:projectRoot});const server=new OutlinerServer(store,paths.socket);const client=new OutlinerClient(paths.socket);
 let repairing=false;
 try{
  await server.start();store.configureWorkIdPrefix('PIE');store.create('Work queue [type::work-queue] [project::pi-outliner]');
  server.enableInbox(createInboxModel({workspaceRoot:projectRoot,agentDir,jevApiKey:'',maxTurns:3,sessionDirectory:join(paths.stateDir,'assistant-sessions'),stream(_model,context){
   const last=context.messages.at(-1)!;const failed=last.role==='toolResult'&&last.isError;
   const arguments_=last.role==='user'?{query:'repair fixture'}:{summary:'Filed corrected note and allocated task',source:{text:'Repair fixture source\nUseful source remains.',disposition:'file'},notes:[{text:repairing&&failed?'Design note [type::note]':'Wrong note [type::field-note]'}],tasks:[{title:'Repair fixture task',body:'A concrete task from the capture',priority:'medium',project:'pi-outliner',arc:'navigation',tracks:['daily-use']}],updates:[]};
   const message:AssistantMessage={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-4.1',content:[{type:'toolCall',id:crypto.randomUUID(),name:last.role==='user'?'search_notes':'finish_cleanup',arguments:arguments_}],stopReason:'toolUse',timestamp:Date.now(),usage:{input:20,output:20,cacheRead:0,cacheWrite:0,totalTokens:40,cost:{input:0.001,output:0.001,cacheRead:0,cacheWrite:0,total:0.002}}};
   const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'toolUse',message});stream.end();return stream;
  }}));
  const receipt=await client.request<CaptureReceipt>({action:'capture.create',requestId:'repair',source:'cli',text:'Repair fixture source\nUseful source remains.'});
  const settled=async(count:number)=>{for(let i=0;i<300;i++){const status=await client.request<InboxStatus>({action:'inbox.status'});if(status.results.length===count&&!status.current)return status;await Bun.sleep(20);}throw Error('Fixture did not settle');};
  const failed=await settled(1);assert.equal(failed.results[0]!.failureKind,'validation');assert.equal(failed.paused,false);assert.equal(store.require(receipt.block.id).revision,1);
  assert.equal((store.database.query("SELECT COUNT(*) AS n FROM block_properties WHERE key='work-id'").get() as {n:number}).n,0);
  repairing=true;await client.request({action:'inbox.retry',sourceId:receipt.block.id});
  const success=await settled(2);assert.equal(success.results[0]!.state,'applied');assert.equal(success.results[0]!.attempt?.trigger,'reconsider');assert.equal(success.results[0]!.attempt?.prior?.id,failed.results[0]!.id);
  assert.equal((store.database.query("SELECT COUNT(*) AS n FROM block_properties WHERE key='work-id'").get() as {n:number}).n,1);
  const saved=success.results[0]!.usage!.piSessions!;assert.equal(saved.length,1);
  const log=await readFile(saved[0]!.path!,'utf8');assert.ok(log.includes('notes[0].text'));assert.ok(log.includes('Design note'));
 }finally{await server.close();store.close();}
},async run(session){
 const terminal=await session.attachClient();const tree=session.panes.tree;
 await session.keys(tree,'I');await session.waitVisible(tree,'Inbox agent');await session.keys(tree,'A');
 await session.waitVisible(tree,'Trigger: reconsider');await session.waitVisible(tree,'Prior attempt:');
 await session.checkpoint('01-repaired-with-prior-attempt');
 await session.keys(tree,'down');await session.keys(tree,'A');await session.waitVisible(tree,'Failure: validation');
 await session.checkpoint('02-rejected-proposal-retained');
 await session.keys(tree,'up');await session.keys(tree,'s');
 await session.waitFor('source preview',terminal.visible,text=>text.includes('Useful source remains.'));
 await session.checkpoint('03-source-remains-readable');
 await session.record('results',await session.client.request({action:'inbox.status'}));
}});console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
