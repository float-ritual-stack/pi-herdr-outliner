import assert from 'node:assert/strict';
import {visibleWidth} from '@earendil-works/pi-tui';
import type {AnnotationThread,Block,ChecklistCollection} from '../../src/types';
import {runHerdrScenario} from './herdr-runner';

const ansi=process.argv.includes('--ansi');
const result=await runHerdrScenario({name:`checklist-comments-${ansi?'ansi':'pi'}`,detailRenderer:ansi?'ansi':'pi-tui',async prepare(){},async run(s){
  const terminal=await s.attachClient();await terminal.resize(190,70);
  const note=await s.client.request<Block>({action:'create',text:'# CHECKLIST COMMENTS\n\n1. [ ] Prepare release\n2. [ ] Verify results'});
  const read=()=>s.client.request<Block>({action:'get',blockId:note.id});
  const comments=()=>s.client.request<AnnotationThread[]>({action:'annotations.list',query:{subject:{kind:'block',blockId:note.id},includeResolved:true}});
  const click=async(pane:string,anchor:string,label:string)=>{
    const locate=(frame:string)=>{const rows=frame.split('\n'),a=rows.findIndex(row=>row.includes(anchor));
      const row=rows.findIndex((text,index)=>index>a&&text.includes(label));
      return a<0||row<0?null:{row,column:visibleWidth(rows[row]!.slice(0,rows[row]!.indexOf(label))),a,
        origin:visibleWidth(rows[a]!.slice(0,rows[a]!.indexOf(anchor)))};};
    const frame=await s.waitFor('settled comment target',async()=>({screen:await terminal.visible(),pane:await s.visible(pane)}),value=>{
      const screen=locate(value.screen),local=locate(value.pane);
      return !!screen&&!!local&&screen.row-screen.a===local.row-local.a&&screen.column-screen.origin===local.column-local.origin;
    });
    const point=locate(frame.screen)!;await s.record("checklist-comment-pointer",{pane,anchor,label,point,frame:frame.screen});
    await terminal.write(`\x1b[<0;${point.column+1};${point.row+1}M\x1b[<0;${point.column+1};${point.row+1}m`);
  };
  await s.revealTree(s.panes.tree,note.id);await s.keys(s.panes.tree,'alt+enter');await s.waitVisible(s.panes.detail,'Prepare release');
  await click(s.panes.detail,ansi?'Current [Note]':'● Current','[ ]');
  await s.waitVisible(s.panes.detail,'Checklist step');await s.keys(s.panes.detail,'escape');
  await s.waitFor('status picker closed',()=>s.visible(s.panes.detail),frame=>frame.includes('Prepare release')&&!frame.includes('Checklist step'));
  await s.keys(s.panes.detail,'c');await s.waitVisible(s.panes.detail,ansi?'⌃S save':'Ctrl+S');await s.keys(s.panes.detail,'escape');
  await s.waitFor('comment cancellation painted',()=>s.visible(s.panes.detail),frame=>frame.includes('Comment cancelled')&&!frame.includes(ansi?'⌃S save':'Ctrl+S'));
  assert.equal((await read()).revision,note.revision,'Cancelling a comment must not assign an ID');
  await s.keys(s.panes.detail,'c');await s.waitVisible(s.panes.detail,ansi?'⌃S save':'Ctrl+S');
  await s.text(s.panes.detail,'CHECKLIST COMMENT EVIDENCE');await s.keys(s.panes.detail,'ctrl+s');
  const created=await s.waitFor('item comment saved',comments,threads=>threads.length===1);
  assert.ok(created[0]!.originalTarget.listItemId,'Focused checkbox comment must attach to that item');
  const itemId=created[0]!.originalTarget.listItemId!;
  assert.equal(created[0]!.originalTarget.anchor.kind,'text-quote');
  const saved=await read();assert.equal(saved.text,note.text.replace('Prepare release',`Prepare release ^${itemId}`));
  await s.keys(s.panes.detail,']');await s.waitVisible(s.panes.detail,'CHECKLIST COMMENT EVIDENCE');
  await s.waitVisible(s.panes.detail,'Checklist passage');await s.checkpoint('01-comment-on-step');
  await s.client.request({action:'update',blockId:note.id,expectedRevision:saved.revision,mutation:{author:'agent',actorId:'checklist-journey'},
    text:`# CHECKLIST COMMENTS\n\n1. [ ] Prepare release\n7. [x] Assemble the package ^${itemId}`});
  await s.waitFor('item identity after reword',comments,threads=>threads[0]?.resolvedTarget?.anchor.kind==='list-item');
  await s.keys(s.panes.detail,']');await s.waitVisible(s.panes.detail,'Item attachment');
  await s.waitVisible(s.panes.detail,'Prepare release');await s.waitVisible(s.panes.detail,'CHECKLIST COMMENT EVIDENCE');
  await s.checkpoint('02-reworded-item-retains-original-quote');
  assert.deepEqual((await comments())[0]!.originalTarget,created[0]!.originalTarget);
  await s.revealTree(s.panes.tree,created[0]!.block.id);await s.keys(s.panes.tree,'alt+enter');
  await s.waitVisible(s.panes.detail,'Stored resolution: resolved');await s.keys(s.panes.detail,'r');
  await s.waitVisible(s.panes.detail,'Opened checklist step');await s.waitVisible(s.panes.detail,'Assemble the package');
  await s.keys(s.panes.detail,']');await s.waitVisible(s.panes.detail,'Item attachment');
  await s.checkpoint('02a-reveal-reworded-item');
  await terminal.resize(125,55);await s.waitFor('narrow geometry applied',()=>s.visible(s.panes.detail),frame=>frame.includes('Item attachment')&&Math.max(...frame.split('\n').map(visibleWidth))<60);await s.checkpoint('03-narrow-item-comment');

  await terminal.resize(190,70);await s.waitFor('wide geometry restored',()=>s.visible(s.panes.detail),frame=>frame.split('\n').length>30);await s.focus(s.panes.tree);await s.revealTree(s.panes.tree,note.id);await s.keys(s.panes.tree,'alt+p');
  await s.waitVisible(s.panes.tree,'● Preview ·');
  await click(s.panes.tree,'● Preview ·','[ ]');await s.waitVisible(s.panes.tree,'Checklist step');await s.keys(s.panes.tree,'escape');
  await s.waitFor('Preview picker closed',()=>s.visible(s.panes.tree),frame=>frame.includes('Prepare release')&&!frame.includes('Checklist step'));
  await s.keys(s.panes.tree,'c');await s.waitVisible(s.panes.tree,'Comment on passage');
  await s.text(s.panes.tree,'PREVIEW STEP COMMENT');await s.keys(s.panes.tree,'ctrl+s');
  const both=await s.waitFor('Preview item comment saved',comments,threads=>threads.length===2);
  const added=both.find(thread=>thread.body==='PREVIEW STEP COMMENT')!;
  assert.ok(added.originalTarget.listItemId);assert.notEqual(added.originalTarget.listItemId,itemId);
  const queried=await s.client.request<ChecklistCollection>({action:'checklist.query',blockId:note.id,query:{limit:10}});
  assert.equal(added.originalTarget.listItemId,queried.items[0]!.itemId);
  await s.keys(s.panes.tree,']');await s.waitVisible(s.panes.tree,'CHECKLIST COMMENT EVIDENCE');
  await s.keys(s.panes.tree,']');await s.waitVisible(s.panes.tree,'PREVIEW STEP COMMENT');await s.waitVisible(s.panes.tree,'Checklist passage');
  assert.ok(!(await s.visible(s.panes.tree)).includes('Unpositioned comments'),'Saving a new step comment must not strand the earlier step comment');
  await s.checkpoint('04-preview-comment-canonical-readback');
}});
console.log(JSON.stringify(result,null,2));
assert.equal(result.status,'passed',result.status==='failed'?result.error:'Checklist comment journey failed');
