import {PreviewSelection} from './preview-selection';
import {parseTreePrimaryPointer,parseTreeWheelEvent,parseTreeSecondaryClick} from './tree-mouse';
import {pointInPreview,type TreePreviewFrame,type TreeLocalPreview} from './tree-preview';
import type {TreeController} from './tree-controller';

/** Input is owned by the rendered Preview rectangle, never by rows underneath it. */
export class TreePreviewInput {
  private selection=new PreviewSelection();
  private frame:TreePreviewFrame|undefined;
  private lines:string[]=[];
  private document:TreeLocalPreview['document']|undefined;
  private geometry='';
  render(lines:string[],frame:TreePreviewFrame|undefined,preview:TreeLocalPreview|null|undefined):string[]{
    const visible=frame && (frame.placement!=='compact'||preview?.focused)?frame:undefined;
    const geometry=visible?JSON.stringify([visible.content,visible.offset]):'';
    if(preview?.document!==this.document||geometry!==this.geometry)this.selection.clear();
    this.document=preview?.document;this.geometry=geometry;this.frame=visible;this.lines=lines;
    return visible?this.selection.highlight(lines,visible.content):lines;
  }
  handle(sequence:string,controller:TreeController,copy:(text:string)=>void,redraw:()=>void):boolean{
    const frame=this.frame;
    const wheel=parseTreeWheelEvent(sequence);
    if(wheel&&frame&&pointInPreview(frame.rect,wheel.column,wheel.row)){controller.scrollLocalPreview(wheel.direction==='up'?-3:3);return true;}
    const pointer=parseTreePrimaryPointer(sequence);
    if(pointer){
      const result=this.selection.pointer(pointer,frame?.content??{x:0,y:0,width:0,height:0},this.lines);
      if(result.consumed){controller.focusLocalPreview();if(result.copy)copy(result.copy);redraw();return true;}
      if(frame&&pointInPreview(frame.rect,pointer.column,pointer.row)){controller.focusLocalPreview();return true;}
      if(frame&&pointer.phase==='down')controller.focusLocalPreview(false);
    }
    const secondary=parseTreeSecondaryClick(sequence);
    return !!(secondary&&frame&&pointInPreview(frame.rect,secondary.column,secondary.row));
  }
}
