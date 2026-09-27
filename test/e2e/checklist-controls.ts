import assert from 'node:assert/strict';
import {visibleWidth} from '@earendil-works/pi-tui';
import type {Block,ChecklistCollection} from '../../src/types';
import {runHerdrScenario} from './herdr-runner';

const ansi=process.argv.includes('--ansi');
const detailAnchor=ansi?'Current [Note]':'● Current';
const result=await runHerdrScenario({name:`checklist-controls-${ansi?'ansi':'pi'}`,detailRenderer:ansi?'ansi':'pi-tui',async prepare(){},async run(s){
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
    await s.record('checklist-pointer',{pane,anchor,label,row,column,screen:settled.screen,paneText:settled.pane});
    await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<0;${column+1};${row+1}m`);
  };
  await s.checkpoint('01-readable-plan');
  await click(s.panes.detail,detailAnchor,'[ ]');
  await s.waitVisible(s.panes.detail,'Checklist step');
  await s.waitVisible(s.panes.detail,'Mark done');
  await s.checkpoint('01b-status-menu');
  await s.keys(s.panes.detail,'escape');
  await s.waitFor('Detail picker dismissed',()=>s.visible(s.panes.detail),frame=>frame.includes('Prepare release')&&!frame.includes('Checklist step'));
  assert.equal((await canonical()).revision,source.revision);
  await click(s.panes.detail,detailAnchor,'[ ]');
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
  await click(s.panes.detail,detailAnchor,'[x]');
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
  const host=await s.client.request<Block>({action:'create',text:`# EMBEDDED PLAN\n\nKeep the original instructions available.\n\n!((${source.id}^${assigned.itemId}))\n\nSecond view:\n\n!((${source.id}^${assigned.itemId}))`});
  await s.revealTree(s.panes.tree,host.id);await s.keys(s.panes.tree,'alt+enter');
  await s.waitVisible(s.panes.detail,'Second view:');
  await click(s.panes.detail,detailAnchor,'[~]');await s.waitVisible(s.panes.detail,'Checklist step');
  await s.keys(s.panes.detail,'enter');await s.waitFor('embedded Detail update',status,item=>item.status==='done');
  await s.waitFor('both embedded copies refresh',()=>s.visible(s.panes.detail),frame=>(frame.match(/\[x\][^\n]*Prepare release/g)??[]).length===2);
  assert.equal((await s.client.request<Block>({action:'get',blockId:host.id})).text,host.text);
  await s.keys(s.panes.detail,'ctrl+z');await s.waitFor('embedded Detail Undo',status,item=>item.status==='waiting');
  await s.waitFor('embedded Detail Undo paint',()=>s.visible(s.panes.detail),frame=>/\[~\][^\n]*Prepare release/.test(frame));
  await s.checkpoint('05a-embedded-detail-canonical-update');
  await s.focus(s.panes.tree);await s.revealTree(s.panes.tree,host.id);
  await s.waitVisible(s.panes.tree,'● Preview · # EMBEDDED PLAN');
  await click(s.panes.tree,'● Preview · # EMBEDDED PLAN','[~]');await s.waitVisible(s.panes.tree,'Checklist step');
  await s.keys(s.panes.tree,'enter');await s.waitFor('embedded Preview update',status,item=>item.status==='done');
  await s.waitFor('embedded Preview paint',()=>s.visible(s.panes.tree),frame=>/\[x\][^\n]*Prepare release/.test(frame));
  await s.waitFor('embedded Detail subscription paint',()=>s.visible(s.panes.detail),frame=>/\[x\][^\n]*Prepare release/.test(frame));
  assert.equal((await s.client.request<Block>({action:'get',blockId:host.id})).revision,host.revision);
  await s.checkpoint('05b-embedded-preview-canonical-update');
  const queryPlan=await s.client.request<Block>({action:'create',text:'# QUERY SOURCE [project::query-test]\n\nKeep this safety instruction with the plan.\n\n- [ ] Prepare sample [owner::alex] ^sample\n- [~] Wait on someone else [owner::sam]\n  - Context\n    - [!] Inspect sample [owner::alex] ^inspect'});
  const queryView=await s.client.request<Block>({action:'create',text:'# QUERY VIEW\n[type::checklist-view] [plans::project=query-test] [query::owner=alex] [exclude-status::done] [limit::10]'});
  await s.revealTree(s.panes.tree,queryView.id);await s.keys(s.panes.tree,'alt+enter');
  await s.waitVisible(s.panes.detail,'2 matched steps');
  await s.waitVisible(s.panes.detail,'Inspect sample');
  await s.checkpoint('05c-live-query-results');
  await click(s.panes.detail,detailAnchor,'[ ]');await s.waitVisible(s.panes.detail,'Checklist step');
  await s.keys(s.panes.detail,'enter');
  await s.waitFor('query control changes original',()=>s.client.request<Block>({action:'get',blockId:queryPlan.id}),b=>b.text.includes('[x] Prepare sample'));
  await s.waitVisible(s.panes.detail,'1 matched step');
  await s.waitVisible(s.panes.tree,'1 matched step');
  assert.equal((await s.client.request<Block>({action:'get',blockId:queryView.id})).revision,queryView.revision);
  await s.keys(s.panes.detail,'ctrl+z');await s.waitVisible(s.panes.detail,'2 matched steps');
  await s.focus(s.panes.tree);
  await click(s.panes.tree,'● Preview · # QUERY VIEW','[!]');await s.waitVisible(s.panes.tree,'Checklist step');
  await s.keys(s.panes.tree,'enter');
  await s.waitFor('nested projected status changes original',()=>s.client.request<Block>({action:'get',blockId:queryPlan.id}),b=>b.text.includes('    - [x] Inspect sample'));
  await s.waitVisible(s.panes.tree,'1 matched step');await s.waitVisible(s.panes.detail,'1 matched step');
  await s.checkpoint('05d-query-update-both-readers');
  {
    const longPlan=await s.client.request<Block>({action:'create',text:[
      'OFFSCREEN CHECKLIST','',...Array.from({length:50},(_,i)=>`Context paragraph ${i+1}. ${"Supporting context remains part of the plan. ".repeat(6)}\n`),
      '- [ ] Last destination ^last',
    ].join('\n')});
    await s.revealTree(s.panes.tree,longPlan.id);await s.keys(s.panes.tree,'alt+enter');
    await s.waitVisible(s.panes.detail,'Context paragraph 1.');
    assert.ok(!(await s.visible(s.panes.detail)).includes('Last destination'));
    await s.focus(s.panes.detail);
    // The only checkbox starts outside the viewport. Tab must reveal its real
    // control before Space can change it, without scrolling source text by hand.
    for(let i=0;i<8;i++) {
      await s.keys(s.panes.detail,'tab');
      if((await s.visible(s.panes.detail)).includes('Last destination'))break;
    }
    await s.waitVisible(s.panes.detail,'Last destination');
    await s.keys(s.panes.detail,'space');
    await s.waitFor('offscreen keyboard mutation',()=>s.client.request<Block>({action:'get',blockId:longPlan.id}),b=>b.text.includes('[x] Last destination'));
    await s.waitVisible(s.panes.detail,'Last destination');
    await s.waitVisible(s.panes.detail,'[x] Last destination');
    await s.checkpoint('06-keyboard-focus-reveals-offscreen-task');
    await terminal.resize(125,55);
    await s.waitFor('focused task follows resize',()=>s.visible(s.panes.detail),frame=>frame.includes('[x] Last destination')&&Math.max(...frame.split('\n').map(visibleWidth))<60);
    await s.checkpoint('06a-focused-task-after-resize');
    await s.keys(s.panes.detail,'ctrl+z');
    await s.waitFor('offscreen Undo',()=>s.client.request<Block>({action:'get',blockId:longPlan.id}),b=>b.text===longPlan.text);
    await s.waitVisible(s.panes.detail,'[ ] Last destination');
    await s.revealTree(s.panes.tree,source.id);await s.keys(s.panes.tree,'alt+enter');
    await s.waitVisible(s.panes.detail,'Prepare release');
    const reader=(await s.registrations()).find(c=>c.runtime?.paneId===s.panes.detail)!;
    await s.client.request({action:'ui.command.send',command:{command:'open',targetClientId:reader.clientId,
      target:{kind:'block',blockId:longPlan.id,fragmentId:'last'}}});
    await s.waitFor('resolved fragment is visible',()=>s.visible(s.panes.detail),frame=>frame.split('\n').some(row=>row.includes('[ ] Last destination')&&!row.includes('^last')));
    await s.checkpoint('07-fragment-reveals-wrapped-item');
  }
  await s.record('coverage',{input:'Attached-terminal pointer and injected keys',physicalKeyboard:false,
    current:await canonical(),item:await status()});
}});
console.log(JSON.stringify(result));
if(result.status!=='passed')process.exitCode=1;
