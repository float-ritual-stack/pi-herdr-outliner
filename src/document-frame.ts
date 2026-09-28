import {isCopyExcludedLink,measureRenderedLinks} from './rendered-links';
import {hyperlink, stripTerminalSequences, visibleWidth, type MarkdownTheme} from '@earendil-works/pi-tui';
import {sliceDocument, observedDocumentIdentity, type DocumentOrigin, type MappedDocument} from './document-provenance';

export type GlyphStyle = 'heading' | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'link' | 'listBullet' | 'quote' | 'quoteBorder' | 'codeBlock' | 'codeBlockBorder' | 'hr';
export interface DocumentGlyph {
  readonly text: string;
  readonly painted?: string;
  /** Width-preserving outer paint, such as embedded-note or callout tint. */
  readonly paintLayers?: readonly ((text:string)=>string)[];
  readonly origins: readonly DocumentOrigin[];
  readonly styles: readonly GlyphStyle[];
  readonly link?: {readonly uri:string; readonly id:string};
  readonly copy: boolean;
}
export interface DocumentCell extends DocumentGlyph {
  readonly row:number;
  readonly column:number;
  readonly width:number;
}
export interface DocumentPoint {row:number;column:number}
export interface DocumentSelectionRange {readonly row:number;readonly start:number;readonly end:number}
export interface DocumentSelection {
  readonly text:string;
  readonly origins:readonly DocumentOrigin[];
}
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});

/** Graphemes consume the projection map before style or wrapping can lose it. */
export function documentGlyphs(document:MappedDocument, styles:readonly GlyphStyle[]=[], link?:DocumentGlyph['link']):DocumentGlyph[] {
  return [...segmenter.segment(document.text)].map(({segment,index})=>({text:segment,
    origins:sliceDocument(document,index,index+segment.length).runs.map(run=>run.origin),
    styles, ...(link ? {link} : {}),copy:!link || !isCopyExcludedLink(link.uri)}));
}
export function generatedGlyphs(text:string,reason:string,copy=false,styles:readonly GlyphStyle[]=[]):DocumentGlyph[] {
  return [...segmenter.segment(text)].map(({segment})=>({text:segment,origins:[{kind:'generated',reason}],styles,copy}));
}

export function paintDocumentRows(rows:readonly (readonly DocumentGlyph[])[],width:number,paint:(text:string)=>string):DocumentGlyph[][] {
  return rows.map(row=>{
    const size=row.reduce((sum,glyph)=>sum+visibleWidth(glyph.text),0);
    const padded=[...row,...generatedGlyphs(' '.repeat(Math.max(0,width-size)),'paint padding')];
    return padded.map(glyph=>({...glyph,paintLayers:[...(glyph.paintLayers??[]),paint]}));
  });
}

function identity(value:unknown):string {
  return JSON.stringify(value,(key,value)=>key==='document' ? observedDocumentIdentity(value) : value);
}
function appendOrigin(origins:DocumentOrigin[],origin:DocumentOrigin):void {
  const previous=origins.at(-1);
  if(!previous){origins.push(origin);return;}
  if(identity(previous)===identity(origin))return; // A tab/atomic label spans several cells.
  if(previous.kind==='source' && origin.kind==='source' && identity(previous.occurrence)===identity(origin.occurrence)) {
    const left=previous.slices.at(-1),right=origin.slices[0];
    if(left && right && identity(observedDocumentIdentity(left.document))===identity(observedDocumentIdentity(right.document)) && left.end===right.start) {
      origins[origins.length-1]={...previous,slices:[...previous.slices.slice(0,-1),{...left,end:right.end},...origin.slices.slice(1)]};
      return;
    }
  }
  origins.push(origin);
}

function overlapsOrigin(left:DocumentOrigin,right:DocumentOrigin):boolean {
  if(left.kind==='generated'||right.kind==='generated')return false;
  if(left.kind==='derived'||right.kind==='derived')return left.kind==='derived'&&right.kind==='derived'&&identity(left)===identity(right);
  if(identity(left.occurrence)!==identity(right.occurrence))return false;
  const a=left.kind==='source'?left.slices:[left.token],b=right.kind==='source'?right.slices:[right.token];
  return a.some(one=>b.some(two=>identity(observedDocumentIdentity(one.document))===identity(observedDocumentIdentity(two.document))&&one.start<two.end&&two.start<one.end));
}

