import {expect, test} from 'bun:test';
import {mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDetailDestination} from '../src/detail-pane-placement';

// Exercise the real launch adapter, including a post-create focus failure.
test('new destination waits for its own registration and survives a focus failure',async()=>{
 const root=mkdtempSync(join(tmpdir(),'outliner-create-destination-'));
 const executable=join(root,'herdr'),log=join(root,'args.json');
 const old={HERDR_ENV:process.env.HERDR_ENV,HERDR_BIN_PATH:process.env.HERDR_BIN_PATH};
 try {
  writeFileSync(executable,`#!/usr/bin/env bun\nif(process.argv[4]==='open'){await Bun.write(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({result:{plugin_pane:{pane:{pane_id:'w1:p9',workspace_id:'w1',tab_id:'w1:t1'}}}}));}else{process.exit(1);}\n`);chmodSync(executable,0o755);
  process.env.HERDR_ENV='1';process.env.HERDR_BIN_PATH=executable;
  let reads=0;
  const destination=await createDetailDestination({request:async input=>{
   expect(input.action).toBe('clients.list');
   const args=JSON.parse(readFileSync(log,'utf8')) as string[];
   const context=args.find(a=>a.startsWith('OUTLINER_BROWSING_CONTEXT_ID='))!.split('=')[1]!;
   const exact={clientId:'created',role:'detail',contextId:context,runtime:{paneId:'w1:p9'}};
   return (++reads===1?[{...exact,contextId:'old'},{...exact,clientId:'wrong-pane',runtime:{paneId:'w1:p8'}}]:[exact]) as never;
  }},'source',{workspaceRoot:'/project',initialTarget:{kind:'block',blockId:'note'},placement:{kind:'split',direction:'right',targetPaneId:'w1:p1'}});
  expect(destination).toEqual({clientId:'created',region:'detail'});expect(reads).toBe(2);
  // A successful host creation with no matching app registration is NOT a link.
  await expect(createDetailDestination({request:async()=>[] as never},'source',{workspaceRoot:'/project',initialTarget:{kind:'block',blockId:'note'},placement:{kind:'split',direction:'right',targetPaneId:'w1:p1'},timeoutMs:0})).rejects.toThrow('Previous destination unchanged');
 } finally {
  for(const [key,value] of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  rmSync(root,{recursive:true,force:true});
 }
});
