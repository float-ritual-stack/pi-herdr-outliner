import {documentComponent} from './document-components';
import {sourceTable,type TableNode} from './document-tables';
import {Marked,type Token,type Tokens,type Links} from 'marked';
import {decodeHTMLStrict} from 'entities';
import {sanitizeReaderDocument} from './document-presentation';
import {sanitizeDynamicText} from './terminal';
import {sliceByColumn,stripTerminalSequences,visibleWidth,type Component,type MarkdownTheme} from '@earendil-works/pi-tui';
import {atomicDocument,concatDocuments,sliceDocument,type MappedDocument} from './document-provenance';
import {DocumentFrame,documentGlyphs,generatedGlyphs,wrapDocumentGlyphs,type DocumentGlyph,type GlyphStyle} from './document-frame';

const parser=new Marked();
type Row=DocumentGlyph[];

function transformed(source:MappedDocument,text:string):MappedDocument {
  if(source.text===text)return source;
  if(source.runs.length===1)return atomicDocument(text,source.runs[0]!.origin);
  // A consumed transform can cross projection boundaries. Every output glyph
  // depends on all consumed slices; overlapping atomic runs preserve that fact.
  return {text,runs:text?source.runs.map(run=>({...run,start:0,end:text.length,mapping:'atomic'})):[]};
}

function entityText(source:MappedDocument):MappedDocument {
  const parts:MappedDocument[]=[];let cursor=0;
  // CommonMark requires the semicolon and bounds numeric references. The
  // decoder owns the HTML named-entity table and invalid-code-point handling.
  for(const match of source.text.matchAll(/&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]+);/g)) {
    const end=match.index+match[0].length;
    parts.push(sliceDocument(source,cursor,match.index),transformed(sliceDocument(source,match.index,end),decodeHTMLStrict(match[0])));
    cursor=end;
  }
  parts.push(sliceDocument(source,cursor));
  // Decode first, then sanitize the assembled text: separate entities can
  // otherwise synthesize OSC/CSI commands after the normal input sanitizer.
  return sanitizeReaderDocument(concatDocuments(parts));
}

