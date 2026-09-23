import { expect, test } from 'bun:test';
import { TreeConnections } from '../src/tree-connections';
import { authoredTextDigest, AUTHORED_LINKS_MAX_ENTRIES_PER_GROUP } from '../src/authored-links';
import type { RequestInput } from '../src/client';
import type { TreeIndexBlock } from '../src/types';
import type { TreeRow } from '../src/virtual-branches';
import { connectionOwner, type TreeDisplayRow } from '../src/tree-rows';

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function row(id:string,rowId=id):TreeRow<TreeIndexBlock>{
 const block:TreeIndexBlock={id,parentId:null,position:0,revision:1,author:'user',createdAt:'',updatedAt:'',properties:[],depth:0,hasChildren:false,preview:id,previewReferences:[],textDigest:authoredTextDigest(id)};
 return{kind:'physical',rowId,canonicalId:id,block,depth:0,hasChildren:false,collapsed:false,multilineExpanded:false};
}
function links(id:string,targets:string[]){
 return{kind:'ready',ownerId:id,ownerTextDigest:authoredTextDigest(id),outlinks:{entries:targets.map(target=>({kind:'outlink',key:target,label:target,referenceKind:'block',occurrenceCount:1,firstSpan:{start:0,end:1},resolution:{kind:'ready',target:{kind:'block',blockId:target},title:target}})),completeness:{kind:'complete'},invalidCount:0,diagnostics:[]},resources:{entries:[],completeness:{kind:'complete'},invalidCount:0,diagnostics:[]}};
}
function fixture(respond?:(input:RequestInput)=>unknown|Promise<unknown>){
 const roots=[row(A),row(B)],calls:RequestInput[]=[];
 const index=new Map(roots.map(r=>[r.canonicalId,r.block]));
 const connections=new TreeConnections({async request<T>(input:RequestInput):Promise<T>{
  calls.push(input);const answer=await respond?.(input);if(answer!==undefined)return answer as T;
  if(input.action==='blocks.authored-links')return links(input.ownerBlockId,input.ownerBlockId===A?[B]:[A]) as T;
  if(input.action==='references.backlinks')return{targetBlockId:input.query.targetBlockId,sources:[],completeness:{kind:'complete'}} as T;
  throw Error('unexpected request');
 }},()=>{});
 const rows=()=>connections.compose(roots,()=>false);
 return{connections,roots,calls,rows,refresh:()=>connections.refresh(rows,()=>index)};
}
function child(rows:TreeDisplayRow<TreeIndexBlock>[],owner:string,group='outlinks'){
 const row=rows.find(r=>r.kind==='authored-link'&&r.owner.rowId===owner&&r.group===group);
 if(!row)throw Error('missing link');return row;
}
test('manual cyclic disclosure stays occurrence-local, bounded and survives parent hide/reopen',async()=>{
 const f=fixture();f.connections.toggle(f.roots[0]!);await f.refresh();
 const b=child(f.rows(),A);f.connections.toggle(b);await f.refresh();
 const a=child(f.rows(),b.rowId);f.connections.toggle(a);await f.refresh();
 const again=child(f.rows(),a.rowId);
 expect(connectionOwner(again)?.blockId).toBe(B);expect(again.rowId).not.toBe(b.rowId);
 expect(again.rowId.length).toBeLessThan(90);expect(f.calls.length).toBe(6);
 f.connections.toggle(f.roots[1]!);await f.refresh();
 expect(child(f.rows(),A).rowId).toBe(b.rowId);
 f.connections.toggle(f.roots[0]!);expect(f.rows().some(r=>r.rowId===a.rowId)).toBe(false);
 expect(child(f.rows(),B)).toBeDefined();
 f.connections.toggle(f.roots[0]!);await f.refresh();expect(f.rows().some(r=>r.rowId===again.rowId)).toBe(true);
 expect(f.calls.every(c=>c.action==='blocks.authored-links'||c.action==='references.backlinks')).toBe(true);
 expect(f.calls.filter(c=>c.action==='references.backlinks').every(c=>c.query.limit===AUTHORED_LINKS_MAX_ENTRIES_PER_GROUP)).toBe(true);
});
test('backlink failure is local and truncated sources remain visibly incomplete',async()=>{
 let fail=true;
 const f=fixture(input=>{
  if(input.action!=='references.backlinks')return;
  if(fail)throw Error('offline');
  return{targetBlockId:input.query.targetBlockId,sources:[{blockId:'source',title:'Source',occurrenceCount:2}],completeness:{kind:'truncated',limit:50}};
 });
 f.connections.toggle(f.roots[0]!);await f.refresh();expect(child(f.rows(),A)).toBeDefined();
 let header=f.rows().find(r=>r.kind==='authored-link-header'&&r.group==='backlinks');
 expect(header?.kind==='authored-link-header'&&header.state).toEqual({kind:'error',message:'offline'});
 fail=false;f.connections.invalidate();await f.refresh();header=f.rows().find(r=>r.kind==='authored-link-header'&&r.group==='backlinks');
 expect(header?.kind==='authored-link-header'&&header.state.kind==='ready'&&header.state.limited).toBe(true);
 expect(connectionOwner(child(f.rows(),A,'backlinks'))?.blockId).toBe('source');
});
test('a disclosure opened while another response is pending loads without another user action',async()=>{
 let release!:()=>void;let first=true;
 const barrier=new Promise<void>(resolve=>{release=resolve;});
 const f=fixture(async input=>{if(input.action==='blocks.authored-links'&&first){first=false;await barrier;}});
 f.connections.toggle(f.roots[0]!);const pending=f.refresh();
 f.connections.toggle(f.roots[1]!);const coalesced=f.refresh();release();await Promise.all([pending,coalesced]);
 expect(child(f.rows(),A)).toBeDefined();expect(child(f.rows(),B)).toBeDefined();
 expect(f.rows().filter(r=>r.kind==='authored-link-header').every(r=>r.kind==='authored-link-header'&&r.state.kind==='ready')).toBe(true);
});
test('hiding during a pending read cannot restore a closed disclosure',async()=>{
 let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
 const f=fixture(async input=>{if(input.action==='blocks.authored-links')await barrier;});
 f.connections.toggle(f.roots[0]!);const pending=f.refresh();f.connections.toggle(f.roots[0]!);release();await pending;
 expect(f.rows()).toHaveLength(2);
});

test('reopening a parent refreshes retained dirty descendants revealed by its load',async()=>{
 const f=fixture();f.connections.toggle(f.roots[0]!);await f.refresh();
 const b=child(f.rows(),A);f.connections.toggle(b);await f.refresh();
 f.connections.toggle(f.roots[0]!);f.connections.invalidate();await f.refresh();
 f.calls.length=0;f.connections.toggle(f.roots[0]!);await f.refresh();
 expect(f.calls.filter(c=>c.action==='blocks.authored-links').map(c=>c.ownerBlockId)).toEqual([A,B]);
 expect(child(f.rows(),b.rowId)).toBeDefined();expect(f.connections.needsRefresh).toBe(false);
});
