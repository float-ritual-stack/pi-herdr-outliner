import type {Tokens} from 'marked';
import {concatDocuments,generatedDocument,sliceDocument,type MappedDocument} from './document-provenance';

export interface TableCell {
  /** Logical source identity, independent of grid/card layout and width. */
  id:string;
  source:MappedDocument;
}
export interface TableNode {
  header:TableCell[];
  rows:TableCell[][];
  align:readonly ('left'|'center'|'right'|null)[];
}

/** GFM splits pipes even inside code spans; an odd backslash count protects a
 * pipe. Consume those delimiters before inline parsing, retaining escaped pipes
 * as atomic source transforms rather than looking up the normalized cell text. */
function rowCells(row:MappedDocument):MappedDocument[] {
  const cells:MappedDocument[]=[];let start=0,slashes=0;
  for(let index=0;index<row.text.length;index++) {
    const char=row.text[index];
    if(char==='|'&&slashes%2===0){cells.push(sliceDocument(row,start,index));start=index+1;}
    slashes=char==='\\'?slashes+1:0;
  }
  cells.push(sliceDocument(row,start));
  if(!cells[0]?.text.trim())cells.shift();
  if(cells.length&&!cells.at(-1)!.text.trim())cells.pop();
  return cells.map(cell=>{
    const begin=cell.text.length-cell.text.trimStart().length,end=cell.text.trimEnd().length;
    const trimmed=sliceDocument(cell,begin,Math.max(begin,end));
    const parts:MappedDocument[]=[];let cursor=0;
    for(const match of trimmed.text.matchAll(/\\\|/g)) {
      parts.push(sliceDocument(trimmed,cursor,match.index));
      const consumed=sliceDocument(trimmed,match.index,match.index+2);
      // Generated escapes can precede authored pipes. Keep each contributing
      // origin on the single output character, never stretch either range.
      parts.push({text:'|',runs:consumed.runs.map(run=>({start:0,end:1,origin:run.origin,mapping:'atomic' as const}))});
      cursor=match.index+2;
    }
    parts.push(sliceDocument(trimmed,cursor));return concatDocuments(parts);
  });
}

export function sourceTable(source:MappedDocument,token:Tokens.Table,path:string):TableNode|null {
  const lines:MappedDocument[]=[];let offset=0;
  for(const text of source.text.split('\n')) {
    lines.push(sliceDocument(source,offset,offset+text.length));offset+=text.length+1;
  }
  const columns=token.header.length;
  const parseRow=(line:MappedDocument,expected:Tokens.TableCell[],rowId:string):TableCell[]|null=>{
    const cells=rowCells(line).slice(0,columns);
    while(cells.length<columns)cells.push(generatedDocument('','missing table cell'));
    if(cells.length!==expected.length||cells.some((cell,index)=>cell.text!==expected[index]!.text))return null;
    return cells.map((source,index)=>({id:`${path}/${rowId}/cell:${index}`,source}));
  };
  if(lines.length<2)return null;
  const header=parseRow(lines[0]!,token.header,'header');if(!header)return null;
  const rows:TableCell[][]=[];
  for(const [index,row] of token.rows.entries()) {
    const line=lines[index+2];if(!line)return null;
    const cells=parseRow(line,row,`row:${index}`);if(!cells)return null;
    rows.push(cells);
  }
  if(lines.slice(token.rows.length+2).some(line=>line.text.trim()))return null;
  return {header,rows,align:token.align};
}
