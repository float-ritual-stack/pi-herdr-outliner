import {CHECKLIST_CHOICES} from "./checklist-session";
import {parsePreviewRegionActionUri} from "./detail-preview-regions";
import {BufferComposer,BUFFER_COMPOSER_HEIGHT,bufferComposerEditorBody} from './buffer-composer';
import {layoutDetailEditor} from './detail-editor-layout';
import {renderPaneBar, type ChromeLevel, type PaneBarButton} from "./reader-chrome";
import {withInternalLinks, stripRenderedLinks, measureRenderedLinks, type RenderedLink} from './rendered-links';
import {getMarkdownTheme} from '@earendil-works/pi-coding-agent';
import {truncateToWidth, visibleWidth} from '@earendil-works/pi-tui';
import type {DocumentFrame} from './document-frame';
import {renderDetailReadPreview, type DetailReadPreviewDocument} from './detail-pi-preview';
import type {DocumentPreviewState} from './document-preview';
import {sanitizeDynamicText} from './terminal';

/** A pane bar for this preview: its pinned buttons and its `[⋯]` menu. */
export interface DocumentPreviewBar {
  buttons: readonly PaneBarButton[];
  menuAction?: string;
  /** The host pane's hint row shows notices, so the preview keeps no row for them. */
  noticeInHint?: boolean;
}
export interface PreviewRect {x:number;y:number;width:number;height:number}
export interface DocumentPreviewFrame {
  rect: PreviewRect;
  content: PreviewRect;
  lines: string[];
  documentFrame?: DocumentFrame;
  totalRows: number;
  offset: number;
  controls?: Array<{rect: PreviewRect; action: string}>;
  links?: Array<{rect: PreviewRect; uri: string}>;
  divider?: PreviewRect;
  placement?: 'beside'|'below'|'compact';
}
const cache=new WeakMap<DetailReadPreviewDocument,{width:number;disclosures:string;lines:string[];frame:DocumentFrame;links:PreviewLink[];threadRows:Map<string,number>;selected:string|null}>();
export type PreviewLink = RenderedLink;
export function documentPreviewLinks(document:DetailReadPreviewDocument,width:number):PreviewLink[]{documentPreviewLines(document,width);return cache.get(document)!.links;}
export function documentPreviewThreadRow(document:DetailReadPreviewDocument,id:string,width=cache.get(document)?.width ?? 80):number|undefined {
  documentPreviewLines(document,width);
  return cache.get(document)?.threadRows.get(id);
}
export function revealDocumentPreviewComment(document:DetailReadPreviewDocument,id:string,width=cache.get(document)?.width ?? 80):void {
  withInternalLinks(()=>renderDetailReadPreview(document,width,getMarkdownTheme(),undefined,true,undefined,id));
  cache.delete(document);
}
/** Reveal a canonical line using this reader's last measured width and shared source map. */
export function revealDocumentPreviewSourceLine(document:DetailReadPreviewDocument,line:number,previous:DetailReadPreviewDocument):number {
  const width=cache.get(previous)?.width ?? 80;
  const rendered=withInternalLinks(()=>renderDetailReadPreview(document,width,getMarkdownTheme(),undefined,true,line));
  cache.delete(document);
  return rendered.sourceLineRow(line);
}
const background='\x1b[48;5;236m';
function shade(line:string,width:number):string {
  return background+truncateToWidth(line,width,'…',true).replace(/\x1b\[(?:0|49)?m/g,reset=>reset+background)+'\x1b[49m';
}
/** Shared row measurement and painting cache, invalidated by document identity or width. */
export function documentPreviewLines(document:DetailReadPreviewDocument,width:number):string[] {
  let entry=cache.get(document);
  const disclosures=JSON.stringify([...(document.previewRegions?.disclosureOverrides ?? [])]);
  const selected=document.annotations?.selectedAnnotationId ?? null;
  if(entry?.width!==width || entry.disclosures!==disclosures || entry.selected!==selected){
    // OSC links are an internal geometry map; they never reach the terminal.
    // Render synchronously with links even when the host does not support OSC 8.
    const rendered=withInternalLinks(()=>renderDetailReadPreview(document,width,getMarkdownTheme(),undefined,true));
    entry={width,disclosures,selected,frame:rendered.frame,threadRows:rendered.threadRows,links:measureRenderedLinks(rendered.lines),lines:rendered.lines.map(stripRenderedLinks)};
    cache.set(document,entry);
  }
  return entry.lines;
}
/** Render one allocated document rectangle. All input geometry comes from this frame. */
export function renderDocumentPreview(preview:DocumentPreviewState,rect:PreviewRect,help:string,toolbar?:string, chrome: ChromeLevel = "full", bar?: DocumentPreviewBar):DocumentPreviewFrame {
  if(preview.checklistPicker){
    const picker=preview.checklistPicker;
    const room=Math.max(1,rect.height-2);
    const start=Math.max(0,Math.min(picker.index-room+1,CHECKLIST_CHOICES.length-room));
    const choices=CHECKLIST_CHOICES.slice(start,start+room);
    const lines=['Checklist step',...choices.map((choice,index)=>`${start+index===picker.index?'>':' '} ${choice.label}`),'Enter choose · Esc cancel'];
    const controls:NonNullable<DocumentPreviewFrame['controls']>=choices.map((choice,index)=>({
      rect:{x:rect.x,y:rect.y+index+1,width:rect.width,height:1},action:`preview.checklist.choose:${choice.id}`,
    })).filter(control=>control.rect.y<rect.y+rect.height);
    if(lines.length<=rect.height)controls.push({rect:{x:rect.x,y:rect.y+lines.length-1,width:rect.width,height:1},action:'preview.checklist.cancel'});
    return {rect,content:{...rect,height:0},lines:lines.slice(0,rect.height).map(line=>shade(line,rect.width)),
      offset:preview.offset,totalRows:0,links:[],controls};
  }
  if(preview.comment){
    const draft=preview.comment;
    const readerHeight=Math.max(0,rect.height-BUFFER_COMPOSER_HEIGHT);
    const reader=readerHeight?renderDocumentPreview({...preview,comment:undefined},{...rect,height:readerHeight},help,toolbar,chrome,bar):null;
    const composerHeight=Math.min(BUFFER_COMPOSER_HEIGHT,Math.max(1,rect.height));
    const body=bufferComposerEditorBody(rect.width,composerHeight);
    const layout=layoutDetailEditor(draft.buffer.lines,draft.buffer.row,draft.buffer.column,body);
    const composer=new BufferComposer(()=>({title:draft.annotationId?'Reply':draft.target?.anchor.kind==='text-quote'?'Comment on passage':'Comment on note',context:draft.target?.anchor.kind==='text-quote'?draft.target.anchor.exact:preview.title,buffer:draft.buffer,
      placeholder:'Write a comment',commitAction:'Ctrl+S',cancelAction:'Esc',viewportOffset:Math.max(0,layout.cursorRow-body.height+1),
      height:composerHeight,status:draft.saving?'Saving…':preview.notice}));
    composer.focused=preview.focused;
    const rows=composer.render(rect.width);
    const lines=[...(reader?.lines??[]),...rows].slice(0,rect.height);
    return {rect,content:reader?.content??{...rect,height:0},lines,totalRows:reader?.totalRows??0,offset:reader?.offset??preview.offset,
      links:[],controls:[]};
  }
  if (chrome === "compact" || bar) return renderBarPreview(preview, rect, chrome, bar ?? {buttons: []}, help);
  const content={...rect,y:rect.y+2,height:Math.max(1,rect.height-3)};
  const rendered=documentPreviewLines(preview.document,content.width);
  const offset=Math.max(0,Math.min(preview.offset,Math.max(0,rendered.length-content.height)));
  const controls:NonNullable<DocumentPreviewFrame['controls']>=[];
  // [‹][›][Open] must remain reachable even in a narrow reader.
  let navigation=toolbar&&visibleWidth(toolbar)<=rect.width-12?toolbar:'';
  let column=visibleWidth(navigation);
  for(const [label,action] of [['‹','back'],['›','forward'],['Open','open'],...(preview.document.commentTarget?[['Comment','comment']]:[])]){
    const text=`[${label}]`;
    if(column+text.length>rect.width)break;
    const enabled=action==='open'||action==='comment'||(action==='back'?preview.canBack:preview.canForward);
    if(enabled)controls.push({rect:{x:rect.x+column,y:rect.y+1,width:text.length,height:1},action:`preview.${action}`});
    navigation+=enabled?text:`\x1b[2m${text}\x1b[22m`;column+=text.length;
  }
  const links=documentPreviewLinks(preview.document,content.width).filter(link=>link.row>=offset&&link.row<offset+content.height).map(link=>({uri:link.uri,rect:{x:content.x+link.column,y:content.y+link.row-offset,width:link.width,height:1}}));
  const commentKey=preview.bindings?.comment??'c',selectKey=preview.bindings?.select??'v';
  const commentPrompt=preview.document.commentTarget?` · ${commentKey} comment`:'';
  const lines=[preview.selecting?`Select passage · arrows move · Shift selects${commentPrompt} · Esc clear`:preview.passageSelected?`Passage selected${commentPrompt} · Esc clear`:`${preview.focused?'●':'○'} Preview · ${sanitizeDynamicText(preview.title)}`,navigation,...rendered.slice(offset,offset+content.height)];
  while(lines.length<rect.height-1)lines.push('');
  lines.push(preview.notice ? sanitizeDynamicText(preview.notice) : preview.activeLink ? parsePreviewRegionActionUri(preview.activeLink)?.type==='checklist.open'?'Enter status · Space toggle · Ctrl+Z undo':`Enter follow · ${sanitizeDynamicText(preview.activeLinkLabel??preview.activeLink)}` : `${preview.document.commentTarget?`${commentKey} comment · `:""}${selectKey} select · [/] threads · Tab links · ${help}`);
  return {rect,content,lines:lines.slice(0,rect.height).map(line=>shade(line,rect.width)),offset,totalRows:rendered.length,documentFrame:cache.get(preview.document)!.frame,links,controls};
}
export function pointInPreview(rect:PreviewRect,column:number,row:number):boolean{return column>=rect.x&&column<rect.x+rect.width&&row>=rect.y&&row<rect.y+rect.height;}

function previewHelpLine(preview: DocumentPreviewState, help: string): string {
  const commentKey=preview.bindings?.comment??'c',selectKey=preview.bindings?.select??'v';
  if (preview.activeLink) return parsePreviewRegionActionUri(preview.activeLink)?.type==='checklist.open'?'Enter status · Space toggle · Ctrl+Z undo':`Enter follow · ${sanitizeDynamicText(preview.activeLinkLabel??preview.activeLink)}`;
  return `${preview.document.commentTarget&&commentKey!=='unbound'?`${commentKey} comment · `:""}${selectKey} select · [/] threads · Tab links${help?` · ${help}`:""}`;
}

/**
 * The preview under a pane bar: one bar row (title, pinned buttons, `[⋯]`), the document,
 * and in full chrome a shortcut row. Selecting a passage swaps the pins for its own two buttons.
 */
function renderBarPreview(preview: DocumentPreviewState, rect: PreviewRect, chrome: ChromeLevel, bar: DocumentPreviewBar, help: string): DocumentPreviewFrame {
  const notice = preview.notice && !bar.noticeInHint ? sanitizeDynamicText(preview.notice) : "";
  const footer = chrome === "full" ? 1 : Number(Boolean(notice));
  const content = {...rect, y: rect.y + 1, height: Math.max(0, rect.height - 1 - footer)};
  const rendered = documentPreviewLines(preview.document, content.width);
  const offset = Math.max(0, Math.min(preview.offset, Math.max(0, rendered.length - content.height)));
  const commentKey = preview.bindings?.comment==='unbound'?'Comment':preview.bindings?.comment??'c';
  const selection = preview.selecting || preview.passageSelected;
  const buttons: PaneBarButton[] = selection
    ? [...(preview.document.commentTarget ? [{actionId: "preview.comment", text: `[${commentKey}]`}] : []), {actionId: "preview.selection.cancel", text: "[Esc]"}]
    : [...bar.buttons];
  // The pane's identity stays first; a selection says what it is after it.
  const identity = `${preview.focused ? "●" : "○"} Preview · ${preview.selecting ? "Select passage · Shift+arrows" : preview.passageSelected ? "Passage selected" : sanitizeDynamicText(preview.title)}`;
  const strip = renderPaneBar(rect.width, identity, buttons, selection ? undefined : bar.menuAction);
  const controls: NonNullable<DocumentPreviewFrame["controls"]> = strip.controls.map(control => ({
    rect: {x: rect.x + control.x, y: rect.y, width: control.width, height: 1}, action: control.action,
  }));
  const links = documentPreviewLinks(preview.document, content.width)
    .filter(link => link.row >= offset && link.row < offset + content.height)
    .map(link => ({uri: link.uri, rect: {x: content.x + link.column, y: content.y + link.row - offset, width: link.width, height: 1}}));
  const lines = [strip.line, ...rendered.slice(offset, offset + content.height)];
  while (lines.length < rect.height - footer) lines.push("");
  if (chrome === "full") lines.push(notice || `\x1b[2m${previewHelpLine(preview, help)}\x1b[22m`);
  else if (notice) lines.push(notice);
  return {rect, content, lines: lines.slice(0,rect.height).map(line => shade(line,rect.width)), offset, totalRows: rendered.length, documentFrame:cache.get(preview.document)!.frame, links, controls};
}
