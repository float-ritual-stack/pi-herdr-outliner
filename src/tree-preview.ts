import {outlinerActionLink} from './outliner-actions';
import {PREVIEW_NAVIGATION_WIDTH,renderDocumentPreview,type DocumentPreviewFrame} from './document-preview-renderer';

import type {DocumentPreviewState} from './document-preview';
export interface PreviewPreferences {
  enabled: boolean;
  dock: 'auto' | 'right' | 'bottom';
  sideFraction: number;
  bottomFraction: number;
}
export function defaultPreviewPreferences(): PreviewPreferences {
  return {enabled: true, dock: 'auto', sideFraction: .55, bottomFraction: .55};
}
export interface TreePreviewFrame extends DocumentPreviewFrame {
  treeWidth: number;
  treeHeight: number;
  placement: 'beside'|'below'|'compact';
}
export function treePreviewFrame(preview:DocumentPreviewState,width:number,height:number,help:string, preferences=defaultPreviewPreferences()):TreePreviewFrame {
  const wanted = preferences.dock === 'auto' ? (width >= 101 ? 'right' : 'bottom') : preferences.dock;
  const placement = wanted === 'right' && width >= 60 ? 'beside' : wanted === 'bottom' && height >= 16 ? 'below' : 'compact';
  const fraction = Math.max(.2, Math.min(.8, placement === 'beside' ? preferences.sideFraction : preferences.bottomFraction));
  const treeWidth = placement === 'beside' ? Math.max(25, Math.min(width - 26, Math.round((width - 1) * (1 - fraction)))) : width;
  const treeHeight = placement === 'below' ? Math.max(6, Math.min(height - 7, Math.round((height - 1) * (1 - fraction)))) : height;
  const rect={x:placement==='beside'?treeWidth+1:0,y:placement==='below'?treeHeight+1:0,width:placement==='beside'?width-treeWidth-1:width,height:placement==='below'?height-treeHeight-1:height};
  const controls: NonNullable<TreePreviewFrame['controls']> = [];
  let toolbar = '', column = 0;
  for (const [label, action] of [['→','right'],['↓','bottom'],['Auto','auto'],['−','shrink'],['+','grow'],['×','close']]) {
    const text = `[${label}]`;
    if (column + text.length > rect.width-PREVIEW_NAVIGATION_WIDTH) break;
    controls.push({rect: {x: rect.x + column, y: rect.y + 1, width: text.length, height: 1}, action: `tree.preview.${action}`});
    toolbar += outlinerActionLink(`tree.preview.${action}`, action === preferences.dock ? `\x1b[7m${text}\x1b[27m` : text);
    column += text.length;
  }
  const divider = placement === 'beside' ? {x: treeWidth, y: 0, width: 1, height} : placement === 'below' ? {x: 0, y: treeHeight, width, height: 1} : undefined;
  const rendered=renderDocumentPreview({...preview,title:`${preview.title} · ${preferences.dock === 'auto'?'Auto':preferences.dock==='right'?'Dock right':'Dock below'}`},rect,`→ right · ↓ below · Auto fit · drag divider · ${help}`,toolbar);
  return {...rendered,treeWidth,treeHeight,placement,controls:[...controls,...rendered.controls??[]],divider};
}
