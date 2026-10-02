import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {visibleWidth} from '@earendil-works/pi-tui';
import {OutlinerClient} from '../../src/client';
import {OutlinerServer} from '../../src/server';
import {OutlinerStore} from '../../src/store';
import type {Block,BrowsingContextState} from '../../src/types';
import type {InboxStatus} from '../../src/inbox-types';
import {runHerdrScenario} from './herdr-runner';
let sourceId='',outputId='',rawId='',original='';
const result=await runHerdrScenario({name:'capture-history',
 // Preview's Open is a menu action; this journey pins it to the bar.
 uiConfig:{bar:{preview:['tree.preview.right','tree.preview.bottom','tree.preview.auto','tree.preview.close','tree.reader.open']}},
 async prepare(projectRoot,paths){
 await mkdir(paths.stateDir,{recursive:true});
 const store=new OutlinerStore(paths.database,{workspaceRoot:projectRoot}),server=new OutlinerServer(store,paths.socket),client=new OutlinerClient(paths.socket);
 try{
  await server.start();
  const receipt=await client.request<{block:Block}>({action:'capture.create',source:'cli',requestId:'raw-capture',text:'RAW CAPTURE [tag::original]\n\nUntidy original wording 日本語\n\n'+('Long original paragraph.\n\n'.repeat(30))});
  sourceId=receipt.block.id;original=receipt.block.text;
  server.enableInbox(async()=>({plan:{summary:'Cleaned and split fixture',source:{text:'CLEANED NOTE\n\nClear useful wording.',disposition:'file'},notes:[{text:'EXTRACTED NOTE\n\nOne useful idea.'}],tasks:[],updates:[]},usage:{provider:'fixture',model:'fixture',inputTokens:0,outputTokens:0,cost:0,jevCalls:0,elapsedMs:0}}));
  for(let i=0;i<200;i++){
   const status=await client.request<InboxStatus>({action:'inbox.status'});
   if(status.results.length&&!status.current){outputId=status.results[0]!.outputIds[0]!;rawId=(await client.request<Block>({action:'get',blockId:sourceId})).properties.find(p=>p.key==='raw-capture')!.value;return;}
   await Bun.sleep(50);
  }throw Error('Fixture cleanup did not finish');
 }finally{await server.close();store.close();}
},async run(s){
 const terminal=await s.attachClient();await terminal.resize(180,65);
 const panes=await s.openRemoteBrowsingContext({name:'raw-capture'});
 const tree=(await s.registrations()).find(c=>c.runtime?.paneId===panes.tree)!;
 const detail=(await s.registrations()).find(c=>c.runtime?.paneId===panes.detail)!;
 const click=async(label:string)=>{
  const frame=await s.waitFor('attached '+label,terminal.visible,t=>t.includes(label));
  const lines=frame.split('\n'),row=lines.findIndex(line=>line.includes(label));
  const column=visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf(label)))+2;
  await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<0;${column+1};${row+1}m`);
 };
 for(const [id,title] of [[sourceId,'CLEANED NOTE'],[outputId,'EXTRACTED NOTE']] as const){
  await s.focus(panes.tree);await s.revealTree(panes.tree,id);
  await s.waitVisible(panes.tree,'Original capture');
  const before=await s.client.request<BrowsingContextState>({action:'browsing-context.get',contextId:tree.contextId!});
  await s.checkpoint('discover-'+title);
  await click('Original capture');await s.waitVisible(panes.tree,'Untidy original wording');
  assert.deepEqual(await s.client.request({action:'browsing-context.get',contextId:tree.contextId!}),before);
  await s.checkpoint('original-'+title);
  await s.keys(panes.tree,'alt+left');await s.waitVisible(panes.tree,'Preview · '+title);
 }
 await terminal.resize(120,55);await s.waitVisible(panes.tree,'Original capture');
 await s.keys(panes.tree,'tab','enter');await s.waitVisible(panes.tree,'Untidy original wording');
 await s.checkpoint('narrow-keyboard-original');
 await click('[Open]');await s.waitVisible(panes.detail,'Untidy original wording');
 await s.waitFor('original Resource is Current',s.registrations,cs=>cs.some(c=>c.clientId===detail.clientId&&c.currentTarget?.kind==='resource'&&c.currentTarget.resourceId===rawId));
 const description=await s.client.request<{computed:{markdown:string}}>({action:'resources.describe',destinationClientId:detail.clientId,target:{kind:'resource',resourceId:rawId}});
 assert.equal(description.computed.markdown,original);
 await s.checkpoint('detail-original');
 await s.focus(panes.tree);
 await s.revealTree(panes.tree,sourceId);
 await s.waitVisible(panes.tree,'● Preview');await s.keys(panes.tree,'alt+p');await s.waitVisible(panes.tree,'○ Preview');
 await s.setKeybindings({'tree.authored-links.toggle':['Alt+J']});
 await s.keys(panes.tree,'ctrl+r');await s.waitVisible(panes.tree,'Keymap and bars reloaded');
 await s.keys(panes.tree,'alt+j');await s.waitVisible(panes.tree,'Resources');
 await s.waitVisible(panes.tree,'Before this rewrite');
 await s.checkpoint('authored-history-resources');
 await s.closeDetached(panes.detail);await s.closeDetached(panes.tree);
}});console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
