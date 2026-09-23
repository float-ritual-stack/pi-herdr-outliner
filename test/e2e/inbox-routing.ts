import assert from 'node:assert/strict';
import type {Block,CaptureReceipt} from '../../src/types';
import type {InboxStatus} from '../../src/inbox-types';
import {runHerdrScenario} from './herdr-runner';

// Opt-in live model journey, isolated from the user's database and panes.
const result=await runHerdrScenario({name:'inbox-routing',allowInboxAgent:true,allowJev:true,allowNoteAssistance:true,async prepare(){},async run(session){
 const state=()=>session.client.request<InboxStatus>({action:'inbox.status'});
 await session.waitFor('configured assistance',state,value=>value.enabled,20000);
 const terminal=await session.attachClient();const pane=session.panes.tree;await terminal.resize(240,80);
 const create=(id:string,text:string)=>session.client.request<CaptureReceipt>({action:'capture.create',requestId:id,source:'cli',text});
 const filler=await create('routing-filler','aaaa');
 await session.waitFor('reversible archive',state,value=>!value.current&&value.results.some(item=>item.sourceId===filler.block.id),120000);
 await session.keys(pane,'I');await session.keys(pane,'A');await session.waitVisible(pane,'Route: archive');
 await session.checkpoint('01-live-archive-route');
 const receipt=(await state()).results.find(item=>item.sourceId===filler.block.id)!;assert.equal(receipt.routing?.route,'archive');
 assert.equal(receipt.usage?.piSessions?.length??0,0);
 await session.keys(pane,'u');
 await session.waitFor('Undo archived capture',state,value=>value.results.find(item=>item.id===receipt.id)?.state==='undone');
 const restored=await session.client.request<Block>({action:'get',blockId:filler.block.id});assert.equal(restored.text,filler.block.text);assert.equal(restored.parentId,filler.block.parentId);assert.equal((await state()).pending,0);
 await session.checkpoint('02-archive-undo-restores-original');
 await session.keys(pane,'r');await session.text(pane,'This is the exact name of a parser fixture. Keep it as an ordinary reference note explaining that context; do not archive it.');await session.keys(pane,'enter');
 await session.waitFor('directed reconsideration',state,value=>!value.current&&value.results.some(item=>item.id!==receipt.id&&item.sourceId===filler.block.id),150000);
 const retry=(await state()).results.find(item=>item.id!==receipt.id&&item.sourceId===filler.block.id)!;
 assert.equal(retry.state,'applied');assert.equal(retry.routing?.route,'editorial');assert.equal(retry.attempt?.trigger,'reconsider');
 await session.keys(pane,'up');await session.keys(pane,'A');await session.waitVisible(pane,'Route: editorial');await session.checkpoint('03-steering-escalates-to-editor');
 const shopping=await create('routing-shopping','Grocery list\n- milk\n- coffee\n- rice');
 await session.waitFor('useful short note',state,value=>!value.current&&value.results.some(item=>item.sourceId===shopping.block.id),120000);
 const kept=(await state()).results.find(item=>item.sourceId===shopping.block.id)!;assert.equal(kept.routing?.route,'keep');assert.equal(kept.usage?.piSessions?.length??0,0);
 const final=await session.client.request<Block>({action:'get',blockId:shopping.block.id});assert.ok(final.text.includes('- milk\n- coffee\n- rice'));assert.equal(final.properties.filter(p=>p.key==='tag').length,0);
 // New receipts preserve the selection; reopen to inspect the newest result.
 await session.keys(pane,'esc');await session.keys(pane,'I');await session.keys(pane,'A');await session.waitVisible(pane,'Route: keep');await session.keys(pane,'1');await session.waitVisible(pane,'Grocery list');
 await session.checkpoint('04-useful-list-kept-without-tags');await session.record('routing-results',await state());
}});console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
