import assert from 'node:assert/strict';
import type {Block} from '../../src/types';
import {runHerdrScenario} from './herdr-runner';
const result=await runHerdrScenario({name:'virtual-branch-defaults',async prepare(){},async run(s){
 const terminal=await s.attachClient();await terminal.resize(190,55);const tree=s.panes.tree;
 const create=(text:string,parentId:string|null=null)=>s.client.request<Block>({action:'create',text,parentId});
 const folder=await create('Sources');const ticket=await create('PC-762 fixture\n[fixture::378]',folder.id);
 await create('Working note 378',ticket.id);
 const view=await create('Doing compact\n[type::virtual-branch] [query::fixture=378] [child-depth::1] [expanded::false]');
 await s.setKeybindings({'tree.root.focus':['Alt+F'],'tree.virtual-branch.reset-expansion':['Alt+Z']});await s.keys(tree,'ctrl+r');await s.waitVisible(tree,'Keymap and bars reloaded');
 await s.revealTree(tree,view.id);await s.keys(tree,'alt+f');await s.waitVisible(tree,'Focused branch: Doing compact');
 assert(!(await s.visible(tree)).includes('Working note 378'));await s.checkpoint('01-compact-default');
 await s.keys(tree,'down','right');await s.waitVisible(tree,'Working note 378');await s.checkpoint('02-open-keyboard');
 const before=await s.client.request<Block>({action:'get',blockId:view.id});
 await s.client.request({action:'update',mutation:{author:'agent',actorId:'PIE378-fixture'},blockId:view.id,expectedRevision:before.revision,text:before.text+'\nUnrelated prose refresh.'});
 await s.waitVisible(tree,'Working note 378');
 await s.keys(tree,'alt+z');await s.waitFor('reset folds result',()=>s.visible(tree),t=>!t.includes('Working note 378'));
 await s.checkpoint('03-reset-default');
 // Pointer uses the live rendered disclosure position, not remembered fixture coordinates.
 const screen=await s.waitFor('attached compact row',terminal.visible,t=>t.split('\n').some(l=>l.includes('PC-762 fixture')&&l.includes('▸')));const lines=screen.split('\n');const y=lines.findIndex(l=>l.includes('PC-762 fixture')&&l.includes('▸'));assert(y>=0);
 const marker=lines[y]!.indexOf('▸');assert(marker>=0,'collapsed disclosure marker visible');
 await terminal.write(`\x1b[<0;${marker+1};${y+1}M\x1b[<0;${marker+1};${y+1}m`);
 await s.waitVisible(tree,'Working note 378');await terminal.resize(145,48);await s.waitVisible(tree,'Working note 378');await s.checkpoint('04-pointer-open-resize');
}});console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
