import {getCapabilities, setCapabilities, sliceByColumn, stripTerminalSequences, visibleWidth} from '@earendil-works/pi-tui';

export interface RenderedLink {row:number;column:number;width:number;uri:string;label:string;occurrenceId?:string}

/** Synchronous only: OSC links describe geometry even on terminals without OSC 8. */
export function withInternalLinks<T>(render:()=>T):T {
  const capabilities=getCapabilities();
  try {setCapabilities({...capabilities,hyperlinks:true});return render();}
  finally {setCapabilities(capabilities);}
}
export function stripRenderedLinks(line:string):string {
  return line.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g,'');
}
export function measureRenderedLinks(lines:readonly string[]):RenderedLink[] {
  const links:RenderedLink[]=[];
  let occurrenceId:string|undefined;
  lines.forEach((line,row)=>{
    let cursor=0,column=0,active:{uri:string;column:number}|undefined;
    const append=(end:number)=>{
      if(!active||end<=active.column)return;
      const width=end-active.column;
      links.push({row,column:active.column,width,uri:active.uri,...(occurrenceId?{occurrenceId}:{}),label:stripTerminalSequences(sliceByColumn(line,active.column,width,true)).trim()||active.uri});
    };
    for(const match of line.matchAll(/\x1b\](?:8;[^;\x07\x1b]*;([^\x07\x1b]*)|133;outliner-link=([^\x07\x1b]*))(?:\x07|\x1b\\)/g)){
      column+=visibleWidth(line.slice(cursor,match.index));
      if(match[2]!==undefined) occurrenceId=match[2];
      else {append(column);active=match[1]?{uri:match[1],column}:undefined;}
      cursor=match.index+match[0].length;
    }
    append(column+visibleWidth(line.slice(cursor)));
  });
  return links;
}
