import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {expect,test} from 'bun:test';
import {stripTerminalSequences,visibleWidth,type MarkdownTheme} from '@earendil-works/pi-tui';
import {parseDetailCallouts} from '../src/detail-callouts';
import {documentFolds} from '../src/document-folds';
import {checklistControls} from '../src/checklist-controls';
import {reconcilePreviewRegions, type PreviewRegionState} from '../src/detail-preview-regions';
import {SourceSpannedMarkdown} from '../src/source-spanned-markdown';
import {atomicDocument,concatDocuments,generatedDocument,observeDocument,sourceDocument,withDocumentOccurrence,type DocumentOrigin,type MappedDocument} from '../src/document-provenance';
const plain=(s:string)=>s;
const theme:MarkdownTheme={heading:plain,link:plain,linkUrl:plain,code:plain,codeBlock:plain,codeBlockBorder:plain,quote:plain,quoteBorder:plain,hr:plain,listBullet:plain,bold:plain,italic:plain,strikethrough:plain,underline:plain};
function reader(document:MappedDocument,width:number) {
  const component=new SourceSpannedMarkdown(theme,plain,undefined,false,undefined,true);
  component.setContent(document,[],false);
  component.render(width);
  expect(component.renderedFrame).not.toBeNull();
  return {component,frame:component.renderedFrame!};
}
function ranges(origins:readonly DocumentOrigin[]) {
  return origins.flatMap(origin=>origin.kind==='source'?origin.slices.map(slice=>[slice.start,slice.end]):[]);
}

test('the real Markdown reader emits visible grapheme cells and exact escape/code/source evidence together',()=>{
  const text='**A界** é 👩‍💻 \\* ` a\nb `';
  const observed=observeDocument({kind:'block',blockId:'synthetic-reader'},text,4);
  const {frame}=reader(sourceDocument(observed),50);
  expect(frame.lines.map(line=>stripTerminalSequences(line).trimEnd())).toEqual(['A界 é 👩‍💻 * a b']);
  expect(frame.inspect({row:0,column:1})?.text).toBe('界');
  expect(frame.inspect({row:0,column:2})?.text).toBe('界');
  expect(ranges(frame.select({row:0,column:2},{row:0,column:3}).origins)).toEqual([[3,4]]);
  expect(frame.select({row:0,column:2},{row:0,column:3}).text).toBe('界');
  expect(frame.select({row:0,column:2},{row:0,column:2}).text).toBe('');
  const emoji=frame.cells.find(cell=>cell.text==='👩‍💻')!;
  expect(emoji.width).toBe(2);
  expect(ranges(emoji.origins)).toEqual([[10,15]]);
  const escaped=frame.cells.find(cell=>cell.text==='*')!;
  expect(ranges(escaped.origins)).toEqual([[16,18]]);
  const codeSpace=frame.cells.find(cell=>cell.text===' '&&cell.styles.includes('code'))!;
  expect(ranges(codeSpace.origins)).toEqual([[22,23]]);
  const padding=frame.inspect({row:0,column:49})!;
  expect(padding.origins).toEqual([{kind:'generated',reason:'layout padding'}]);
  expect(frame.select({row:0,column:48},{row:0,column:50}).text).toBe('');
});

test('linear and rectangular selection reduce the same wrapped frame without enclosing hidden source gaps',()=>{
  const text='abcd efgh\nijkl mnop';
  const {component,frame}=reader(sourceDocument(observeDocument({kind:'block',blockId:'synthetic-selection'},text,1)),9);
  expect(frame.lines).toEqual(['abcd efgh','ijkl mnop']);
  const start={row:0,column:2},end={row:1,column:7};
  expect(frame.select(start,end).text).toBe('cd efgh\nijkl mn');
  expect(ranges(frame.select(start,end).origins)).toEqual([[2,9],[10,17]]);
  expect(frame.select(start,end,'rectangular').text).toBe('cd ef\nkl mn');
  expect(ranges(frame.select(start,end,'rectangular').origins)).toEqual([[2,7],[12,17]]);
  component.render(5);
  expect(component.renderedFrame!.lines.map(line=>line.trimEnd())).toEqual(['abcd','efgh','ijkl','mnop']);
  expect(frame.lines).toEqual(['abcd efgh','ijkl mnop']); // Prior captures survive resize.
});

