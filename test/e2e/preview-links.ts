import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {visibleWidth} from '@earendil-works/pi-tui';
import {OutlinerClient} from '../../src/client';
import {OutlinerServer} from '../../src/server';
import {OutlinerStore} from '../../src/store';
import type {Block,BrowsingContextState} from '../../src/types';
import type {InboxStatus} from '../../src/inbox-types';
import {runHerdrScenario} from './herdr-runner';

let sourceId='',targetId='';
const result=await runHerdrScenario({
 name:'preview-links',
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
  const panes=await session.openRemoteBrowsingContext({name:'preview-links'});
  const tree=(await session.registrations()).find(c=>c.runtime?.paneId===panes.tree)!;
  const detail=(await session.registrations()).find(c=>c.runtime?.paneId===panes.detail)!;
  await session.focus(panes.tree);await session.revealTree(panes.tree,sourceId);
  const terminal=await session.attachClient();
  const point=(text:string,label:string)=>{
   const lines=text.split('\n');const row=lines.findIndex(line=>line.includes(label));
   const anchorText=text.includes('Inbox agent')?'Inbox agent':'Outliner  ';
   const anchor=lines.findIndex(line=>line.includes(anchorText));
   if(row<0||anchor<0)return null;
   const column=visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf(label)))+1;
   const left=visibleWidth(lines[anchor]!.slice(0,lines[anchor]!.indexOf(anchorText)));
   return{row,column,relativeRow:row-anchor,relativeColumn:column-left};
  };
  const click=async(label:string)=>{
   const ready=await session.waitFor(`native ${label}`,async()=>({native:point(await terminal.visible(),label),pane:point(await session.visible(panes.tree),label)}),({native,pane})=>!!native&&!!pane&&native.relativeRow===pane.relativeRow&&native.relativeColumn===pane.relativeColumn);
   const {column,row}=ready.native!;
   await session.record('click-'+label,{column,row});
   await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<0;${column+1};${row+1}m`);
  };
  for(const columns of [180,100]){
   await terminal.resize(columns,70);
   await session.revealTree(panes.tree,sourceId);
   await session.waitFor('origin frame settled',terminal.visible,text=>text.includes('Follow destination')&&text.includes('Preview · PREVIEW ORIGIN'));
   const before=await session.client.request<BrowsingContextState>({action:'browsing-context.get',contextId:tree.contextId!});
   const detailBefore=(await session.registrations()).find(c=>c.clientId===detail.clientId)!.currentTarget;
   await click('Follow destination');
   await session.waitVisible(panes.tree,'Preview · PREVIEW DESTINATION');
   assert.deepEqual(await session.client.request({action:'browsing-context.get',contextId:tree.contextId!}),before);
   assert.deepEqual((await session.registrations()).find(c=>c.clientId===detail.clientId)!.currentTarget,detailBefore);
   await click('[‹]');await session.waitVisible(panes.tree,'Preview · PREVIEW ORIGIN');
   await session.keys(panes.tree,'tab','enter');await session.waitVisible(panes.tree,'Preview · PREVIEW DESTINATION');
   await session.keys(panes.tree,'alt+left');await session.waitVisible(panes.tree,'Preview · PREVIEW ORIGIN');
   await session.keys(panes.tree,'alt+right');await session.waitVisible(panes.tree,'Preview · PREVIEW DESTINATION');
   await click('[Open]');await session.waitVisible(panes.detail,'Destination content');
   await session.checkpoint(`tree-links-${columns}`);
  }
  await session.focus(panes.tree);await terminal.resize(180,70);
  await session.keys(panes.tree,'alt+p','I');await session.waitVisible(panes.tree,'Inbox agent');
  await session.waitVisible(panes.tree,'Follow destination');
  await click('Follow destination');await session.waitVisible(panes.tree,'Preview · Source · current · PREVIEW DESTINATION');
  await click('[‹]');await session.waitVisible(panes.tree,'Follow destination');
  // Dragging a link sends clipboard text and must not navigate.
  const frame=await session.waitFor('native source restored',terminal.visible,text=>text.includes('Follow destination'));const rows=frame.split('\n');const row=rows.findIndex(line=>line.includes('Follow destination'));const column=visibleWidth(rows[row]!.slice(0,rows[row]!.indexOf('Follow destination')));
  await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<32;${column+7};${row+1}M\x1b[<0;${column+7};${row+1}m`);
  await session.waitFor('clipboard text',()=>readFile(join(session.artifactDirectory,'attached-client.ansi'),'utf8'),text=>[...text.matchAll(/\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)/g)].some(match=>Buffer.from(match[1]!,'base64').toString().includes('Follow')));
  assert.ok((await session.visible(panes.tree)).includes('Follow destination'));
  await session.keys(panes.tree,'tab','enter');await session.waitVisible(panes.tree,'PREVIEW DESTINATION');
  await session.keys(panes.tree,'esc');await session.waitFor('Escape returns to Inbox list',()=>session.visible(panes.tree),text=>text.includes('○ Preview')&&!text.includes('● Preview'));
  await session.checkpoint('inbox-click-copy-history');
 }
});
console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
