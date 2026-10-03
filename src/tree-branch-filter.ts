import {matchesSearchText,prepareSearchQuery} from './search-match';
import type {OutlinerRequester} from './client-target';
import type {Block,TreeIndexBlock} from './types';
import type {TreeRow,VirtualBranchProjection} from './virtual-branches';

type Row=TreeRow<TreeIndexBlock>;
const MAX_CANDIDATES=1000;

/** Disposable search over one occurrence, retaining projection identity and rank. */
export class TreeBranchFilter {
  query='';
  count=0;
  coverage='';
  private candidates:Row[]=[];
  private documents=new Map<string,{revision:number;text:string}>();
  constructor(readonly rowId:string,readonly label:string){}

  async refresh(projection:VirtualBranchProjection<TreeIndexBlock>,requester:OutlinerRequester):Promise<void>{
    const start=projection.rows.findIndex(row=>row.rowId===this.rowId);
    const root=projection.rows[start];
    if(!root||root.block.deletedAt||root.block.effectiveDeletedRootId){this.candidates=[];this.coverage='Root no longer available';this.count=0;return;}
    let end=start+1;
    while(end<projection.rows.length&&projection.rows[end]!.depth>root.depth)end++;
    this.candidates=projection.rows.slice(start,Math.min(end,start+MAX_CANDIDATES+1));
    const problems=new Set<string>();
    if(end-start-1>MAX_CANDIDATES)problems.add(`first ${MAX_CANDIDATES} descendants only`);
    const viewIds=new Set(this.candidates.flatMap(row=>row.kind==='occurrence'?[row.viewId,row.canonicalId]:[row.canonicalId]));
    for(const id of viewIds){
      const state=projection.branchStates.get(id);if(!state)continue;
      if(state.configurationErrors.length||state.queryError)problems.add('projection unavailable');
      if(Object.values(state.truncation).some(Boolean))problems.add('projection bounds apply');
    }
    const entries=[...new Map(this.candidates.slice(1).map(row=>[row.canonicalId,row.block])).values()];
    const next=new Map<string,{revision:number;text:string}>();
    // Read full bodies once per revision, not on every keystroke. Bound fanout.
    for(let i=0;i<entries.length;i+=8)await Promise.all(entries.slice(i,i+8).map(async entry=>{
      const cached=this.documents.get(entry.id);
      if(cached?.revision===entry.revision){next.set(entry.id,cached);return;}
      try{
        const block=await requester.request<Block|null>({action:'get',blockId:entry.id});
        if(!block||block.deletedAt||block.effectiveDeletedRootId||block.revision!==entry.revision){problems.add('content changed; refresh');return;}
        next.set(entry.id,{revision:block.revision,text:block.text});
      }catch{problems.add('some content unavailable; refresh');}
    }));
    this.documents=next;this.coverage=[...problems].join(' · ');
  }

  rows():Row[]{
    const root=this.candidates[0];if(!root){this.count=0;return [];}
    const query=this.query.trim();
    const candidates=this.candidates.slice(1);
    const text=(row:Row)=>this.documents.get(row.canonicalId)?.text??row.block.preview;
    // Work-ID prefixes are literal; fuzzy subsequences must not turn DEM-37 into DEM-307.
    const matches=new Set((!query?candidates:/^[\p{L}\d]+-\d+/u.test(query)
      ?candidates.filter(row=>text(row).toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      :(q=>candidates.filter(row=>matchesSearchText(q,[text(row)])))(prepareSearchQuery(query))).map(row=>row.rowId));
    this.count=matches.size;
    const keep=new Set<string>([root.rowId]);
    const ancestry:Row[]=[];
    for(const row of this.candidates){
      while(ancestry.length&&ancestry.at(-1)!.depth>=row.depth)ancestry.pop();
      if(matches.has(row.rowId)){keep.add(row.rowId);for(const parent of ancestry)keep.add(parent.rowId);}
      ancestry.push(row);
    }
    return this.candidates.filter(row=>keep.has(row.rowId)).map(row=>({...row,depth:row.depth-root.depth}));
  }

  get cue():string{return `${this.count} matches${this.coverage?' · PARTIAL: '+this.coverage:''} · ${this.query||'all'} in ${this.label}`;}
}