test('entity decoding consumes exact authored spans without decoding code or executing terminal controls',()=>{
  const text='&amp; &#x1F600; &NotEqualTilde; e&#769; `&amp;` \\&amp; &bogus; &copy';
  const {component,frame}=reader(sourceDocument(observeDocument({kind:'block',blockId:'synthetic-entities'},text)),90);
  expect(frame.lines.map(line=>line.trimEnd())).toEqual(['& 😀 ≂̸ é &amp; &amp; &bogus; &copy']);
  expect(ranges(frame.cells.find(cell=>cell.text==='😀')!.origins)).toEqual([[6,15]]);
  expect(ranges(frame.cells.find(cell=>cell.text==='≂̸')!.origins)).toEqual([[16,31]]);
  expect(ranges(frame.cells.find(cell=>cell.text==='é')!.origins)).toEqual([[32,33],[33,39]]);
  expect(frame.select({row:0,column:0},{row:0,column:1}).text).toBe('&');
  expect(ranges(frame.select({row:0,column:0},{row:0,column:1}).origins)).toEqual([[0,5]]);
  component.render(8);
  expect(component.renderedFrame!.cells.find(cell=>cell.text==='😀')?.origins).toEqual(frame.cells.find(cell=>cell.text==='😀')!.origins);
  const hostile='a&#27;[31mb &Tab;c &#27;]52;c;payload&#7;d';
  const safe=reader(sourceDocument(observeDocument({kind:'block',blockId:'synthetic-encoded-controls'},hostile)),40).frame;
  expect(safe.lines.map(line=>line.trimEnd())).toEqual(['ab     c d']);
  expect(safe.lines.join('')).not.toContain('\x1b');
  const d=safe.cells.find(cell=>cell.text==='d')!;
  expect(ranges(d.origins)).toEqual([[hostile.length-1,hostile.length]]);
  const split=reader(concatDocuments([
    sourceDocument(observeDocument({kind:'block',blockId:'synthetic-entity-left'},'&am')),
    sourceDocument(observeDocument({kind:'block',blockId:'synthetic-entity-right'},'p;')),
  ]),10).frame;
  expect(split.select({row:0,column:0},{row:0,column:1}).text).toBe('&');
  expect(split.cells[0]!.origins.filter(origin=>origin.kind==='source').map(origin=>origin.slices.map(slice=>[slice.document.subject,slice.start,slice.end]))).toEqual([
    [[{kind:'block',blockId:'synthetic-entity-left'},0,3]],
    [[{kind:'block',blockId:'synthetic-entity-right'},0,2]],
  ]);
});

test('images retain authored alt labels and link identity through wrapping, nesting and reference definitions',()=>{
  const text='![**chart** &amp; \\[one\\]](https://example.test/image.png)\n\n[![thumb][picture]](https://example.test/page)\n\n[picture]: https://example.test/thumb.png\n\n![](https://example.test/empty.png)';
  const {component,frame}=reader(sourceDocument(observeDocument({kind:'block',blockId:'synthetic-images'},text)),50);
  expect(frame.lines.map(line=>line.trimEnd())).toEqual(['chart & [one]','','thumb','','Image']);
  expect(ranges(frame.select({row:0,column:0},{row:0,column:5}).origins)).toEqual([[4,9]]);
  expect(ranges(frame.cells.find(cell=>cell.text==='&')!.origins)).toEqual([[12,17]]);
  expect(ranges(frame.cells.find(cell=>cell.text==='[')!.origins)).toEqual([[18,20]]);
  expect(component.renderedLinks.map(link=>link.uri)).toEqual(['https://example.test/image.png','https://example.test/page','https://example.test/empty.png']);
  const originalIds=component.renderedLinks.map(link=>link.occurrenceId);
  component.render(6);
  expect(new Set(component.renderedLinks.map(link=>link.occurrenceId))).toEqual(new Set(originalIds));
  expect(component.renderedFrame!.cells.filter(cell=>cell.text==='&').map(cell=>ranges(cell.origins))).toEqual([[[12,17]]]);
});

