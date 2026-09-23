import {getMarkdownTheme} from '@earendil-works/pi-coding-agent';
import {getCapabilities, setCapabilities, getOsc8LinkAtColumn, stripTerminalSequences, truncateToWidth, visibleWidth} from '@earendil-works/pi-tui';
import {renderDetailReadPreviewLines, type DetailReadPreviewDocument} from './detail-pi-preview';
import type {DocumentPreviewState} from './document-preview';
import {sanitizeDynamicText} from './terminal';

// [‹][›][Open] must remain reachable even in a narrow reader.
export const PREVIEW_NAVIGATION_WIDTH=12;
export interface PreviewRect {x:number;y:number;width:number;height:number}
export interface DocumentPreviewFrame {
  rect: PreviewRect;
  content: PreviewRect;
  lines: string[];
  totalRows: number;
  offset: number;
  controls?: Array<{rect: PreviewRect; action: string}>;
  links?: Array<{rect: PreviewRect; uri: string}>;
  divider?: PreviewRect;
  placement?: 'beside'|'below'|'compact';
}
const cache=new WeakMap<DetailReadPreviewDocument,{width:number;lines:string[];links:PreviewLink[]}>();
export interface PreviewLink {row:number;column:number;width:number;uri:string;label:string}
export function documentPreviewLinks(document:DetailReadPreviewDocument,width:number):PreviewLink[]{documentPreviewLines(document,width);return cache.get(document)!.links;}
const background='\x1b[48;5;236m';
function shade(line:string,width:number):string {
  return background+truncateToWidth(line,width,'…',true).replace(/\x1b\[(?:0|49)?m/g,reset=>reset+background)+'\x1b[49m';
}
/** Shared row measurement and painting cache, invalidated by document identity or width. */
export function documentPreviewLines(document:DetailReadPreviewDocument,width:number):string[] {
  let entry=cache.get(document);
  if(entry?.width!==width){
    // OSC links are an internal geometry map; they never reach the terminal.
    // Render synchronously with links even when the host does not support OSC 8.
    const capabilities=getCapabilities();
    let rendered:string[];
    try {
      setCapabilities({...capabilities,hyperlinks:true});
      rendered=renderDetailReadPreviewLines(document,width,getMarkdownTheme(),undefined,true);
    } finally {setCapabilities(capabilities);}
    const links:PreviewLink[]=[];
    rendered.forEach((line,row)=>{
      let previous:PreviewLink|undefined;
      const columns=visibleWidth(line);
      for(let column=0;column<columns;column++){
        const uri=getOsc8LinkAtColumn(line,column);
        if(!uri){previous=undefined;continue;}
        if(previous?.uri===uri&&previous.column+previous.width===column)previous.width++;
        else {previous={row,column,width:1,uri,label:stripTerminalSequences(line).trim()};links.push(previous);}
      }
    });
    entry={width,links,lines:rendered.map(line=>line.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g,''))};
    cache.set(document,entry);
  }
  return entry.lines;
}
/** Render one allocated document rectangle. All input geometry comes from this frame. */
export function renderDocumentPreview(preview:DocumentPreviewState,rect:PreviewRect,help:string,toolbar?:string):DocumentPreviewFrame {
  const content={...rect,y:rect.y+2,height:Math.max(1,rect.height-3)};
  const rendered=documentPreviewLines(preview.document,content.width);
  const offset=Math.max(0,Math.min(preview.offset,Math.max(0,rendered.length-content.height)));
  const controls:NonNullable<DocumentPreviewFrame['controls']>=[];
  let navigation=toolbar&&visibleWidth(toolbar)<=rect.width-PREVIEW_NAVIGATION_WIDTH?toolbar:'';
  let column=visibleWidth(navigation);
  for(const [label,action] of [['‹','back'],['›','forward'],['Open','open']]){
    const text=`[${label}]`;
    if(column+text.length>rect.width)break;
    const enabled=action==='open'||(action==='back'?preview.canBack:preview.canForward);
    if(enabled)controls.push({rect:{x:rect.x+column,y:rect.y+1,width:text.length,height:1},action:`preview.${action}`});
    navigation+=enabled?text:`\x1b[2m${text}\x1b[22m`;column+=text.length;
  }
  const links=documentPreviewLinks(preview.document,content.width).filter(link=>link.row>=offset&&link.row<offset+content.height).map(link=>({uri:link.uri,rect:{x:content.x+link.column,y:content.y+link.row-offset,width:link.width,height:1}}));
  const lines=[`${preview.focused?'●':'○'} Preview · ${sanitizeDynamicText(preview.title)}`,navigation,...rendered.slice(offset,offset+content.height)];
  while(lines.length<rect.height-1)lines.push('');
  lines.push(preview.notice ? sanitizeDynamicText(preview.notice) : preview.activeLink ? `Enter follow · ${sanitizeDynamicText(preview.activeLinkLabel??preview.activeLink)}` : `Tab links · Alt+←/→ history · ${help}`);
  return {rect,content,lines:lines.slice(0,rect.height).map(line=>shade(line,rect.width)),offset,totalRows:rendered.length,links,controls};
}
export function pointInPreview(rect:PreviewRect,column:number,row:number):boolean{return column>=rect.x&&column<rect.x+rect.width&&row>=rect.y&&row<rect.y+rect.height;}
