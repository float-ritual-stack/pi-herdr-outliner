import {isKeyRelease,StdinBuffer} from "@earendil-works/pi-tui";
import {decodePiDetailInput,piDetailChooserInput} from "./detail-pi-input";

type ReviewInput=ReturnType<typeof piDetailChooserInput>;

/** Share the terminal's framing and Escape timer; pasted documents and key
 * releases never become review commands, including on the raw ANSI host. */
export class EditRecoveryInput {
  private readonly buffer=new StdinBuffer({escapeTimeout:30});
  private emit:((input:ReviewInput)=>void)|undefined;
  constructor(){
    this.buffer.on("data",data=>{
      if(isKeyRelease(data))return;
      const input=decodePiDetailInput(data);
      if(input.kind==="key"&&input.inputAction!=="suppress")this.emit?.(piDetailChooserInput(input));
    });
  }
  dispose():void {this.emit=undefined;this.buffer.destroy();}
  accept(data:string,emit:(input:ReviewInput)=>void):void {
    this.emit=emit;this.buffer.process(data);
  }
}
