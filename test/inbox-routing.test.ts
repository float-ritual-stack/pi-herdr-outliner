import {expect,test} from 'bun:test';
import {chooseInboxRoute,type InboxRoute} from '../src/inbox-routing';
import {loadInboxRoutingPrompt} from '../src/ai-prompts';
const policy=(await loadInboxRoutingPrompt()).policy;
const context={complete:true,hasChildren:false,steered:false};
function answers(route:InboxRoute,top=0.94,disposable=0.99){return {inbox_route:{type:'choice',choice:route,probabilities:Object.fromEntries(['keep','metadata','archive','editorial'].map(key=>[key,key===route?top:(1-top)/3]))},inbox_disposable:{type:'noul',noul:disposable}};}
test('routing accepts decisive cheap paths and retains the evidence',()=>{
 for(const route of ['keep','metadata','archive','editorial'] as InboxRoute[])expect(chooseInboxRoute(answers(route),policy,context)).toMatchObject({route,judged:route,disposable:0.99});
});
test('ambiguity and incomplete evidence escalate without treating a score as archive permission',()=>{
 expect(chooseInboxRoute(answers('archive',0.4),policy,context).route).toBe('editorial');
 expect(chooseInboxRoute(answers('archive',0.95,0.6),policy,context).route).toBe('editorial');
 for(const guard of [{complete:false},{hasChildren:true},{steered:true}])expect(chooseInboxRoute(answers('archive'),policy,{...context,...guard}).route).toBe('editorial');
 for(const raw of [undefined,{}, {inbox_route:{type:'choice',choice:'archive',probabilities:{archive:1}}}, {...answers('archive'),inbox_disposable:{type:'noul',noul:NaN}}])expect(chooseInboxRoute(raw,policy,context).route).toBe('editorial');
 const mismatch=answers('archive');mismatch.inbox_route.probabilities.keep=1;expect(chooseInboxRoute(mismatch,policy,context).route).toBe('editorial');
});
