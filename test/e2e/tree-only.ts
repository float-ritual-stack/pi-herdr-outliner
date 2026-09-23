import assert from 'node:assert/strict';
import {runHerdrScenario} from './herdr-runner';
const result=await runHerdrScenario({name:'tree-only',detailRenderer:process.argv.includes('--ansi')?'ansi':'pi-tui',commandKeys:[{key:'prefix+shift+u',command:'float.pi-outliner.open-tree'}],async prepare(){},async run(s){
 const terminal=await s.attachClient();await s.waitFor('attached',terminal.visible,t=>t.includes('Outliner'));
 const initial=await s.registrations();const detailCount=initial.filter(c=>c.role==='detail').length;
 for(const origin of ['shell','tree','detail'] as const){
  const before=new Set((await s.registrations()).map(c=>c.clientId));
  if(origin==='shell'){
   await s.text(s.panes.launcher,"printf 'TREE_ONLY_%s\\n' SHELL");await s.keys(s.panes.launcher,'enter');
   const frame=await s.waitFor('shell marker',terminal.visible,t=>t.includes('TREE_ONLY_SHELL'));
   const row=frame.split('\n').findIndex(l=>l.includes('TREE_ONLY_SHELL'))+1;
   const column=frame.split('\n')[row-1]!.indexOf('TREE_ONLY_SHELL')+2;
   await terminal.write(`\x1b[<0;${column};${row}M\x1b[<0;${column};${row}m`);
   await terminal.write('\x02');await s.waitFor('prefix',terminal.visible,t=>t.includes('PREFIX'));await terminal.write('U');
  }else {await s.keys(s.panes[origin],'?');await s.waitVisible(s.panes[origin],process.argv.includes('--ansi')&&origin==='detail'?'Actions':'Find:');await s.text(s.panes[origin],'New Tree');await s.waitVisible(s.panes[origin],'New Tree');await s.keys(s.panes[origin],'enter');}
  const clients=await s.waitFor('new Tree registration',s.registrations,cs=>cs.some(c=>c.role==='tree'&&!before.has(c.clientId)));
  const added=clients.filter(c=>c.role==='tree'&&!before.has(c.clientId));assert.equal(added.length,1);assert.equal(clients.filter(c=>c.role==='detail').length,detailCount);
  const pane=await s.adoptDetached(added[0]!.clientId,'tree');await s.waitVisible(pane,'Outliner');
  assert.ok(added[0]!.contextId);assert.ok(!initial.some(c=>c.contextId===added[0]!.contextId));
  await s.checkpoint(`new-tree-from-${origin}`);await s.closeDetached(pane);
 }
}});console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
