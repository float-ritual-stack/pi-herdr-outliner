import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {visibleWidth} from '@earendil-works/pi-tui';
import {OutlinerClient} from '../../src/client';
import {OutlinerServer} from '../../src/server';
import {OutlinerStore} from '../../src/store';
import type {Block} from '../../src/types';
import type {InboxStatus} from '../../src/inbox-types';
import {runHerdrScenario} from './herdr-runner';

let sourceId='',targetId='';
const result=await runHerdrScenario({
 name:'open-here',
 async prepare(projectRoot,paths){
  await mkdir(paths.stateDir,{recursive:true});
  const store=new OutlinerStore(paths.database,{workspaceRoot:projectRoot});
  const server=new OutlinerServer(store,paths.socket);const client=new OutlinerClient(paths.socket);
  try{
   await server.start();
   const target=await client.request<Block>({action:'create',text:'PREVIEW DESTINATION\n\n> [!summary] Destination content\n> Followed inside the local reader.'});targetId=target.id;
   const receipt=await client.request<{block:Block}>({action:'capture.create',source:'cli',requestId:'preview-links-source',text:`PREVIEW ORIGIN\n\n[Follow destination](pi-outliner://block/${targetId})\n\n${'Paragraph to scroll and copy.\n\n'.repeat(30)}`});sourceId=receipt.block.id;
   server.enableInbox(async({source})=>({plan:{summary:'Retained linked fixture',source:{text:source.text,disposition:'file'},notes:[],tasks:[],updates:[]},usage:{provider:'fixture',model:'fixture',inputTokens:0,outputTokens:0,cost:0,jevCalls:0,elapsedMs:0}}));
   for(let i=0;i<200;i++){
    const status=await client.request<InboxStatus>({action:'inbox.status'});
    if(status.results.length&&!status.current)return;
    await Bun.sleep(50);
   }
   throw Error('Fixture receipt did not finish');
  }finally{await server.close();store.close();}
 },
 async run(session){
  const panes=await session.openRemoteBrowsingContext({name:'open-here'});
  const tree=(await session.registrations()).find(c=>c.runtime?.paneId===panes.tree)!;
  const detail=(await session.registrations()).find(c=>c.runtime?.paneId===panes.detail)!;
  await session.client.request({action:'navigation.link.set',source:{clientId:tree.clientId,region:'tree'},destination:null});
  await session.client.request({action:'navigation.link.set',source:{clientId:detail.clientId,region:'detail'},destination:null});
  const terminal=await session.attachClient();await terminal.resize(190,70);
  const click=async(pane:string,label:string)=>{
   await session.focus(pane);await session.waitVisible(pane,label);
   const point=(text:string)=>{
     const lines=text.split('\n'), row=lines.findIndex(line=>line.includes(label));
     const anchorText=pane===panes.detail?'● Current':text.includes('Inbox agent')?'Inbox agent':'Outliner  ';
     const anchor=lines.findIndex(line=>line.includes(anchorText));
     if(row<0||anchor<0)return null;
     const column=visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf(label)));
     const left=visibleWidth(lines[anchor]!.slice(0,lines[anchor]!.indexOf(anchorText)));
     return{row,column,relativeRow:row-anchor,relativeColumn:column-left};
   };
   const ready=await session.waitFor('native '+label,async()=>({native:point(await terminal.visible()),pane:point(await session.visible(pane))}),v=>!!v.native&&!!v.pane&&v.native.relativeRow===v.pane.relativeRow&&v.native.relativeColumn===v.pane.relativeColumn);
   const {row}=ready.native!, column=ready.native!.column+2;
   await session.record('click '+label,{row,column});
   await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<0;${column+1};${row+1}m`);
  };
  await session.focus(panes.tree);await session.revealTree(panes.tree,sourceId);
  await session.waitVisible(panes.tree,'Follow destination');
  await click(panes.tree,'Follow destination');await session.waitVisible(panes.tree,'Preview · PREVIEW DESTINATION');
  await click(panes.tree,'[Open]');await session.waitVisible(panes.tree,'Enter: Open here');
  const unchanged=(await session.registrations()).find(c=>c.clientId===detail.clientId)!.currentTarget;
  await session.checkpoint('tree-missing-destination');
  await click(panes.tree,'Enter: Open here');
  await session.waitFor('recovery dismissed',()=>session.visible(panes.tree),text=>!text.includes('Enter: Open here')&&text.includes('Preview · PREVIEW DESTINATION'));
  assert.deepEqual((await session.registrations()).find(c=>c.clientId===detail.clientId)!.currentTarget,unchanged);
  await session.keys(panes.tree,'alt+left');await session.waitVisible(panes.tree,'Preview · PREVIEW ORIGIN');
  await session.keys(panes.tree,'alt+right');await session.waitVisible(panes.tree,'Preview · PREVIEW DESTINATION');
  await session.keys(panes.tree,'alt+p');
  await session.waitFor('Tree focus restored',()=>session.visible(panes.tree),text=>text.includes('○ Preview'));
  await session.keys(panes.tree,'I');await session.waitVisible(panes.tree,'Inbox agent');
  await session.keys(panes.tree,'alt+enter');await session.waitVisible(panes.tree,'Enter: Open here');
  await session.keys(panes.tree,'enter');await session.waitFor('Inbox recovery in place',()=>session.visible(panes.tree),text=>!text.includes('Enter: Open here')&&text.includes('Inbox agent')&&text.includes('PREVIEW ORIGIN'));
  await session.checkpoint('inbox-open-here');
  await session.keys(panes.tree,'alt+p');await session.waitFor('Inbox list focus',()=>session.visible(panes.tree),text=>text.includes('○ Preview'));
  await session.keys(panes.tree,'esc');await session.waitFor('Inbox closed',()=>session.visible(panes.tree),text=>!text.includes('Inbox agent')); 
  await session.client.request({action:'navigation.dispatch',sourceClientId:tree.clientId,intent:'open',target:{kind:'block',blockId:sourceId},destination:{clientId:detail.clientId,region:'detail'}});
  await session.waitVisible(panes.detail,'Follow destination');
  // Close Preview so the native authored link label is unique to Detail.
  await click(panes.tree,'[Hide Preview]');
  await session.waitFor('Tree Preview hidden',()=>session.visible(panes.tree),text=>!text.includes('Preview ·'));
  await session.focus(panes.detail);
  await click(panes.detail,'Follow destination');await session.waitVisible(panes.detail,'Enter: Open here');
  assert.deepEqual((await session.registrations()).find(c=>c.clientId===detail.clientId)!.currentTarget,{kind:'block',blockId:sourceId});
  await session.checkpoint('detail-before-confirmation');
  await click(panes.detail,'Enter: Open here');await session.waitVisible(panes.detail,'Destination content');
  assert.deepEqual((await session.registrations()).find(c=>c.clientId===detail.clientId)!.currentTarget,{kind:'block',blockId:targetId});
  for(const [clientId,region] of [[tree.clientId,'tree'],[detail.clientId,'detail']] as const){
    const link=await session.client.request<{destination:unknown}>({action:'navigation.link.get',source:{clientId,region}});assert.equal(link.destination,null);
  }
  await session.checkpoint('detail-confirmed-no-link');
 }
});
console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