test('repeated embedded text keeps separate host occurrences and immutable captured observations',()=>{
  const observed=observeDocument({kind:'block',blockId:'synthetic-source'},'repeat',3);
  const host=observeDocument({kind:'block',blockId:'synthetic-host'},'one two',1);
  const parts=[0,4].map(start=>{
    const token={document:host,start,end:start+3};
    return withDocumentOccurrence(sourceDocument(observed),{host:token,path:[{token,target:'synthetic-source'}]});
  });
  const {frame}=reader(concatDocuments([parts[0]!,generatedDocument('\n','occurrence separator'),parts[1]!]),10);
  observed.revision=99;
  const selection=frame.select({row:0,column:0},{row:1,column:6});
  expect(selection.text).toBe('repeat\nrepeat');
  const origins=selection.origins.filter(origin=>origin.kind==='source');
  expect(origins.map(origin=>origin.occurrence!.host.start)).toEqual([0,4]);
  expect(origins.map(origin=>origin.slices.map(slice=>[slice.start,slice.end,slice.document.revision]))).toEqual([[[0,6,3]],[[0,6,3]]]);
});

test('identical Resource text at distinct provider revisions never shares source ownership',()=>{
  const observed=observeDocument({kind:'resource',resourceId:'synthetic-resource'},'same');
  const content=[1,2].map(revision=>sourceDocument({...observed,resource:{
    revision:{resourceId:'synthetic-resource',addressVersion:1,revision:{kind:'filesystem' as const,mtimeNs:String(revision),size:'4'}},
    adapter:{id:'filesystem.text',version:1},capturedAt:'2026-01-01T00:00:00Z',
  }}));
  const {frame}=reader(concatDocuments(content),8);
  const selection=frame.select({row:0,column:0},{row:0,column:8});
  expect(selection.text).toBe('samesame');
  const origins=selection.origins.filter(origin=>origin.kind==='source');
  expect(origins).toHaveLength(2);
  expect(origins.map(origin=>origin.slices.map(slice=>[slice.start,slice.end,slice.document.resource?.revision.revision]))).toEqual([
    [[0,4,{kind:'filesystem',mtimeNs:'1',size:'4'}]],[[0,4,{kind:'filesystem',mtimeNs:'2',size:'4'}]],
  ]);
  expect(frame.firstRowForOrigins(sourceDocument(observed).runs.map(run=>run.origin))).toBeUndefined();
});

test('link geometry is emitted from cells and distinguishes the same label in separate paragraphs',()=>{
  const text='[same](https://example.test/a)\n\n[same](https://example.test/a)';
  const {component,frame}=reader(sourceDocument(observeDocument({kind:'block',blockId:'synthetic-links'},text)),12);
  expect(frame.lines.map(line=>line.trimEnd())).toEqual(['same','','same']);
  expect(component.renderedLinks.map(link=>[link.row,link.column,link.width,link.label])).toEqual([[0,0,4,'same'],[2,0,4,'same']]);
  expect(new Set(component.renderedLinks.map(link=>link.occurrenceId)).size).toBe(2);
  expect(ranges(frame.select({row:2,column:0},{row:2,column:4}).origins)).toEqual([[33,37]]);
});

