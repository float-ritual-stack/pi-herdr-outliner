import type {OutlinerRequester} from "./client-target";
import {completionTargetAtCursor, pageAddressCompletion, pageCompletionLookupQuery, type CompletionTarget} from './completion';
import {rankBlockFocusMatches} from './block-focus';
import {ensureHeadingFragment, fragmentCandidates, parseFragmentCompletionQuery, resolveFragment} from './fragments';
import {blockDisplayTitle} from './references';
import {propertyInspectorAuthoredText} from './property-inspector';
import type {ReferencedPathCandidate} from './files';
import type {Block, BlockSearchQuery, GotoSearchCollection, PageAddressCollection, SelectionContext, VisibleBlockCollection} from './types';
import type {FragmentCandidateCollection, FragmentCandidateQuery} from './fragment-search';
import type {TextBuffer} from './text-buffer';

export interface ReferenceCompletionItem {
  label:string;
  insertion:string;
  blockId?:string;
  address?:string;
  fragmentId?:string;
  kind?:string;
  context?:string;
  /** A heading that gets its anchor when chosen: in another note through the service, in the draft as `line`. */
  anchor?:{blockId:string;fragmentId:string;lineIndex:number;line:string;text?:string;expectedRevision:number};
}
export interface ReferenceCompletionState {
  start:number;end:number;index:number;items:ReferenceCompletionItem[];
  truncatedLimit?:number|null;
  incompleteness?:string;
  message?:string;
  loading?:boolean;
  generation?:number;
}
export interface ReferenceCompletionProvider {
  queryBlocks(query:BlockSearchQuery):Promise<VisibleBlockCollection>;
  queryPageAddresses(query:string|undefined,limit:number):Promise<PageAddressCollection>;
  completeFiles(query:string):Promise<ReferencedPathCandidate[]>;
  readContext(blockId:string):Promise<SelectionContext>;
  updateBlock(input:{blockId:string;text:string;expectedRevision:number}):Promise<Block>;
  /** The service's fragment completion over every note (PIE-424, PIE-295); without it, the first 500 blocks are searched here. */
  fragmentCandidates?(query:FragmentCandidateQuery):Promise<FragmentCandidateCollection>;
  /** The service writes a heading's anchor, revision-checked. */
  ensureFragment?(input:{blockId:string;lineIndex:number;expectedRevision:number}):Promise<{fragmentId:string;created:boolean}>;
  /** The one search (`tree.search`, src/search-match.ts), from the note being edited; `((` uses it when given. */
  searchBlocks?(query:string,contextBlockId?:string):Promise<GotoSearchCollection>;
}
const unsupportedAction=(error:unknown)=>/unsupported action|unknown action/i.test(error instanceof Error?error.message:String(error));
export interface CompletionDraft {blockId:string;text:string}
const LIMIT=20;
function snippet(text:string):string {
  return propertyInspectorAuthoredText(text).split(/\r?\n/).slice(1).join(' ').replace(/\s+/g,' ').trim().slice(0,240);
}
export async function lookupReferenceCompletion(provider:ReferenceCompletionProvider,target:CompletionTarget,prefix:string|null,draft?:CompletionDraft):Promise<ReferenceCompletionState> {
  let items:ReferenceCompletionItem[]=[],truncatedLimit:number|null=null,message='',incompleteness='';
  if(target.kind==='file') {
    const files=await provider.completeFiles(target.query);
    items=files.slice(0,LIMIT).map(file=>({label:file.sourcePath,kind:file.isDirectory?'folder':'file',insertion:`[file::${file.sourcePath}${file.isDirectory?'':']'}`}));
    if(files.length>LIMIT)truncatedLimit=LIMIT;
    message='No matching files';
  } else if(target.kind==='page') {
    const result=await provider.queryPageAddresses(pageCompletionLookupQuery(target.query,prefix)||undefined,LIMIT);
    items=result.addresses.map(address=>({...pageAddressCompletion(address,target.query,prefix),blockId:address.blockId,address:address.address,kind:address.kind}));
    if(result.completeness.kind==='truncated')truncatedLimit=result.completeness.limit;
    message='No matching named addresses; [[target|label]] labels a target, ((...)) searches blocks';
  } else {
    const fragment=parseFragmentCompletionQuery(target.query);
    if(fragment&&provider.fragmentCandidates){
      // The service searches every note by its own fragment rules (PIE-424); PIE-295's 500-block cap is gone.
      try{
        const found=await provider.fragmentCandidates({...(fragment.blockQuery?{noteQuery:fragment.blockQuery}:{}),fragmentQuery:fragment.fragmentQuery,mode:fragment.mode,limit:LIMIT,...(draft?{draft}:{})});
        items=found.items.map(hit=>{
          const fragmentId=hit.fragmentId??hit.anchor!.fragmentId;
          return {label:`${hit.title} › ${hit.kind==='heading'?'#':'¶'} ${hit.label}${hit.fragmentId?` · ^${hit.fragmentId}`:' · create anchor'}`,blockId:hit.blockId,fragmentId,kind:'fragment',insertion:`((${hit.blockId}^${fragmentId}))`,
            ...(hit.anchor?{anchor:{blockId:hit.blockId,fragmentId,lineIndex:hit.lineIndex,line:hit.anchor.line,expectedRevision:hit.revision}}:{})};
        });
        if(found.completeness.kind==='truncated'){truncatedLimit=found.completeness.limit;incompleteness=`Showing first ${found.completeness.limit} fragments`;}
        const message='No matching block fragments';
        return {start:target.start,end:target.end,index:0,items,truncatedLimit,incompleteness,message:items.length?incompleteness:message};
      }catch(error){if(!unsupportedAction(error))throw error;}
    }
    if(!fragment&&provider.searchBlocks){
      // Goto's ranker: punctuation, word order and typos forgiven, nearer the draft's note first; `((` alone lists what's linked around it.
      const found=await provider.searchBlocks(target.query,draft?.blockId);
      items=found.matches.slice(0,LIMIT).map(match=>({label:match.title,blockId:match.block.id,kind:'block',context:[match.path,snippet(match.snippet)].filter(Boolean).join(' › '),insertion:`((${match.block.id}))`}));
      if(found.matches.length>LIMIT)truncatedLimit=LIMIT;
      return {start:target.start,end:target.end,index:0,items,truncatedLimit,incompleteness,message:items.length?(truncatedLimit?`Showing first ${truncatedLimit} matches`:''):'No matching blocks'};
    }
    const result=await provider.queryBlocks(fragment?{limit:500}:{text:target.query||undefined,limit:LIMIT});
    if(result.completeness.kind==='truncated'){truncatedLimit=result.completeness.limit;incompleteness=fragment?`Searched only ${result.blocks.length} blocks; more blocks were not checked`:'';}
    if(!fragment)items=result.blocks.map(block=>({label:blockDisplayTitle(block),blockId:block.id,kind:'block',context:snippet(block.text),insertion:`((${block.id}))`}));
    else {
      const blocks=fragment.blockQuery?rankBlockFocusMatches(result.blocks,fragment.blockQuery,50).map(match=>match.block):result.blocks;
      if(fragment.blockQuery&&result.blocks.length>blocks.length)incompleteness=[incompleteness,`Checked fragments in ${blocks.length} ranked blocks; other blocks were not checked`].filter(Boolean).join(' · ');
      let candidates=0;
      outer: for(const block of blocks){
        const source=block.id===draft?.blockId?draft.text:block.text;
        for(const candidate of fragmentCandidates(source,fragment.fragmentQuery,fragment.mode)){
          candidates++;
          if(items.length>=LIMIT)break outer;
          const anchor=candidate.fragmentId?{text:source,fragmentId:candidate.fragmentId,created:false}:ensureHeadingFragment(source,candidate.lineIndex);
          items.push({label:`${blockDisplayTitle(block)} › ${candidate.kind==='heading'?'#':'¶'} ${candidate.label}${candidate.fragmentId?` · ^${candidate.fragmentId}`:' · create anchor'}`,blockId:block.id,fragmentId:anchor.fragmentId,kind:'fragment',context:snippet(source),insertion:`((${block.id}^${anchor.fragmentId}))`,...(anchor.created?{anchor:{blockId:block.id,fragmentId:anchor.fragmentId,lineIndex:candidate.lineIndex,line:anchor.text.split(/\r?\n/)[candidate.lineIndex]!,text:anchor.text,expectedRevision:block.revision}}:{})});
        }
      }
      if(candidates>LIMIT){truncatedLimit=LIMIT;incompleteness=[incompleteness,`Showing first ${LIMIT} fragments`].filter(Boolean).join(' · ');}
    }
    message=fragment?'No matching block fragments':'No matching blocks';
  }
  return {start:target.start,end:target.end,index:0,items,truncatedLimit,incompleteness,message:items.length?(incompleteness||(truncatedLimit?`Showing first ${truncatedLimit} matches`:'')):[incompleteness?`Partial search: ${incompleteness}`:'',message].filter(Boolean).join(' · ')};
}

