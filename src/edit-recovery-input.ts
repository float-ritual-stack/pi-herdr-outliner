import {isKeyRelease} from "@earendil-works/pi-tui";
import {PiDetailInputStreamDecoder,piDetailChooserInput} from "./detail-pi-input";

/** Review shortcuts must never interpret a release or pasted document as commands. */
export class EditRecoveryInput {
  private readonly decoder=new PiDetailInputStreamDecoder();
  private timer:ReturnType<typeof setTimeout>|undefined;
  dispose():void {if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
  accept(data:string,emit:(input:ReturnType<typeof piDetailChooserInput>)=>void):void {
    this.dispose();
    for(const input of this.push(data))emit(input);
    this.timer=setTimeout(()=>{this.timer=undefined;for(const input of this.decoder.flush())if(input.kind==="key"&&input.inputAction!=="suppress")emit(piDetailChooserInput(input));},30);
  }
  push(data:string):ReturnType<typeof piDetailChooserInput>[] {
    if(isKeyRelease(data))return [];
    return this.decoder.push(data).flatMap(input=>input.kind==="key"&&input.inputAction!=="suppress"?[piDetailChooserInput(input)]:[]);
  }
}