test('nested checklist layout retains authored item ownership through hanging wraps and continuation prefixes',()=>{
  const text='- [x] parent words wrap\n  continuation\n  - child\n\n- sibling';
  const {frame}=reader(sourceDocument(observeDocument({kind:'block',blockId:'synthetic-list'},text)),20);
  expect(frame.lines.map(line=>line.trimEnd())).toEqual(['- [x] parent words','      wrap','      continuation','    - child','','- sibling']);
  const child=frame.cells.find(cell=>cell.row===3&&cell.text==='c')!;
  expect(ranges(child.origins)).toEqual([[43,44]]);
  expect(frame.select({row:3,column:6},{row:3,column:11}).text).toBe('child');
  expect(ranges(frame.select({row:3,column:6},{row:3,column:11}).origins)).toEqual([[43,48]]);
  expect(frame.inspect({row:0,column:0})?.origins).toEqual([{kind:'generated',reason:'list marker'}]);
  expect(frame.inspect({row:1,column:2})?.origins).toEqual([{kind:'generated',reason:'list continuation'}]);
  expect(frame.select({row:1,column:0},{row:2,column:18}).text).toBe('wrap\ncontinuation');
});

test('quote borders and lazy continuation keep source cells separate from presentation prefixes',()=>{
  const text='> alpha\n> **same**\nlazy\n>\n> - child';
  const {frame}=reader(sourceDocument(observeDocument({kind:'block',blockId:'synthetic-quote'},text)),20);
  expect(frame.lines.map(line=>line.trimEnd())).toEqual(['│ alpha','│ same','│ lazy','│','│ - child']);
  expect(frame.select({row:0,column:0},{row:2,column:20}).text).toBe('alpha\nsame\nlazy');
  expect(ranges(frame.select({row:1,column:2},{row:1,column:6}).origins)).toEqual([[12,16]]);
  expect(frame.inspect({row:0,column:0})?.origins).toEqual([{kind:'generated',reason:'quote border'}]);
});

test('fenced and indented code retain UTF-16 offsets and highlighting without making fences copyable',()=>{
  const text='```js\r\nconst 界 = 1;\r\n```\r\n';
  const mapped=sourceDocument(observeDocument({kind:'block',blockId:'synthetic-code'},text));
  const component=new SourceSpannedMarkdown({...theme,highlightCode:code=>code.split('\n').map(line=>`\x1b[32m${line}\x1b[0m`)},plain);
  component.setContent(mapped,[],false);component.render(24);
  const frame=component.renderedFrame!;expect(frame).not.toBeNull();
  expect(frame.lines.map(line=>stripTerminalSequences(line).trimEnd())).toEqual(['```js','  const 界 = 1;','```']);
  expect(frame.lines[1]).toContain('\x1b[32m');
  expect(frame.select({row:0,column:0},{row:2,column:24}).text).toBe('const 界 = 1;');
  expect(ranges(frame.cells.find(cell=>cell.text==='界')!.origins)).toEqual([[13,14]]);
  const indented=reader(sourceDocument(observeDocument({kind:'block',blockId:'synthetic-indent'},'    x\n    y')),10).frame;
  expect(indented.select({row:0,column:0},{row:3,column:10}).text).toBe('x\ny');
  expect(ranges(indented.select({row:0,column:0},{row:3,column:10}).origins)).toEqual([[4,5],[10,11]]);
});


