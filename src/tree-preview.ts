import type {ChromeLevel, PaneBarButton} from "./reader-chrome";
import {renderDocumentPreview,type DocumentPreviewFrame} from './document-preview-renderer';

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
/** Tree and its Preview share one hint row at the bottom of the pane. */
export const TREE_HINT_ROWS = 1;

export interface TreePreviewChrome {
  chrome: ChromeLevel;
  buttons: readonly PaneBarButton[];
}

/** Where Auto docking puts Preview at this width. */
export function autoPreviewDock(width: number): 'right' | 'bottom' {
  return width >= 101 ? 'right' : 'bottom';
}

/**
 * Lays out Tree and its Preview inside a pane of `width`×`height`, above the shared hint row.
 * Renderer and controller both call this with the whole pane size, so input geometry and the
 * painted frame always agree.
 */
export function treePreviewFrame(preview:DocumentPreviewState,width:number,height:number,help:string, preferences=defaultPreviewPreferences(), chrome: TreePreviewChrome = {chrome: "compact", buttons: []}):TreePreviewFrame {
  const area = Math.max(1, height - TREE_HINT_ROWS);
  // Compact Preview needs a bar row and a little content; full adds its shortcut row.
  const previewMinimum = chrome.chrome === "full" ? 5 : 4;
  const wanted = preferences.dock === 'auto' ? autoPreviewDock(width) : preferences.dock;
  const placement = wanted === 'right' && width >= 60 ? 'beside' : wanted === 'bottom' && area >= previewMinimum + 6 ? 'below' : 'compact';
  const fraction = Math.max(.2, Math.min(.8, placement === 'beside' ? preferences.sideFraction : preferences.bottomFraction));
  const treeWidth = placement === 'beside' ? Math.max(25, Math.min(width - 26, Math.round((width - 1) * (1 - fraction)))) : width;
  const treeHeight = placement === 'below' ? Math.max(5, Math.min(area - previewMinimum, Math.round((area - 1) * (1 - fraction)))) : area;
  // Docked below, Preview's shaded bar is the divider: no rule row between Tree and Preview.
  const rect={x:placement==='beside'?treeWidth+1:0,y:placement==='below'?treeHeight:0,width:placement==='beside'?width-treeWidth-1:width,height:placement==='below'?area-treeHeight:area};
  const rendered=renderDocumentPreview(preview,rect,help,undefined,chrome.chrome,{buttons:chrome.buttons,menuAction:"tree.preview.menu",noticeInHint:true});
  // Dragging the bar's title (left of its buttons) resizes, as the rule did.
  const firstButton = Math.min(rect.x + rect.width, ...(rendered.controls ?? []).filter(control => control.rect.y === rect.y).map(control => control.rect.x));
  const divider = placement === 'beside' ? {x: treeWidth, y: 0, width: 1, height: area}
    : placement === 'below' ? {x: 0, y: treeHeight, width: Math.max(1, firstButton - 1), height: 1} : undefined;
  return {...rendered,treeWidth,treeHeight,placement,divider};
}