function codeSpanBody(source:MappedDocument):MappedDocument {
  const marker=/^`+/.exec(source.text)![0];
  let content=sliceDocument(source,marker.length,source.text.length-marker.length);
  const parts:MappedDocument[]=[];let cursor=0;
  for(const match of content.text.matchAll(/\r\n|\r|\n/g)) {
    parts.push(sliceDocument(content,cursor,match.index),transformed(sliceDocument(content,match.index,match.index+match[0].length),' '));
    cursor=match.index+match[0].length;
  }
  parts.push(sliceDocument(content,cursor));content=concatDocuments(parts);
  if(content.text.startsWith(' ')&&content.text.endsWith(' ')&&/[^ ]/.test(content.text))content=sliceDocument(content,1,content.text.length-1);
  return content;
}

function linkLabelSpan(raw:string):{start:number;end:number}|null {
  if(raw.startsWith('<')&&raw.endsWith('>'))return {start:1,end:raw.length-1};
  if(!raw.startsWith('['))return {start:0,end:raw.length}; // GFM autolink.
  let depth=1;
  for(let index=1;index<raw.length;index++) {
    if(raw[index]==='\\'){index++;continue;}
    if(raw[index]==='[')depth++;
    if(raw[index]===']'&&--depth===0)return {start:1,end:index};
  }
  return null;
}

/** Token.raw must start at the current cursor. No search over repeated text is
 * accepted as proof of where a token came from. */
function inline(source:MappedDocument,styles:readonly GlyphStyle[]=[],link?:DocumentGlyph['link'],path='root',tokens:Token[]=parser.Lexer.lexInline(source.text),definitions?:Links):DocumentGlyph[]|null {
  const output:DocumentGlyph[]=[];let cursor=0;
  for(const token of tokens) {
    if(!source.text.startsWith(token.raw,cursor))return null;
    const span=sliceDocument(source,cursor,cursor+token.raw.length);
    cursor+=token.raw.length;
    let glyphs:DocumentGlyph[]|null;
    switch(token.type) {
      case 'strong': case 'em': case 'del': {
        const delimiter=token.type==='em'?1:token.type==='del'&&!span.text.startsWith('~~')?1:2;
        const style=token.type==='strong'?'bold':token.type==='em'?'italic':'strikethrough';
        glyphs=inline(sliceDocument(span,delimiter,span.text.length-delimiter),[...styles,style],link,`${path}/${cursor}`,token.tokens,definitions);break;
      }
      case 'escape': glyphs=documentGlyphs(transformed(span,token.text),styles,link);break;
      case 'codespan': glyphs=documentGlyphs(codeSpanBody(span),[...styles,'code'],link);break;
      case 'image': case 'link': {
        const image=token.type==='image',prefix=image?1:0;
        const label=linkLabelSpan(span.text.slice(prefix));if(!label)return null;
        const labelSource=sliceDocument(span,prefix+label.start,prefix+label.end);
        // Marked's link tokens have already unescaped bracket labels. Parse the
        // authored label in link context so those consumed escapes retain their
        // own offsets, without recursively autolinking a URL label.
        const lexer=new parser.Lexer(parser.defaults);lexer.state.inLink=true;
        if(definitions)lexer.tokens.links=definitions;
        const labelTokens=span.text.startsWith('[')||image?lexer.inlineTokens(labelSource.text):token.tokens;
        const target=link??{uri:sanitizeDynamicText(decodeHTMLStrict(token.href)),id:`link:${path}/${cursor-token.raw.length}`};
        glyphs=image&&!labelSource.text
          ? documentGlyphs(transformed(span,'Image'),[...styles,'link','underline'],target)
          : inline(labelSource,[...styles,'link','underline'],target,`${path}/${cursor}`,labelTokens,definitions);break;
      }
      case 'br': glyphs=documentGlyphs(transformed(span,'\n'),styles,link);break;
      case 'text': glyphs=token.tokens ? inline(span,styles,link,path,token.tokens,definitions) : documentGlyphs(entityText(span),styles,link);break;
      case 'html': glyphs=documentGlyphs(span,styles,link);break;
      default:return null;
    }
    if(!glyphs)return null;output.push(...glyphs);
  }
  return cursor===source.text.length?output:null;
}

function blockInline(source:MappedDocument,token:Token):{source:MappedDocument;styles:GlyphStyle[]}|null {
  if(token.type==='heading') {
    const atx=/^ {0,3}#{1,6}(?:[ \t]+|$)/.exec(source.text);
    let start=atx?.[0].length??0;
    let end=source.text.length;
    if(atx){end=source.text.trimEnd().length;const closing=/[ \t]+#+[ \t]*$/.exec(source.text.slice(start,end));if(closing)end=start+closing.index;}
    else {const underline=/\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/.exec(source.text);if(!underline)return null;end=underline.index;}
    const body=sliceDocument(source,start,end);
    if(body.text!==token.text)return null;
    return {source:body,styles:token.depth===1?['underline','bold','heading']:['bold','heading']};
  }
  if(token.type==='paragraph'||token.type==='text') {
    const body=sliceDocument(source,0,token.text.length);
    return body.text===token.text?{source:body,styles:[]}:null;
  }
  return null;
}

type LayoutNode = (
  | {kind:'flow';glyphs:DocumentGlyph[]}
  | {kind:'quote';children:LayoutNode[]}
  | {kind:'list';items:{marker:DocumentGlyph[];children:LayoutNode[]}[];loose:boolean}
  | {kind:'code';lines:DocumentGlyph[][];language:string}
  | {kind:'table';table:TableNode;header:DocumentGlyph[][];rows:DocumentGlyph[][][]}
  | {kind:'labelled-values';entries:{label:DocumentGlyph[];value:DocumentGlyph[]}[]}
  | {kind:'rule'}
) & {blankAfter:boolean};

/** Prefix removal is a grammar operation at each known line boundary. The
 * parser's normalized text is a check, never a string-search positioning oracle. */
function stripLinePrefixes(source:MappedDocument,count:(line:string,index:number)=>number):MappedDocument {
  const parts:MappedDocument[]=[];let cursor=0;
  for(const [index,line] of source.text.split(/(?<=\n)/).entries()) {
    const removed=count(line,index);
    parts.push(sliceDocument(source,cursor+removed,cursor+line.length));cursor+=line.length;
  }
  return concatDocuments(parts);
}
function matchBody(body:MappedDocument,expected:string):MappedDocument|null {
  if(body.text===expected)return body;
  if(body.text.startsWith(expected)&&/^\n*$/.test(body.text.slice(expected.length)))return sliceDocument(body,0,expected.length);
  return null;
}
function normalized(document:MappedDocument):MappedDocument {
  const parts:MappedDocument[]=[];let cursor=0;
  for(const match of document.text.matchAll(/\r\n|\r/g)) {
    parts.push(sliceDocument(document,cursor,match.index),transformed(sliceDocument(document,match.index,match.index+match[0].length),'\n'));
    cursor=match.index+match[0].length;
  }
  parts.push(sliceDocument(document,cursor));return concatDocuments(parts);
}
function codeBody(source:MappedDocument,expected:string,indented:boolean):MappedDocument|null {
  if(indented)return matchBody(stripLinePrefixes(source,line=>Math.min(4,/^ */.exec(line)![0].length)),expected);
  const open=/^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(source.text);
  if(!open)return null;
  const start=open[0].length;
  const rawEnd=source.text.endsWith('\n')?source.text.length-1:source.text.length;
  const lastNewline=source.text.lastIndexOf('\n',rawEnd-1);
  const closing=/^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(source.text.slice(lastNewline+1,rawEnd));
  const end=closing&&lastNewline+1>=start&&closing[1]![0]===open[2]![0]&&closing[1]!.length>=open[2]!.length?lastNewline+1:source.text.length;
  const body=stripLinePrefixes(sliceDocument(source,start,end),line=>Math.min(open[1]!.length,/^ */.exec(line)![0].length));
  return matchBody(body,expected);
}
function compileBlocks(document:MappedDocument,path='root',definitions?:Links):LayoutNode[]|null {
  const lexer=new parser.Lexer(parser.defaults);
  if(definitions)lexer.tokens.links=definitions;
  const tokens=lexer.lex(document.text),nodes:LayoutNode[]=[];let cursor=0;
  for(let index=0;index<tokens.length;index++) {
    const token=tokens[index]!;
    if(!document.text.startsWith(token.raw,cursor))return null;
    const source=sliceDocument(document,cursor,cursor+token.raw.length);
    const nodePath=`${path}/${cursor}`;cursor+=token.raw.length;
    const next=tokens[index+1]?.type;
    const blankAfter=Boolean(next&&next!=='space'&&token.type!=='list'&&(token.type!=='paragraph'||next!=='list'));
    if(token.type==='def')continue;
    if(token.type==='space'){
      // Hidden reference definitions do not introduce a second visual gap.
      if(tokens[index-1]?.type!=='def')nodes.push({kind:'flow',glyphs:[],blankAfter:false});
      continue;
    }
    if(token.type==='blockquote') {
      const body=matchBody(stripLinePrefixes(source,line=>/^ {0,3}> ?/.exec(line)?.[0].length??0),token.text);
      const children=body&&compileBlocks(body,nodePath,tokens.links);if(!children)return null;
      nodes.push({kind:'quote',children,blankAfter});continue;
    }
    if(token.type==='list') {
      const items:{marker:DocumentGlyph[];children:LayoutNode[]}[]=[];let itemCursor=0;
      for(const [itemIndex,item] of token.items.entries()) {
        // Marked excludes a separator newline from some tight list item raws.
        while(source.text[itemCursor]==='\n')itemCursor++;
        if(!source.text.startsWith(item.raw,itemCursor))return null;
        const itemSource=sliceDocument(source,itemCursor,itemCursor+item.raw.length);itemCursor+=item.raw.length;
        const prefix=/^( {0,3})([-+*]|\d{1,9}[.)])([ \t]*)(?=\S|\n|$)/.exec(item.raw);
        if(!prefix)return null;
        const markerEnd=prefix[1]!.length+prefix[2]!.length;
        const spaceCount=prefix[3]!.length>4?1:prefix[3]!.length;
        const indent=markerEnd+spaceCount;
        let body=stripLinePrefixes(itemSource,(line,lineIndex)=>lineIndex===0?indent:
          line.slice(0,indent)===' '.repeat(indent)?indent:line.trim()===''?/^ */.exec(line)![0].length:0);
        const markerText=token.ordered?`${Number(token.start)+itemIndex}.`:'-';
        const marker=generatedGlyphs(markerText,'list marker',true,['listBullet']);
        marker.push(...generatedGlyphs(' ','list marker separator',true));
        if(item.task) {
          const checkbox=/^\[[ xX]\][ \t]+/.exec(body.text);if(!checkbox)return null;
          marker.push(...documentGlyphs(transformed(sliceDocument(body,0,3),`[${item.checked?'x':' '}]`),['listBullet']),
            ...generatedGlyphs(' ','task marker separator',true));
          body=sliceDocument(body,checkbox[0].length);
        }
        const matched=matchBody(body,item.text);if(!matched)return null;
        const children=compileBlocks(matched,`${nodePath}/item:${itemIndex}`,tokens.links);if(!children)return null;
        items.push({marker,children});
      }
      if(source.text.slice(itemCursor).trim())return null;
      nodes.push({kind:'list',items,loose:token.loose,blankAfter});continue;
    }
    if(token.type==='code') {
      const body=codeBody(source,token.text,token.codeBlockStyle==='indented');if(!body)return null;
      const component = documentComponent(token.lang ?? '', body, nodePath);
      if (component?.kind === 'labelled-values') {
        const entries = component.entries.map(entry => ({
          label: inline(entry.label, ['bold'], undefined, `${entry.id}/label`),
          value: inline(entry.value, [], undefined, `${entry.id}/value`),
        }));
        if (entries.every(entry => entry.label && entry.value)) {
          nodes.push({kind: 'labelled-values', entries: entries as {label: DocumentGlyph[]; value: DocumentGlyph[]}[], blankAfter});
          continue;
        }
        nodes.push({kind: 'flow', glyphs: generatedGlyphs('Component unavailable: unsupported inline content', 'component diagnostic', true), blankAfter: true});
      } else if (component) {
        nodes.push({kind: 'flow', glyphs: generatedGlyphs(`Component unavailable: ${component.reason}`, 'component diagnostic', true), blankAfter: true});
      }
      let offset=0;
      const lines=body.text.split('\n').map(line=>{const mapped=sliceDocument(body,offset,offset+line.length);offset+=line.length+1;return documentGlyphs(mapped,['codeBlock']);});
      nodes.push({kind:'code',lines,language:token.lang??'',blankAfter});continue;
    }
    if(token.type==='table') {
      const table=sourceTable(source,token as Tokens.Table,nodePath);if(!table)return null;
      const renderCells=(cells:TableNode['header'])=>cells.map(cell=>{
        const cellLexer=new parser.Lexer(parser.defaults);cellLexer.tokens.links=tokens.links;
        return inline(cell.source,[],undefined,cell.id,cellLexer.inlineTokens(cell.source.text),tokens.links);
      });
      const header=renderCells(table.header),rows=table.rows.map(renderCells);
      if(header.some(cell=>cell===null)||rows.some(row=>row.some(cell=>cell===null)))return null;
      nodes.push({kind:'table',table,header:header as DocumentGlyph[][],rows:rows as DocumentGlyph[][][],blankAfter});continue;
    }
    if(token.type==='hr'){nodes.push({kind:'rule',blankAfter});continue;}
    if(token.type==='html') {
      const start=source.text.length-source.text.trimStart().length,end=source.text.trimEnd().length;
      nodes.push({kind:'flow',glyphs:documentGlyphs(sliceDocument(source,start,Math.max(start,end))),blankAfter});continue;
    }
    const body=blockInline(source,token);if(!body)return null;
    const glyphs=inline(body.source,body.styles,undefined,nodePath,'tokens' in token?token.tokens:undefined,tokens.links);if(!glyphs)return null;
    if(token.type==='heading'&&token.depth>=3)glyphs.unshift(...generatedGlyphs(`${'#'.repeat(token.depth)} `,'heading depth',true,body.styles));
    nodes.push({kind:'flow',glyphs,blankAfter});
  }
  return cursor===document.text.length?nodes:null;
}
const glyphWidth=(glyphs:readonly DocumentGlyph[])=>glyphs.reduce((sum,glyph)=>sum+visibleWidth(glyph.text),0);
type TableLayout=Extract<LayoutNode,{kind:'table'}>;
function layoutTable(node:TableLayout,width:number):Row[] {
  const count=node.header.length;if(!count)return [];
  const all=[node.header,...node.rows];
  const natural=node.header.map((_,column)=>Math.max(1,...all.map(row=>glyphWidth(row[column]!))));
  const minimum=natural.map(size=>Math.min(size,6));
  const available=width-(3*count+1);
  if(available<minimum.reduce((sum,size)=>sum+size,0))return tableCards(node,width);
  const widths=[...minimum];
  let spare=available-widths.reduce((sum,size)=>sum+size,0);
  while(spare>0) {
    let chosen=-1;
    for(let column=0;column<count;column++)if(natural[column]!>widths[column]!&&
      (chosen<0||natural[column]!-widths[column]!>natural[chosen]!-widths[chosen]!))chosen=column;
    if(chosen<0)break;
    widths[chosen]++;spare--;
  }
  const rows:Row[]=[];
  const border=(left:string,middle:string,right:string)=>generatedGlyphs(left+widths.map(size=>'─'.repeat(size+2)).join(middle)+right,'table border');
  rows.push(border('┌','┬','┐'));
  const renderRow=(cells:DocumentGlyph[][],header=false)=>{
    const wrapped=cells.map((cell,column)=>wrapDocumentGlyphs(cell,widths[column]!));
    const height=Math.max(...wrapped.map(cell=>cell.length));
    for(let line=0;line<height;line++) {
      const row=generatedGlyphs('│ ','table border');
      for(let column=0;column<count;column++) {
        const content=wrapped[column]![line]??[];
        const padding=widths[column]!-glyphWidth(content);
        const alignment=node.table.align[column];
        const left=alignment==='right'?padding:alignment==='center'?Math.floor(padding/2):0;
        row.push(...generatedGlyphs(' '.repeat(left),'table cell padding'),
          ...content.map(glyph=>header?{...glyph,styles:[...glyph.styles,'bold'] as GlyphStyle[]}:glyph),
          ...generatedGlyphs(' '.repeat(padding-left),'table cell padding'));
        if(column<count-1)row.push(...generatedGlyphs(' ','table column separator',true),...generatedGlyphs('│ ','table border'));
        else row.push(...generatedGlyphs(' │','table border'));
      }
      rows.push(row);
    }
  };
  renderRow(node.header,true);rows.push(border('├','┼','┤'));
  for(const [index,row] of node.rows.entries()) {
    renderRow(row);if(index<node.rows.length-1)rows.push(border('├','┼','┤'));
  }
  rows.push(border('└','┴','┘'));return rows;
}

function tableCards(node:TableLayout,width:number):Row[] {
  const rows:Row[]=[];
  if(!node.rows.length)return node.header.flatMap(header=>wrapDocumentGlyphs(header,width));
  for(const [rowIndex,cells] of node.rows.entries()) {
    if(rowIndex)rows.push([]);
    rows.push(...wrapDocumentGlyphs(generatedGlyphs(`Row ${rowIndex+1}`,'table record label',false,['bold']),width));
    for(const [column,cell] of cells.entries()) {
      // Header repetition is a separate interaction occurrence; value IDs are
      // unchanged across grid/card conversion and different wrap widths.
      const header=node.header[column]!;
      const label=header.length?header.map(glyph=>({...glyph,styles:[...glyph.styles,'bold'] as GlyphStyle[],
        ...(glyph.link?{link:{...glyph.link,id:`${glyph.link.id}/card:${rowIndex}`}}:{})})):
        generatedGlyphs(`Column ${column+1}`,'unnamed table column',true,['bold']);
      const prefix=[...label,...generatedGlyphs(': ','table label separator',true)];
      const value=cell.length?cell:generatedGlyphs('—','empty table cell');
      const leadWidth=glyphWidth(prefix);
      if(leadWidth<=Math.floor(width/2)) {
        const wrapped=wrapDocumentGlyphs(value,Math.max(1,width-leadWidth));
        for(const [line,content] of wrapped.entries())rows.push([...(line?generatedGlyphs(' '.repeat(leadWidth),'table continuation'):prefix),...content]);
      } else {
        rows.push(...wrapDocumentGlyphs(prefix,width));
        const indent=width>=4?2:0;
        rows.push(...wrapDocumentGlyphs(value,Math.max(1,width-indent)).map(line=>[...generatedGlyphs(' '.repeat(indent),'table value indentation'),...line]));
      }
    }
  }
  return rows;
}

/** Responsive labelled values use the same attributed glyphs as table cells.
 * Separators are useful copied punctuation, not source-backed decorations. */
function layoutLabelledValues(entries: readonly {label: DocumentGlyph[]; value: DocumentGlyph[]}[], width: number): Row[] {
  const items = entries.map(entry => [...entry.label,
    ...generatedGlyphs(': ', 'component label separator', true), ...entry.value]);
  const separator = generatedGlyphs(' · ', 'component item separator', true);
  const natural = items.reduce((sum, item) => sum + glyphWidth(item), 0) + (items.length - 1) * 3;
  if (natural <= width) return [items.flatMap((item, index) => index ? [...separator, ...item] : item)];
  return items.flatMap(item => wrapDocumentGlyphs(item, width));
}

function layout(nodes:readonly LayoutNode[],width:number,theme:MarkdownTheme,listDepth=0):Row[] {
  const rows:Row[]=[];
  for(const node of nodes) {
    if(node.kind==='flow')rows.push(...wrapDocumentGlyphs(node.glyphs,width));
    else if(node.kind==='quote') {
      const prefix=width>=3?generatedGlyphs('│ ','quote border',false,['quoteBorder']):[];
      const children=layout(node.children,Math.max(1,width-glyphWidth(prefix)),theme);
      while(children.length&&!children.at(-1)!.length)children.pop();
      rows.push(...children.map(row=>[...prefix,...row.map(glyph=>({...glyph,styles:[...glyph.styles,'italic','quote'] as GlyphStyle[]}))]));
    } else if(node.kind==='list') {
      for(const [index,item] of node.items.entries()) {
        const indent=generatedGlyphs(' '.repeat(Math.min(listDepth*4,Math.max(0,width-2))),'list indentation');
        const prefix=[...indent,...item.marker];
        const contentWidth=Math.max(1,width-glyphWidth(prefix));
        let emitted=false;
        for(const child of item.children) {
          if(child.kind==='list'){rows.push(...layout([child],width,theme,listDepth+1));emitted=true;continue;}
          for(const row of layout([child],contentWidth,theme)) {
            const lead=emitted?generatedGlyphs(' '.repeat(glyphWidth(prefix)),'list continuation'):prefix;
            rows.push(...wrapDocumentGlyphs([...lead,...row],width));emitted=true;
          }
        }
        if(!emitted)rows.push(...wrapDocumentGlyphs(prefix,width));
        if(node.loose&&index<node.items.length-1)rows.push([]);
      }
    } else if(node.kind==='code') {
      rows.push(...wrapDocumentGlyphs(generatedGlyphs('```'+node.language,'code fence',false,['codeBlockBorder']),width));
      const prefix=generatedGlyphs(theme.codeBlockIndent??'  ','code indentation');
      const sourceLines=node.lines.map(line=>line.map(glyph=>glyph.text).join(''));
      const highlighted=theme.highlightCode?.(sourceLines.join('\n'),node.language);
      for(const [index,line] of node.lines.entries()) {
        let column=0;
        const styled=line.map(glyph=>{
          const size=visibleWidth(glyph.text);
          const painted=highlighted?.[index]===undefined?null:sliceByColumn(highlighted[index]!,column,size,true);
          column+=size;
          return painted!==null&&stripTerminalSequences(painted)===glyph.text?{...glyph,painted,styles:[]}:glyph;
        });
        rows.push(...wrapDocumentGlyphs([...prefix,...styled],width));
      }
      rows.push(...wrapDocumentGlyphs(generatedGlyphs('```','code fence',false,['codeBlockBorder']),width));
    } else if(node.kind==='table')rows.push(...layoutTable(node,width));
    else if(node.kind==='labelled-values')rows.push(...layoutLabelledValues(node.entries,width));
    else rows.push(generatedGlyphs('─'.repeat(Math.min(width,80)),'horizontal rule',false,['hr']));
    if(node.blankAfter)rows.push([]);
  }
  return rows;
}

