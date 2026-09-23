import {test,expect} from 'bun:test';
import {noteMetadataSummary} from '../src/inbox-observations';
import {combinedInboxUsage} from '../src/inbox-usage';
const usage={provider:'typesafe',model:'jev',inputTokens:10,outputTokens:1,cost:0,jevCalls:1,elapsedMs:900};
test('metadata summary describes effective changes and a no-op without claiming prose or task creation',()=>{
 expect(noteMetadataSummary('Note [type::note] [tag::a]','Note [type::reference] [tag::b]')).toBe('type note → reference; added 1 tag (b); removed 1 tag (a)');
 expect(noteMetadataSummary('Old [type::note]','New prose [type::note]')).toBe('No metadata changes');
});
test('sequential model phases retain omissions and mark missing historical coverage',()=>{
 const missing={area:'retrieval',reason:'Shortlist only'};
 const combined=combinedInboxUsage({...usage,notChecked:[missing]},{...usage,notChecked:[missing]});
 expect(combined.elapsedMs).toBe(1800);expect(combined.notChecked).toEqual([missing]);
 expect(combinedInboxUsage(usage,{...usage,notChecked:[]}).notChecked).toEqual([{area:'coverage',reason:'Earlier model phase did not record omissions'}]);
});
