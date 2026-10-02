import {expect,test} from 'bun:test';
import {mentionMessageOf,workspaceForCwd} from '../claude-mod/hooks/mention-message';
import {register} from '../claude-mod/hooks/register';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {OutlinerStore} from '../src/store';
import {OutlinerServer} from '../src/server';
import {OutlinerClient} from '../src/client';
import {writeClientConfig} from '../src/paths';

const answer={reason:'answer',answer:'[[HUB-001]]',turnId:'turn-1',durationMs:0,isAborted:false};

test('a listed folder owns its subfolders; the nearest listed ancestor wins regardless of order',()=>{
 expect(workspaceForCwd('/Users/sam/hub/projects/outliner-mod',['/Users/sam/hub'])).toBe('/Users/sam/hub');
 expect(workspaceForCwd('/work/hub/',['/work/hub/'])).toBe('/work/hub');
 expect(workspaceForCwd('/work/hub/src/../notes',['/work/hub'])).toBe('/work/hub');
 for(const roots of [['/work','/work/hub'],['/work/hub','/work']])
  expect(workspaceForCwd('/work/hub/src',roots)).toBe('/work/hub');
 expect(workspaceForCwd('/work/hub/src',['/work/./hub/'])).toBe('/work/hub');
 expect(workspaceForCwd('/work/hub',['/'])).toBe('/');
});

test('path boundaries and traversal do not route siblings into a listed folder',()=>{
 for(const cwd of ['/work/hub-other','/work/hub/../private','/work/hub-worktrees/feature','relative/work/hub'])
  expect(workspaceForCwd(cwd,['/work/hub'])).toBeNull();
 expect(workspaceForCwd('/work/hub',[])).toBeNull();
});

test('a message carries the workspace folder; subagents, aborted and empty responses and no workspace send none',()=>{
 expect(mentionMessageOf(answer,{id:'session-1'},{root:'/work/hub'})).toEqual({
  workspaceRoot:'/work/hub',agent:'claude',sessionId:'session-1',messageId:'turn-1',text:'[[HUB-001]]',
 });
 expect(mentionMessageOf(answer,{id:'session-1'},null)).toBeNull();
 for(const change of [{agentId:'child'},{reason:'aborted',isAborted:true},{answer:' '}])
  expect(mentionMessageOf({...answer,...change},{id:'session-1'},{root:'/work/hub'})).toBeNull();
});

/**
 * The registered hooks against a real service and the real CLI: `root` is bound
 * to the service by its client.json (under a scratch config root), and the
 * session runs in `cwd`. Resolves to what the service then lists, and the runs.
 */
async function completeTurnIn(cwdOf,optionsOf=()=>({}),sessionEnvOf=()=>({})){
 const temp=mkdtempSync(join(tmpdir(),'claude-folder-'));
 const root=join(temp,'workspace with spaces');
 mkdirSync(join(root,'projects','mod'),{recursive:true});
 mkdirSync(join(temp,'elsewhere'),{recursive:true});
 const socket=join(temp,'service.sock');
 const scratchEnv={XDG_CONFIG_HOME:join(temp,'config'),OUTLINER_STATE_DIR:join(temp,'state'),HOME:join(temp,'home')};
 writeClientConfig(scratchEnv,{mode:'remote',socketPath:socket,workspaceRoot:root});
 const inherited=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('OUTLINER_')&&!key.startsWith('PI_OUTLINER_')));
 const store=new OutlinerStore(join(temp,'db.sqlite'),{workspaceRoot:root});
 const server=new OutlinerServer(store,socket);
 const client=new OutlinerClient(socket);
 const installation=resolve(import.meta.dir,'..');
 const target=store.create('Ticket [page::HUB-001]');
 const background=[];
 let inFlight=0;
 const runs=[];
 const toasts=[];
 const hooks=new Map();
 register((name,matcherOrCallback,callback)=>{hooks.set(name,callback??matcherOrCallback);},optionsOf(root));
 const sessionEnv=sessionEnvOf(root);
 const handler=hooks.get('turn.complete');
 const engine={
  env:{get:async name=>sessionEnv[name]},
  session:{id:async()=>'session-1',cwd:async()=>cwdOf(root,temp)},
  clock:{after:(_delay,callback)=>background.push(callback)},
  ui:{toast:text=>toasts.push(text)},
  process:{run:async(argv,init)=>{
   runs.push({argv,init});
   inFlight++;
   try{
   if(argv[0]==='herdr')return {exitCode:0,stderr:'',stdout:JSON.stringify({result:{plugins:[{plugin_id:'float.pi-outliner',enabled:true,plugin_root:installation}]}})};
   const child=Bun.spawn(argv,{cwd:init.cwd,env:{...inherited,...scratchEnv,...init.env},stdin:new Response(init.stdin),stdout:'pipe',stderr:'pipe'});
   const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
   return {exitCode,stdout,stderr};
   }finally{inFlight--;}
  }},
 };
 try{
  await server.start();
  expect(await handler(engine,answer,async()=>({text:answer.answer}))).toEqual({text:answer.answer});
  // Background work queues more (finding the folder, then delivering): run it until nothing is left or running.
  for(let idle=0,i=0;idle<5&&i<600;i++){
   const queued=background.splice(0);
   for(const callback of queued)callback();
   idle=queued.length||inFlight?0:idle+1;
   await Bun.sleep(20);
  }
  const entries=(await client.request({action:'mentions.list'})).entries;
  return {root,target,runs,toasts,entries};
 }finally{await server.close();store.close();rmSync(temp,{recursive:true,force:true});}
}

