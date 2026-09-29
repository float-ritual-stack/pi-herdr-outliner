import assert from 'node:assert/strict';
import {visibleWidth} from '@earendil-works/pi-tui';
import type {Block} from '../../src/types';
import {runHerdrScenario} from './herdr-runner';

// An embedded note whose title has parentheses must not take the host's links
// with it: every reference, above or inside the embed, stays clickable.
const result=await runHerdrScenario({name:'embed-links',async prepare(){},async run(s){
 const terminal=await s.attachClient();await terminal.resize(200,70);
 const first=await s.client.request<Block>({action:'create',text:'DAY ONE LIST'});
 const alpha=await s.client.request<Block>({action:'create',text:'ALPHA TARGET'});
 const bravo=await s.client.request<Block>({action:'create',text:'BRAVO EMBED\n\nBravo body.'});
 const rough=await s.client.request<Block>({action:'create',text:[
  'ROUGH EDGES (2026-09-29)','',
  '- [x] Write `((uuid))` to link, or `((uuid|label))` to name it ^link-syntax',
  '- [!] **Embeds** like `!((b8f38120-0000-4000-8000-00000000abcd|doing))` ignore labels ^embed-label',
  '- [ ] Ticket titles like `((PC-1027: thanks Kim; follow up))` are not references ^q-missing-query',
  `- [ ] See ((${first.id}|FIRST LIST LABEL)) for the first list ^first-list`,'',
  '[type::test-plan]',
 ].join('\n')});
 const host=(last:string)=>s.client.request<Block>({action:'create',text:
  `JAZZHANDS HOST\nhost-marker-line\n\n((${alpha.id}))\n\n!((${bravo.id}))\n\n${last}`});
 const referenced=await host(`((${rough.id}))`),embedded=await host(`!((${rough.id}))`);
 const detail=(await s.registrations()).find(c=>c.runtime?.paneId===s.panes.detail)!;
 const tree=(await s.registrations()).find(c=>c.runtime?.paneId===s.panes.tree)!;
 await s.client.request({action:'navigation.link.set',source:{clientId:detail.clientId,region:'detail'},destination:null});
 const open=async(block:Block)=>{
  await s.client.request({action:'navigation.dispatch',sourceClientId:tree.clientId,sourceRegion:'tree',intent:'open',target:{kind:'block',blockId:block.id},destination:{clientId:detail.clientId,region:'detail'}});
  await s.waitVisible(s.panes.detail,'host-marker-line');await s.waitVisible(s.panes.detail,'ROUGH EDGES');await s.focus(s.panes.detail);
 };
 const locate=(text:string,label:string)=>{
  const rows=text.split('\n'),row=rows.findIndex(line=>line.includes(label));
  return row<0?null:{row,column:visibleWidth(rows[row]!.slice(0,rows[row]!.indexOf(label)))};
 };
 // Place the label through the Detail pane's own frame, anchored on a line only Detail shows.
 const click=async(label:string)=>{
  const {native,pane}=await s.waitFor(`attached ${label}`,async()=>({native:await terminal.visible(),pane:await s.visible(s.panes.detail)}),
   ({native,pane})=>!!locate(native,'host-marker-line')&&!!locate(pane,label)&&!!locate(pane,'host-marker-line'));
  const anchor=locate(native,'host-marker-line')!,paneAnchor=locate(pane,'host-marker-line')!,target=locate(pane,label)!;
  const row=anchor.row+target.row-paneAnchor.row,column=anchor.column+target.column-paneAnchor.column+1;
  await s.record(`click-${label}`,{row,column});
  await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<0;${column+1};${row+1}m`);
 };
 const chooser=async(why:string)=>{
  await s.waitFor(why,()=>s.visible(s.panes.detail),text=>text.includes('Enter: Open here'));
  await s.keys(s.panes.detail,'escape');
  await s.waitFor(`${why} closed`,()=>s.visible(s.panes.detail),text=>!text.includes('Enter: Open here'));
 };
 // Enter opens the clicked target here: the host leaves Detail and the target's own text shows.
 const opens=async(why:string,shows:string)=>{
  await s.waitFor(why,()=>s.visible(s.panes.detail),text=>text.includes('Enter: Open here'));
  await s.keys(s.panes.detail,'enter');
  await s.waitFor(`${why}: opened`,()=>s.visible(s.panes.detail),text=>!text.includes('host-marker-line')&&text.includes(shows));
 };
 const targets:Record<string,string>={'ALPHA TARGET':'ALPHA TARGET','ROUGH EDGES (2026-09-29)':'Ticket titles like','FIRST LIST LABEL':'DAY ONE LIST'};
 for(const [name,block] of [['referenced',referenced],['embedded',embedded]] as const){
  await open(block);
  await s.checkpoint(`${name}-open`);
  for(const label of ['ALPHA TARGET','ROUGH EDGES (2026-09-29)',...(name==='embedded'?['FIRST LIST LABEL']:[])]){
   await click(label);
   await opens(`${name}: click ${label} opens it`,targets[label]!);
   await s.checkpoint(`${name}-opened-${label.split(' ')[0]!.toLowerCase()}`);
   await open(block);
  }
  // Keyboard: the first body link takes focus and Enter offers its destination.
  await s.keys(s.panes.detail,'tab');
  await s.keys(s.panes.detail,'enter');
  await chooser(`${name}: Tab then Enter offers a destination`);
  await s.checkpoint(`${name}-links-clickable`);
 }
 assert.equal((await s.client.request<Block>({action:'get',blockId:embedded.id})).text,embedded.text);
}});console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
