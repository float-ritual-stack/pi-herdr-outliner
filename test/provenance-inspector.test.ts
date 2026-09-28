import {expect,test} from 'bun:test';
import {stripTerminalSequences,visibleWidth,type MarkdownTheme} from '@earendil-works/pi-tui';
import {SourceSpannedMarkdown} from '../src/source-spanned-markdown';
import {ProvenanceInspector} from '../src/provenance-inspector';
import {concatDocuments,generatedDocument,observeDocument,sourceDocument,withDocumentOccurrence} from '../src/document-provenance';
const plain=(text:string)=>text;
const theme:MarkdownTheme={heading:plain,link:plain,linkUrl:plain,code:plain,codeBlock:plain,codeBlockBorder:plain,quote:plain,quoteBorder:plain,hr:plain,listBullet:plain,bold:plain,italic:plain,strikethrough:plain,underline:plain};

test('inspector shows transformed UTF-16 evidence, occurrence identity and generated reasons from the captured frame',()=>{
  const observed=observeDocument({kind:'block',blockId:'sample-source'},'&amp; 界',4);
  const host=observeDocument({kind:'block',blockId:'sample-host'},'first second',2);
  const tokens=[{document:host,start:0,end:5},{document:host,start:6,end:12}];
  const document=concatDocuments(tokens.flatMap((token,index)=>[
    ...(index?[generatedDocument('\n','separator')]:[]),
    withDocumentOccurrence(sourceDocument(observed),{host:token,path:[{token,target:'sample-source'}]}),
  ]));
  const reader=new SourceSpannedMarkdown(theme,plain,undefined,false,undefined,true);
  reader.setContent(document,[],false);reader.render(20);
  const inspector=new ProvenanceInspector();
  inspector.open(reader.renderedFrame!,1);
  const show=()=>inspector.render(100,45).map(stripTerminalSequences).join('\n');
  try {
    let output=show();
    expect(output).toContain('Cell row 2, column 1 · "&"');
    expect(output).toContain('Origin: source');
    expect(output).toContain('Slice 1 UTF-16 [0, 5)');
    expect(output).toContain('Source: "&amp;"');
    expect(output).toContain('"blockId":"sample-source"');
    expect(output).toContain('"revision":4');
    expect(output.replace(/\n/g,'')).toContain(observed.hash);
    expect(output).toContain('Occurrence host token UTF-16 [6, 12)');
    expect(output).toContain('Path 1: sample-source');
    // A new renderer generation must not replace the inspected observation.
    reader.setContent(sourceDocument(observeDocument(observed.subject,'replacement',5)),[],false);reader.render(8);
    inspector.handle('\x1b[C\x1b[C');output=show();
    expect(output).toContain('Cell row 2, column 3 · "界"');
    expect(output).toContain('Slice 1 UTF-16 [6, 7)');
    expect(output).toContain('Width: 2');
    // Click the second column occupied by the same wide grapheme.
    inspector.handle('\x1b[<0;4;4M');
    expect(show()).toContain('column 4 · "界"');
    inspector.handle('\x1b[C');output=show();
    expect(output).toContain('Origin: generated');
    expect(output).toContain('Reason: layout padding');
    expect(output).not.toContain('UTF-16');
    inspector.handle('\x11');expect(inspector.active).toBe(false);
  } finally {inspector.dispose();}
});

test('inspector retains evidence access at narrow widths, frames input, and ignores pasted commands',()=>{
  const reader=new SourceSpannedMarkdown(theme,plain,undefined,false,undefined,true);
  reader.setContent(sourceDocument(observeDocument({kind:'block',blockId:'safe-document'},'abcdefghijklmnopqrstuvw界Z',1)),[],false);
  reader.render(50);
  const inspector=new ProvenanceInspector();inspector.open(reader.renderedFrame!);
  try {
    inspector.handle('\x1b[200~\x11\x1b[C\x1b[201~');
    expect(inspector.active).toBe(true);
    const lines=inspector.render(25,10);
    expect(lines).toHaveLength(10);
    expect(lines.every(line=>visibleWidth(line)<=25)).toBe(true);
    inspector.handle('\x1b[');inspector.handle('6~');
    const scrolled=inspector.render(25,10).map(stripTerminalSequences).join('\n');
    expect(scrolled).toContain('revision');
    expect(scrolled).not.toContain('Evidence 1–');
    inspector.handle('\x1b[F');inspector.render(25,10);
    inspector.handle('\x1b[H');
    const reset=inspector.render(60,20).map(stripTerminalSequences).join('\n');
    expect(reset).toContain('Cell row 1, column 1 · "a"');
    expect(reset).toContain('Evidence 1–');
  } finally {inspector.dispose();}
});