test('folding and task controls preserve source anchors while removing hidden content and disclosure glyphs from copy',()=>{
  const text='# Plan\n- [X] alpha\n  continuation\n- [~] beta\n## Later\nsecret';
  const observed=observeDocument({kind:'block',blockId:'synthetic-fold-task'},text,7);
  const state:PreviewRegionState={regions:[],focusedRegionId:null,disclosureOverrides:new Map()};
  const folds=documentFolds(text),controls=checklistControls({id:'synthetic-fold-task',text,revision:7});
  reconcilePreviewRegions(state,[...folds,...controls]);
  const component=new SourceSpannedMarkdown(theme,plain,state,false,undefined,true);
  component.setContent(sourceDocument(observed),[],false,[],folds,controls);
  component.render(32);
  const expanded=component.renderedFrame!;expect(expanded).not.toBeNull();
  const alpha=expanded.cells.find(cell=>cell.text==='a'&&ranges(cell.origins)[0]?.[0]===13)!;
  expect(alpha).toBeDefined();
  expect(ranges(expanded.select({row:alpha.row,column:alpha.column},{row:alpha.row,column:alpha.column+5}).origins)).toEqual([[13,18]]);
  const mark=expanded.cells.find(cell=>cell.text==='x')!;
  expect(ranges(mark.origins)).toEqual([[10,11]]);
  expect(mark.link?.uri).toContain('checklist');
  expect(expanded.select({row:0,column:0},{row:expanded.lines.length-1,column:32}).text).not.toContain('▾');
  const later=folds.find(fold=>fold.sourceSpan!.startLine===4)!;
  state.disclosureOverrides.set(later.id,false);
  component.render(18);
  const collapsed=component.renderedFrame!;
  const copy=collapsed.select({row:0,column:0},{row:collapsed.lines.length-1,column:18}).text;
  expect(copy).toContain('[x] alpha');
  expect(copy).toContain('[~] beta');
  expect(copy).not.toContain('secret');
  expect(copy).not.toContain('▸');
  expect(expanded.select({row:0,column:0},{row:expanded.lines.length-1,column:32}).text).toContain('secret');
  const beta=collapsed.cells.find(cell=>cell.text==='b')!;
  expect(ranges(beta.origins)).toEqual([[40,41]]);
});


test('table cells preserve escaped pipes and empty rows through grid/card resize without anchoring borders',()=>{
  const text='| Name | Value |\n| :--- | ---: |\n| **One** | a\\|b |\n| | [next](https://example.test/next) |\n| Three | `c\\|d` |';
  const {component,frame}=reader(sourceDocument(observeDocument({kind:'block',blockId:'synthetic-table'},text,2)),60);
  expect(frame.lines.map(line=>line.trimEnd())).toEqual([
    '┌───────┬───────┐','│ Name  │ Value │','├───────┼───────┤',
    '│ One   │   a|b │','├───────┼───────┤','│       │  next │',
    '├───────┼───────┤','│ Three │   c|d │','└───────┴───────┘']);
  const pipe=text.indexOf('a\\|b')+1,codePipe=text.indexOf('c\\|d')+1;
  expect(ranges(frame.select({row:3,column:13},{row:3,column:14}).origins)).toEqual([[pipe,pipe+2]]);
  expect(frame.select({row:3,column:13},{row:3,column:14}).text).toBe('|');
  expect(ranges(frame.select({row:7,column:13},{row:7,column:14}).origins)).toEqual([[codePipe,codePipe+2]]);
  expect(frame.select({row:3,column:2},{row:7,column:7},'rectangular').text).toBe('One\n\n\n\nThree');
  expect(ranges(frame.select({row:3,column:2},{row:7,column:7},'rectangular').origins)).toEqual([
    [text.indexOf('One'),text.indexOf('One')+3],[text.indexOf('Three'),text.indexOf('Three')+5]]);
  expect(frame.select({row:0,column:0},{row:0,column:17}).text).toBe('');
  expect(frame.inspect({row:0,column:0})?.origins).toEqual([{kind:'generated',reason:'table border'}]);
  const linkId=component.renderedLinks.find(link=>link.label==='next')!.occurrenceId;
  for(const width of [28,14,4]) {
    component.render(width);const current=component.renderedFrame!;expect(current).not.toBeNull();
    expect(current.lines.every(line=>visibleWidth(line)<=width)).toBe(true);
    const links=component.renderedLinks.filter(link=>link.uri==='https://example.test/next');
    expect(new Set(links.map(link=>link.occurrenceId))).toEqual(new Set([linkId]));
    expect(links.map(link=>link.label).join('')).toBe('next');
    expect(ranges(current.cells.find(cell=>cell.text==='|'&&ranges(cell.origins)[0]?.[0]===pipe)!.origins)).toEqual([[pipe,pipe+2]]);
    if(width===14) {
      const copy=current.select({row:0,column:0},{row:current.lines.length-1,column:width}).text;
      expect(copy).toContain('Name: One');expect(copy).toContain('Name: ');
      expect(copy).toContain('Value: next');expect(copy).toContain('Name: Three');
      expect(current.lines.filter(line=>line.startsWith('Row '))).toHaveLength(3);
    }
  }
});

