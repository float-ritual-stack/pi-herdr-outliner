import {getMarkdownTheme} from '@earendil-works/pi-coding-agent';
import {truncateToWidth} from '@earendil-works/pi-tui';
import {renderDetailReadPreviewLines, type DetailReadPreviewDocument} from './detail-pi-preview';
import type {OutlinerNavigationTarget} from './types';
import {sanitizeDynamicText} from './terminal';

export interface TreeLocalPreview {
  readonly target: OutlinerNavigationTarget;
  readonly title: string;
  readonly document: DetailReadPreviewDocument;
  readonly offset: number;
  readonly focused: boolean;
}
export interface PreviewRect {x:number;y:number;width:number;height:number}
export interface TreePreviewFrame {
  rect: PreviewRect;
  content: PreviewRect;
  lines: string[];
  totalRows: number;
  offset: number;
  treeWidth: number;
  treeHeight: number;
  placement: 'beside'|'below'|'compact';
}
const cache = new WeakMap<DetailReadPreviewDocument,{width:number;lines:string[]}>();
const PREVIEW_BACKGROUND = '\x1b[48;5;236m';
function shadePreviewLine(line: string, width: number): string {
  const padded = truncateToWidth(line, width, '…', true);
  return PREVIEW_BACKGROUND + padded.replace(/\x1b\[(?:0|49)?m/g, reset => reset + PREVIEW_BACKGROUND) + '\x1b[49m';
}
export function treePreviewFrame(preview:TreeLocalPreview,width:number,height:number,help:string):TreePreviewFrame {
  const placement=width>=101?'beside':height>=24?'below':'compact';
  const treeWidth=placement==='beside'?Math.floor((width-1)*.45):width;
  const treeHeight=placement==='below'?Math.floor((height-1)*.45):height;
  const rect={x:placement==='beside'?treeWidth+1:0,y:placement==='below'?treeHeight+1:0,width:placement==='beside'?width-treeWidth-1:width,height:placement==='below'?height-treeHeight-1:height};
  const content={x:rect.x,y:rect.y+2,width:rect.width,height:Math.max(1,rect.height-3)};
  let entry=cache.get(preview.document);
  if(entry?.width!==content.width){entry={width:content.width,lines:renderDetailReadPreviewLines(preview.document,content.width,getMarkdownTheme()).map(line=>line.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g,''))};cache.set(preview.document,entry);}
  const offset=Math.max(0,Math.min(preview.offset,Math.max(0,entry.lines.length-content.height)));
  const lines=[truncateToWidth(`${preview.focused?'●':'○'} Preview · ${sanitizeDynamicText(preview.title)}`,rect.width),'─'.repeat(rect.width),...entry.lines.slice(offset,offset+content.height)];
  while(lines.length<rect.height-1)lines.push('');
  lines.push(truncateToWidth(help,rect.width));
  return{rect,content,lines:lines.map(line=>shadePreviewLine(line,rect.width)),totalRows:entry.lines.length,offset,treeWidth,treeHeight,placement};
}
export function pointInPreview(rect:PreviewRect,column:number,row:number):boolean{return column>=rect.x&&column<rect.x+rect.width&&row>=rect.y&&row<rect.y+rect.height;}
