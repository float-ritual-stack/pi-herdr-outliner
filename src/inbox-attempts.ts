import type {OutlinerStore} from './store';
import type {Block} from './types';
import type {InboxResult} from './inbox-types';

export class InboxPlanValidationError extends Error {
  constructor(readonly field:string,problem:string){super(`${field}: ${problem}`);this.name='InboxPlanValidationError';}
}
export class InboxConflictError extends Error {
  constructor(message:string){super(message);this.name='InboxConflictError';}
}
export function inboxFailureKind(error:unknown,canceled=false):NonNullable<InboxResult['failureKind']>{
 if(canceled)return 'canceled';
 if(error instanceof InboxPlanValidationError)return 'validation';
 if(error instanceof InboxConflictError)return 'conflict';
 const message=error instanceof Error?error.message:String(error);
 if(/timed out|timeout|deadline/i.test(message))return 'timeout';
 if(error instanceof Error&&error.name==='InboxModelUnavailableError')return 'provider';
 if(/revision|changed.*not applied|stale/i.test(message))return 'conflict';
 if(/validation|Invalid Inbox|managed property|Roadmap|work queue|Work-ID/i.test(message))return 'validation';
 return 'other';
}

/** Retry requests survive restart; result context lives with the existing receipt. */
export class InboxAttempts {
 constructor(private store:OutlinerStore,private hasNotes:boolean){
  store.database.exec('CREATE TABLE IF NOT EXISTS inbox_retry_triggers (source_id TEXT PRIMARY KEY, trigger TEXT NOT NULL)');
 }
 request(sourceId:string,trigger:'reconsider'|'resume'):void{
  this.store.database.query('INSERT INTO inbox_retry_triggers(source_id,trigger) VALUES (?,?) ON CONFLICT(source_id) DO UPDATE SET trigger=excluded.trigger').run(sourceId,trigger);
 }
 start(source:Block):NonNullable<InboxResult['attempt']>{
  return this.store.database.transaction(()=>{
   const pending=this.store.database.query('SELECT trigger FROM inbox_retry_triggers WHERE source_id=?').get(source.id) as {trigger:string}|null;
   const tables=this.hasNotes?['inbox_agent_results','note_assistance_results']:['inbox_agent_results'];
   const row=this.store.database.query(`SELECT result_json FROM (${tables.map(table=>`SELECT result_json,created_at,rowid AS ordinal FROM ${table} WHERE source_id=?`).join(' UNION ALL ')}) ORDER BY created_at DESC,ordinal DESC LIMIT 1`).get(...tables.map(()=>source.id)) as {result_json:string}|null;
   const prior=row?JSON.parse(row.result_json) as InboxResult:undefined;
   this.store.database.query('DELETE FROM inbox_retry_triggers WHERE source_id=?').run(source.id);
   const trigger=pending?.trigger??(!prior?'new-note':prior.attempt&&prior.attempt.sourceRevision!==source.revision?'source-changed':prior.state==='canceled'?'after-interruption':'eligible-note-update');
   return {trigger,sourceRevision:source.revision,...prior?{prior:{id:prior.id,state:prior.state,...prior.usage?{cost:prior.usage.cost}:{}}}:{}};
  })();
 }
 /** Caller wraps application and this annotation in one transaction. */
 finish(result:InboxResult,attempt:NonNullable<InboxResult['attempt']>,note:boolean,failureKind?:InboxResult['failureKind']):InboxResult {
  result.attempt=attempt;if(failureKind)result.failureKind=failureKind;
  this.store.database.query(`UPDATE ${note?'note_assistance_results':'inbox_agent_results'} SET result_json=? WHERE id=?`).run(JSON.stringify(result),result.id);
  return result;
 }
}
