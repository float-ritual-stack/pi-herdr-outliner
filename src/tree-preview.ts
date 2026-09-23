import {getMarkdownTheme} from '@earendil-works/pi-coding-agent';
import {truncateToWidth} from '@earendil-works/pi-tui';
import {renderDetailReadPreviewLines, type DetailReadPreviewDocument} from './detail-pi-preview';
import type {OutlinerNavigationTarget} from './types';
import {outlinerActionLink} from './outliner-actions';
import {sanitizeDynamicText} from './terminal';

export interface TreeLocalPreview {
  readonly target: OutlinerNavigationTarget;
  readonly title: string;
  readonly document: DetailReadPreviewDocument;
  readonly offset: number;
  readonly focused: boolean;
}
export interface PreviewPreferences {
  enabled: boolean;
  dock: 'auto' | 'right' | 'bottom';
  sideFraction: number;
  bottomFraction: number;
}
export function defaultPreviewPreferences(): PreviewPreferences {
  return {enabled: true, dock: 'auto', sideFraction: .55, bottomFraction: .55};
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
  controls?: Array<{rect: PreviewRect; action: string}>;
  divider?: PreviewRect;
}
const cache = new WeakMap<DetailReadPreviewDocument,{width:number;lines:string[]}>();
const PREVIEW_BACKGROUND = '\x1b[48;5;236m';
function shadePreviewLine(line: string, width: number): string {
  const padded = truncateToWidth(line, width, '…', true);
  return PREVIEW_BACKGROUND + padded.replace(/\x1b\[(?:0|49)?m/g, reset => reset + PREVIEW_BACKGROUND) + '\x1b[49m';
}
export function treePreviewFrame(preview:TreeLocalPreview,width:number,height:number,help:string, preferences=defaultPreviewPreferences()):TreePreviewFrame {
  const wanted = preferences.dock === 'auto' ? (width >= 101 ? 'right' : 'bottom') : preferences.dock;
  const placement = wanted === 'right' && width >= 60 ? 'beside' : wanted === 'bottom' && height >= 16 ? 'below' : 'compact';
  const fraction = Math.max(.2, Math.min(.8, placement === 'beside' ? preferences.sideFraction : preferences.bottomFraction));
  const treeWidth = placement === 'beside' ? Math.max(25, Math.min(width - 26, Math.round((width - 1) * (1 - fraction)))) : width;
  const treeHeight = placement === 'below' ? Math.max(6, Math.min(height - 7, Math.round((height - 1) * (1 - fraction)))) : height;
  const rect={x:placement==='beside'?treeWidth+1:0,y:placement==='below'?treeHeight+1:0,width:placement==='beside'?width-treeWidth-1:width,height:placement==='below'?height-treeHeight-1:height};
  const content={x:rect.x,y:rect.y+2,width:rect.width,height:Math.max(1,rect.height-3)};
  let entry=cache.get(preview.document);
  if(entry?.width!==content.width){entry={width:content.width,lines:renderDetailReadPreviewLines(preview.document,content.width,getMarkdownTheme()).map(line=>line.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g,''))};cache.set(preview.document,entry);}
  const offset=Math.max(0,Math.min(preview.offset,Math.max(0,entry.lines.length-content.height)));
  const controls: NonNullable<TreePreviewFrame['controls']> = [];
  let toolbar = '', column = 0;
  for (const [label, action] of [['→','right'],['↓','bottom'],['Auto','auto'],['−','shrink'],['+','grow'],['×','close']]) {
    const text = `[${label}]`;
    if (column + text.length > rect.width) break;
    controls.push({rect: {x: rect.x + column, y: rect.y + 1, width: text.length, height: 1}, action: `tree.preview.${action}`});
    toolbar += outlinerActionLink(`tree.preview.${action}`, text) + ' ';
    column += text.length + 1;
  }
  const divider = placement === 'beside' ? {x: treeWidth, y: 0, width: 1, height} : placement === 'below' ? {x: 0, y: treeHeight, width, height: 1} : undefined;
  const lines=[truncateToWidth(`${preview.focused?'●':'○'} Preview · ${sanitizeDynamicText(preview.title)}`,rect.width),toolbar,...entry.lines.slice(offset,offset+content.height)];
  while(lines.length<rect.height-1)lines.push('');
  lines.push(truncateToWidth(help,rect.width));
  return{rect,content,lines:lines.map(line=>shadePreviewLine(line,rect.width)),totalRows:entry.lines.length,offset,treeWidth,treeHeight,placement,controls,divider};
}
export function pointInPreview(rect:PreviewRect,column:number,row:number):boolean{return column>=rect.x&&column<rect.x+rect.width&&row>=rect.y&&row<rect.y+rect.height;}
