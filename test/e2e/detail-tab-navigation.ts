import assert from 'node:assert/strict';
import {visibleWidth} from '@earendil-works/pi-tui';
import type {Block} from '../../src/types';
import {runHerdrScenario} from './herdr-runner';
const composed=process.argv.includes('--composed');
const result=await runHerdrScenario({name:composed?'detail-tab-composed':'detail-tab',layout:composed?'composed':'separate',async prepare(){},async run(s){
 const terminal=await s.attachClient();await terminal.resize(180,60);
 const destination=await s.client.request<Block>({action:'create',text:'KEYBOARD DESTINATION\n\nArrived through the document body.'});
 const raw=['KEYBOARD SOURCE','[owner::evan]', '',...Array.from({length:70},(_,i)=>`Reading paragraph ${i}\n`),`[Late body link](pi-outliner://block/${destination.id})`].join('\n');
 const source=await s.client.request<Block>({action:'create',text:raw});
 const detail=(await s.registrations()).find(c=>c.runtime?.paneId===s.panes.detail)!;
 const tree=(await s.registrations()).find(c=>c.runtime?.paneId===s.panes.tree)!;
 await s.client.request({action:'navigation.link.set',source:{clientId:detail.clientId,region:'detail'},destination:null});
 const open=async(block:Block)=>{
  if(composed){await s.revealTree(s.panes.tree,block.id);await s.keys(s.panes.tree,'enter');}
  else await s.client.request({action:'navigation.dispatch',sourceClientId:tree.clientId,sourceRegion:'tree',intent:'open',target:{kind:'block',blockId:block.id},destination:{clientId:detail.clientId,region:'detail'}});
  await s.waitVisible(s.panes.detail,block.text.split('\n')[0]!);await s.focus(s.panes.detail);
 };
 await open(source);
 await s.checkpoint('01-before-body-focus');
 // Inline Properties is the first stop; the visible body link follows it.
 await s.keys(s.panes.detail,'tab','tab');await s.waitVisible(s.panes.detail,'Late body link');
 await s.checkpoint('02-body-link-focus-scroll');
 await s.keys(s.panes.detail,'enter');await s.waitVisible(s.panes.detail,'Enter: Open here');
 await s.keys(s.panes.detail,'enter');await s.waitVisible(s.panes.detail,'Arrived through the document body.');
 await s.waitFor('canonical body destination',s.registrations,cs=>cs.some(c=>c.clientId===detail.clientId&&c.currentTarget?.kind==='block'&&c.currentTarget.blockId===destination.id));
 assert.equal((await s.client.request<Block>({action:'get',blockId:source.id})).text,raw);
 await s.checkpoint('03-body-link-open');
 await open(source);
 await s.keys(s.panes.detail,'tab','tab');
 const mouseFrame=await s.waitFor('attached body link',terminal.visible,text=>text.includes('Late body link'));
 const mouseRows=mouseFrame.split('\n'),row=mouseRows.findIndex(line=>line.includes('Late body link'));
 const column=visibleWidth(mouseRows[row]!.slice(0,mouseRows[row]!.indexOf('Late body link')))+2;
 await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<0;${column+1};${row+1}m`);
 await s.waitVisible(s.panes.detail,'Enter: Open here');
 await s.keys(s.panes.detail,'escape');
 await s.waitFor('cancel returns to source',()=>s.visible(s.panes.detail),text=>text.includes('Late body link')&&!text.includes('Enter: Open here'));
 assert.ok((await s.registrations()).some(c=>c.clientId===detail.clientId&&c.currentTarget?.kind==='block'&&c.currentTarget.blockId===source.id));
 await s.checkpoint('03b-mouse-link-and-cancel');
 const properties=await s.client.request<Block>({action:'create',text:['PROPERTY FOCUS',...Array.from({length:24},(_,i)=>`[field-${i}::value-${i}]`),'','Body remains after the table.'].join('\n')});
 await open(properties);await s.keys(s.panes.detail,'tab','enter');await s.waitVisible(s.panes.detail,'field-0');
 for(let i=0;i<24;i++)await s.keys(s.panes.detail,'tab');
 await s.waitVisible(s.panes.detail,'value-23');await s.checkpoint('04-property-focus-scroll');
 await terminal.resize(120,45);
 // Resize returns before the attached terminal's new geometry has propagated.
 // wait-output can match the old frame; await the reflowed, focused entry instead.
 await s.waitFor('reflowed focused property after resize',()=>s.visible(s.panes.detail),text=>
  text.includes('L25:C') && (composed ? text.includes('│ ▶       │') :
   text.includes('● Current') && /│\s*│\s*│ L25:C1/.test(text)));
 await s.checkpoint('05-narrow-focused-property');
}});console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
