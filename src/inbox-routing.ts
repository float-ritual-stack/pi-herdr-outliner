export type InboxRoute='keep'|'metadata'|'archive'|'editorial';
export interface InboxRoutingDecision {route:InboxRoute;reason:string;judged?:InboxRoute;margin?:number;disposable?:number;}
export interface InboxRoutingPolicy {route:{instructions:string;criteria:Record<InboxRoute,string>};disposable:string;minimumMargin:number;archiveProbability:number;}
const routes:InboxRoute[]=['keep','metadata','archive','editorial'];
const probability=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
/** A trial policy, evaluated on named cases; confidence is not calibrated permission. */
export function chooseInboxRoute(answers:Record<string,unknown>|undefined,policy:InboxRoutingPolicy,context:{complete:boolean;hasChildren:boolean;steered:boolean}):InboxRoutingDecision {
 if(!context.complete)return {route:'editorial',reason:'Full note exceeds the routing window; Pi must read it'};
 if(context.steered)return {route:'editorial',reason:'Explicit reconsideration or steering receives editorial attention'};
 const raw=answers?.inbox_route as {type?:unknown;choice?:unknown;probabilities?:Record<string,unknown>}|undefined;
 const disposable=answers?.inbox_disposable as {type?:unknown;noul?:unknown}|undefined;
 if(raw?.type!=='choice'||!routes.includes(raw.choice as InboxRoute)||!routes.every(route=>probability(raw.probabilities?.[route]))||disposable?.type!=='noul'||!probability(disposable.noul))return {route:'editorial',reason:'Routing judgment unavailable or malformed; retain content for Pi'};
 const ranked=routes.map(route=>({route,p:raw.probabilities![route] as number})).sort((a,b)=>b.p-a.p);
 const margin=ranked[0]!.p-ranked[1]!.p,judged=raw.choice as InboxRoute;
 if(ranked[0]!.route!==judged||Math.abs(ranked.reduce((sum,item)=>sum+item.p,0)-1)>0.02)return {route:'editorial',reason:'Routing distribution inconsistent; retain content for Pi'};
 const evidence={judged,margin,disposable:disposable.noul};
 if(margin<policy.minimumMargin)return {...evidence,route:'editorial',reason:'Routing alternatives are close; Pi handles the ambiguity'};
 if(judged==='archive'&&(context.hasChildren||disposable.noul<policy.archiveProbability))return {...evidence,route:'editorial',reason:context.hasChildren?'Note has child context; retain it for Pi':'Disposal judgment is uncertain; retain it for Pi'};
 return {...evidence,route:judged,reason:{keep:'Useful as authored; file intact without inferred metadata',metadata:'Coherent useful content; organize metadata only',archive:'Clear test noise; archive intact with Undo',editorial:'Editorial work is useful: clean up, split, relate or allocate tasks'}[judged]};
}
