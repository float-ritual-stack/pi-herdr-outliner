import {PreviewSelection} from './preview-selection';
import {parseTreePrimaryPointer,parseTreeWheelEvent,parseTreeSecondaryClick} from './tree-mouse';
import {pointInPreview,type DocumentPreviewFrame} from './document-preview-renderer';
import type {DocumentPreviewState} from './document-preview';

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
  private resizing: DocumentPreviewFrame | undefined;
  get ownsPointer(): boolean { return this.selection.ownsPointer || !!this.resizing; }
  render(lines:string[],frame:DocumentPreviewFrame|undefined,preview:DocumentPreviewState|null|undefined):string[]{
    const visible=frame && (frame.placement!=='compact'||preview?.focused)?frame:undefined;
    const geometry=visible?JSON.stringify([visible.content,visible.offset]):'';
    if(preview?.document!==this.document||geometry!==this.geometry)this.selection.clear();
    this.document=preview?.document;this.geometry=geometry;this.frame=visible;this.lines=lines;
    return visible?this.selection.highlight(lines,visible.content):lines;
  }
  handle(sequence:string,controller:PreviewInputActions,copy:(text:string)=>void,redraw:()=>void):boolean{
    const frame=this.frame;
    const wheel=parseTreeWheelEvent(sequence);
    if(wheel&&frame&&pointInPreview(frame.rect,wheel.column,wheel.row)){controller.scroll(wheel.direction==='up'?-3:3);return true;}
    const pointer=parseTreePrimaryPointer(sequence);
    if(pointer){
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
        if (result.consumed) { if(result.copy)copy(result.copy); redraw(); return true; }
      }
      const button = frame?.controls?.find(control=>pointInPreview(control.rect,pointer.column,pointer.row));
      if (button) {
        if (pointer.phase === 'down') void controller.invoke(button.action);
        return true;
      }

      const result=this.selection.pointer(pointer,frame?.content??{x:0,y:0,width:0,height:0},this.lines);
      if(result.consumed){controller.focus();if(result.copy)copy(result.copy);redraw();return true;}
      if(frame&&pointInPreview(frame.rect,pointer.column,pointer.row)){controller.focus();return true;}
      if(frame&&pointer.phase==='down')controller.focus(false);
    }
    const secondary=parseTreeSecondaryClick(sequence);
    return !!(secondary&&frame&&pointInPreview(frame.rect,secondary.column,secondary.row));
  }
}
