import {rankTextSearchMatches} from './block-focus';
import {summarizeInboxResult} from './inbox-repository';
import {blockDisplayTitle} from './references';
import type {SearchCollection,SearchExcerpt} from './search-ranking';
import type {InboxResult,InboxResultSummary} from './inbox-types';
import type {Block} from './types';
import type {OutlinerStore} from './store';

export interface InboxSearchMatch extends SearchExcerpt {
  result: InboxResultSummary;
  /** Revisions authorize freshness only, never a write. */
  revisions: Array<{id:string;revision:number}>;
}
export type InboxSearchCollection = SearchCollection<InboxSearchMatch>;
const CANDIDATES=80;
export const INBOX_SEARCH_VISIBLE=30;

/** Search both operation histories in one service-owned observation, independent of pagination. */
export function searchInboxHistory(store:OutlinerStore,query:string):InboxSearchCollection {
  if(typeof query!=='string'||query.length>500)throw new Error('Inbox query must be at most 500 characters');
  return store.database.transaction(():InboxSearchCollection=>{
    const rows=store.database.query(`SELECT result_json FROM (
      SELECT result_json,created_at,0 AS origin,rowid AS ordinal FROM inbox_agent_results
      UNION ALL SELECT result_json,created_at,1 AS origin,rowid AS ordinal FROM note_assistance_results
    ) ORDER BY created_at DESC,origin DESC,ordinal DESC`).all() as Array<{result_json:string}>;
    const documents=rows.map(row=>{
      const result=summarizeInboxResult(JSON.parse(row.result_json) as InboxResult);
      const blocks=[result.sourceId,...result.outputIds].map(id=>store.get(id)).filter((block):block is Block=>block!==null&&!block.deletedAt&&!block.effectiveDeletedRootId);
      return {id:result.id,title:result.sourceTitle,text:[result.sourceTitle,result.summary,...blocks.map(block=>block.text)].join('\n\n'),result,
        titles:blocks.map(block=>blockDisplayTitle(block)),revisions:blocks.map(block=>({id:block.id,revision:block.revision}))};
    });
    const matches=query.trim()?rankTextSearchMatches(documents,query,CANDIDATES+1):documents.slice(0,CANDIDATES+1).map(document=>({document,kind:'recent'}));
    const terms=query.toLowerCase().split(/\s+/).filter(term=>term.length>=3);
    return {matches:matches.slice(0,CANDIDATES).map(({document,kind})=>{
      const lower=document.text.toLowerCase();
      const at=terms.map(term=>lower.indexOf(term)).filter(index=>index>=0).sort((a,b)=>a-b)[0]??0;
      return {result:document.result,revisions:document.revisions,title:document.title.slice(0,250),path:document.titles.join(' · ').slice(0,500),
        snippet:document.text.slice(Math.max(0,at-120),Math.max(0,at-120)+1400),exact:kind==='exact-id'||kind==='exact-title'};
    }),completeness:matches.length>CANDIDATES?{kind:'truncated',limit:CANDIDATES}:{kind:'complete'},semantic:{status:'lexical'}};
  })();
}
export function visibleInboxSearch(result:InboxSearchCollection):InboxSearchCollection {
 return {...result,matches:result.matches.slice(0,INBOX_SEARCH_VISIBLE),completeness:result.matches.length>INBOX_SEARCH_VISIBLE?{kind:'truncated',limit:INBOX_SEARCH_VISIBLE}:result.completeness};
}