/** Unsupported structures remain explicitly unmapped during migration. */
export class AttributedMarkdown implements Component {
  private cache:{width:number;frame:DocumentFrame}|null=null;
  private constructor(private readonly nodes:readonly LayoutNode[],private readonly theme:MarkdownTheme,private readonly linksEnabled:boolean){}
  // Raw and code/HTML slices reach glyphs verbatim, so terminal controls are
  // stripped here rather than trusting every caller to sanitize first.
  static compile(document:MappedDocument,theme:MarkdownTheme,linksEnabled:boolean,path='root'):AttributedMarkdown|null {
    document=sanitizeReaderDocument(document);
    const nodes=document.text.trim()?compileBlocks(normalized(document),path):[];
    return nodes?new AttributedMarkdown(nodes,theme,linksEnabled):null;
  }
  static compileInline(document:MappedDocument,theme:MarkdownTheme,linksEnabled:boolean):AttributedMarkdown|null {
    const glyphs=inline(sanitizeReaderDocument(document));
    return glyphs?new AttributedMarkdown([{kind:'flow',glyphs,blankAfter:false}],theme,linksEnabled):null;
  }
  glyphRows(width:number):DocumentGlyph[][] {return layout(this.nodes,Math.max(1,Math.floor(width)),this.theme);}
  frame(width:number):DocumentFrame {
    width=Math.max(1,Math.floor(width));
    if(this.cache?.width===width)return this.cache.frame;
    const frame=new DocumentFrame(this.glyphRows(width),width,this.theme,this.linksEnabled);
    this.cache={width,frame};return frame;
  }
  render(width:number):string[]{return [...this.frame(width).lines];}
  invalidate():void{this.cache=null;}
}
