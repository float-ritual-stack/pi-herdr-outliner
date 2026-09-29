import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname,join} from "node:path";
import {visibleWidth} from "@earendil-works/pi-tui";
import {resolveClientConfigPath} from "../../src/paths";
import type {Block,OutlinerServiceStatus} from "../../src/types";
import {runHerdrScenario} from "./herdr-runner";

const composed=process.argv.includes("--composed");
const result=await runHerdrScenario({
  name:composed?"workspace-copy-composed":"workspace-copy",layout:composed?"composed":"separate",
  async prepare() {},
  async run(session){
    const terminal=await session.attachClient();
    const resize=async(columns:number,rows:number)=>{
      await terminal.resize(columns,rows);
      await session.waitFor('attached layout resized',()=>terminal.visible(),frame=>frame.split('\n').some(line=>/[┐┘]$/.test(line)&&visibleWidth(line)===columns));
    };
    await resize(260,70);
    const tree=session.panes.tree;
    const transcript=join(session.artifactDirectory,"attached-client.ansi");
    const copied=async(action:()=>Promise<void>,expected:string)=>{
      const before=(await readFile(transcript,"utf8")).length;
      await action();
      const values=await session.waitFor(`exact clipboard value: ${expected}`,async()=>[...(await readFile(transcript,"utf8")).slice(before).matchAll(/\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)/g)].map(m=>Buffer.from(m[1]!,"base64").toString()),values=>values.includes(expected));
      assert.deepEqual(values,[expected],"One gesture must emit only the requested value");
      return values[0]!;
    };
    const open=async(pane:string)=>{
      await session.focus(pane);await session.keys(pane,"?");
      await session.text(pane,"Workspace and connection");await session.keys(pane,"enter");
      await session.waitVisible(pane,"Workspace:");
    };
    const focusField=async(pane:string,label:string)=>{
      for(let i=0;i<24;i++){
        const before=await session.visible(pane);
        if(before.includes(`› ${label}:`))return;
        const old=before.split('\n').find(line=>line.includes('› '));
        await session.keys(pane,"tab");
        await session.waitFor("field selection painted",()=>session.visible(pane),frame=>frame.split('\n').some(line=>line.includes('› ')&&line!==old));
      }
      throw Error(`Field not found: ${label}`);
    };
    const point=async(label:string,lineMatch?:string)=>session.waitFor("attached report hit target",async()=>{
      const paneLines=(await session.visible(tree)).split("\n");
      const localRow=paneLines.findIndex(line=>line.includes(label)&&(!lineMatch||line.includes(lineMatch)));
      if(localRow<0)return null;
      const localColumn=visibleWidth(paneLines[localRow]!.slice(0,paneLines[localRow]!.indexOf(label)));
      const native=(await terminal.visible()).split("\n");
      const anchor='Workspace and connection';
      const top=native.findIndex(line=>line.includes(anchor));
      if(top<0)return null;
      const left=visibleWidth(native[top]!.slice(0,native[top]!.indexOf(anchor)));
      if(!native[top+localRow]?.slice(left+localColumn).startsWith(label))return null;
      return {row:top+localRow,column:left+localColumn};
    },p=>p!==null);
    const baseline=session.database.query('SELECT id,text,revision FROM blocks ORDER BY id').all();
    await open(tree);
    const path=session.projectRoot;
    const location=await point(path);
    await copied(()=>terminal.write(`\x1b[<0;${location!.column+1};${location!.row+1}M\x1b[<32;${location!.column+path.length+1};${location!.row+1}M\x1b[<0;${location!.column+path.length+1};${location!.row+1}m`),path);
    await session.waitVisible(tree,'Selection sent to terminal clipboard');
    const end=await point('Client host:');
    const header=(await session.visible(tree)).split('\n').find(line=>line.includes('Client host:'))!;
    const selectedHeader=header.slice(0,header.indexOf('Client host:')+'Client host:'.length);
    await copied(()=>terminal.write(`\x1b[<0;${location!.column+1};${location!.row+1}M\x1b[<32;${end!.column+'Client host:'.length+1};${end!.row+1}M\x1b[<0;${end!.column+'Client host:'.length+1};${end!.row+1}m`),path+'\n'+selectedHeader);
    await session.checkpoint("workspace-drag-copy");
    const config=resolveClientConfigPath({OUTLINER_WORKSPACE_ROOT:session.projectRoot,XDG_CONFIG_HOME:join(dirname(session.projectRoot),'xdg-config')});
    await focusField(tree,'Config');
    await copied(()=>session.keys(tree,'c'),config);
    if(composed){
      const client=(await session.registrations()).find(c=>c.role==='composed')!;
      await session.client.request({action:'ui.command.send',command:{targetClientId:client.clientId,targetRegion:'detail',command:'focus'}});
    }
    const hit=await point('[Copy]','› Config:');
    await copied(()=>terminal.write(`\x1b[<0;${hit!.column+1};${hit!.row+1}M\x1b[<0;${hit!.column+1};${hit!.row+1}m`),config);
    await copied(()=>session.keys(tree,'c'),config);
    if(composed){
      // Keep a drag that leaves Tree inside the diagnostic content rectangle.
      const frame=(await session.visible(tree)).split('\n');
      // Use the visibly rendered first fragment of the config value as the selection oracle.
      const fieldRow=frame.findIndex(line=>line.includes('› Config:'));
      const treeWidth=/^─+/.exec(frame[1]!)![0].length;
      const prefix=frame[fieldRow+1]!.slice(0,treeWidth).trimEnd().trimStart();
      const start=await point(prefix);
      await copied(()=>terminal.write(`\x1b[<0;${start!.column+1};${start!.row+1}M\x1b[<32;${start!.column+90};${start!.row+1}M\x1b[<0;${start!.column+90};${start!.row+1}m`),prefix);
    }

    await resize(composed?220:110,50);
    await session.waitFor('narrow config rendered',()=>session.visible(tree),frame=>frame.includes('› Config:')&&!frame.includes(config));
    const payload=await copied(()=>session.keys(tree,'c'),config);
    await session.checkpoint('narrow-complete-value');
    await terminal.write('\x1b[6~');
    await session.keys(tree,'shift+tab');
    await session.waitVisible(tree,'› Client protocol:');
    const service=await session.client.request<OutlinerServiceStatus>({action:'ping'});
    await copied(()=>session.keys(tree,'c'),String(service.protocolVersion));
    await focusField(tree,'Local database');
    await copied(()=>session.keys(tree,'c'),service.location!.database);
    await session.keys(tree,'escape');
    await session.waitFor('returned to Tree',()=>session.visible(tree),frame=>!frame.includes('Workspace and connection')&&/[●○] Tree \[/u.test(frame));
    assert.deepEqual(session.database.query('SELECT id,text,revision FROM blocks ORDER BY id').all(),baseline);

    // Feed the terminal clipboard payload into the real editor and verify exact persisted bytes.
    // This is a protocol-level paste receiver, not a physical laptop clipboard claim.
    const receiver=await session.client.request<Block>({action:'create',text:''});
    const detail=(await session.registrations()).find(c=>c.runtime?.paneId===session.panes.detail&&c.role===(composed?'composed':'detail'))!;
    await session.client.request({action:'ui.command.send',command:{targetClientId:detail.clientId,targetRegion:'detail',command:'edit',target:{kind:'block',blockId:receiver.id}}});
    await session.waitVisible(session.panes.detail,'Editing');
    await session.text(session.panes.detail,payload);
    await session.keys(session.panes.detail,'ctrl+s');
    await session.waitFor('clipboard pasted exactly',()=>session.client.request<Block>({action:'get',blockId:receiver.id}),b=>b.text===config);
    await session.checkpoint('clipboard-editor-roundtrip');

    const remote=await session.openRemoteBrowsingContext({name:'diagnostic-remote',treeTransport:'forwarded'});
    await resize(260,70);
    await open(remote.tree);
    await focusField(remote.tree,'Service database');
    await copied(()=>session.keys(remote.tree,'c'),service.location!.database);
    await focusField(remote.tree,'Workspace');
    await copied(()=>session.keys(remote.tree,'c'),remote.workspaceRoot);
    assert.notEqual(remote.workspaceRoot,service.location!.workspaceRoot);
    await session.checkpoint('remote-ownership');
    await session.keys(remote.tree,'escape');
    await session.record('coverage',{clipboard:'OSC52 capture and real-editor paste roundtrip; physical host clipboard not claimed',remote:'Client workspace and service database copied separately without changing connection'});
  },
});
console.log(JSON.stringify(result));
if(result.status!=="passed")process.exitCode=1;
