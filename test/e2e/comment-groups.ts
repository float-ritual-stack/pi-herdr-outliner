import assert from 'node:assert/strict';
import {visibleWidth} from '@earendil-works/pi-tui';
import {blockAnnotationRepresentation} from '../../src/annotation-representations';
import {createTextQuoteAnchor} from '../../src/annotations';
import type {AnnotationBatchReceipt, AnnotationThread, Block} from '../../src/types';
import {runHerdrScenario} from './herdr-runner';

const result=await runHerdrScenario({
  name:'comment-groups',
  async prepare(){},
  async run(s){
    const tree=s.panes.tree, terminal=await s.attachClient();
    await terminal.resize(200,70);
    const host=await s.client.request<Block>({action:'create',text:'DISCUSSION NOTE\n[fixture::discussion]\n\nALPHA PASSAGE\n\nBETA PASSAGE\n\nGAMMA PASSAGE'});
    const ordinary=await s.client.request<Block>({action:'create',parentId:host.id,text:'ORDINARY CHILD'});
    const add=async (quote:string,body:string,source:'user'|'agent')=>{
      const start=host.text.indexOf(quote);
      const receipt=await s.client.request<AnnotationBatchReceipt>({action:'annotations.create',requestId:crypto.randomUUID(),author:source,
        input:{target:{representation:blockAnnotationRepresentation(host),anchor:createTextQuoteAnchor(host.text,start,start+quote.length)},body,source}});
      return receipt.annotations[0]!;
    };
    const first=await add('ALPHA PASSAGE','FIRST DISCUSSION','user');
    const second=await add('BETA PASSAGE','SECOND DISCUSSION','user');
    const third=await add('GAMMA PASSAGE','OTHER AUTHOR DISCUSSION','agent');
    await s.client.request({action:'annotations.reply',requestId:crypto.randomUUID(),input:{annotationId:second.block.id,body:'EXISTING NESTED REPLY',source:'agent'}});
    await s.client.request({action:'create',text:'DISCUSSION VIEW\n[type::virtual-branch] [query::fixture=discussion] [child-depth::2]'});
    const threads=()=>s.client.request<AnnotationThread[]>({action:'annotations.list',query:{subject:{kind:'block',blockId:host.id},includeResolved:true}});
    const before=await threads();
    const treeText=()=>s.visible(tree);
    const rootCommentLines=(text:string)=>text.split('\n').filter(line=>line.includes('Comment on “'));
    await s.focus(tree); await s.revealTree(tree,host.id); await s.keys(tree,'esc');
    await s.waitFor('two quiet groups',treeText,text=>text.split('Comments  3 threads').length===3&&rootCommentLines(text).length===0);
    await s.checkpoint('01-quiet-physical-and-virtual');
    const clickGroup=async (ordinal:number)=>{
      const frame=await s.waitFor('group available in attached terminal',terminal.visible,text=>text.split('\n').filter(line=>line.includes('Comments  3 threads')).length===2);
      const lines=frame.split('\n'), indexes=lines.flatMap((line,i)=>line.includes('Comments  3 threads')?[i]:[]);
      const row=indexes[ordinal]!, text=lines[row]!;
      const column=visibleWidth(text.slice(0,text.indexOf('Comments')))-2;
      await s.record(`native-group-${ordinal}`,{frame,row,column});
      await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<0;${column+1};${row+1}m`);
    };
    await clickGroup(0);
    await s.waitFor('physical threads only',treeText,text=>rootCommentLines(text).length===4);
    assert.ok((await treeText()).includes('ORDINARY CHILD'));
    await s.checkpoint('02-mouse-opens-physical-group');
    await s.keys(tree,'left');
    await s.waitFor('keyboard closes group',treeText,text=>rootCommentLines(text).length===0);
    await s.revealTree(tree,host.id);
    await s.keys(tree,'/'); await s.text(tree,'BETA PASSAGE'); await s.keys(tree,'enter');
    await s.waitVisible(tree,'Comment on “BETA PASSAGE”');
    await s.keys(tree,'down','.');
    await s.waitVisible(tree,'SECOND DISCUSSION');
    await s.keys(tree,'?'); await s.text(tree,'Clear branch filter'); await s.keys(tree,'enter');
    await s.waitFor('filter restores closed groups after expanding a match',treeText,text=>text.split('Comments  3 threads').length===3&&rootCommentLines(text).length===0);
    await s.checkpoint('02a-filter-restores-disclosure');
    await clickGroup(1);
    await s.waitFor('virtual threads only',treeText,text=>rootCommentLines(text).length===4);
    await s.checkpoint('03-independent-virtual-group');
    await s.keys(tree,'left');
    await s.revealTree(tree,second.block.id);
    await s.waitFor('direct reference opens physical path',treeText,text=>rootCommentLines(text).length===4);
    await s.checkpoint('04-direct-comment-reveal');
    await s.revealTree(tree,host.id);
    // Return to the same discussion through the local Preview, without a Detail destination.
    const registration=(await s.registrations()).find(c=>c.runtime?.paneId===tree)!;
    await s.client.request({action:'navigation.link.set',source:{clientId:registration.clientId,region:'tree'},destination:null});
    await s.keys(tree,'?'); await s.text(tree,'Show / hide Preview'); await s.keys(tree,'enter');
    await s.waitVisible(tree,'Preview · DISCUSSION NOTE');
    await s.keys(tree,'f7');
    await s.waitVisible(tree,'Preview · DISCUSSION NOTE');
    await s.keys(tree,']'); await s.waitVisible(tree,'FIRST DISCUSSION');
    await s.keys(tree,']'); await s.waitVisible(tree,'SECOND DISCUSSION');
    await s.keys(tree,'C'); await s.waitVisible(tree,'Write a comment');
    await s.text(tree,'REPLY FROM PREVIEW'); await s.keys(tree,'ctrl+s');
    await s.waitFor('reply updates same thread',threads,ts=>ts.length===3&&ts.find(t=>t.block.id===second.block.id)?.replies.length===2);
    await s.keys(tree,'D'); await s.waitFor('same thread resolved',threads,ts=>ts.find(t=>t.block.id===second.block.id)?.lifecycle==='resolved');
    await s.keys(tree,'D'); await s.waitFor('same thread reopened',threads,ts=>ts.find(t=>t.block.id===second.block.id)?.lifecycle==='open');
    await s.checkpoint('05-preview-reply-and-lifecycle');
    await s.keys(tree,'esc');
    await s.revealTree(tree,second.block.id);
    await terminal.resize(130,48);
    await s.waitVisible(tree,'Comments  3 threads');
    await s.checkpoint('06-narrow-comments');
    const after=await threads();
    assert.deepEqual(after.map(t=>t.block.id),before.map(t=>t.block.id));
    for(const thread of after){
      const original=before.find(t=>t.block.id===thread.block.id)!;
      assert.deepEqual(thread.originalTarget,original.originalTarget);
      assert.equal(thread.block.parentId,host.id);
      assert.equal(thread.block.author,original.block.author);
      assert.ok(thread.replies.every(reply=>reply.block.parentId===thread.block.id));
    }
    assert.equal((await s.client.request<Block>({action:'get',blockId:ordinary.id})).parentId,host.id);
    assert.deepEqual(after.map(t=>t.block.id),[first.block.id,second.block.id,third.block.id]);
    await s.record('canonical-discussion-preserved',{before,after,ordinary,inputs:'Attached terminal mouse disclosure; Herdr-injected arrows, Preview reply and lifecycle keys; attached terminal resize. No physical laptop input claim.'});
  }
});
console.log(JSON.stringify(result)); if(result.status!=='passed')process.exitCode=1;