function snapshot<T>(value:T,seen:WeakMap<object,object>):T {
  if(value===null||typeof value!=='object')return value;
  const prior=seen.get(value);if(prior)return prior as T;
  const copy:any=Array.isArray(value)?[]:{};
  seen.set(value,copy);
  for(const [key,item] of Object.entries(value))copy[key]=snapshot(item,seen);
  return Object.freeze(copy) as T;
}

/** Serialize a contiguous link once, including differently styled label spans.
 * Geometry consumers must not see one separate activation per grapheme. */
function paintRow(row:readonly DocumentGlyph[],theme:MarkdownTheme,linksEnabled:boolean):string {
  let painted='';
  for(let start=0;start<row.length;) {
    const link=row[start]!.link;
    let end=start+1;
    while(end<row.length&&row[end]!.link?.id===link?.id&&row[end]!.link?.uri===link?.uri)end++;
    let label='';
    for(let index=start;index<end;) {
      const styles=row[index]!.styles;
      const layers=row[index]!.paintLayers??[];
      let limit=index+1;
      while(limit<end&&row[limit]!.styles.length===styles.length&&row[limit]!.styles.every((style,n)=>style===styles[n])&&
        (row[limit]!.paintLayers?.length??0)===layers.length&&layers.every((paint,n)=>paint===row[limit]!.paintLayers![n]))limit++;
      let text=row.slice(index,limit).map(glyph=>glyph.painted??glyph.text).join('');
      for(const style of styles)text=theme[style](text);
      for(const paint of layers)text=paint(text);
      label+=text;index=limit;
    }
    painted+=link&&linksEnabled?hyperlink(label,link.uri):label;
    start=end;
  }
  return painted;
}

/** Immutable geometry and evidence from one layout. Coordinates are visible
 * columns; selection ends are exclusive. A touched wide glyph is selected whole. */
