import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {visibleWidth} from '@earendil-works/pi-tui';
import type {Block} from '../../src/types';
import {runHerdrScenario} from './herdr-runner';
const composed=process.argv.includes('--composed');
const result=await runHerdrScenario({name:composed?'local-markdown-composed':'local-markdown',layout:composed?'composed':'separate',async prepare(root){
 await writeFile(join(root,'project.md'),'# PROJECT FILE\n\n> [!summary] File context\n> Read alongside the daily note.\n\n[[FILE LINK TARGET]]\n');
},async run(s){
 const terminal=await s.attachClient();await terminal.resize(220,65);
 const target=await s.client.request<Block>({action:'create',text:'FILE LINK TARGET [page::FILE LINK TARGET]\n\nArrived from Markdown.'});
 const source=await s.client.request<Block>({action:'create',text:'DAILY NOTE\n\nPersonal thoughts before the reference.\n\nRead [file::project.md] alongside this note.\n\nContinue writing here.'});
 // Enter keeps Tree focus since PIE-364; Alt+Enter opens and focuses Detail.
 await s.revealTree(s.panes.tree,source.id);await s.keys(s.panes.tree,'alt+enter');await s.waitVisible(s.panes.detail,'Continue writing here.');await s.focus(s.panes.detail);
 if(composed)await s.waitFor('Detail region focused',s.registrations,entries=>entries.some(c=>c.runtime?.paneId===s.panes.detail&&c.focusedRegion==='detail'));
 const detail=(await s.registrations()).find(c=>c.runtime?.paneId===s.panes.detail)!;
 const click=async(label:string)=>{
  const frame=await s.waitFor('native '+label,terminal.visible,t=>t.includes(label)),lines=frame.split('\n');
  // Choose the Detail occurrence to the right of a same-named Tree row.
  // Compact chrome (PIE-385) puts the title in the frame; the header reads "● Current".
  const currentRow=lines.findIndex(line=>/[●○] Current( ·| \[)/u.test(line));
  assert.ok(currentRow>=0);
  const currentCol=visibleWidth(lines[currentRow]!.slice(0,lines[currentRow]!.search(/[●○] Current( ·| \[)/u)))-2;
  const match=lines.flatMap((line,row)=>line.includes(label)?[{row,col:visibleWidth(line.slice(0,line.lastIndexOf(label)))+2}]:[])
   .filter(point=>composed?point.col>=currentCol:point.row>=currentRow)
   .sort((a,b)=>b.col-a.col||b.row-a.row)[0]!;
  const {row,col}=match;
  await terminal.write(`\x1b[<0;${col+1};${row+1}M\x1b[<0;${col+1};${row+1}m`);
 };
 await s.checkpoint('01-daily-note');
 await s.keys(s.panes.detail,'tab','tab','enter');await s.waitVisible(s.panes.detail,'PROJECT FILE');
 assert.ok((await s.registrations()).some(c=>c.clientId===detail.clientId&&c.currentTarget?.kind==='block'&&c.currentTarget.blockId===source.id));
 await s.waitVisible(s.panes.detail,'File context');await s.checkpoint('02-keyboard-file-preview');
 await s.keys(s.panes.detail,'escape');await s.waitFor('Preview closed',()=>s.visible(s.panes.detail),t=>!t.includes('PROJECT FILE')&&t.includes('Continue writing here.'));
 await s.waitFor('attached Preview closed',terminal.visible,t=>!t.includes('PROJECT FILE'));
 await click('project.md');await s.waitVisible(s.panes.detail,'PROJECT FILE');
 await s.checkpoint('03-mouse-file-preview');
 // Use the existing explicit destination route for a link in the file.
 await s.client.request({action:'navigation.link.set',source:{clientId:detail.clientId,region:'detail'},destination:{clientId:detail.clientId,region:'detail'}});
 await click('FILE LINK TARGET');await s.waitVisible(s.panes.detail,'Arrived from Markdown.');
 await s.waitFor('file link Current destination',s.registrations,cs=>cs.some(c=>c.clientId===detail.clientId&&c.currentTarget?.kind==='block'&&c.currentTarget.blockId===target.id));
 assert.equal((await s.client.request<Block>({action:'get',blockId:source.id})).text,source.text);
 await s.checkpoint('04-file-link-open');
}});console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
