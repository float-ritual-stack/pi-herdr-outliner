import assert from 'node:assert/strict';
import {runHerdrScenario} from './herdr-runner';
const result=await runHerdrScenario({name:'workspace-diagnostics',async prepare(){},async run(s){
 const terminal=await s.attachClient();await terminal.resize(180,48);
 await s.keys(s.panes.tree,'?');await s.text(s.panes.tree,'Workspace and connection');await s.waitVisible(s.panes.tree,'Workspace and connection');
 await s.keys(s.panes.tree,'enter');await s.waitVisible(s.panes.tree,'Client host:');await s.waitVisible(s.panes.tree,'Service database:');
 const text=await s.visible(s.panes.tree);assert.ok(text.includes('Connection: local'));assert.ok(text.includes('Service: ready'));await s.checkpoint('01-discover-workspace-report');
 await terminal.resize(100,42);await s.keys(s.panes.tree,'pagedown');await s.checkpoint('02-narrow-report');await s.keys(s.panes.tree,'escape');await s.waitVisible(s.panes.tree,'Outliner');
}});console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
