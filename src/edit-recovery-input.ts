import {isKeyRelease} from "@earendil-works/pi-tui";
import {PiDetailInputStreamDecoder,piDetailChooserInput} from "./detail-pi-input";

/** Review shortcuts must never interpret a release or pasted document as commands. */
export class EditRecoveryInput {
  private readonly decoder=new PiDetailInputStreamDecoder();
  push(data:string):ReturnType<typeof piDetailChooserInput>[] {
    if(isKeyRelease(data))return [];
    return this.decoder.push(data).flatMap(input=>input.kind==="key"&&input.inputAction!=="suppress"?[piDetailChooserInput(input)]:[]);
  }
}
