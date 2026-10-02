import assert from 'node:assert/strict';
import type {Block} from '../../src/types';
import {runHerdrScenario} from './herdr-runner';
const result=await runHerdrScenario({
 name:'outlink-labels',async prepare(){},
 async run(session){
  const target=await session.client.request<Block>({action:'create',text:'PIE-181 — Recon map\n\nTarget body ^section'});
  const owner=await session.client.request<Block>({action:'create',text:`LABEL OWNER\n\n((${target.id}|PIE-181))\n((${target.id}^section|Why this matters))`});
  await session.revealTree(session.panes.tree,owner.id);
  await session.setKeybindings({'tree.preview.toggle':['Alt+H']});
  await session.keys(session.panes.tree,'ctrl+r');await session.waitVisible(session.panes.tree,'Keymap and bars reloaded');
  await session.keys(session.panes.tree,'alt+h');
  await session.keys(session.panes.tree,'?');await session.waitVisible(session.panes.tree,'Find:');
  await session.text(session.panes.tree,'Show authored links');await session.keys(session.panes.tree,'enter');
  await session.waitVisible(session.panes.tree,'Authored links shown');
  await session.keys(session.panes.tree,'down','down','down');
  const frame=await session.waitVisible(session.panes.tree,'Why this matters → PIE-181');
  const rows=frame.split('\n').filter(line=>line.includes('▸'));
  assert.ok(rows.some(line=>line.includes('PIE-181 — Recon map · block')));
  assert.ok(rows.some(line=>line.includes('Why this matters → PIE-181 — Recon map · ^section')));
  assert.ok(!rows.some(line=>line.includes('PIE-181 → PIE-181')));
  assert.equal((await session.client.request<Block>({action:'get',blockId:owner.id})).text,owner.text);
  await session.checkpoint('concise-labels-and-fragment');
 }
});
console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
