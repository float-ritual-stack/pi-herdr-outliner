import type {OutlinerRequester} from './client-target';
import {loadDetailReadPreview} from './detail-read-preview';
import {blockDisplayTitle} from './references';
import type {MentionCollection,MentionEntry,MentionScope} from './mentions-types';
import type {Block,BookmarkStatus} from './types';
import type {VirtualBranchOccurrenceRow} from './virtual-branches';
import type {NavigatorCommand,VirtualBranchNavigatorProjection,VirtualBranchNavigatorPreview} from './virtual-branch-navigator';

/** Adapts the retained mention history to the existing split list/reader. */
export class MentionsNavigator {
 private scope:MentionScope|undefined;
 private context=false;
 private entries=new Map<string,MentionEntry>();
 constructor(private client:OutlinerRequester){}
 readonly commands:readonly NavigatorCommand[]=[
  {key:'s',label:()=>this.scope?'Workspace':'Conversation',run:async row=>{
    if(this.scope)this.scope=undefined;
    else {const entry=this.entry(row);this.scope={agent:entry.agent,sessionId:entry.sessionId};}
    return this.scope?`Conversation: ${this.scope.agent} / ${this.scope.sessionId}`:'All workspace conversations';
  }},
  {key:'m',label:()=>this.context?'Note':'Message',run:async()=>{this.context=!this.context;return this.context?'Surrounding completed message':'Mentioned note';}},
  {key:'c',label:()=> 'Clear',run:async()=>{const result=await this.client.request<{removed:number}>({action:'mentions.clear',scope:this.scope});return`Cleared ${result.removed} retained messages; canonical notes unchanged`; }},
  {key:'v',label:()=> 'Save message',run:async row=>{await this.client.request({action:'mentions.save',messageKey:this.entry(row).messageKey});return'Saved completed message to Inbox';}},
  {key:'b',label:()=> 'Bookmark',run:async row=>{
   const entry=this.entry(row);if(!entry.block)throw Error(entry.unavailableReason);
   const before=await this.client.request<BookmarkStatus>({action:'bookmarks.status',targetBlockId:entry.block.id});
   if(before.record)return'Already bookmarked';
   await this.client.request({action:'bookmarks.toggle',targetBlockId:entry.block.id,expectedRecordId:null});return'Bookmarked mentioned note';
  }},
 ];
 private entry(row:VirtualBranchOccurrenceRow|undefined):MentionEntry{
  const entry=row&&this.entries.get(row.rowId);if(!entry)throw Error('Select a mention first');return entry;
 }
 async projection():Promise<VirtualBranchNavigatorProjection>{
  const found=await this.client.request<MentionCollection>({action:'mentions.list',scope:this.scope,limit:100});
  this.entries=new Map(found.entries.map(entry=>[`mention:${entry.key}`,entry]));
  const rows:VirtualBranchOccurrenceRow[]=[...this.entries].map(([rowId,entry],position)=>{
   const title=entry.block?blockDisplayTitle(entry.block):`${entry.address} — unavailable`;
   const preview=`${title} · ${entry.agent} · ${entry.mentionedAt.slice(11,16)} · ${entry.excerpt}`;
   const block={...(entry.block??{id:rowId,parentId:null,revision:1,author:'system' as const,createdAt:entry.mentionedAt,updatedAt:entry.mentionedAt,properties:[]}),text:preview,displayText:preview,position,depth:0,hasChildren:false};
   return{kind:'occurrence',rowId,canonicalId:block.id,block,depth:0,relativeDepth:0,hasChildren:false,multilineExpanded:false,collapsed:false,viewId:'recent-mentions',matchRootCanonicalId:block.id,parentRowId:'recent-mentions'};
  });
  return{title:`Recent mentions${found.notChecked.length?' · '+found.notChecked.join('; '):''} · ${this.scope?`${this.scope.agent} conversation`:'Workspace'} · ${found.retention.messages}/${found.retention.maximum} messages retained`,rows,state:{config:null,configurationErrors:[],creationErrors:[],queryError:null,count:rows.length,descendantCount:0,completeness:found.completeness,truncation:{rootQuery:found.completeness.kind==='truncated',depth:false,budget:false},queried:true}};
 }
 async preview(row:VirtualBranchOccurrenceRow):Promise<VirtualBranchNavigatorPreview>{
  const entry=this.entry(row);
  const provenance=`${entry.agent} · session ${entry.sessionId} · ${entry.mentionedAt}\n\n${entry.excerpt}`;
  const target=entry.block?{target:{kind:'block' as const,blockId:entry.block.id},title:blockDisplayTitle(entry.block)}:null;
  if(this.context||!entry.block){
   const message=this.context?await this.client.request<{text:string}>({action:'mentions.message',messageKey:entry.messageKey}):null;
   const text=`${this.context?'Completed message':'Mention unavailable'}\n\n${provenance}\n\n${message?.text??entry.unavailableReason}`;
   const document={canonicalText:text,resolvedText:text,projectedText:text,embedRanges:[],workIdPrefix:null};
   return target?{document,target}:{document,target:null,unavailableReason:entry.unavailableReason??'No target'};
  }
  const block=await this.client.request<Block|null>({action:'get',blockId:entry.block.id});
  if(!block||block.effectiveDeletedRootId)throw Error('Mentioned note is no longer available');
  const document=await loadDetailReadPreview(this.client,block);
  return{document,target:target!,context:provenance};
 }
}
