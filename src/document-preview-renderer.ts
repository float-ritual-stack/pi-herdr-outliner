import {getMarkdownTheme} from '@earendil-works/pi-coding-agent';
import {truncateToWidth} from '@earendil-works/pi-tui';
import {renderDetailReadPreviewLines, type DetailReadPreviewDocument} from './detail-pi-preview';
import type {DocumentPreviewState} from './document-preview';
import {sanitizeDynamicText} from './terminal';

export interface PreviewRect {x:number;y:number;width:number;height:number}
export interface DocumentPreviewFrame {
  rect: PreviewRect;
  content: PreviewRect;
  lines: string[];
  totalRows: number;
  offset: number;
  controls?: Array<{rect: PreviewRect; action: string}>;
  divider?: PreviewRect;
  placement?: 'beside'|'below'|'compact';
}
const cache=new WeakMap<DetailReadPreviewDocument,{width:number;lines:string[]}>();
const background='\x1b[48;5;236m';
function shade(line:string,width:number):string {
  return background+truncateToWidth(line,width,'…',true).replace(/\x1b\[(?:0|49)?m/g,reset=>reset+background)+'\x1b[49m';
}
/** Render one allocated document rectangle. All input geometry comes from this frame. */
export function renderDocumentPreview(preview:DocumentPreviewState,rect:PreviewRect,help:string,toolbar?:string):DocumentPreviewFrame {
  const content={...rect,y:rect.y+2,height:Math.max(1,rect.height-3)};
  let entry=cache.get(preview.document);
  if(entry?.width!==content.width){
    entry={width:content.width,lines:renderDetailReadPreviewLines(preview.document,content.width,getMarkdownTheme()).map(line=>line.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g,''))};
    cache.set(preview.document,entry);
  }
  const offset=Math.max(0,Math.min(preview.offset,Math.max(0,entry.lines.length-content.height)));
  const lines=[`${preview.focused?'●':'○'} Preview · ${sanitizeDynamicText(preview.title)}`,toolbar??'─'.repeat(rect.width),...entry.lines.slice(offset,offset+content.height)];
  while(lines.length<rect.height-1)lines.push('');
  lines.push(help);
  return {rect,content,lines:lines.slice(0,rect.height).map(line=>shade(line,rect.width)),offset,totalRows:entry.lines.length};
}
export function pointInPreview(rect:PreviewRect,column:number,row:number):boolean{return column>=rect.x&&column<rect.x+rect.width&&row>=rect.y&&row<rect.y+rect.height;}
