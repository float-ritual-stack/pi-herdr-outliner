import assert from 'node:assert/strict';
import {annotationSourceHash,createTextQuoteAnchor} from '../../src/annotations';
import type {Block,AnnotationBatchReceipt} from '../../src/types';
import {runHerdrScenario} from './herdr-runner';
const result=await runHerdrScenario({name:'virtual-branch-attention',async prepare(){},async run(s){
  const terminal=await s.attachClient();await terminal.resize(200,60);const tree=s.panes.tree;
  const create=(text:string,parentId:string|null=null)=>s.client.request<Block>({action:'create',text,parentId});
  const sources=await create('Sources');
  const a=await create('PC-985 fixture\n[fixture::379]',sources.id), b=await create('PC-762 fixture\n[fixture::379]',sources.id);
  const an=await create('Review registration',a.id), bn=await create('Review transfer',b.id);
  const ordinary=await create('Ordinary sibling',a.id);await create('Hidden sibling detail',ordinary.id);
  const annotate=async(note:Block,body:string)=>{
    const contentHash=annotationSourceHash(note.text);
    const representation={id:`block:${note.id}:${contentHash}`,subject:{kind:'block' as const,blockId:note.id},sourceSnapshot:{kind:'block' as const,blockId:note.id,updatedAt:note.updatedAt,contentHash},adapter:{id:'outliner.block-text',version:1},mediaType:'text/markdown',contentHash,capturedAt:note.updatedAt};
    const anchor=createTextQuoteAnchor(note.text,0,note.text.length);
    const r=await s.client.request<AnnotationBatchReceipt>({action:'annotations.create',requestId:crypto.randomUUID(),input:{target:{representation,anchor},body,source:'user'}});
    return r.annotations[0]!;
  };
  const important=await annotate(an,'[priority::high]\nNeeds attention');await annotate(bn,'Ordinary comment');
  const view=await create('Attention view\n[type::virtual-branch] [query::fixture=379] [child-depth::2] [expanded::false] [expand-when::type=annotation annotation-status=open priority=high]');
  const compact=await create('Other compact view\n[type::virtual-branch] [query::fixture=379] [child-depth::2] [expanded::false]');
  await s.setKeybindings({'tree.root.focus':['Alt+F'],'tree.virtual-branch.reset-expansion':['Alt+Z']});await s.keys(tree,'ctrl+r');await s.waitVisible(tree,'Keymap and bars reloaded');
  const focus=async(v:Block)=>{await s.revealTree(tree,v.id);await s.keys(tree,'alt+f');await s.waitVisible(tree,`Focused branch: ${v.text.split('\n')[0]}`);};
  await focus(view);await s.waitVisible(tree,'Comment on');
  let frame=await s.visible(tree);assert(!frame.includes('Hidden sibling detail'));assert(!frame.includes('Review transfer'));await s.checkpoint('01-attention-path');
  await s.keys(tree,'down','left');await s.waitFor('manual collapse',()=>s.visible(tree),f=>!f.includes('Review registration'));
  const fresh=await annotate(an,'[priority::high]\nFresh attention');await s.waitVisible(tree,'ATTENTION 2');assert(!(await s.visible(tree)).includes('Review registration'));await s.checkpoint('02-manual-collapse-wins');
  const screen=await s.waitFor('collapsed attention row',terminal.visible,f=>f.split('\n').some(l=>l.includes('PC-985 fixture')&&l.includes('▸')));
  const lines=screen.split('\n'),y=lines.findIndex(l=>l.includes('PC-985 fixture')&&l.includes('▸')),x=lines[y]!.indexOf('▸');
  await terminal.write(`\x1b[<0;${x+1};${y+1}M\x1b[<0;${x+1};${y+1}m`);await s.waitVisible(tree,'Review registration');
  await s.client.request({action:'annotations.lifecycle',input:{annotationId:important.block.id,lifecycle:'resolved'},mutation:{author:'agent',actorId:'fixture379'}});
  await s.waitVisible(tree,'ATTENTION 1');
  await s.keys(tree,'down','right');
  await s.client.request({action:'annotations.lifecycle',input:{annotationId:fresh.block.id,lifecycle:'resolved'},mutation:{author:'agent',actorId:'fixture379'}});
  await s.waitVisible(tree,'ATTENTION 0');assert((await s.visible(tree)).includes('Review registration'));
  await s.checkpoint('02b-last-match-resolved-keeps-path');
  await focus(compact);assert(!(await s.visible(tree)).includes('Review registration'));await s.checkpoint('03-independent-view');
  // Depth policy changes are exercised against both matched tickets and real comment grandchildren.
  for(const depth of [0,1,2]){
    const before=await s.client.request<Block>({action:'get',blockId:compact.id});
    await s.client.request({action:'update',blockId:compact.id,expectedRevision:before.revision,text:`Other compact view\n[type::virtual-branch] [query::fixture=379] [child-depth::${depth}] [expanded::true]`,mutation:{author:'agent',actorId:'fixture379'}});
    await s.keys(tree,'alt+z');await s.waitVisible(tree,'Reset this view');
    await s.waitFor(`depth ${depth}`,()=>s.visible(tree),f=>depth===0?!f.includes('Review registration'):f.includes('Review registration')&&(depth===2?f.includes('Comment on'):!f.includes('Comment on')));
    await s.checkpoint(`04-depth-${depth}`);
  }
  await s.keys(tree,'down','down','down');await s.waitVisible(tree,'Comment on');await terminal.resize(150,48);await s.waitVisible(tree,'Comment on');await s.checkpoint('05-resize');
}});console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
