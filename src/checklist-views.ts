import {standaloneListItemText} from "./markdown-structure";
import {parsePropertyFilterExpression} from './block-query';
import {queryChecklistItems} from './checklist-items';
import {parseProperties} from './properties';
import {stripFragmentAnchors} from './fragments';
import type {ChecklistSearchQuery, ChecklistSearchCollection} from './types';
import type {DetailEmbedRequester, DetailEmbedRange} from './detail-embeds';

export function isChecklistView(text:string):boolean {
  return parseProperties(text).some(property=>property.key==='type'&&property.value==='checklist-view');
}

/** Plan predicates and item predicates deliberately have separate scopes. */
export function parseChecklistView(text:string):ChecklistSearchQuery {
  const properties=parseProperties(text);
  const one=(key:string,required=false)=>{
    const values=properties.filter(property=>property.key===key);
    if(values.length>1||required&&!values.length)throw Error(`Checklist view needs ${required?'exactly':'at most'} one ${key} property`);
    return values[0]?.value;
  };
  if(one('type',true)!=='checklist-view')throw Error('Expected [type::checklist-view]');
  const query=one('query',true)!;
  const plans=one('plans');
  const subtreeRootId=one('subtree');
  const limitText=one('limit')??'100';
  if(!/^\d+$/.test(limitText))throw Error('Checklist view limit must be an integer');
  const nested=one('nested');
  if(nested!==undefined&&nested!=='include'&&nested!=='top-level')throw Error('Checklist nested mode must be include or top-level');
  const exclude=one('exclude-status');
  const items:ChecklistSearchQuery['items']={limit:Number(limitText),filters:parsePropertyFilterExpression(query),
    ...(nested?{nested}:{}),...(exclude?{excludeStatuses:exclude.split(',').map(value=>value.trim()) as ChecklistSearchQuery['items']['excludeStatuses']}: {})};
  queryChecklistItems('',items,[]);
  return {scope:{...(plans?{filters:parsePropertyFilterExpression(plans)}:{}),...(subtreeRootId?{subtreeRootId}:{})},items};
}

export async function projectChecklistView(requester:DetailEmbedRequester,text:string):Promise<{
  text:string; sources:NonNullable<DetailEmbedRange['sources']>; collection:ChecklistSearchCollection;
}> {
  const collection=await requester.request<ChecklistSearchCollection>({action:'checklist.search',query:parseChecklistView(text)});
  const rows=[`Checklist results · ${collection.matches.length} matched ${collection.matches.length===1?'step':'steps'}${collection.completeness.kind==='truncated'?' · LIMITED':''}`];
  const sources:NonNullable<DetailEmbedRange['sources']>=[];
  if(!collection.matches.length)rows.push('No matching checklist steps.');
  for(const {block,item} of collection.matches){
    rows.push('',`Plan: ((${block.id})) · ${item.identity==='unique'?`((${block.id}^${item.itemId}|Open step))`:item.identity==='duplicate'?'Ambiguous step address · fix duplicate IDs in the plan':'Unaddressed step · Copy step link to assign an address'}`,'');
    const contentStartLine=rows.length;
    const lines=block.text.split(/\r?\n/).slice(item.span.startLine,item.span.endLine+1);
    rows.push(...stripFragmentAnchors(standaloneListItemText(lines.join('\n'))).split('\n'));
    sources.push({block,startLine:item.span.startLine,endLine:item.span.endLine,contentStartLine,itemStarts:[item.span.start]});
  }
  return {text:rows.join('\n'),sources,collection};
}
