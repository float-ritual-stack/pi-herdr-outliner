import assert from 'node:assert/strict';
import {visibleWidth} from '@earendil-works/pi-tui';
import type {AnnotationThread, Block} from '../../src/types';
import {runHerdrScenario} from './herdr-runner';

const result=await runHerdrScenario({
  name:'local-preview-comments',
  async prepare(){},
  async run(s){
    const panes=s.panes;
    const tree=(await s.registrations()).find(c=>c.runtime?.paneId===panes.tree)!;
    await s.client.request({action:'navigation.link.set',source:{clientId:tree.clientId,region:'tree'},destination:null});
    const note=await s.client.request<Block>({action:'create',text:'LOCAL COMMENT NOTE\n\nKeep this writing intact.\n\n## Further reading\nThe comment stays here.'});
    const other=await s.client.request<Block>({action:'create',text:'OTHER BROWSING TARGET'});
    await s.focus(panes.tree);
    await s.revealTree(panes.tree,note.id);
    const terminal=await s.attachClient();
    await terminal.resize(150,62);
    const comments=()=>s.client.request<AnnotationThread[]>({action:'annotations.list',query:{subject:{kind:'block',blockId:note.id},includeResolved:true}});
    const frame=await s.waitFor('Comment control visible',terminal.visible,text=>text.includes('Preview · LOCAL COMMENT NOTE')&&(text.includes('[c]')||text.includes('[Comment]')));
    const lines=frame.split('\n');
    const row=lines.findIndex(line=>line.includes('[c]')||line.includes('[Comment]'));
    const marker=lines[row]!.includes('[Comment]')?'[Comment]':'[c]';
    const column=visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf(marker)))+1;
    await s.record('native-comment-control',{row,column,frame});
    await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<0;${column+1};${row+1}m`);
    await s.waitVisible(panes.tree,'Comment on note');
    await s.text(panes.tree,'LOCAL WHOLE NOTE FEEDBACK');
    await s.waitVisible(panes.tree,'LOCAL WHOLE NOTE FEEDBACK');
    await terminal.resize(120,62);
    await s.waitFor('narrow composer remains readable',()=>s.visible(panes.tree),text=>text.includes('LOCAL WHOLE NOTE FEEDBACK')&&text.includes('Ctrl+S')&&Math.max(...text.split('\n').map(visibleWidth))<55);
    await s.checkpoint('local-comment-draft-narrow');
    await s.revealTree(panes.tree,other.id);
    await s.waitVisible(panes.tree,'LOCAL WHOLE NOTE FEEDBACK');
    await s.keys(panes.tree,'ctrl+s');
    await s.waitFor('comment persisted on original note',comments,threads=>threads.length===1&&threads[0]!.body==='LOCAL WHOLE NOTE FEEDBACK');
    assert.equal((await comments())[0]!.originalTarget.anchor.kind,'whole-subject');
    assert.equal((await s.client.request<AnnotationThread[]>({action:'annotations.list',query:{subject:{kind:'block',blockId:other.id}}})).length,0);
    await s.keys(panes.tree,']');
    await s.waitVisible(panes.tree,'LOCAL WHOLE NOTE FEEDBACK');
    const replyFrame=await s.waitFor('Reply visible',terminal.visible,text=>text.includes('Reply · Resolve'));
    const replyLines=replyFrame.split('\n');
    const replyRow=replyLines.findIndex(line=>line.includes('Reply · Resolve'));
    const replyColumn=visibleWidth(replyLines[replyRow]!.slice(0,replyLines[replyRow]!.indexOf('Reply')));
    await terminal.write(`\x1b[<0;${replyColumn+1};${replyRow+1}M\x1b[<0;${replyColumn+1};${replyRow+1}m`);
    await s.waitVisible(panes.tree,'Write a comment');
    await s.text(panes.tree,'LOCAL PREVIEW REPLY');
    await s.keys(panes.tree,'ctrl+s');
    await s.waitFor('reply persisted once',comments,threads=>threads.length===1&&threads[0]!.replies.length===1&&threads[0]!.replies[0]!.body==='LOCAL PREVIEW REPLY');
    await s.waitVisible(panes.tree,'LOCAL PREVIEW REPLY');
    await s.checkpoint('local-comment-and-reply-saved');
    assert.equal((await s.client.request<Block>({action:'get',blockId:note.id})).text,note.text);
  },
});
console.log(JSON.stringify(result));
if(result.status!=='passed')process.exitCode=1;