test('folder mode: a reply in a bound folder\'s subfolder reaches the outline its client.json binds, through the real CLI',async()=>{
 const {root,target,runs,toasts,entries}=await completeTurnIn(root=>join(root,'projects','mod'));
 expect(toasts).toEqual([]);
 const bound=runs.find(run=>run.argv.includes('bound-folder'));
 expect(bound?.argv.at(-1)).toBe(join(root,'projects','mod'));
 const ingest=runs.find(run=>run.argv.includes('ingest'));
 expect(ingest?.init.cwd).toBe(root);
 expect(ingest?.init.env).toEqual({OUTLINER_WORKSPACE_ROOT:root});
 expect(JSON.parse(ingest?.init.stdin).workspaceRoot).toBe(root);
 expect(entries.map(entry=>entry.block?.id)).toEqual([target.id]);
},15000);

test('folder mode: a reply in an unbound folder reaches no outline',async()=>{
 const {runs,toasts,entries}=await completeTurnIn((_root,temp)=>join(temp,'elsewhere'));
 expect(toasts).toEqual([]);
 expect(runs.some(run=>run.argv.includes('bound-folder'))).toBe(true);
 expect(runs.some(run=>run.argv.includes('ingest'))).toBe(false);
 expect(entries).toEqual([]);
},15000);

test('folder mode: an opted-out bound folder reaches no outline, and its binding is never asked for',async()=>{
 for(const [optionsOf,envOf] of [[()=>({}),root=>({PI_OUTLINER_MENTIONS_MODE:'folder',PI_OUTLINER_MENTIONS_WORKSPACES:join(root,'projects')})],[root=>({workspaces:`${root}/`,mode:'folder'}),()=>({})]]){
  const {runs,entries}=await completeTurnIn(root=>join(root,'projects','mod'),optionsOf,envOf);
  expect(runs.some(run=>run.argv.includes('bound-folder')||run.argv.includes('ingest'))).toBe(false);
  expect(entries).toEqual([]);
 }
},20000);

test('strict allowlist mode: a listed folder feeds the outline as before, and an unlisted bound one does not',async()=>{
 const listed=await completeTurnIn(root=>join(root,'projects','mod'),root=>({workspaces:root,mode:'allowlist'}));
 expect(listed.runs.some(run=>run.argv.includes('bound-folder'))).toBe(false);
 expect(listed.entries.map(entry=>entry.block?.id)).toEqual([listed.target.id]);
 const unlisted=await completeTurnIn(root=>join(root,'projects','mod'),()=>({}),()=>({PI_OUTLINER_MENTIONS_MODE:'allowlist'}));
 expect(unlisted.runs.some(run=>run.argv.includes('ingest'))).toBe(false);
 expect(unlisted.entries).toEqual([]);
},20000);