test('table and nested prose reference links retain document definitions without copying definition syntax',()=>{
  const text='[dest]: https://example.test/shared\n\n| Item | Ref |\n| --- | --- |\n| a | [same][dest] |\n\n> - [same][dest]';
  const {component,frame}=reader(sourceDocument(observeDocument({kind:'block',blockId:'synthetic-table-refs'},text)),40);
  const links=component.renderedLinks.filter(link=>link.uri==='https://example.test/shared');
  expect(links.map(link=>link.label)).toEqual(['same','same']);
  expect(new Set(links.map(link=>link.occurrenceId)).size).toBe(2);
  expect(frame.select({row:0,column:0},{row:frame.lines.length-1,column:40}).text).not.toContain('https://');
});

test('table widths are shared across rows and wrapped selections exclude neighbouring columns and padding',()=>{
  const text='| Left | Mid | Right |\n| :--- | :---: | ---: |\n| alpha beta gamma | z | 7 |\n| a | abc | 12345 |';
  const {component,frame}=reader(sourceDocument(observeDocument({kind:'block',blockId:'synthetic-table-wrap'},text)),29);
  expect(frame.lines.map(line=>line.trimEnd())).toEqual([
    '┌─────────────┬─────┬───────┐','│ Left        │ Mid │ Right │','├─────────────┼─────┼───────┤',
    '│ alpha beta  │  z  │     7 │','│ gamma       │     │       │','├─────────────┼─────┼───────┤',
    '│ a           │ abc │ 12345 │','└─────────────┴─────┴───────┘']);
  const left=frame.select({row:3,column:2},{row:4,column:13},'rectangular');
  expect(left.text).toBe('alpha beta\ngamma');
  const start=text.indexOf('alpha');
  expect(ranges(left.origins)).toEqual([[start,start+10],[start+11,start+16]]);
  expect(left.text).not.toContain('z');expect(left.text).not.toContain('│');
  component.render(8);
  const narrow=component.renderedFrame!;
  expect(narrow.lines.every(line=>visibleWidth(line)<=8)).toBe(true);
  const authored=narrow.cells.filter(cell=>cell.origins.some(origin=>origin.kind==='source'&&origin.slices.some(slice=>slice.start>=start&&slice.end<=start+16))).map(cell=>cell.text).join('');
  expect(authored.replaceAll(' ','')).toBe('alphabetagamma');
  const second=text.lastIndexOf('| a |')+2;
  const secondRow=narrow.cells.find(cell=>cell.text==='a'&&ranges(cell.origins)[0]?.[0]===second)!.row;
  expect(component.sourceLineRow(8,4)).toBe(secondRow);
});


