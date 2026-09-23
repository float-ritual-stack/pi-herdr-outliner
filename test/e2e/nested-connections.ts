import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import type {Block} from '../../src/types';
import {runHerdrScenario} from './herdr-runner';
const result=await runHerdrScenario({
 name:'nested-connections',async prepare(){},async run(session){
  const a=await session.client.request<Block>({action:'create',text:'CONNECTION ALPHA'});
  const b=await session.client.request<Block>({action:'create',text:`CONNECTION BETA\n\n((${a.id}|Return to Alpha))`});
  const updated=await session.client.request<Block>({action:'update',blockId:a.id,text:`CONNECTION ALPHA\n\n((${b.id}|Go to Beta))`,expectedRevision:a.revision,mutation:{author:'agent',actorId:'nested-connections-fixture'}});
  await session.revealTree(session.panes.tree,a.id);
  await session.setKeybindings({'tree.root.focus':['Alt+F'],'tree.authored-links.toggle':['Alt+J'],'tree.preview.toggle':['Alt+H']});
  await session.keys(session.panes.tree,'ctrl+r');await session.waitVisible(session.panes.tree,'Outliner keymap reloaded');
  await session.keys(session.panes.tree,'alt+f');await session.waitVisible(session.panes.tree,'Focused branch:');
  await session.keys(session.panes.tree,'alt+j');await session.waitVisible(session.panes.tree,'Backlinks');
  const terminal=await session.attachClient();await terminal.resize(260,80);await session.focus(session.panes.tree);
  const clickArrow=async(label:string)=>{
   const coordinate=(text:string)=>{
    const lines=text.split('\n'), row=lines.findIndex(l=>l.includes(label)&&l.includes('▸'));
    const anchor=lines.findIndex(l=>l.includes('Outliner  '));if(row<0||anchor<0)return null;
    const column=visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf('▸')));
    const left=visibleWidth(lines[anchor]!.slice(0,lines[anchor]!.indexOf('Outliner  ')));
    return{row,column,y:row-anchor,x:column-left};
   };
   const ready=await session.waitFor('native disclosure '+label,async()=>({native:coordinate(await terminal.visible()),pane:coordinate(await session.visible(session.panes.tree))}),v=>!!v.native&&!!v.pane&&v.native.x===v.pane.x&&v.native.y===v.pane.y);
   const {row,column}=ready.native!;await session.record('click disclosure',{label,row,column});
   await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<0;${column+1};${row+1}m`);
  };
  await clickArrow('Go to Beta');await session.waitVisible(session.panes.tree,'Preview · CONNECTION BETA');await session.keys(session.panes.tree,'down','down');await session.waitVisible(session.panes.tree,'Return to Alpha');
  await session.checkpoint('nested-outlinks-and-backlinks');
  // Disclosure selects Beta. Walk through its Outlinks header to Alpha, then expand by keyboard.
  await session.keys(session.panes.tree,'right');
  const cyclic=await session.waitFor('explicit cycle',()=>session.visible(session.panes.tree),text=>text.split('Go to Beta →').length===3);
  assert.ok(cyclic.includes('Backlinks'));
  await session.checkpoint('manual-cycle');
  await session.keys(session.panes.tree,'left');
  await session.waitFor('cycle collapsed',()=>session.visible(session.panes.tree),text=>text.split('Go to Beta →').length===2);
  await session.keys(session.panes.tree,'right');await session.waitFor('cycle reopened',()=>session.visible(session.panes.tree),text=>text.split('Go to Beta →').length===3);
  assert.equal((await session.client.request<Block>({action:'get',blockId:a.id})).text,updated.text);
  assert.equal((await session.client.request<Block>({action:'get',blockId:b.id})).text,b.text);
  await session.checkpoint('reopened-read-only');
 }
});
console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
