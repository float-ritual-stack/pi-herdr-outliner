import {isKeyRelease, StdinBuffer, truncateToWidth, wrapTextWithAnsi} from '@earendil-works/pi-tui';
import {decodePiDetailInput} from './detail-pi-input';
import {type DocumentFrame, type DocumentPoint} from './document-frame';
import {observedDocumentIdentity, type DocumentOrigin, type SourceSlice} from './document-provenance';
import {parseTreePrimaryPointer, parseTreeWheelEvent} from './tree-mouse';
import {sanitizeDynamicText, type TerminalKey} from './terminal';

const quoted=(value:string)=>JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
  char=>`\\u${char.charCodeAt(0).toString(16).padStart(4,'0')}`);
function sliceReport(label:string,slice:SourceSlice):string[] {
  const identity=observedDocumentIdentity(slice.document);
  const text=slice.document.text.slice(slice.start,slice.end);
  return [`${label} UTF-16 [${slice.start}, ${slice.end})`,
    `Observed: ${JSON.stringify(identity)}`,
    `Source: ${quoted(text.slice(0,512))}${text.length>512?' (excerpt; range above is complete)':''}`];
}
function originReport(origin:DocumentOrigin):string[] {
  const lines=[`Origin: ${origin.kind}`];
  switch(origin.kind){
    case 'generated': return [...lines,`Reason: ${origin.reason}`];
    case 'source': origin.slices.forEach((slice,index)=>lines.push(...sliceReport(`Slice ${index+1}`,slice)));break;
    case 'reference': lines.push(`Destination: ${origin.destination}`,...sliceReport('Token',origin.token));break;
    case 'derived':
      lines.push(`Result: ${origin.resultId}`,'Derived value: no exact authored range');
      if(origin.result)lines.push(`Observed result: ${JSON.stringify(observedDocumentIdentity(origin.result))}`);
      origin.dependencies.forEach((slice,index)=>lines.push(...sliceReport(`Dependency ${index+1}`,slice)));
      if(origin.resourceDependencies?.length)lines.push(`Resource dependencies: ${JSON.stringify(origin.resourceDependencies)}`);
      return lines;
  }
  if(origin.occurrence){
    lines.push(...sliceReport('Occurrence host token',origin.occurrence.host));
    origin.occurrence.path.forEach((step,index)=>lines.push(`Path ${index+1}: ${step.target}`,...sliceReport('Path token',step.token)));
  }
  return lines;
}