test('nested callouts expose authored title/body cells and generated chrome through disclosure and narrow resize',()=>{
  const text='Before\n\n> [!note]+ Outer\n> **alpha**\n> > [!tip]- Inner\n> > hidden\n> tail\n\nAfter';
  const state:PreviewRegionState={regions:[],focusedRegionId:null,disclosureOverrides:new Map()};
  const callouts=parseDetailCallouts(text);reconcilePreviewRegions(state,callouts);
  const component=new SourceSpannedMarkdown(theme,value=>`\x1b[48;5;236m${value}\x1b[0m`,state,false,undefined,true);
  component.setContent(sourceDocument(observeDocument({kind:'block',blockId:'synthetic-callouts'},text,3)),[{startLine:3,endLine:3}],true,callouts);
  component.render(32);const first=component.renderedFrame!;expect(first).not.toBeNull();
  expect(first.lines.some(line=>line.includes('hidden'))).toBe(false);
  const alpha=first.cells.find(cell=>cell.text==='a'&&ranges(cell.origins)[0]?.[0]===text.indexOf('alpha'))!;
  expect(ranges(first.select({row:alpha.row,column:alpha.column},{row:alpha.row,column:alpha.column+5}).origins)).toEqual([[text.indexOf('alpha'),text.indexOf('alpha')+5]]);
  expect(first.lines[alpha.row]).toContain('\x1b[48;5;236m');
  const title=first.cells.find(cell=>cell.text==='O')!;
  expect(ranges(title.origins)).toEqual([[text.indexOf('Outer'),text.indexOf('Outer')+1]]);
  expect(first.inspect({row:alpha.row,column:0})?.origins).toEqual([{kind:'generated',reason:'callout rail'}]);
  const copy=first.select({row:0,column:0},{row:first.lines.length-1,column:32}).text;
  expect(copy).toContain('Outer');expect(copy).toContain('Inner');expect(copy).toContain('alpha');
  expect(copy).not.toMatch(/[│●◆+−]/);
  const inner=state.regions.find(region=>region.id===callouts[1]!.id)!;
  inner.disclosure!.expanded=true;state.disclosureOverrides.set(inner.id,true);
  component.render(14);const expanded=component.renderedFrame!;
  const hidden=expanded.cells.find(cell=>cell.text==='h'&&ranges(cell.origins)[0]?.[0]===text.indexOf('hidden'))!;
  expect(hidden).toBeDefined();expect(ranges(hidden.origins)).toEqual([[text.indexOf('hidden'),text.indexOf('hidden')+1]]);
  expect(first.select({row:0,column:0},{row:first.lines.length-1,column:32}).text).not.toContain('hidden');
  for(const width of [1,2,5]){component.render(width);expect(component.renderedFrame!.lines.every(line=>visibleWidth(line)<=width)).toBe(true);}
});

test('styled repeated embeds retain separate occurrences and exact source after paint and resize',()=>{
  const target=observeDocument({kind:'block',blockId:'synthetic-embedded-text'},'**shared**',4);
  const host=observeDocument({kind:'block',blockId:'synthetic-embed-host'},'first second',2);
  const copies=[0,6].map(start=>{
    const token={document:host,start,end:start+5};
    return withDocumentOccurrence(sourceDocument(target),{host:token,path:[{token,target:'synthetic-embedded-text'}]});
  });
  const document=concatDocuments([copies[0]!,generatedDocument('\n\n','embed separator'),copies[1]!]);
  const component=new SourceSpannedMarkdown(theme,text=>`\x1b[48;5;236m${text}\x1b[0m`);
  component.setContent(document,[{startLine:0,endLine:2}],true);
  component.render(20);const frame=component.renderedFrame!;expect(frame).not.toBeNull();
  const selected=frame.select({row:0,column:0},{row:2,column:6});
  expect(selected.text).toBe('shared\n\nshared');
  expect(selected.origins.filter(origin=>origin.kind==='source').map(origin=>[origin.occurrence!.host.start,...ranges([origin])[0]!])).toEqual([[0,2,8],[6,2,8]]);
  expect(frame.lines[0]).toContain('\x1b[48;5;236m');
  component.render(4);expect(component.renderedFrame!.lines.every(line=>visibleWidth(line)<=4)).toBe(true);
  expect(frame.select({row:0,column:0},{row:2,column:6}).text).toBe(selected.text);
});


