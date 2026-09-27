import type {TerminalKey} from './terminal';
import {PreviewSelection} from './preview-selection';
import {parseTreePrimaryPointer,parseTreeWheelEvent,parseTreeSecondaryClick} from './tree-mouse';
import {pointInPreview,type DocumentPreviewFrame} from './document-preview-renderer';
import type {PreviewPassageCapture,DocumentPreviewState} from './document-preview';
import {isCopyExcludedLink} from './rendered-links';

/** Input is owned by the rendered Preview rectangle, never by rows underneath it. */
export interface PreviewInputActions {
  focus(focused?: boolean): void;
  scroll(delta: number): void;
  resize(fraction: number): void;
  invoke(action: string): Promise<void>;
}
export class DocumentPreviewInput {
  private selection=new PreviewSelection();
  private frame:DocumentPreviewFrame|undefined;
  private lines:string[]=[];
  private document:DocumentPreviewState['document']|undefined;
  private geometry='';
  private pressedLink: {uri:string;column:number;row:number}|undefined;
  private resizing: DocumentPreviewFrame | undefined;
  private renderRevision=0;
  private passage:PreviewPassageCapture|null=null;
  private keyboardSelecting=false;
  get selecting():boolean{return this.keyboardSelecting;}
  captureSelection():PreviewPassageCapture|null{return this.passage;}
  clearSelection():void {this.keyboardSelecting=false;this.selection.clear();this.passage=null;}
  private exclusions(){return this.frame?.links?.filter(link=>isCopyExcludedLink(link.uri)).map(link=>({row:link.rect.y,column:link.rect.x,width:link.rect.width}))??[];}
  private retainCapture(input:'pointer'|'keyboard'):void {
    const capture=this.selection.capture();
    this.passage=capture && this.document?{...capture,input,document:this.document,renderRevision:this.renderRevision,capturedAt:new Date().toISOString()}:null;
  }
  selectionKey(key:TerminalKey,str=''):boolean {
    if(!this.frame || !this.document)return false;
    if((str||key.name)==='v'&&!key.ctrl&&!key.meta){
      if(this.keyboardSelecting)this.clearSelection();
      else {this.passage=null;this.keyboardSelecting=this.selection.beginKeyboard(this.frame.content,this.lines,this.exclusions());}
      return true;
    }
    if(!this.keyboardSelecting)return false;
    if(key.name==='escape'){this.clearSelection();return true;}
    if(!key.ctrl&&!key.meta&&['left','right','up','down','home','end'].includes(key.name??'')){
      this.selection.moveKeyboard(key.name!,!!key.shift);this.retainCapture('keyboard');return true;
    }
    return false;
  }
  get ownsPointer(): boolean { return this.selection.ownsPointer || !!this.resizing; }
  render(lines:string[],frame:DocumentPreviewFrame|undefined,preview:DocumentPreviewState|null|undefined):string[]{
    const visible=frame && (frame.placement!=='compact'||preview?.focused)?frame:undefined;
    const geometry=visible?JSON.stringify([visible.content,visible.offset,[...(preview?.document.previewRegions?.disclosureOverrides ?? [])]]):'';
    if(preview?.document!==this.document||geometry!==this.geometry){this.clearSelection();this.pressedLink=undefined;}
    this.renderRevision++;
    this.document=preview?.document;this.geometry=geometry;this.frame=visible;this.lines=lines;
    return visible?this.selection.highlight(lines,visible.content,this.keyboardSelecting):lines;
  }
  handle(sequence:string,controller:PreviewInputActions,copy:(text:string)=>void,redraw:()=>void):boolean{
    const frame=this.frame;
    const wheel=parseTreeWheelEvent(sequence);
    if(wheel&&frame&&pointInPreview(frame.rect,wheel.column,wheel.row)){controller.scroll(wheel.direction==='up'?-3:3);return true;}
    const pointer=parseTreePrimaryPointer(sequence);
    if(pointer){
      if(this.pressedLink&&(pointer.column!==this.pressedLink.column||pointer.row!==this.pressedLink.row))this.pressedLink=undefined;
      if (this.resizing || (pointer.phase === 'down' && frame?.divider && pointInPreview(frame.divider,pointer.column,pointer.row))) {
        this.resizing ??= frame;
        const original = this.resizing!;
        const total = original.placement === 'beside' ? original.rect.x + original.rect.width : original.rect.y + original.rect.height;
        const position = original.placement === 'beside' ? pointer.column : pointer.row;
        controller.resize(1 - position / Math.max(1,total - 1));
        if (pointer.phase === 'up') this.resizing = undefined;
        this.selection.clear(); return true;
      }
      // A drag begun in content owns its release even above the toolbar.
      if (pointer.phase !== 'down') {
        const result = this.selection.pointer(pointer,frame?.content??{x:0,y:0,width:0,height:0},this.lines);
        if (result.consumed) {
          const link=this.pressedLink;
          if(pointer.phase==='up')this.pressedLink=undefined;
          if(result.copy){
            this.retainCapture('pointer');
            copy(result.copy);
          }
          else if(pointer.phase==='up'&&link)void controller.invoke(`preview.link:${encodeURIComponent(link.uri)}`);
          redraw(); return true;
        }
      }
      const button = frame?.controls?.find(control=>pointInPreview(control.rect,pointer.column,pointer.row));
      if (button) {
        if (pointer.phase === 'down') void controller.invoke(button.action);
        return true;
      }

      if(pointer.phase==='down'){
        this.keyboardSelecting=false;this.passage=null;
        const link=frame?.links?.find(link=>pointInPreview(link.rect,pointer.column,pointer.row));
        this.pressedLink=link?{uri:link.uri,column:pointer.column,row:pointer.row}:undefined;
      }
      const excluded=this.exclusions();
      const result=this.selection.pointer(pointer,frame?.content??{x:0,y:0,width:0,height:0},this.lines,excluded);
      if(result.consumed){controller.focus();if(result.copy)copy(result.copy);redraw();return true;}
      if(frame&&pointInPreview(frame.rect,pointer.column,pointer.row)){controller.focus();return true;}
      if(frame&&pointer.phase==='down')controller.focus(false);
    }
    const secondary=parseTreeSecondaryClick(sequence);
    return !!(secondary&&frame&&pointInPreview(frame.rect,secondary.column,secondary.row));
  }
}
