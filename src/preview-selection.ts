import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { TreePrimaryPointer } from "./tree-mouse";
import {copyRenderedColumns,type CopyExcludedSpan} from './rendered-links';

export interface PreviewContentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Point = { column: number; row: number };
type Pointer = Pick<TreePrimaryPointer, "phase" | "column" | "row">;
type Selection = {
  rect: PreviewContentRect;
  anchor: Point;
  head: Point;
  lines: readonly string[];
  excluded: readonly CopyExcludedSpan[];
};

function sameRect(a: PreviewContentRect, b: PreviewContentRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function clamp(point: Point, rect: PreviewContentRect): Point {
  if (point.row < rect.y) return {row: rect.y, column: rect.x};
  if (point.row >= rect.y + rect.height) return {row: rect.y + rect.height - 1, column: rect.x + rect.width};
  return {row: point.row, column: Math.max(rect.x, Math.min(rect.x + rect.width, point.column))};
}

function range(selection: Selection, row: number): [number, number] | null {
  const {anchor, head, rect} = selection;
  const forward = anchor.row < head.row || (anchor.row === head.row && anchor.column <= head.column);
  const [start, end] = forward ? [anchor, head] : [head, anchor];
  if (row < start.row || row > end.row) return null;
  const left = row === start.row ? start.column : rect.x;
  const right = row === end.row ? end.column : rect.x + rect.width;
  return right > left ? [left, right] : null;
}

function graphemeRange(selection: Selection, row: number, line: string): [number, number] | null {
  const columns = range(selection, row);
  if (!columns) return null;
  const edge = (column: number, strict: boolean) => visibleWidth(sliceByColumn(line, 0, column, strict));
  // Expand partial glyphs inside the rectangle, but never borrow a neighboring pane's glyph.
  const left = edge(columns[0], true);
  const right = edge(columns[1], false);
  const boundedLeft = left >= selection.rect.x ? left : edge(columns[0], false);
  const boundedRight = right <= selection.rect.x + selection.rect.width ? right : edge(columns[1], true);
  return boundedRight > boundedLeft ? [boundedLeft, boundedRight] : null;
}

/** Select rendered columns within one Preview; the caller owns clipboard delivery. */
export class PreviewSelection {
  private claimed = false;
  private selection: Selection | null = null;

  get ownsPointer(): boolean { return this.claimed; }

  // Keep ownership until mouseup, even when a redraw cancels the selected content.
  clear(): void {
    this.selection = null;
  }

  /** Lines are the full frame, with one entry per actual terminal row. End columns are exclusive. */
  pointer(event: Pointer, rect: PreviewContentRect, visibleAnsiLines: readonly string[], excluded:readonly CopyExcludedSpan[]=[]): {consumed: boolean; copy?: string} {
    if (event.phase === "down") {
      this.clear();
      this.claimed = rect.width > 0 && rect.height > 0 && event.column >= rect.x &&
        event.column < rect.x + rect.width && event.row >= rect.y && event.row < rect.y + rect.height;
      if (this.claimed) this.selection = {rect: {...rect}, anchor: {...event}, head: {...event}, lines: [...visibleAnsiLines], excluded:[...excluded]};
      return {consumed: this.claimed};
    }
    if (!this.claimed) return {consumed: false};
    if (this.selection && !sameRect(this.selection.rect, rect)) this.clear();
    if (this.selection) this.selection.head = clamp(event, this.selection.rect);
    if (event.phase !== "up") return {consumed: true};
    this.claimed = false;
    if (!this.selection) return {consumed: true};
    const capture=this.capture();
    return capture?{consumed:true,copy:capture.quote}:{consumed:true};
  }

  /** Keyboard movement uses the same painted cells and exclusion spans as a drag. */
  beginKeyboard(rect: PreviewContentRect, lines: readonly string[], excluded: readonly CopyExcludedSpan[]): boolean {
    if(rect.width<1 || rect.height<1)return false;
    this.claimed=false;
    let row=rect.y;
    while(row<rect.y+rect.height-1 && !stripTerminalSequences(sliceByColumn(lines[row]??'',rect.x,rect.width,true)).trim())row++;
    const leading=/^ */.exec(stripTerminalSequences(sliceByColumn(lines[row]??'',rect.x,rect.width,true)))![0].length;
    const column=Math.min(rect.x+rect.width-1,rect.x+leading);
    this.selection={rect:{...rect},anchor:{row,column},head:{row,column},lines:[...lines],excluded:[...excluded]};
    return true;
  }

  moveKeyboard(direction:string,extend:boolean):void {
    if(!this.selection)return;
    const selected=this.selection,{rect}=selected;
    let {row,column}=selected.head;
    const boundaries=(at:number)=>{
      const text=stripTerminalSequences(sliceByColumn(selected.lines[at]??'',rect.x,rect.width,true)).trimEnd();
      const result=[rect.x];
      for(const part of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text))result.push(result.at(-1)!+visibleWidth(part.segment));
      return result;
    };
    if(direction==='up')row=Math.max(rect.y,row-1);
    if(direction==='down')row=Math.min(rect.y+rect.height-1,row+1);
    const cells=boundaries(row);
    if(direction==='home')column=rect.x;
    else if(direction==='end')column=cells.at(-1)!;
    else if(direction==='left')column=cells.filter(cell=>cell<column).at(-1)??rect.x;
    else if(direction==='right')column=cells.find(cell=>cell>column)??cells.at(-1)!;
    else column=cells.filter(cell=>cell<=column).at(-1)??rect.x;
    selected.head={row,column};
    if(!extend)selected.anchor={...selected.head};
  }

  /** Completed drag evidence stays in the original painted rectangle. */
  capture():{quote:string;snapshotText:string;cells:Array<{row:number;start:number;end:number}>}|null {
    if(this.claimed || !this.selection)return null;
    const {anchor,head,lines,rect}=this.selection;
    if(anchor.row===head.row && anchor.column===head.column)return null;
    const selected:string[]=[];
    for(let row=Math.min(anchor.row,head.row);row<=Math.max(anchor.row,head.row);row++){
      const columns=graphemeRange(this.selection,row,lines[row]??'');
      selected.push(columns?copyRenderedColumns(lines[row]??'',columns[0],columns[1],this.selection.excluded.filter(span=>span.row===row)):'');
    }
    const quote=selected.join('\n');
    if(!quote.trim())return null;
    const snapshotText=lines.slice(rect.y,rect.y+rect.height).map((line,index)=>
      copyRenderedColumns(line,rect.x,rect.x+rect.width,this.selection!.excluded.filter(span=>span.row===rect.y+index))).join('\n');
    const cells=lines.flatMap((line,row)=>{const span=graphemeRange(this.selection!,row,line);return span?[{row,start:span[0],end:span[1]}]:[];});
    return {quote,snapshotText,cells};
  }

  /** Reverse only selected content; surrounding frame columns retain their existing ANSI. */
  highlight(frameLines: readonly string[], rect: PreviewContentRect, keyboardCursor=false): string[] {
    const selection = this.selection;
    if (!selection || !sameRect(selection.rect, rect)) return [...frameLines];
    return frameLines.map((line, row) => {
      const columns = graphemeRange(selection, row, line) ?? (keyboardCursor && row===selection.head.row ? [selection.head.column,Math.min(rect.x+rect.width,selection.head.column+1)] : null);
      if (!columns) return line;
      const [left, right] = columns;
      const middle = stripTerminalSequences(sliceByColumn(line, left, right - left, true));
      if (!middle) return line;
      return `${sliceByColumn(line, 0, left, true)}\x1b[7m${middle}\x1b[27m${sliceByColumn(line, right, Number.MAX_SAFE_INTEGER, true)}`;
    });
  }
}
