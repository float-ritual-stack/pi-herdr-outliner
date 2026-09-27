import assert from 'node:assert/strict';
import {visibleWidth} from '@earendil-works/pi-tui';
import type {Block,ChecklistCollection} from '../../src/types';
import {runHerdrScenario} from './herdr-runner';

const result=await runHerdrScenario({name:'checklist-controls',async prepare(){},async run(s){
  const terminal=await s.attachClient();
  await terminal.resize(190,70);
  const source=await s.client.request<Block>({action:'create',text:[
    'CHECKLIST CONTROLS','','Run once, then record the outcome.','',
    '1. [ ] Prepare release','   - [~] Check dependency ^dependency',
    '2. [ ] Verify release ^verify','3. [x] Build, next: deploy ^build',
    '4. [!] Inspect result ^inspect','5. [ ] Observe ^observe',
    '6. [ ] Close ^close','7. [ ] Record ^record','','Then:',
    '- [Read instructions](https://example.test/guide)',
  ].join('\n')});
  const canonical=()=>s.client.request<Block>({action:'get',blockId:source.id});
  const status=async()=> (await s.client.request<ChecklistCollection>({action:'checklist.query',blockId:source.id,query:{limit:20}})).items[0]!;
  await s.revealTree(s.panes.tree,source.id);
  await s.keys(s.panes.tree,'alt+enter');
  await s.waitVisible(s.panes.detail,'Prepare release');
  await s.focus(s.panes.detail);
  const click=async(pane:string,anchor:string,label:string)=>{
    const relative=(frame:string)=>{
      const rows=frame.split('\n'),a=rows.findIndex(row=>row.includes(anchor));
      const row=rows.findIndex((text,index)=>index>a&&text.includes(label));
      if(a<0||row<0)return null;
      return `${row-a}:${visibleWidth(rows[row]!.slice(0,rows[row]!.indexOf(label)))-visibleWidth(rows[a]!.slice(0,rows[a]!.indexOf(anchor)))}`;
    };
    const settled=await s.waitFor('settled checklist target '+label,async()=>({screen:await terminal.visible(),pane:await s.visible(pane)}),
      frame=>relative(frame.screen)!==null&&relative(frame.screen)===relative(frame.pane));
    const lines=settled.screen.split('\n'),a=lines.findIndex(row=>row.includes(anchor));
    const row=lines.findIndex((text,index)=>index>a&&text.includes(label));
    const column=visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf(label)));
    await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<0;${column+1};${row+1}m`);
  };
  await s.checkpoint('01-readable-plan');
  await click(s.panes.detail,'● Current','[ ]');
  await s.waitVisible(s.panes.detail,'Checklist step');
  await s.waitVisible(s.panes.detail,'Mark done');
  await s.checkpoint('01b-status-menu');
  await s.keys(s.panes.detail,'escape');
  await s.waitFor('Detail picker dismissed',()=>s.visible(s.panes.detail),frame=>frame.includes('Prepare release')&&!frame.includes('Checklist step'));
  assert.equal((await canonical()).revision,source.revision);
  await click(s.panes.detail,'● Current','[ ]');
  await s.waitVisible(s.panes.detail,'Checklist step');
  await s.keys(s.panes.detail,'enter');
  const assigned=await s.waitFor('Detail done persists',status,item=>item.status==='done');
  assert.ok(assigned.itemId);
  assert.equal((await canonical()).text,source.text.replace('1. [ ] Prepare release',`1. [x] Prepare release ^${assigned.itemId}`));
  await s.waitVisible(s.panes.detail,'[x]');
  await s.checkpoint('02-detail-done');
  await s.keys(s.panes.detail,'tab','shift+tab','space');
  await s.waitFor('focused Space toggles',status,item=>item.status==='todo');
  await s.keys(s.panes.detail,'ctrl+z');
  await s.waitFor('Detail Undo restores',status,item=>item.status==='done');
  const wideRows=(await s.visible(s.panes.detail)).split('\n').length;
  await terminal.resize(130,55);
  await s.waitFor('resized Detail content',()=>s.visible(s.panes.detail),frame=>frame.includes('Prepare release')&&frame.split('\n').length<wideRows);
  await click(s.panes.detail,'● Current','[x]');
  await s.waitVisible(s.panes.detail,'Checklist step');
  await s.keys(s.panes.detail,'escape');
  await s.waitFor('Detail picker dismissed',()=>s.visible(s.panes.detail),frame=>frame.includes('Prepare release')&&!frame.includes('Checklist step'));
  assert.equal((await status()).status,'done');
  await s.checkpoint('03-narrow-detail-cancel');

  const narrowRows=(await s.visible(s.panes.detail)).split('\n').length;
  await terminal.resize(210,80);
  await s.waitFor('expanded Detail geometry',()=>s.visible(s.panes.detail),frame=>frame.split('\n').length>narrowRows);
  await s.focus(s.panes.tree);await s.revealTree(s.panes.tree,source.id);
  await s.keys(s.panes.tree,'alt+p');
  await s.waitVisible(s.panes.tree,'● Preview ·');
  await click(s.panes.tree,'● Preview ·','[x]');
  await s.waitVisible(s.panes.tree,'Checklist step');
  await s.keys(s.panes.tree,'escape');
  await s.waitVisible(s.panes.tree,'● Preview ·');
  await click(s.panes.tree,'● Preview ·','[x]');
  await s.waitVisible(s.panes.tree,'Checklist step');
  await s.keys(s.panes.tree,'down','down','enter');
  await s.waitFor('Preview waiting persists',status,item=>item.status==='waiting');
  await s.waitVisible(s.panes.tree,'[~]');
  await s.checkpoint('04-preview-waiting');
  await s.keys(s.panes.tree,'tab','shift+tab','space');
  await s.waitFor('Preview Space toggles',status,item=>item.status==='done');
  await s.keys(s.panes.tree,'ctrl+z');
  await s.waitFor('Preview Undo restores',status,item=>item.status==='waiting');
  assert.equal((await status()).itemId,assigned.itemId);
  await s.waitVisible(s.panes.detail,'[~]');
  await s.checkpoint('05-canonical-update-in-both-readers');
  await s.record('coverage',{input:'Attached-terminal pointer and injected keys',physicalKeyboard:false,
    current:await canonical(),item:await status()});
}});
console.log(JSON.stringify(result));
if(result.status!=='passed')process.exitCode=1;
