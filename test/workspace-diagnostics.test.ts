import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,existsSync,renameSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {inspectWorkspaceConnection} from '../src/workspace-diagnostics';
import {resolvePaths,resolveClientConfigPath} from '../src/paths';
import {OutlinerServer} from '../src/server';
import {OutlinerStore} from '../src/store';

test('moved root storage stays missing, backup unchanged, working child retains own database',async()=>{
 const root=mkdtempSync(join(tmpdir(),'workspace-info-'));
 const env={OUTLINER_WORKSPACE_ROOT:join(root,'workspace'),OUTLINER_STATE_DIR:join(root,'state'),OUTLINER_REMOTE:'0'};
 const parent=resolvePaths(env),childEnv={...env,OUTLINER_WORKSPACE_ROOT:join(env.OUTLINER_WORKSPACE_ROOT,'notes')},child=resolvePaths(childEnv);
 const original=new OutlinerStore(parent.database,{workspaceRoot:parent.workspaceRoot});original.create('PARENT PRESERVED');original.close();
 const backup=parent.stateDir+'-saved';renameSync(parent.stateDir,backup);const bytes=readFileSync(join(backup,'outliner.sqlite'));
 const store=new OutlinerStore(child.database,{workspaceRoot:child.workspaceRoot});const note=store.create('CHILD PRESERVED');const server=new OutlinerServer(store,child.socket);await server.start();
 try{
  const missing=await inspectWorkspaceConnection(env);expect(missing.ok).toBe(false);expect(missing.lines.join('\n')).toContain(parent.database);expect(missing.lines.join('\n')).toContain('new workspace or moved storage');expect(existsSync(parent.stateDir)).toBe(false);expect(readFileSync(join(backup,'outliner.sqlite'))).toEqual(bytes);
  const working=await inspectWorkspaceConnection(childEnv);expect(working.ok).toBe(true);expect(working.lines.join('\n')).toContain(`Service database: ${child.database}`);expect(store.get(note.id)?.text).toBe('CHILD PRESERVED');
 }finally{await server.close();store.close();rmSync(root,{recursive:true,force:true});}
});
test('remote unavailable and invalid config are reported without creating local storage',async()=>{
 const root=mkdtempSync(join(tmpdir(),'workspace-info-'));
 const env={OUTLINER_WORKSPACE_ROOT:root,OUTLINER_STATE_DIR:join(root,'state'),XDG_CONFIG_HOME:join(root,'config')};
 try{
  const path=resolveClientConfigPath(env);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify({mode:'remote',socketPath:join(root,'forward.sock')}));
  const report=await inspectWorkspaceConnection(env);const text=report.lines.join('\n');expect(report.ok).toBe(false);expect(text).toContain('SSH socket tunnel');expect(text).not.toContain('Local database:');expect(text).toContain('Storage belongs to the remote service');expect(existsSync(env.OUTLINER_STATE_DIR)).toBe(false);
  writeFileSync(path,'{broken');const broken=await inspectWorkspaceConnection(env);expect(broken.lines.join('\n')).toContain(`Invalid JSON in Outliner client config at ${path}`);expect(existsSync(env.OUTLINER_STATE_DIR)).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('doctor CLI reports failed connection with paths and nonzero status without initializing a database',async()=>{
 const root=mkdtempSync(join(tmpdir(),'workspace-doctor-'));
 try{
  const child=Bun.spawn([process.execPath,'src/cli.ts','doctor','--json'],{env:{...process.env,OUTLINER_WORKSPACE_ROOT:root,OUTLINER_STATE_DIR:join(root,'state'),OUTLINER_REMOTE:'0',OUTLINER_SOCKET_PATH:undefined},stdout:'pipe',stderr:'pipe'});
  const text=await new Response(child.stdout).text();expect(await child.exited).toBe(1);expect(JSON.parse(text).lines.join('\n')).toContain(`Workspace: ${root}`);expect(existsSync(join(root,'state'))).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
