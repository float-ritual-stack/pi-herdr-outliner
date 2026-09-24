import {expect,test} from 'bun:test';
import {mentionMessageOf} from '../claude-mod/hooks/mention-message';
import {register} from '../claude-mod/hooks/register';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {OutlinerStore} from '../src/store';
import {OutlinerServer} from '../src/server';
import {OutlinerClient} from '../src/client';

const answer={reason:'answer',answer:'[[HUB-001]]',turnId:'turn-1',durationMs:0,isAborted:false};
const message=(cwd,roots,event=answer)=>mentionMessageOf(event,{id:'session-1',cwd},roots);

test('Claude subfolder answers retain the configured workspace identity',()=>{
 expect(message('/Users/evan/float-hub/projects/outliner-mod',['/Users/evan/float-hub'])).toEqual({
  workspaceRoot:'/Users/evan/float-hub',agent:'claude',sessionId:'session-1',messageId:'turn-1',text:'[[HUB-001]]',
 });
 expect(message('/work/hub/',['/work/hub/'])?.workspaceRoot).toBe('/work/hub');
 expect(message('/work/hub/src/../notes',['/work/hub'])?.workspaceRoot).toBe('/work/hub');
});

test('nearest configured ancestor wins regardless of list order',()=>{
 for(const roots of [['/work','/work/hub'],['/work/hub','/work']])
  expect(message('/work/hub/src',roots)?.workspaceRoot).toBe('/work/hub');
 expect(message('/work/hub/src',['/work/./hub/'])?.workspaceRoot).toBe('/work/hub');
 expect(message('/work/hub',['/'])?.workspaceRoot).toBe('/');
});

test('path boundaries and traversal do not route siblings into the workspace',()=>{
 for(const cwd of ['/work/hub-other','/work/hub/../private','/work/hub-worktrees/feature','relative/work/hub'])
  expect(message(cwd,['/work/hub'])).toBeNull();
 expect(message('/work/hub',[])).toBeNull();
});

test('subfolders still exclude subagents, aborted and empty responses',()=>{
 for(const change of [{agentId:'child'},{reason:'aborted',isAborted:true},{answer:' '}])
  expect(message('/work/hub/src',['/work/hub'],{...answer,...change})).toBeNull();
});

test('registered completion hook delivers a subfolder reply through CLI into the parent service',async()=>{
 const temp=mkdtempSync(join(tmpdir(),'claude-subfolder-'));
 const root=join(temp,'workspace with spaces');
 mkdirSync(join(root,'projects','mod'),{recursive:true});
 const socket=join(temp,'service.sock');
 const store=new OutlinerStore(join(temp,'db.sqlite'),{workspaceRoot:root});
 const server=new OutlinerServer(store,socket);
 const client=new OutlinerClient(socket);
 const installation=resolve(import.meta.dir,'..');
 const target=store.create('Ticket [page::HUB-001]');
 let handler;
 const background=[];
 const runs=[];
 const toasts=[];
 register((name,callback)=>{expect(name).toBe('turn.complete');handler=callback;},{workspaces:root});
 const engine={
  env:{get:async()=>undefined},
  session:{id:async()=>'session-1',cwd:async()=>join(root,'projects','mod')},
  clock:{after:(_delay,callback)=>background.push(callback)},
  ui:{toast:text=>toasts.push(text)},
  process:{run:async(argv,init)=>{
   runs.push({argv,init});
   if(argv[0]==='herdr')return {exitCode:0,stderr:'',stdout:JSON.stringify({result:{plugins:[{plugin_id:'float.pi-outliner',enabled:true,plugin_root:installation}]}})};
   const child=Bun.spawn(argv,{cwd:init.cwd,env:{...process.env,...init.env,OUTLINER_CONFIG_PATH:join(temp,'client.json'),OUTLINER_REMOTE:'1',OUTLINER_SOCKET_PATH:socket},stdin:new Response(init.stdin),stdout:'pipe',stderr:'pipe'});
   const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
   return {exitCode,stdout,stderr};
  }},
 };
 try{
  await server.start();
  expect(await handler(engine,answer,async()=>({text:answer.answer}))).toEqual({text:answer.answer});
  for(const callback of background)callback();
  let result;
  for(let i=0;i<200;i++){
   result=await client.request({action:'mentions.list'});
   if(result.entries.length||toasts.length)break;
   await Bun.sleep(25);
  }
  expect(toasts).toEqual([]);
  expect(runs[1]?.init.cwd).toBe(root);
  expect(runs[1]?.init.env.OUTLINER_WORKSPACE_ROOT).toBe(root);
  expect(JSON.parse(runs[1]?.init.stdin).workspaceRoot).toBe(root);
  expect(result.entries.map(entry=>entry.block?.id)).toEqual([target.id]);
 }finally{await server.close();store.close();rmSync(temp,{recursive:true,force:true});}
},10000);
