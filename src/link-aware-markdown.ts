import {Markdown, type MarkdownTheme} from '@earendil-works/pi-tui';

let nextDocumentPiece=0;
const marker=(id:string)=>`\x1b]133;outliner-link=${id}\x07`;

/** Internal, zero-width occurrence markers survive wrapping; readers remove them before painting. */
export class LinkAwareMarkdown extends Markdown {
  private readonly resetOccurrences:()=>void;
  constructor(text:string,theme:MarkdownTheme){
    const piece=nextDocumentPiece++;
    let occurrence=0;
    super(text,0,0,{...theme,link:label=>marker(`${piece}:${occurrence++}`)+theme.link(label)});
    this.resetOccurrences=()=>{occurrence=0;};
  }
  override render(width:number):string[]{
    this.resetOccurrences();
    return super.render(width);
  }
}
export function stripLinkMarkers(line:string):string {
  return line.replace(/\x1b\]133;outliner-link=[^\x07\x1b]*(?:\x07|\x1b\\)/g,'');
}
