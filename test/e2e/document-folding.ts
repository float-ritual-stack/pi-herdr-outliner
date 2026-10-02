import assert from 'node:assert/strict';
import {visibleWidth} from '@earendil-works/pi-tui';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Block} from '../../src/types';
import {annotationSourceHash,createTextQuoteAnchor} from '../../src/annotations';
import {runHerdrScenario} from './herdr-runner';

const result = await runHerdrScenario({name:'document-folding', async prepare(){}, async run(s){
  const terminal = await s.attachClient();
  await terminal.resize(180,65);
  let source = await s.client.request<Block>({action:'create',text:[
    'FOLDING PLAN', '', '## First section ▾', 'Intro paragraph',
    '- [ ] Parent item', '  - Nested destination ^step', '',
    '## Other section', 'Other content', '',
    '> [!note]- Saved callout', '> Callout body',
  ].join('\n')});
  source = await s.client.request<Block>({action:'update',blockId:source.id,expectedRevision:source.revision,
    mutation:{author:'agent',actorId:'document-folding-fixture'},
    text:source.text.replace('FOLDING PLAN','FOLDING PLAN\n\n[Jump within note](pi-outliner://block/'+source.id+'?fragment=step)')});
  const registrations = await s.registrations();
  const tree = registrations.find(c=>c.runtime?.paneId===s.panes.tree)!;
  const detail = registrations.find(c=>c.runtime?.paneId===s.panes.detail)!;
  const start=source.text.indexOf('Nested destination');
  const hash=annotationSourceHash(source.text);
  await s.client.request({action:'annotations.create',requestId:crypto.randomUUID(),input:{source:'agent',body:'REVIEW NESTED ITEM',target:{
    representation:{id:`block:${source.id}:${hash}`,subject:{kind:'block',blockId:source.id},sourceSnapshot:{kind:'block',blockId:source.id,updatedAt:source.updatedAt,contentHash:hash},adapter:{id:'outliner.block-text',version:1},mediaType:'text/markdown',contentHash:hash,capturedAt:source.updatedAt},
    anchor:createTextQuoteAnchor(source.text,start,start+'Nested destination'.length),
  }}});
  const open = async(fragmentId?:string)=>s.client.request({action:'navigation.dispatch',sourceClientId:tree.clientId,sourceRegion:'tree',intent:'open',target:{kind:'block',blockId:source.id,...fragmentId?{fragmentId}:{}},destination:{clientId:detail.clientId,region:'detail'}});
  await open();await s.focus(s.panes.detail);
  await s.waitVisible(s.panes.detail,'Nested destination');
  const point = async(label:string,pane=s.panes.detail,anchor='● Current')=>{
    const relative=(frame:string)=>{
      const rows=frame.split('\n'), anchorRow=rows.findIndex(line=>line.includes(anchor)), labelRow=rows.findIndex((line,index)=>index>anchorRow&&line.includes(label));
      if(labelRow<0||anchorRow<0)return null;
      return [labelRow-anchorRow,visibleWidth(rows[labelRow]!.slice(0,rows[labelRow]!.indexOf(label)))-visibleWidth(rows[anchorRow]!.slice(0,rows[anchorRow]!.indexOf(anchor)))].join(':');
    };
    // xterm can briefly retain reflowed old rows after a resize. Compare with
    // the application's own settled geometry before sending real pointer input.
    const settled=await s.waitFor('settled fold control '+label,async()=>({frame:await terminal.visible(),pane:await s.visible(pane)}),value=>relative(value.frame)!==null&&relative(value.frame)===relative(value.pane));
    const frame=settled.frame;
    const lines=frame.split('\n'), anchorRow=lines.findIndex(line=>line.includes(anchor)), row=lines.findIndex((line,index)=>index>anchorRow&&line.includes(label));
    const column=visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf(label)));
    return {column,row};
  };
  const click = async(label:string,pane=s.panes.detail,anchor='● Current')=>{
    const {column,row}=await point(label,pane,anchor);
    await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<0;${column+1};${row+1}m`);
  };
  const copyHeading=async(pane=s.panes.detail,anchor='● Current',endExclusive=false)=>{
    const label='▾ First section ▾';
    const {column,row}=await point(label,pane,anchor);
    const transcript=join(s.artifactDirectory,'attached-client.ansi');
    const before=(await readFile(transcript,'utf8')).length;
    const end=column+label.length+(endExclusive?1:0);
    await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<32;${end};${row+1}M\x1b[<0;${end};${row+1}m`);
    const copies=await s.waitFor('heading clipboard output',async()=>[...(await readFile(transcript,'utf8')).slice(before).matchAll(/\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)/g)].map(match=>Buffer.from(match[1]!,'base64').toString()),values=>values.length>0);
    assert.deepEqual(copies,['First section ▾'],'Copy omits generated disclosure, not authored glyphs');
  };
  await s.checkpoint('01-expanded-plan');
  await copyHeading();
  assert.ok((await s.visible(s.panes.detail)).includes('Nested destination'),'Drag must not fold');
  await s.keys(s.panes.detail,'?');
  await s.text(s.panes.detail,'Detail chrome');
  await s.keys(s.panes.detail,'enter');
  await s.waitVisible(s.panes.detail,'Opens in:');
  await copyHeading();
  await s.keys(s.panes.detail,']');
  await s.waitVisible(s.panes.detail,'REVIEW NESTED ITEM');
  await s.checkpoint('01b-expanded-density-comment-and-copy');
  await s.keys(s.panes.detail,'?');
  await s.text(s.panes.detail,'Detail chrome');
  await s.keys(s.panes.detail,'enter');
  await s.waitFor('compact after comment',()=>s.visible(s.panes.detail),f=>!f.includes('Opens in:'));
  await click('▾ Parent item');
  await s.waitFor('nested list hidden',()=>s.visible(s.panes.detail),f=>f.includes('Parent item')&&!f.includes('Nested destination'));
  await click('First section');
  await s.waitFor('section hidden',()=>s.visible(s.panes.detail),f=>f.includes('First section')&&!f.includes('Parent item'));
  await s.checkpoint('02-folded-section');
  // Pointer activation focuses its disclosure; Enter uses the registry action.
  await s.keys(s.panes.detail,'enter');
  await s.waitFor('nested choice retained',()=>s.visible(s.panes.detail),f=>f.includes('Parent item')&&!f.includes('Nested destination'));
  await terminal.resize(100,55);
  await s.waitVisible(s.panes.detail,'Parent item');
  await s.checkpoint('03-narrow-nested-choice');
  await click('Other section');
  await s.waitFor('unrelated section folded',()=>s.visible(s.panes.detail),f=>!f.includes('Other content'));
  await s.keys(s.panes.detail,']');
  await s.waitVisible(s.panes.detail,'REVIEW NESTED ITEM');
  await s.waitVisible(s.panes.detail,'Nested destination');
  assert.ok(!(await s.visible(s.panes.detail)).includes('Other content'));
  await s.checkpoint('03b-comment-revealed');
  await click('First section');
  await s.waitFor('first section folded again',()=>s.visible(s.panes.detail),f=>!f.includes('Nested destination'));
  await open('step');
  await s.waitVisible(s.panes.detail,'Nested destination');
  assert.equal((await s.client.request<Block>({action:'get',blockId:source.id})).revision,source.revision);
  assert.equal((await s.client.request<Block>({action:'get',blockId:source.id})).text,source.text);
  await s.checkpoint('04-fragment-revealed');
  // The existing Tree hosts an independent local Preview beside this Detail.
  await terminal.resize(220,90);
  const local={tree:s.panes.tree};
  await s.focus(local.tree);await s.revealTree(local.tree,source.id);
  const previewText=async()=>{const frame=await s.visible(local.tree);const start=frame.indexOf('Preview ·');return start<0?'':frame.slice(start);};
  await s.waitFor('independent Preview starts expanded',previewText,f=>f.includes('Nested destination')&&f.includes('Other content'));
  await s.keys(local.tree,'alt+p');
  await s.waitVisible(local.tree,'● Preview ·');
  await s.waitFor('attached Preview focus',()=>terminal.visible(),f=>f.includes('● Preview ·'));
  await copyHeading(local.tree,'● Preview ·',true);
  assert.ok((await previewText()).includes('Nested destination'),'Preview drag must not fold');
  await click('First section',local.tree,'Preview ·');
  await s.waitFor('local Preview folded',previewText,f=>f.includes('First section')&&!f.includes('Nested destination'));
  await s.keys(local.tree,'enter');
  await s.waitFor('local Preview reopens with Enter',previewText,f=>f.includes('Nested destination'));
  await click('Other section',local.tree,'● Preview ·');
  await s.waitFor('Preview unrelated section folded',previewText,f=>!f.includes('Other content'));
  await click('First section',local.tree,'● Preview ·');
  await s.waitFor('Preview target hidden',previewText,f=>!f.includes('Nested destination'));
  await click('Jump within note',local.tree,'● Preview ·');
  await s.waitFor('Preview fragment revealed in context',previewText,f=>f.includes('Nested destination')&&f.includes('Other section')&&!f.includes('Other content'));
  // Local Preview state must not reopen the unrelated fold in Detail.
  assert.ok(!(await s.visible(s.panes.detail)).includes('Other content'));
  await s.checkpoint('05-independent-preview');
  const changed=await s.client.request<Block>({action:'update',blockId:source.id,expectedRevision:source.revision,mutation:{author:'agent',actorId:'document-folding-fixture'},text:source.text.replace('## First section ▾','## Changed section')});
  await s.waitVisible(s.panes.detail,'Changed section');
  await s.waitVisible(s.panes.detail,'Other content');
  assert.equal(changed.revision,source.revision+1);
  await s.checkpoint('06-edited-source-fails-open');
}});
console.log(JSON.stringify(result));
if(result.status!=='passed')process.exitCode=1;