/** One editor-local lookup lane. No canonical text or anchor writes until acceptance. */
export class ReferenceCompletionSession {
  state:ReferenceCompletionState|null=null;
  private generation=0;
  private accepting=false;
  private selectedInsertion?:string;
  private snapshot?:{text:string;row:number;column:number;buffer:TextBuffer};
  constructor(private provider:ReferenceCompletionProvider,private buffer:()=>TextBuffer,private prefix:()=>string|null,private changed:()=>void,private active:()=>boolean,private draft:()=>CompletionDraft|undefined=()=>undefined){}
  dismiss():void {this.generation++;this.state=null;this.snapshot=undefined;this.changed();}
  private current(generation:number):boolean {
    const b=this.buffer(),s=this.snapshot;
    return this.active()&&generation===this.generation&&!!s&&s.buffer===b&&s.text===b.text&&s.row===b.row&&s.column===b.column;
  }
  async refresh():Promise<void>{
    const b=this.buffer(),target=completionTargetAtCursor(b.lines[b.row]??'',b.column);
    if(!this.active()||!target){this.dismiss();return;}
    const generation=++this.generation,selected=this.state?.items[this.state.index]?.insertion??this.selectedInsertion;
    this.snapshot={text:b.text,row:b.row,column:b.column,buffer:b};
    this.state={start:target.start,end:target.end,index:0,items:[],generation,loading:true,message:'Finding references…'};this.changed();
    try{
      const result=await lookupReferenceCompletion(this.provider,target,this.prefix(),this.draft());
      if(!this.current(generation))return;
      result.index=Math.max(0,result.items.findIndex(item=>item.insertion===selected));
      this.selectedInsertion=result.items[result.index]?.insertion;
      result.generation=generation;this.state=result;this.changed();void this.enrich(generation);
    }catch(error){if(this.current(generation)){this.state={start:target.start,end:target.end,index:0,items:[],message:`Lookup failed: ${error instanceof Error?error.message:String(error)}`};this.changed();}}
  }
  private async enrich(generation=this.generation):Promise<void>{
    const item=this.state?.items[this.state.index];if(!item?.blockId)return;
    try{
      const context=await this.provider.readContext(item.blockId);
      if(!this.current(generation)||this.state?.items[this.state.index]!==item)return;
      item.context=context.selected?[...context.ancestors.map(blockDisplayTitle),snippet(context.selected.text)].filter(Boolean).join(' › '):'Target unavailable';this.changed();
    }catch(error){if(this.current(generation)&&this.state?.items[this.state.index]===item){item.context=`Context unavailable: ${error instanceof Error?error.message:String(error)}`;this.changed();}}
  }
  move(delta:number):void{if(!this.state)return;this.state.index=Math.max(0,Math.min(this.state.items.length-1,this.state.index+delta));this.selectedInsertion=this.state.items[this.state.index]?.insertion;this.changed();void this.enrich();}
  async accept(index=this.state?.index??0,renderedGeneration?:number):Promise<boolean>{
    const state=this.state,item=state?.items[index],generation=this.generation;
    if(this.accepting||!state||!item||(renderedGeneration!==undefined&&renderedGeneration!==generation)||!this.current(generation))return false;
    this.accepting=true;
    try{
      if(item.blockId){
        if(item.address){
          const addresses=await this.provider.queryPageAddresses(item.address,LIMIT);
          if(!this.current(generation))return false;
          if(!addresses.addresses.some(address=>address.address===item.address&&address.blockId===item.blockId))throw Error("Address changed; search again");
        }
        const context=await this.provider.readContext(item.blockId);
        if(!this.current(generation))return false;
        if(!context.selected||context.selected.id!==item.blockId||context.selected.deletedAt||context.selected.effectiveDeletedRootId)throw Error('Target is no longer available; search again');
        if(item.fragmentId&&!item.anchor){
          const draft=this.draft();
          const source=draft?.blockId===item.blockId?draft.text:context.selected.text;
          if(resolveFragment(source,item.fragmentId).status!=='resolved')throw Error('Fragment changed or is ambiguous; search again');
        }
        if(item.anchor&&item.blockId!==this.draft()?.blockId){
          const anchor=item.anchor;
          if(this.provider.ensureFragment){
            // The service writes the anchor, revision-checked; a different id than offered means the note moved on.
            const written=await this.provider.ensureFragment({blockId:anchor.blockId,lineIndex:anchor.lineIndex,expectedRevision:anchor.expectedRevision});
            if(written.fragmentId!==anchor.fragmentId)throw Error('Fragment changed; search again');
          }else if(anchor.text!==undefined)await this.provider.updateBlock({blockId:anchor.blockId,text:anchor.text,expectedRevision:anchor.expectedRevision});
          else throw Error('This service cannot add the anchor; search again');
          if(!this.current(generation))return false;
        }
      }
      const b=this.buffer();
      b.editTogether(()=>{
      if(item.anchor&&item.blockId===this.draft()?.blockId){
        b.replaceLine(item.anchor.lineIndex,item.anchor.line);
      }
      b.replaceCurrentLine(state.start,state.end,item.insertion);
      });this.dismiss();return true;
    }catch(error){if(this.current(generation)){state.message=error instanceof Error?error.message:String(error);this.changed();}return false;}finally{this.accepting=false;}
  }
}

export function referenceCompletionProvider(client:OutlinerRequester,actorId:string):ReferenceCompletionProvider {
  return {
    queryBlocks:query=>client.request({action:"blocks.query",query}),
    fragmentCandidates:query=>client.request({action:"fragments.candidates",query}),
    ensureFragment:input=>client.request({action:"fragments.ensure",...input,mutation:{author:"user",actorId}}),
    queryPageAddresses:(query,limit)=>client.request({action:"pages.complete",query,limit}),
    searchBlocks:(query,contextBlockId)=>client.request({action:"tree.search",query,...(contextBlockId?{contextBlockId}:{})}),
    completeFiles:prefix=>client.request({action:"files.complete",prefix}),
    readContext:blockId=>client.request({action:"blocks.context",blockId}),
    updateBlock:input=>client.request({action:"update",...input,mutation:{author:"user",actorId}}),
  };
}