/** Inspect a frozen reader frame. No source reload, quote search or mutation. */
export class ProvenanceInspector {
  private frame:DocumentFrame|null=null;
  private point:DocumentPoint={row:0,column:0};
  private reportOffset=0;
  private reportRows=1;
  private reportLength=0;
  private strip:{top:number;left:number;rows:number}|null=null;
  private input:StdinBuffer|null=null;
  get active():boolean {return this.frame!==null;}
  constructor(private readonly invalidate:()=>void=()=>{}){}
  open(frame:DocumentFrame,row=0):void {
    this.dispose();this.frame=frame;
    this.point={row:Math.max(0,Math.min(frame.lines.length-1,row)),column:0};
    this.reportOffset=0;
    const input=new StdinBuffer({escapeTimeout:30});this.input=input;
    input.on('data',data=>{
      if(isKeyRelease(data))return;
      const pointer=parseTreePrimaryPointer(data);
      if(pointer){if(pointer.phase==='down')this.click(pointer.row,pointer.column);return;}
      const wheel=parseTreeWheelEvent(data);
      if(wheel){this.scrollReport(wheel.direction==='up'?-3:3);return;}
      const decoded=decodePiDetailInput(data);
      if(decoded.kind==='key'&&decoded.inputAction!=='suppress')this.key(decoded.key);
    });
    this.invalidate();
  }
  /** Input is local to the overlay; the host translates its column origin. */
  handle(data:string,columnOffset=0):boolean {
    if(!this.active)return false;
    const localized=data.replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g,(_,button,column,row,end)=>
      `\x1b[<${button};${Number(column)-columnOffset};${row}${end}`);
    this.input?.process(localized);return true;
  }
  private move(row:number,column:number):void {
    if(!this.frame)return;
    row=Math.max(0,Math.min(this.frame.lines.length-1,row));
    const cells=this.frame.cells.filter(cell=>cell.row===row);
    const end=cells.at(-1);
    this.point={row,column:Math.max(0,Math.min(end?end.column+end.width-1:0,column))};
    this.reportOffset=0;this.invalidate();
  }
  private key(key:TerminalKey):void {
    if(key.name==='escape'||(key.ctrl&&key.name==='q')){this.dispose();this.invalidate();return;}
    const cell=this.frame?.inspect(this.point);
    switch(key.name){
      case 'left':this.move(this.point.row,(cell?.column??this.point.column)-1);break;
      case 'right':this.move(this.point.row,(cell?.column??this.point.column)+(cell?.width??1));break;
      case 'up':this.move(this.point.row-1,this.point.column);break;
      case 'down':this.move(this.point.row+1,this.point.column);break;
      case 'home':this.move(this.point.row,0);break;
      case 'end':this.move(this.point.row,Infinity);break;
      case 'pageup':this.scrollReport(-this.reportRows);break;
      case 'pagedown':this.scrollReport(this.reportRows);break;
    }
  }
  private scrollReport(delta:number):void {
    this.reportOffset=Math.max(0,Math.min(Math.max(0,this.reportLength-this.reportRows),this.reportOffset+delta));
    this.invalidate();
  }
  private click(row:number,column:number):void {
    if(this.strip&&row>=2&&row<2+this.strip.rows&&column>=0)this.move(this.strip.top+row-2,this.strip.left+column);
  }
  render(width:number,height:number):string[] {
    width=Math.max(1,Math.floor(width));height=Math.max(1,Math.floor(height));
    const frame=this.frame;if(!frame)return [];
    const rows=Math.min(3,Math.max(0,height-6),frame.lines.length);
    const top=Math.max(0,Math.min(this.point.row-1,frame.lines.length-rows));
    const left=Math.max(0,this.point.column-Math.floor(width/2));
    this.strip={top,left,rows};
    const lines=['Provenance · frozen reader frame','Arrows/click: cell · PgUp/Dn: evidence · Esc: close'];
    for(let row=top;row<top+rows;row++){
      const cells=frame.cells.filter(cell=>cell.row===row);
      // Start from clean graphemes, not OSC links or author-supplied controls.
      let text='',column=left;
      for(const cell of cells){
        if(cell.column<left||cell.column+cell.width>left+width)continue;
        text+=' '.repeat(Math.max(0,cell.column-column));
        const plain=sanitizeDynamicText(cell.text);
        text+=row===this.point.row&&cell.column<=this.point.column&&this.point.column<cell.column+cell.width?`\x1b[7m${plain}\x1b[27m`:plain;
        column=cell.column+cell.width;
      }
      lines.push(text);
    }
    const cell=frame.inspect(this.point);
    lines.push(`Cell row ${this.point.row+1}, column ${this.point.column+1} · ${cell?quoted(cell.text):'no painted cell'}`);
    const report=cell?[`Width: ${cell.width} · Copy: ${cell.copy?'yes':'no'}`,...cell.origins.flatMap(originReport)]:['No source claim'];
    const wrapped=report.flatMap(line=>wrapTextWithAnsi(sanitizeDynamicText(line),width));
    this.reportRows=Math.max(1,height-lines.length-1);this.reportLength=wrapped.length;
    this.reportOffset=Math.min(this.reportOffset,Math.max(0,wrapped.length-this.reportRows));
    lines.push(...wrapped.slice(this.reportOffset,this.reportOffset+this.reportRows));
    lines.push(`Evidence ${this.reportOffset+1}–${Math.min(wrapped.length,this.reportOffset+this.reportRows)} / ${wrapped.length}`);
    return Array.from({length:height},(_,index)=>truncateToWidth(lines[index]??'',width));
  }
  dispose():void {this.input?.destroy();this.input=null;this.frame=null;this.strip=null;}
}
