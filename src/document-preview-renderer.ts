import {BufferComposer,BUFFER_COMPOSER_HEIGHT,bufferComposerEditorBody} from './buffer-composer';
import {layoutDetailEditor} from './detail-editor-layout';
import type {ReaderDensity} from "./reader-chrome";
import {withInternalLinks, stripRenderedLinks, measureRenderedLinks, type RenderedLink} from './rendered-links';
import {getMarkdownTheme} from '@earendil-works/pi-coding-agent';
import {truncateToWidth, visibleWidth,stripTerminalSequences,sliceByColumn} from '@earendil-works/pi-tui';
import {annotationSourceHash,createTextQuoteAnchor} from './annotations';
import {renderDetailReadPreview, type DetailReadPreviewDocument} from './detail-pi-preview';
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
const cache=new WeakMap<DetailReadPreviewDocument,{width:number;disclosures:string;lines:string[];links:PreviewLink[];threadRows:Map<string,number>;selected:string|null}>();
export type PreviewLink = RenderedLink;
/** Exact identity proof for an untransformed, unwrapped source document.
 * Rich layouts use rendered evidence until their renderer supplies a source map.
 * Never locate a selection by searching for its quote in the source.
 */
export function documentPreviewSourceAnchor(document:DetailReadPreviewDocument,width:number,row:number,left:number,right:number,quote:string){
  const snapshot=document.commentTarget?.representation.sourceSnapshot;
  if(snapshot?.kind!=='block'||annotationSourceHash(document.canonicalText)!==snapshot.contentHash||
    document.truncated||document.embedRanges.length||document.annotations?.annotationThreads.length||
    document.resolvedText!==document.canonicalText||document.projectedText!==document.canonicalText)return null;
  const source=document.canonicalText.split('\n');
  const painted=documentPreviewLines(document,width).map(line=>stripTerminalSequences(line).trimEnd());
  if(painted.length!==source.length||painted.some((line,index)=>line!==source[index]!.trimEnd()))return null;
  const line=source[row];
  if(line===undefined||left<0||right>visibleWidth(line.trimEnd()))return null;
  const offset=source.slice(0,row).reduce((sum,line)=>sum+line.length+1,0);
  const start=offset+sliceByColumn(line,0,left,true).length,end=offset+sliceByColumn(line,0,right,true).length;
  return document.canonicalText.slice(start,end)===quote?createTextQuoteAnchor(document.canonicalText,start,end):null;
}
export function documentPreviewLinks(document:DetailReadPreviewDocument,width:number):PreviewLink[]{documentPreviewLines(document,width);return cache.get(document)!.links;}
export function documentPreviewThreadRow(document:DetailReadPreviewDocument,id:string,width=cache.get(document)?.width ?? 80):number|undefined {
  documentPreviewLines(document,width);
  return cache.get(document)?.threadRows.get(id);
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
    entry={width,disclosures,selected,threadRows:rendered.threadRows,links:measureRenderedLinks(rendered.lines),lines:rendered.lines.map(stripRenderedLinks)};
    cache.set(document,entry);
  }
  return entry.lines;
}
/** Render one allocated document rectangle. All input geometry comes from this frame. */
export function renderDocumentPreview(preview:DocumentPreviewState,rect:PreviewRect,help:string,toolbar?:string, density: ReaderDensity = "expanded", menuAction?: string):DocumentPreviewFrame {
  if(preview.comment){
    const draft=preview.comment;
    const readerHeight=Math.max(0,rect.height-BUFFER_COMPOSER_HEIGHT);
    const reader=readerHeight?renderDocumentPreview({...preview,comment:undefined},{...rect,height:readerHeight},help,toolbar,density,menuAction):null;
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
  if (density === "compact") return renderCompactPreview(preview, rect, menuAction);
  const content={...rect,y:rect.y+2,height:Math.max(1,rect.height-3)};
  const rendered=documentPreviewLines(preview.document,content.width);
  const offset=Math.max(0,Math.min(preview.offset,Math.max(0,rendered.length-content.height)));
  const controls:NonNullable<DocumentPreviewFrame['controls']>=[];
  let navigation=toolbar&&visibleWidth(toolbar)<=rect.width-PREVIEW_NAVIGATION_WIDTH?toolbar:'';
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
  const lines=[preview.selecting?`Select passage · arrows move · Shift selects${commentPrompt}`:preview.passageSelected?`Passage selected${commentPrompt} · Esc clear`:`${preview.focused?'●':'○'} Preview · ${sanitizeDynamicText(preview.title)}`,navigation,...rendered.slice(offset,offset+content.height)];
  while(lines.length<rect.height-1)lines.push('');
  lines.push(preview.notice ? sanitizeDynamicText(preview.notice) : preview.activeLink ? `Enter follow · ${sanitizeDynamicText(preview.activeLinkLabel??preview.activeLink)}` : `${commentKey} comment · ${selectKey} select · [/] threads · Tab links · ${help}`);
  return {rect,content,lines:lines.slice(0,rect.height).map(line=>shade(line,rect.width)),offset,totalRows:rendered.length,links,controls};
}
export function pointInPreview(rect:PreviewRect,column:number,row:number):boolean{return column>=rect.x&&column<rect.x+rect.width&&row>=rect.y&&row<rect.y+rect.height;}

function renderCompactPreview(preview: DocumentPreviewState, rect: PreviewRect, menuAction?: string): DocumentPreviewFrame {
  const notice = preview.notice ? sanitizeDynamicText(preview.notice) : "";
  const content = {...rect, y: rect.y + 1, height: Math.max(0, rect.height - 1 - Number(Boolean(notice)))};
  const rendered = documentPreviewLines(preview.document, content.width);
  const offset = Math.max(0, Math.min(preview.offset, Math.max(0, rendered.length - content.height)));
  const controls: NonNullable<DocumentPreviewFrame["controls"]> = [];
  // Unavailable history controls are omitted so they never take title space.
  const commentKey=preview.bindings?.comment==='unbound'?'Comment':preview.bindings?.comment??'c';
  const actions = ((preview.selecting||preview.passageSelected) ? [[commentKey,"preview.comment",!!preview.document.commentTarget],["Esc","preview.selection.cancel",true]] as const : [["‹", "preview.back", preview.canBack], ["›", "preview.forward", preview.canForward],
    ["Open", "preview.open", true], [commentKey, "preview.comment", !!preview.document.commentTarget], ...(menuAction ? [["⋯", menuAction, true]] : [])] as const)
    .filter(([, , enabled]) => enabled);
  const controlWidth = actions.reduce((sum, [label]) => sum + String(label).length + 2, 0);
  const titleWidth = Math.max(0, rect.width - controlWidth - 1);
  let strip = titleWidth ? truncateToWidth(preview.selecting ? "Select passage · Shift+arrows" : preview.passageSelected ? "Passage selected" : `${preview.focused ? "●" : "○"} Preview · ${sanitizeDynamicText(preview.title)}`, titleWidth) + " " : "";
  let column = visibleWidth(strip);
  for (const [label, action] of actions) {
    const text = `[${label}]`;
    if (column + text.length > rect.width) break;
    controls.push({rect: {x: rect.x + column, y: rect.y, width: text.length, height: 1}, action: String(action)});
    strip += text;
    column += text.length;
  }
  const links = documentPreviewLinks(preview.document, content.width)
    .filter(link => link.row >= offset && link.row < offset + content.height)
    .map(link => ({uri: link.uri, rect: {x: content.x + link.column, y: content.y + link.row - offset, width: link.width, height: 1}}));
  const lines = [strip, ...rendered.slice(offset, offset + content.height)];
  while (lines.length < rect.height - Number(Boolean(notice))) lines.push("");
  if (notice) lines.push(notice);
  return {rect, content, lines: lines.slice(0,rect.height).map(line => shade(line,rect.width)), offset, totalRows: rendered.length, links, controls};
}