test('installed status renderer shares exact cells, link identity and responsive copy with tables', () => {
  const directory = mkdtempSync(join(tmpdir(), 'outliner-components-'));
  const registry = join(directory, 'renderers.json');
  const prior = process.env.OUTLINER_DOCUMENT_RENDERERS;
  process.env.OUTLINER_DOCUMENT_RENDERERS = registry;
  const installation = {version: 1, renderers: {status: {
    manifest: resolve('extensions/status-summary/manifest.json'), enabled: true,
  }}};
  writeFileSync(registry, JSON.stringify(installation));
  try {
    const text = '```component:status\nTo do :: 4\n[Waiting](https://example.test/waiting) :: 4\nDone 界 :: 5\n```';
    const document = sourceDocument(observeDocument({kind: 'block', blockId: 'synthetic-status'}, text, 1));
    const {component, frame} = reader(document, 70);
    expect(frame.lines.map(line => line.trimEnd())).toEqual(['To do: 4 · Waiting: 4 · Done 界: 5']);
    const value = frame.cells.find(cell => cell.text === '5')!;
    expect(ranges(value.origins)).toEqual([[text.indexOf('5'), text.indexOf('5') + 1]]);
    const link = component.renderedLinks.find(link => link.uri === 'https://example.test/waiting')!;
    expect(link.label).toBe('Waiting');
    for (const width of [16, 8, 2, 70]) {
      component.render(width);
      const current = component.renderedFrame!;
      expect(current.lines.every(line => visibleWidth(line) <= width)).toBe(true);
      expect(new Set(component.renderedLinks.map(link => link.occurrenceId))).toEqual(new Set([link.occurrenceId]));
      expect(ranges(current.cells.find(cell => cell.text === '5')!.origins)).toEqual([[text.indexOf('5'), text.indexOf('5') + 1]]);
      if (width === 16) expect(current.select({row: 0, column: 0}, {row: current.lines.length - 1, column: width}).text)
        .toBe('To do: 4\nWaiting: 4\nDone 界: 5');
    }
    // Derived results remain copyable but cannot acquire an exact label/value anchor.
    const result = observeDocument({kind: 'resource', resourceId: 'synthetic-result'}, '4', 2);
    const derived = reader(concatDocuments([
      sourceDocument(observeDocument({kind: 'block', blockId: 'synthetic-definition'}, '```component:status\nWaiting :: ')),
      atomicDocument('4', {kind: 'derived', resultId: 'waiting-count', result,
        dependencies: [{document: observeDocument({kind: 'block', blockId: 'synthetic-task'}, '- [~] Wait'), start: 0, end: 3}]}),
      generatedDocument('\n```', 'component closing fence'),
    ]), 30).frame;
    const count = derived.cells.find(cell => cell.text === '4')!;
    const copied = derived.select({row: count.row, column: count.column}, {row: count.row, column: count.column + 1});
    expect(copied.text).toBe('4');
    expect(ranges(copied.origins)).toEqual([]);
    expect(copied.origins).toEqual([{kind: 'derived', resultId: 'waiting-count', result,
      dependencies: [{document: observeDocument({kind: 'block', blockId: 'synthetic-task'}, '- [~] Wait'), start: 0, end: 3}]}]);

    // A renderer is presentation only; disabling it keeps the editable source.
    installation.renderers.status.enabled = false;
    writeFileSync(registry, JSON.stringify(installation));
    component.setContent(document, [], false);
    component.render(70);
    expect(component.renderedFrame!.lines.join('\n')).toContain('renderer is disabled');
    expect(component.renderedFrame!.lines.join('\n')).toContain('To do :: 4');
    expect(document.text).toBe(text);
    installation.renderers.status.enabled = true;
    writeFileSync(registry, JSON.stringify(installation));
    const malformed = reader(sourceDocument(observeDocument({kind: 'block', blockId: 'synthetic-invalid'},
      '```component:status\nkeep this original prose\n```')), 60).frame;
    expect(malformed.lines.join('\n')).toContain('expected up to 64');
    expect(malformed.lines.join('\n')).toContain('keep this original prose');
    writeFileSync(registry, '{}');
    const unavailable = reader(document, 70).frame;
    expect(unavailable.lines.join('\n')).toContain('installation is unavailable or invalid');
    expect(unavailable.lines.join('\n')).toContain('To do :: 4');

  } finally {
    if (prior === undefined) delete process.env.OUTLINER_DOCUMENT_RENDERERS;
    else process.env.OUTLINER_DOCUMENT_RENDERERS = prior;
    rmSync(directory, {recursive: true, force: true});
  }
});
