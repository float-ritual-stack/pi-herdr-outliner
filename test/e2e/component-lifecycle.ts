import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,copyFile,unlink} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {visibleWidth} from '@earendil-works/pi-tui';
import {runHerdrScenario} from './herdr-runner';
import type {Block} from '../../src/types';
import {OutlinerClient} from '../../src/client';
import {OutlinerServer} from '../../src/server';
import {OutlinerStore} from '../../src/store';
const nvim=Bun.which("nvim");if(!nvim)throw Error("Neovim is required for the component source export journey");
let registry:string,manifest:string,inboxId:string;

const install=(enabled=true)=>writeFile(registry,JSON.stringify({version:1,renderers:{status:{manifest,enabled}}}));
const result=await runHerdrScenario({name:'component-lifecycle',editor:`${nvim} --clean`,async prepare(root,paths){
 const config=join(dirname(root),'xdg-config','pi-herdr-outliner');await mkdir(config,{recursive:true});
 registry=join(config,'document-renderers.json');manifest=join(config,'status.json');
 await copyFile(resolve(import.meta.dir,'../../extensions/status-summary/manifest.json'),manifest);await install();
 await mkdir(paths.stateDir,{recursive:true});
 const store=new OutlinerStore(paths.database,{workspaceRoot:root}),server=new OutlinerServer(store,paths.socket),client=new OutlinerClient(paths.socket);
 try {
  await server.start();
  await client.request({action:'create',text:'# Component destination [page::component-destination]\n\nArrived through the summary link.'});
  const receipt:any=await client.request({action:'capture.create',source:'cli',requestId:'component-fixture',text:'# INBOX COMPONENT\n\n```component:status\nTo do :: 4\n[Waiting for review 界 long label](pi-outliner://page/component-destination) :: 4\nDone :: 5\n```'});inboxId=receipt.block.id;
  server.enableInbox(async({source})=>({plan:{summary:'Retained component fixture',source:{text:source.text,disposition:'file'},notes:[],tasks:[],updates:[]},usage:{provider:'fixture',model:'fixture',inputTokens:0,outputTokens:0,cost:0,jevCalls:0,elapsedMs:0}}));
  let ready=false;for(let i=0;i<200;i++){const status:any=await client.request({action:'inbox.status'});if(status.results.length&&!status.current){ready=true;break;}await Bun.sleep(50);}assert.ok(ready,'fixture receipt finished');
 } finally {await server.close();store.close();}
},async run(s){
 const terminal=await s.attachClient();await terminal.resize(260,85);
 await s.waitFor('initial terminal dimensions',terminal.visible,t=>t.split('\n').length>=84&&Math.max(...t.split('\n').map(visibleWidth))>250);
 let source='# Component lifecycle\n\n```component:status\nTo do :: 4\n[Waiting for review 界 long label](https://example.test/review) :: 4\nDone :: 5\n```';
 let note=await s.client.request<Block>({action:'create',text:source});
 const other=await s.client.request<Block>({action:'create',text:'# Other note\n\nReturn to the component.'});
 const clients=await s.registrations(),tree=clients.find(c=>c.runtime?.paneId===s.panes.tree)!,detail=clients.find(c=>c.runtime?.paneId===s.panes.detail)!;
 const open=async(blockId:string)=>{await s.client.request({action:'navigation.dispatch',sourceClientId:tree.clientId,sourceRegion:'tree',intent:'open',target:{kind:'block',blockId},destination:{clientId:detail.clientId,region:'detail'}});};
 const reopen=async()=>{await open(other.id);await s.waitVisible(s.panes.detail,'Return to the component.');await open(note.id);};
 await open(note.id);await s.focus(s.panes.detail);await s.waitVisible(s.panes.detail,'To do: 4');await s.checkpoint('01-installed-wide');
 for(const [name,configure,expected] of [
 ['disabled',()=>install(false),'renderer is disabled'],
 ['removed',()=>unlink(manifest),'renderer installation is unavailable or invalid'],
 ['invalid',()=>writeFile(manifest,'{"contract":99}'),'renderer installation is unavailable or invalid'],
 ['reenabled',async()=>{await copyFile(resolve(import.meta.dir,'../../extensions/status-summary/manifest.json'),manifest);await install();},'To do: 4'],
 ] as const){
 await configure();if(name==='removed')await install();await reopen();await s.waitVisible(s.panes.detail,expected);
 if(name==='disabled'){
  await s.keys(s.panes.detail,'e');for(let i=0;i<12;i++)await s.keys(s.panes.detail,'down');await terminal.write('\x1b[F');await s.text(s.panes.detail,'\n\nEdited while disabled.');await s.keys(s.panes.detail,'ctrl+s');
  source+='\n\nEdited while disabled.';
  note=await s.waitFor('disabled component source saves normally',()=>s.client.request<Block>({action:'get',blockId:note.id}),b=>b.text===source);
  await s.keys(s.panes.detail,'escape');await s.waitFor('disabled fallback after edit',()=>s.visible(s.panes.detail),t=>t.includes('renderer is disabled')&&t.includes('Edited while disabled.'));
  // Export through the real external-editor handoff, not by writing our oracle.
  await s.keys(s.panes.detail,'ctrl+e');await s.waitVisible(s.panes.detail,'draft.md');
  const exported=join(s.artifactDirectory,'disabled-source.md');
  await terminal.write(`:set nofixeol\r:w ${exported}\r:q!\r`);
  await s.waitFor('external editor exported canonical component source',()=>readFile(exported,'utf8'),text=>text===source);
  await s.waitVisible(s.panes.detail,'$EDITOR returned an unchanged draft');
  await s.keys(s.panes.detail,'escape');await s.waitFor('returned to disabled reader',()=>s.visible(s.panes.detail),t=>t.includes('Current')&&!t.includes('● Edit'));
 }

 await s.checkpoint('02-'+name);assert.deepEqual(await s.client.request({action:'get',blockId:note.id}),note);
 }
 const changed=await s.client.request<Block>({action:'update',blockId:note.id,expectedRevision:note.revision,text:source.replace('To do :: 4','To do :: 6'),mutation:{author:'agent',actorId:'component-fixture'}});
 await s.waitFor('component data revision invalidates layout',()=>s.visible(s.panes.detail),t=>t.includes('To do: 6'));
 note=await s.client.request<Block>({action:'update',blockId:note.id,expectedRevision:changed.revision,text:source,mutation:{author:'agent',actorId:'component-fixture'}});
 await s.waitFor('restored component data',()=>s.visible(s.panes.detail),t=>t.includes('To do: 4'));
 for(const columns of [100,260,100]){
 await terminal.resize(columns,85);await s.waitFor('component reflow '+columns,()=>s.visible(s.panes.detail),t=>{const width=Math.max(...t.split('\n').map(visibleWidth));return (columns===100?width<40:t.includes('To do: 4 · Waiting for review 界 long label: 4 · Done: 5'))&&t.includes('Done: 5')&&t.includes('To do: 4');});
 await s.checkpoint('03-width-'+columns);
 }
 await s.client.request({action:'navigation.link.set',source:{clientId:tree.clientId,region:'tree'},destination:null});
 await s.revealTree(s.panes.tree,note.id);await s.client.request({action:'ui.command.send',command:{targetClientId:tree.clientId,command:'preview',target:{kind:'block',blockId:note.id}}});
 await s.waitFor('unlinked component Preview loaded',()=>s.visible(s.panes.tree),t=>t.includes('To do: 4'));await s.checkpoint('04-unlinked-tree-preview');
 assert.deepEqual(await s.client.request({action:'get',blockId:note.id}),note);
 await s.focus(s.panes.tree);await terminal.resize(260,85);await s.keys(s.panes.tree,'I');
 await s.waitFor('Inbox component in shared Preview',()=>s.visible(s.panes.tree),t=>t.includes('Source · current')&&t.includes('Done: 5'));
 await s.checkpoint('05-inbox-component-wide');
 await s.keys(s.panes.tree,'alt+p','shift+tab');
 for(const columns of [120,260,120]){
  await terminal.resize(columns,85);
  await s.waitFor('Inbox component reflow '+columns,()=>s.visible(s.panes.tree),t=>t.includes('Done: 5')&&(columns===120?Math.max(...t.split('\n').map(visibleWidth))<55:t.includes('To do: 4 · Waiting')));
  await s.checkpoint('06-inbox-focused-'+columns);
 }
 // The final body link stays focused across layout changes and opens locally.
 await s.keys(s.panes.tree,'enter');
 await s.waitFor('focused component link opens after resize',()=>s.visible(s.panes.tree),t=>t.includes('Arrived through the summary link.'));
 await s.keys(s.panes.tree,'alt+left');await s.waitFor('Inbox source returns',()=>s.visible(s.panes.tree),t=>t.includes('Done: 5'));
 await terminal.resize(260,85);
 const locate=(text:string)=>{const lines=text.split('\n'),header=lines.findIndex(l=>l.includes('Preview · Source'));const row=lines.findIndex((l,i)=>i>header&&l.includes('To do: 4 · Waiting')&&l.includes('Done: 5'));if(header<0||row<0)return null;const left=visibleWidth(lines[header]!.slice(0,lines[header]!.indexOf('Preview · Source')));const column=visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf('Done: 5')));return {row,column,relativeRow:row-header,relativeColumn:column-left};};
 const ready=await s.waitFor('Inbox wide component aligned in native and local frames',async()=>({native:locate(await terminal.visible()),local:locate(await s.visible(s.panes.tree))}),p=>!!p.native&&!!p.local&&p.native.relativeRow===p.local.relativeRow&&p.native.relativeColumn===p.local.relativeColumn);
 const {row,column}=ready.native!;await s.record('Inbox-component-drag',ready);
 const transcript=join(s.artifactDirectory,'attached-client.ansi'),before=(await readFile(transcript,'utf8')).length;
 await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<32;${column+8};${row+1}M\x1b[<0;${column+8};${row+1}m`);
 const copied=await s.waitFor('component Preview copies rendered label',async()=>[...(await readFile(transcript,'utf8')).slice(before).matchAll(/\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)/g)].map(m=>Buffer.from(m[1]!,'base64').toString()),a=>a.length>0);
 assert.deepEqual(copied,['Done: 5']);
 await terminal.resize(120,85);await s.waitFor('completed selection survives reflow',()=>s.visible(s.panes.tree),t=>t.includes('Done: 5')&&Math.max(...t.split('\n').map(visibleWidth))<55);
 await s.keys(s.panes.tree,'c');await s.waitFor('Preview composer',()=>s.visible(s.panes.tree),t=>t.includes('Comment'));
 await s.text(s.panes.tree,'Component Preview feedback');await terminal.write('\x13');
 const threads:any[]=await s.waitFor('saved source-backed component comment',()=>s.client.request<any[]>({action:'annotations.list',query:{subject:{kind:'block',blockId:inboxId},includeResolved:true}}),a=>a.some(t=>t.body==='Component Preview feedback'));
 assert.equal(threads[0].originalTarget.passage.quote,'Done: 5');
 await s.waitFor('component comment gutter',()=>s.visible(s.panes.tree),t=>/[+−] Done: 5/.test(t));
 await s.keys(s.panes.tree,']');await s.waitFor('component thread visible',()=>s.visible(s.panes.tree),t=>t.includes('Component Preview feedback'));
 await terminal.resize(260,85);await s.waitFor('wide component thread',()=>s.visible(s.panes.tree),t=>t.includes('Component Preview feedback')&&t.includes('To do: 4 · Waiting'));await s.checkpoint('07-inbox-component-comment');
 await terminal.resize(120,85);await s.waitFor('narrow component thread',()=>s.visible(s.panes.tree),t=>t.includes('Component Preview feedback')&&Math.max(...t.split('\n').map(visibleWidth))<55);await s.checkpoint('08-inbox-comment-narrow');
 await s.record('component-lifecycle',{installationAndResizePreserveSource:true,sourceEditVerified:true,installedManifest:manifest,disabledRemovedInvalidReenabled:true,rebuilt:false,copied,threads});
}});console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