export class DocumentFrame {
  readonly lines:readonly string[];
  readonly cells:readonly DocumentCell[];
  /** Compose known layout placements, never search painted text for its source.
   * Unclaimed cells belong to UI chrome. A clipped or replaced glyph cannot
   * retain the source claim of the glyph that previously occupied that space. */
  static compose(lines:readonly string[],placements:readonly {
    frame:DocumentFrame;
    place:(cell:DocumentCell)=>DocumentPoint|null;
  }[]):DocumentFrame {
    const cells:DocumentCell[]=[];
    for(const [row,line] of lines.entries()) {
      let column=0;
      const excluded=measureRenderedLinks([line]).filter(link=>isCopyExcludedLink(link.uri));
      for(const glyph of generatedGlyphs(stripTerminalSequences(line),'reader chrome',true)) {
        const width=visibleWidth(glyph.text);
        const copy=!excluded.some(span=>column<span.column+span.width&&column+width>span.column);
        cells.push({...glyph,copy,row,column,width});column+=width;
      }
    }
    const positions=new Map(cells.map((cell,index)=>[`${cell.row}:${cell.column}`,index]));
    for(const {frame,place} of placements) for(const cell of frame.cells) {
      const point=place(cell);if(!point)continue;
      const index=positions.get(`${point.row}:${point.column}`);
      if(index===undefined)continue;
      const painted=cells[index]!;
      // Equality is a guard at an explicit coordinate, not a matching oracle.
      if(painted.text!==cell.text||painted.width!==cell.width)continue;
      cells[index]={...cell,...point};
    }
    const frame=Object.create(DocumentFrame.prototype) as DocumentFrame;
    Object.defineProperties(frame,{
      lines:{value:Object.freeze([...lines]),enumerable:true},
      cells:{value:snapshot(cells,new WeakMap()),enumerable:true},
    });
    return Object.freeze(frame);
  }
  constructor(rows:readonly (readonly DocumentGlyph[])[],width:number,theme:MarkdownTheme,linksEnabled:boolean) {
    const cells:DocumentCell[]=[];
    const observations=new WeakMap<object,object>();
    this.lines=Object.freeze(rows.map((row,rowIndex)=>{
      let column=0, painted=paintRow(row,theme,linksEnabled);
      for(const glyph of row){
        const cellWidth=visibleWidth(glyph.text);
        cells.push(snapshot({...glyph,row:rowIndex,column,width:cellWidth},observations));
        column+=cellWidth;
      }
      if(column<width) {
        const padding=generatedGlyphs(' '.repeat(width-column),'layout padding');
        for(const glyph of padding)cells.push(snapshot({...glyph,row:rowIndex,column:column++,width:1},observations));
        painted+=' '.repeat(padding.length);
      }
      return painted;
    }));
    this.cells=Object.freeze(cells);
    Object.freeze(this);
  }
  inspect(point:DocumentPoint):DocumentCell|undefined {
    return this.cells.find(cell=>cell.row===point.row&&cell.column<=point.column&&point.column<cell.column+cell.width);
  }
  firstRowForOrigins(origins:readonly DocumentOrigin[]):number|undefined {
    return this.cells.find(cell=>cell.origins.some(origin=>origins.some(candidate=>overlapsOrigin(origin,candidate))))?.row;
  }
  select(start:DocumentPoint,end:DocumentPoint,mode:'linear'|'rectangular'='linear'):DocumentSelection {
    if(start.row>end.row||(start.row===end.row&&start.column>end.column))[start,end]=[end,start];
    return this.selectRanges(Array.from({length:Math.max(0,end.row-start.row+1)},(_,index)=>{
      const row=start.row+index;
      return {row,start:mode==='rectangular'?Math.min(start.column,end.column):row===start.row?start.column:0,
        end:mode==='rectangular'?Math.max(start.column,end.column):row===end.row?end.column:Infinity};
    }));
  }
  /** Accept terminal-normalized, half-open ranges without guessing selection
   * endpoints again. Linear and rectangular selection share this reducer. */
  selectRanges(ranges:readonly DocumentSelectionRange[]):DocumentSelection {
    const lines=new Map<number,string>(),origins:DocumentOrigin[]=[];
    const byRow=new Map<number,DocumentSelectionRange[]>();
    for(const range of ranges)byRow.set(range.row,[...(byRow.get(range.row)??[]),range]);
    for(const cell of this.cells){
      if(!cell.copy||!byRow.get(cell.row)?.some(range=>range.end>range.start&&cell.column+cell.width>range.start&&cell.column<range.end))continue;
      lines.set(cell.row,(lines.get(cell.row)??'')+cell.text);
      for(const origin of cell.origins)appendOrigin(origins,origin);
    }
    // Retain empty rows inside a selection; omit unselected boundary padding.
    const occupied=[...lines.keys()];
    const first=occupied[0],last=occupied.at(-1);
    const text=first===undefined||last===undefined?'':Array.from({length:last-first+1},(_,index)=>lines.get(first+index)??'').join('\n');
    return snapshot({text,origins},new WeakMap());
  }
}

/** Wrap attributed text, never ANSI strings. Dropped wrap-space emits no cell. */
export function wrapDocumentGlyphs(glyphs:readonly DocumentGlyph[],width:number):DocumentGlyph[][] {
  width=Math.max(1,Math.floor(width));
  const rows:DocumentGlyph[][]=[];
  let row:DocumentGlyph[]=[],columns=0;
  const flush=()=>{rows.push(row);row=[];columns=0;};
  for(let glyph of glyphs){
    if(glyph.text==='\n'||glyph.text==='\r\n'){flush();continue;}
    let size=visibleWidth(glyph.text);
    if(size>width){glyph=generatedGlyphs('…','grapheme exceeds viewport',true)[0]!;size=1;}
    if(columns+size>width){
      if(glyph.text===' '){flush();continue;}
      let breakAt=-1;
      for(let i=row.length-1;i>=0;i--)if(/^ +$/.test(row[i]!.text)){breakAt=i;break;}
      if(breakAt>0){
        const remainder=row.slice(breakAt+1);
        row=row.slice(0,breakAt);flush();row=remainder;columns=row.reduce((sum,g)=>sum+visibleWidth(g.text),0);
      } else flush();
      if(glyph.text===' ' && row.length===0)continue;
      if(columns+size>width)flush();
    }
    row.push(glyph);columns+=size;
  }
  if(row.length||!rows.length)flush();
  return rows;
}
