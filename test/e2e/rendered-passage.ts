import {blockAnnotationRepresentation} from "../../src/annotation-representations";
import {createTextQuoteAnchor,createAnnotationReferenceContext} from '../../src/annotations';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {visibleWidth} from '@earendil-works/pi-tui';
import {checklistItems} from '../../src/checklist-items';
import type {AnnotationThread, Block, InternResourceReceipt} from '../../src/types';
import {runHerdrScenario} from './herdr-runner';

const result = await runHerdrScenario({
  name: 'rendered-passage',
  async prepare(root) {
    await writeFile(join(root,'resource-passage.md'),'# Resource passage\n\nStable **quote** &amp; tail\n');
    const config = join(dirname(root), 'xdg-config', 'pi-herdr-outliner');
    await mkdir(config, {recursive: true});
    await writeFile(join(config, 'document-renderers.json'), JSON.stringify({version: 1, renderers: {
      status: {manifest: resolve(import.meta.dir, '../../extensions/status-summary/manifest.json'), enabled: true},
    }}));
  },
  async run(s) {
    const terminal = await s.attachClient();
    await terminal.resize(220, 65);
    const source = await s.client.request<Block>({action:'create', text:'# Shared material\n\n- [ ] Repeated passage'});
    const host = await s.client.request<Block>({action:'create', text:
      `# Passage host\n\n!((${source.id}))\n\nBetween copies\n\n!((${source.id}))\n\nHost tail`});
    const registrations = await s.registrations();
    const tree = registrations.find(client => client.runtime?.paneId === s.panes.tree)!;
    const detail = registrations.find(client => client.runtime?.paneId === s.panes.detail)!;
    await s.client.request({action:'navigation.dispatch', sourceClientId:tree.clientId, sourceRegion:'tree', intent:'open',
      target:{kind:'block', blockId:host.id}, destination:{clientId:detail.clientId, region:'detail'}});
    await s.focus(s.panes.detail);
    const needle = 'Repeated passage';
    const relative = (frame:string) => {
      const lines = frame.split('\n');
      const header = lines.findIndex(line => line.includes('● Current'));
      if (header < 0) return null;
      const left = visibleWidth(lines[header]!.slice(0, lines[header]!.indexOf('● Current')));
      const matches = lines.flatMap((line,row) => row > header && line.indexOf(needle) >= left ? [row] : []);
      const row = matches[1];
      return row === undefined ? null : {row, column:visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf(needle))), header, left};
    };
    const settled = await s.waitFor('second occurrence in the attached reader', async () => ({
      screen:await terminal.visible(), pane:await s.visible(s.panes.detail),
    }), ({screen,pane}) => {
      const a = relative(screen), b = relative(pane);
      return !!a && !!b && a.row-a.header === b.row-b.header && a.column-a.left === b.column-b.left;
    });
    await s.checkpoint('01-two-occurrences');
    const point = relative(settled.screen)!;
    const transcript = join(s.artifactDirectory, 'attached-client.ansi');
    const before = (await readFile(transcript, 'utf8')).length;
    const end = point.column + needle.length;
    await terminal.write(`\x1b[<0;${point.column+1};${point.row+1}M\x1b[<32;${end};${point.row+1}M\x1b[<0;${end};${point.row+1}m`);
    const copies = await s.waitFor('native reader copy', async () => [
      ...(await readFile(transcript,'utf8')).slice(before).matchAll(/\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)/g),
    ].map(match => Buffer.from(match[1]!,'base64').toString()), values => values.length > 0);
    assert.deepEqual(copies, [needle]);
    await s.keys(s.panes.detail, 'c');
    await s.waitVisible(s.panes.detail, 'Comment');
    await s.text(s.panes.detail, 'Discuss the second occurrence');
    await terminal.write('\x13');
    const threads = await s.waitFor('one saved passage thread', () => s.client.request<AnnotationThread[]>({
      action:'annotations.list', query:{subject:{kind:'block',blockId:host.id},includeResolved:true},
    }), values => values.some(thread => thread.body === 'Discuss the second occurrence'));
    assert.equal(threads.length, 1);
    const thread = threads[0]!;
    const passage = thread.originalTarget.passage;
    assert.ok(passage, 'The native reader copy must reach the persisted passage contract');
    assert.equal(passage.quote, needle);
    const fragment = passage.fragments.find(fragment => fragment.kind === 'source');
    assert.ok(fragment?.kind === 'source' && fragment.occurrence);
    assert.equal(passage.documents[fragment.slices[0]!.document]!.subject.kind, 'block');
    assert.deepEqual(passage.documents[fragment.slices[0]!.document]!.subject, {kind:'block',blockId:source.id});
    assert.equal(fragment.occurrence.host.anchor.start, host.text.lastIndexOf('!(('));
    assert.equal(thread.currentResolution.status, 'resolved');
    const marked = await s.waitFor('only the selected occurrence marked', () => s.visible(s.panes.detail), frame => {
      const rows = frame.split('\n').filter(line => line.includes(needle));
      return rows.length === 2 && !/^[+−] /.test(rows[0]!) && /^[+−] /.test(rows[1]!);
    });
    await s.checkpoint('02-persisted-occurrence-marker');
    const clickSharedHeading=async(symbol:'▾'|'▸',offset=2)=>{
      const screen=await s.waitFor('shared heading control visible',terminal.visible,text=>text.includes(`${symbol} Shared material`));
      const lines=screen.split('\n'),row=lines.findIndex(line=>line.includes(`${symbol} Shared material`));
      const column=visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf(`${symbol} Shared material`)))+offset;
      await terminal.write(`\x1b[<0;${column+1};${row+1}M\x1b[<0;${column+1};${row+1}m`);
    };
    for(const remaining of [1,0]){
      await clickSharedHeading('▾');
      await s.waitFor('collapsed occurrence hides its task',()=>s.visible(s.panes.detail),text=>text.split('\n').filter(line=>line.includes(needle)).length===remaining);
    }
    await s.checkpoint('02b-folded-occurrences');
    await s.keys(s.panes.detail, ']');
    await s.waitVisible(s.panes.detail, 'Discuss the second occurrence');
    const revealed=await s.visible(s.panes.detail);
    assert.equal(revealed.split('\n').filter(line=>line.includes(needle)).length,1);
    assert.ok(revealed.includes('▸ Shared material'),'The other occurrence remains collapsed');
    await s.checkpoint('03-thread-open');
    // Use the disclosure glyph here: a rapid repeat on "Shared" is the
    // terminal's deliberate double-click word-selection gesture.
    await clickSharedHeading('▾',0);
    await s.waitFor('selected thread can be folded again',()=>s.visible(s.panes.detail),text=>
      !text.split('\n').some(line=>line.includes('- [ ] '+needle)||line.includes('[ ] '+needle)));
    await s.keys(s.panes.detail, ']');
    await s.waitFor('returning to the same thread reopens only its occurrence',()=>s.visible(s.panes.detail),text=>
      text.includes('Discuss the second occurrence')&&text.includes('▸ Shared material')&&
      text.split('\n').filter(line=>line.includes('[ ] '+needle)).length===1);
    await s.checkpoint('03b-same-thread-reopened');
    await clickSharedHeading('▸');
    await s.waitFor('sibling explicitly restored',()=>s.visible(s.panes.detail),text=>text.split('\n').filter(line=>line.includes(needle)).length===2);
    assert.equal((await s.client.request<Block>({action:'get',blockId:host.id})).text, host.text);
    const assigned = await s.client.request<Block>({action:'get',blockId:source.id});
    const item = checklistItems(assigned.text)[0]!;
    assert.equal(item.identity, 'unique');
    assert.equal(assigned.revision, source.revision + 1);
    assert.equal(assigned.text.replace(` ^${item.itemId}`, ''), source.text);
    assert.equal(fragment.slices[0]!.listItemId, item.itemId);
    const changed = await s.client.request<Block>({action:'update',blockId:source.id,expectedRevision:assigned.revision,
      text:assigned.text.replace('Repeated passage','Replacement wording'), mutation:{author:'user'}});
    await s.waitVisible(s.panes.detail, 'Replacement wording');
    await s.waitVisible(s.panes.detail, 'task attachment');
    await s.waitVisible(s.panes.detail, 'Repeated passage'); // Original quoted words, not a fabricated match.
    const attached = await s.waitFor('changed task keeps second occurrence attachment', () => s.visible(s.panes.detail), frame => {
      const rows = frame.split('\n').filter(line => line.includes('Replacement wording'));
      return rows.length === 2 && !/^[+−] /.test(rows[0]!) && /^− /.test(rows[1]!);
    });
    await s.checkpoint('04-reworded-task-attachment');
    const resource=await s.client.request<InternResourceReceipt>({action:'resources.follow-authored',
      reference:{kind:'filesystem',path:'resource-passage.md'}});
    const resourceToken='[file::resource-passage.md]';
    const resourceHost=await s.client.request<Block>({action:'create',text:`First ${resourceToken}.\nSecond ${resourceToken}.`});
    const secondContext=createAnnotationReferenceContext(resourceHost,resourceHost.text.lastIndexOf(resourceToken),resourceHost.text.lastIndexOf(resourceToken)+resourceToken.length);
    const openResource=async(referenceContext:ReturnType<typeof createAnnotationReferenceContext>)=>s.client.request({
      action:'navigation.dispatch',sourceClientId:tree.clientId,sourceRegion:'tree',intent:'open',
      target:{kind:'resource',resourceId:resource.resource.id,referenceContext},destination:{clientId:detail.clientId,region:'detail'}});
    await openResource(secondContext);
    await s.waitVisible(s.panes.detail,'Stable quote & tail');
    const resourceText='Stable quote & tail';
    const resourcePoint=await s.waitFor('Resource rendered passage in attached client',async()=>{
      const screen=await terminal.visible(),lines=screen.split('\n');
      const row=lines.findIndex(line=>line.includes(resourceText));
      return row<0?null:{row,column:visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf(resourceText)))};
    },point=>!!point);
    const resourceBefore=(await readFile(transcript,'utf8')).length;
    await terminal.write(`\x1b[<0;${resourcePoint!.column+1};${resourcePoint!.row+1}M\x1b[<32;${resourcePoint!.column+resourceText.length};${resourcePoint!.row+1}M\x1b[<0;${resourcePoint!.column+resourceText.length};${resourcePoint!.row+1}m`);
    const resourceCopies=await s.waitFor('Resource rendered clipboard',async()=>[
      ...(await readFile(transcript,'utf8')).slice(resourceBefore).matchAll(/\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)/g),
    ].map(match=>Buffer.from(match[1]!,'base64').toString()),values=>values.length>0);
    assert.deepEqual(resourceCopies,[resourceText]);
    await s.keys(s.panes.detail,'c');
    await s.waitVisible(s.panes.detail,'Comment');
    await s.text(s.panes.detail,'Resource transformed passage');
    await s.waitFor('composer highlights the captured Resource passage',()=>s.visible(s.panes.detail),text=>
      text.split('\n').some(line=>line.includes('▐ ')&&line.includes(resourceText)));
    await s.checkpoint('05-resource-composer-highlight');
    await terminal.write('\x13');
    const resourceThreads=await s.waitFor('Resource passage persisted',()=>s.client.request<AnnotationThread[]>({
      action:'annotations.list',query:{subject:{kind:'resource',resourceId:resource.resource.id},includeResolved:true},
    }),values=>values.some(thread=>thread.body==='Resource transformed passage'));
    const resourceThread=resourceThreads.find(thread=>thread.body==='Resource transformed passage')!;
    assert.equal(resourceThread.originalTarget.passage?.quote,resourceText);
    const sourceSlices=resourceThread.originalTarget.passage!.fragments.flatMap(fragment=>fragment.kind==='source'?fragment.slices:[]);
    assert.deepEqual(sourceSlices.map(slice=>[slice.anchor.start,slice.anchor.end,slice.anchor.exact]),
      [[20,27,'Stable '],[29,34,'quote'],[36,47,' &amp; tail']]);
    assert.equal(resourceThread.currentResolution.status,'resolved');
    assert.deepEqual(resourceThread.originalTarget.referenceContext,secondContext);
    await s.keys(s.panes.detail,']');
    await s.waitVisible(s.panes.detail,'Resource transformed passage');
    await s.checkpoint('05-resource-rendered-passage');
    const shiftedHost=await s.client.request<Block>({action:'update',blockId:resourceHost.id,expectedRevision:resourceHost.revision,
      text:'Added heading\n\n'+resourceHost.text,mutation:{author:'user'}});
    const shiftedContext=createAnnotationReferenceContext(shiftedHost,shiftedHost.text.lastIndexOf(resourceToken),shiftedHost.text.lastIndexOf(resourceToken)+resourceToken.length);
    const firstContext=createAnnotationReferenceContext(shiftedHost,shiftedHost.text.indexOf(resourceToken),shiftedHost.text.indexOf(resourceToken)+resourceToken.length);
    await openResource(firstContext);
    await s.waitFor('another reference does not borrow the comment marker',()=>s.visible(s.panes.detail),text=>
      text.includes('Unpositioned comments (1)')&&!/^[+−] Stable quote/m.test(text));
    await s.checkpoint('06-resource-other-reference');
    await openResource(shiftedContext);
    await s.waitFor('shifted reference keeps the passage marker',()=>s.visible(s.panes.detail),text=>/^[+−] Stable quote/m.test(text));
    const shiftedThread=(await s.client.request<AnnotationThread[]>({action:'annotations.list',
      query:{subject:{kind:'resource',resourceId:resource.resource.id},includeResolved:true}})).find(thread=>thread.block.id===resourceThread.block.id)!;
    assert.deepEqual(shiftedThread.resolvedTarget?.referenceContext,shiftedContext);
    assert.deepEqual(shiftedThread.originalTarget.referenceContext,secondContext);
    await s.checkpoint('07-resource-shifted-reference');

    await s.keys(s.panes.detail,'?');await s.waitVisible(s.panes.detail,'Find:');
    await s.text(s.panes.detail,'Inspect rendered provenance');
    await s.waitVisible(s.panes.detail,'Inspect rendered provenance');
    await s.keys(s.panes.detail,'enter');
    await s.waitVisible(s.panes.detail,'Provenance · frozen reader frame');
    // Traverse actual painted rows. Blank/gutter cells must stay generated.
    let inspector=await s.visible(s.panes.detail);
    for(let row=0;row<12&&!inspector.includes('Cell row 3,');row++){
      await s.keys(s.panes.detail,'down');inspector=await s.visible(s.panes.detail);
    }
    // Click the decoded ampersand in the inspector's frozen context strip.
    const inspectorPoint=await s.waitFor('inspector context strip in attached terminal',async()=>{
      const screen=await terminal.visible(),lines=screen.split('\n');
      const header=lines.findIndex(line=>line.includes('Provenance · frozen reader frame'));
      const row=lines.findIndex((line,row)=>row>header&&row<header+5&&line.includes(resourceText));
      return row<0?null:{row,column:visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf(resourceText)))+13};
    },point=>!!point);
    await terminal.write(`\x1b[<0;${inspectorPoint!.column+1};${inspectorPoint!.row+1}M\x1b[<0;${inspectorPoint!.column+1};${inspectorPoint!.row+1}m`);
    await s.waitVisible(s.panes.detail,'Slice 1 UTF-16 [37, 42)');
    await s.waitVisible(s.panes.detail,'Source: "&amp;"');
    await s.waitVisible(s.panes.detail,resource.resource.id);
    await s.checkpoint('08-provenance-inspector-entity');
    await terminal.write('\x1b[H');
    await s.waitVisible(s.panes.detail,'Origin: generated');
    await s.checkpoint('09-provenance-inspector-generated');
    await s.keys(s.panes.detail,'ctrl+q');
    await s.waitVisible(s.panes.detail,'● Current');
    assert.equal((await s.client.request<Block>({action:'get',blockId:resourceHost.id})).text,shiftedHost.text);
    await s.client.request({action:'ui.command.send',command:{targetClientId:detail.clientId,
      command:'preview',target:{kind:'block',blockId:source.id}}});
    await s.waitVisible(s.panes.detail,'Shared material');
    await s.keys(s.panes.detail,'alt+p');
    await s.keys(s.panes.detail,'?');await s.waitVisible(s.panes.detail,'Find:');
    await s.text(s.panes.detail,'Inspect rendered provenance');
    await s.keys(s.panes.detail,'enter');
    await s.waitVisible(s.panes.detail,'Provenance · frozen reader frame');
    await s.keys(s.panes.detail,'right','right','right','right');
    await s.waitVisible(s.panes.detail,source.id);
    const previewInspection=await s.visible(s.panes.detail);
    assert.ok(!previewInspection.includes(resource.resource.id),'Focused Preview must not inspect retained Current');
    await s.checkpoint('10-provenance-inspector-preview');
    await s.keys(s.panes.detail,'e');
    await s.waitVisible(s.panes.detail,'Provenance · frozen reader frame');
    await s.keys(s.panes.detail,'ctrl+q');
    await s.waitVisible(s.panes.detail,'Shared material');
    assert.equal((await s.client.request<Block>({action:'get',blockId:source.id})).text,changed.text);



    await s.keys(s.panes.detail,'shift+f7');
    const legacy=await s.client.request<Block>({action:'create',text:'# Legacy exact comment\n\n'+
      'A longer paragraph establishes enough ordinary context to wrap well before the quoted words. '.repeat(3)+'TARGET passage ends here.'});
    const legacyStart=legacy.text.indexOf('TARGET');
    await s.client.request({action:'annotations.create',requestId:crypto.randomUUID(),input:{
      target:{representation:blockAnnotationRepresentation(legacy),anchor:createTextQuoteAnchor(legacy.text,legacyStart,legacyStart+6)},
      body:'Existing exact comment follows its visible word.',source:'agent'}});
    await s.client.request({action:'navigation.dispatch',sourceClientId:tree.clientId,sourceRegion:'tree',intent:'open',
      target:{kind:'block',blockId:legacy.id},destination:{clientId:detail.clientId,region:'detail'}});
    for(const columns of [220,160]){
      await terminal.resize(columns,65);
      await s.waitFor('legacy comment marks the actual wrapped quote',()=>s.visible(s.panes.detail),text=>{
        const lines=text.split('\n');
        return !!lines.find(line=>line.startsWith('+ ')&&line.includes('TARGET'))&&
          !lines.find(line=>line.startsWith('+ ')&&line.includes('A longer paragraph establishes'));
      });
    }
    await s.checkpoint('11-legacy-exact-wrapped-quote');
    await s.keys(s.panes.detail,']');
    await s.waitVisible(s.panes.detail,'Existing exact comment follows');
    await s.checkpoint('12-legacy-exact-open');
    assert.equal((await s.client.request<Block>({action:'get',blockId:legacy.id})).text,legacy.text);

    const component = await s.client.request<Block>({action:'create', text:
      '# Responsive summary\n\n```component:status\nTo do :: 4\n[Waiting for review](https://example.test/review) :: 4\nDone 界 :: 5\n```\n\n'+
      '| Stage | Count |\n| --- | ---: |\n| Waiting | 4 |\n| Done | 5 |'});
    await s.client.request({action:'navigation.dispatch',sourceClientId:tree.clientId,sourceRegion:'tree',intent:'open',
      target:{kind:'block',blockId:component.id},destination:{clientId:detail.clientId,region:'detail'}});
    await terminal.resize(260, 65);
    await s.waitVisible(s.panes.detail, 'To do: 4 · Waiting for review: 4 · Done 界: 5');
    await s.checkpoint('13-status-panel-wide');
    await terminal.resize(100, 65);
    await s.waitFor('status panel stacks without losing values',()=>s.visible(s.panes.detail),text=>
      text.includes('To do: 4')&&text.includes('Waiting for review: 4')&&text.includes('Done 界: 5')&&!text.includes(' · Waiting'));
    await s.checkpoint('14-status-panel-narrow');
    await s.client.request({action:'ui.command.send', command:{targetClientId:tree.clientId, command:'preview',
      target:{kind:'block',blockId:component.id}}});
    await s.waitVisible(s.panes.tree, 'Waiting for review: 4');
    await s.checkpoint('15-status-panel-tree-preview');
    await s.focus(s.panes.detail);
    const componentQuote = 'Done 界: 5';
    const componentPoint = await s.waitFor('status value on the attached Detail', async () => {
      const lines = (await terminal.visible()).split('\n');
      const header = lines.findIndex(line => line.includes('● Current'));
      const row = lines.findIndex((line, row) => row > header && line.includes(componentQuote));
      return row < 0 ? null : {row, column: visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf(componentQuote)))};
    }, point => !!point);
    const componentBefore = (await readFile(transcript, 'utf8')).length;
    const componentEnd = componentPoint!.column + visibleWidth(componentQuote);
    await terminal.write(`\x1b[<0;${componentPoint!.column+1};${componentPoint!.row+1}M\x1b[<32;${componentEnd};${componentPoint!.row+1}M\x1b[<0;${componentEnd};${componentPoint!.row+1}m`);
    const componentCopies = await s.waitFor('component clipboard', async () => [
      ...(await readFile(transcript,'utf8')).slice(componentBefore).matchAll(/\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)/g),
    ].map(match => Buffer.from(match[1]!, 'base64').toString()), values => values.length > 0);
    assert.deepEqual(componentCopies, [componentQuote]);
    await s.keys(s.panes.detail, 'c');
    await s.waitVisible(s.panes.detail, 'Comment');
    await s.text(s.panes.detail, 'Status value source evidence');
    await terminal.write('\x13');
    const componentThreads = await s.waitFor('component annotation saved', () => s.client.request<AnnotationThread[]>({
      action:'annotations.list',query:{subject:{kind:'block',blockId:component.id},includeResolved:true},
    }), values => values.some(thread => thread.body === 'Status value source evidence'));
    const componentThread = componentThreads.find(thread => thread.body === 'Status value source evidence')!;
    assert.equal(componentThread.originalTarget.passage?.quote, componentQuote);
    const componentSlices = componentThread.originalTarget.passage!.fragments.flatMap(fragment =>
      fragment.kind === 'source' ? fragment.slices.map(slice => slice.anchor.exact) : []);
    assert.deepEqual(componentSlices, ['Done 界', '5']);
    await s.waitFor('component comment reaches the reader',()=>s.visible(s.panes.detail),text=>/^\+ Done 界: 5/m.test(text));
    await s.keys(s.panes.detail, ']');
    await s.waitVisible(s.panes.detail, 'Status value source evidence');
    await s.checkpoint('16-status-panel-comment');
    await s.record('component-passage-evidence', {componentCopies, componentThread, componentSlices});
    assert.equal((await s.client.request<Block>({action:'get',blockId:component.id})).text,component.text);

    const plan=await s.client.request<Block>({action:'create',text:'# Nested plan [project::result-proof]\n\n- [ ] Parent [owner::alex] ^parent\n  - [ ] Child [owner::alex] ^child'});
    const view=await s.client.request<Block>({action:'create',text:'# Selected results\n[type::checklist-view] [plans::project=result-proof] [query::owner=alex]'});
    await s.client.request({action:'navigation.dispatch',sourceClientId:tree.clientId,sourceRegion:'tree',intent:'open',
      target:{kind:'block',blockId:view.id},destination:{clientId:detail.clientId,region:'detail'}});
    const resultPoint=await s.waitFor('nested result appears twice',async()=>{
      const screen=await terminal.visible(),pane=await s.visible(s.panes.detail);
      const positions=(text:string)=>{
        const lines=text.split('\n'),header=lines.findIndex(line=>line.includes('● Current'));
        const row=lines.flatMap((line,row)=>row>header&&line.includes('Child')?[row]:[])[1];
        return row===undefined?null:{row,header,column:visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf('Child')))};
      };
      const point=positions(screen),local=positions(pane);
      return point&&local&&point.row-point.header===local.row-local.header?point:null;
    },point=>!!point);
    await terminal.write(`\x1b[<0;${resultPoint!.column+1};${resultPoint!.row+1}M\x1b[<32;${resultPoint!.column+5};${resultPoint!.row+1}M\x1b[<0;${resultPoint!.column+5};${resultPoint!.row+1}m`);
    await s.keys(s.panes.detail,'c');
    await s.waitVisible(s.panes.detail,'Comment');
    await s.text(s.panes.detail,'Discuss the independent child result');
    await terminal.write('\x13');
    const resultThreads=await s.waitFor('result comment persisted',()=>s.client.request<AnnotationThread[]>({
      action:'annotations.list',query:{subject:{kind:'block',blockId:view.id}},
    }),threads=>threads.some(thread=>thread.body==='Discuss the independent child result'));
    for(const columns of [220,132]) {
      await terminal.resize(columns,65);
      await s.waitFor('only independent result marked after reflow',()=>s.visible(s.panes.detail),text=>{
        const rows=text.split('\n').filter(line=>line.includes('Child'));
        const width=visibleWidth(text.split('\n')[0]!);
        return (columns===220?width>80:width<70)&&rows.length===2&&!/^[+−] /.test(rows[0]!)&&/^[+−] /.test(rows[1]!);
      });
      await s.checkpoint(`17-checklist-result-${columns}`);
    }
    assert.equal((await s.client.request<Block>({action:'get',blockId:plan.id})).text,plan.text);
    await s.record('checklist-result-evidence',{resultThreads,input:'attached-terminal drag, comment save, wide/narrow independent result gutter'});

    await s.record('resource-passage-evidence',{resourceCopies,resourceThread,shiftedThread,
      input:'attached-terminal drag over bold/entity content, clipboard, composer save and comment navigation'});
    await s.record('passage-evidence', {copies, thread, marked, assigned, changed, attached,
      input:'attached-terminal native drag, c, composer save, next comment, service rewording and live reader refresh'});
  },
});
console.log(JSON.stringify(result));
if (result.status !== 'passed') process.exitCode = 1;
