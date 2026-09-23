import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {blockReferenceOccurrences} from './references';
import {pageAddressReferences} from './page-addresses';
import {workIdReferences} from './work-ids';
import {parseOutlinerLinkUri} from './outliner-links';
import type {OutlinerStore} from './store';
import type {MentionCollection,MentionEntry,MentionMessage,MentionReceipt,MentionScope} from './mentions-types';

export const MENTION_MESSAGE_LIMIT=200;
const MAX_TEXT=65536,MAX_REFERENCES=100;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
interface Reference {bare?:boolean;kind:'block'|'address';value:string;start:number;end:number;}
interface StoredReference extends Reference {blockId:string|null;reason?:string;excerpt:string;}
interface StoredMessage extends MentionMessage {key:string;receivedAt:string;references:StoredReference[];notChecked:string[];}
function required(value:unknown,name:string,max=512):string{
 if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f]/.test(value))throw Error(`${name} must be nonempty text, at most ${max} characters`);
 return value;
}
export function extractMentionReferences(text:string,prefix?:string):Reference[]{
 const refs:Reference[]=[
  ...blockReferenceOccurrences(text).map(r=>({kind:'block' as const,value:r.blockId,start:r.start,end:r.end})),
  ...pageAddressReferences(text).map(r=>({kind:'address' as const,value:r.displayAddress,start:r.start,end:r.end})),
  ...(prefix?workIdReferences(text,prefix).map(r=>({kind:'address' as const,value:r.workId,start:r.start,end:r.end})):[]),
 ];
 for(const match of text.matchAll(/pi-outliner:\/\/[^\s<>"')]+/g)){
  try {
   const target=parseOutlinerLinkUri(match[0]);
   if(target.kind==='block'||target.kind==='page'||target.kind==='work')refs.push({kind:target.kind==='block'?'block':'address',value:target.value,start:match.index,end:match.index+match[0].length});
  } catch { /* Malformed text is not a valid navigable URI. Other references still resolve. */ }
 }
 for(const match of text.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)){
  if(!refs.some(r=>match.index>=r.start&&match.index<r.end))refs.push({bare:true,kind:'block',value:match[0].toLowerCase(),start:match.index,end:match.index+match[0].length});
 }
 const seen=new Set<string>();
 return refs.sort((a,b)=>a.start-b.start).filter(r=>{const key=`${r.kind}:${r.value.toLowerCase()}`;if(seen.has(key))return false;seen.add(key);return true;});
}
function excerpt(text:string,reference:Reference):string{
 const start=Math.max(text.lastIndexOf('\n',reference.start)+1,reference.start-100);
 const end=text.indexOf('\n',reference.end);
 return text.slice(start,Math.min(end<0?text.length:end,reference.end+160)).replace(/\s+/g,' ').trim();
}

/** Bounded disposable conversation history. Only explicit save/bookmark writes canonical notes. */
export class MentionRepository {
 constructor(private store:OutlinerStore,private workspaceRoot:string){
  store.database.exec(`CREATE TABLE IF NOT EXISTS agent_mention_messages (
   sequence INTEGER PRIMARY KEY AUTOINCREMENT,
   message_key TEXT NOT NULL UNIQUE,
   payload_hash TEXT NOT NULL,
   message_json TEXT NOT NULL CHECK(json_valid(message_json))
  )`);
 }
 ingest(input:MentionMessage):MentionReceipt{
  if(!input||typeof input!=='object')throw Error('Mention message is required');
  if(resolve(required(input.workspaceRoot,'workspaceRoot',4096))!==resolve(this.workspaceRoot))throw Error('Mention workspace does not match this Outliner service');
  required(input.agent,'agent',64);required(input.sessionId,'sessionId');required(input.messageId,'messageId');
  if(typeof input.text!=='string'||input.text.length>MAX_TEXT)throw Error(`Mention text must be at most ${MAX_TEXT} characters`);
  const key=hash(JSON.stringify([input.agent,input.sessionId,input.messageId]));
  const payloadHash=hash(input.text);
  return this.store.database.transaction(()=>{
   const existing=this.store.database.query('SELECT payload_hash,message_json FROM agent_mention_messages WHERE message_key=?').get(key) as {payload_hash:string;message_json:string}|null;
   if(existing){
    if(existing.payload_hash!==payloadHash)throw Error('Mention message identity already contains different text');
    const saved:StoredMessage=JSON.parse(existing.message_json);
    return{messageKey:key,deduplicated:true,references:saved.references.length,notChecked:saved.notChecked};
   }
   const candidates=extractMentionReferences(input.text,this.store.workIdAllocatorStatus().prefix??undefined)
    .filter(reference=>!reference.bare||!!this.store.get(reference.value));
   const notChecked=candidates.length>MAX_REFERENCES?[`Only the first ${MAX_REFERENCES} distinct references were checked`]:[];
   const references=candidates.slice(0,MAX_REFERENCES).map(reference=>{
    const resolution=reference.kind==='block'?null:this.store.resolvePageAddress(reference.value);
    const block=reference.kind==='block'?this.store.get(reference.value):resolution?.block;
    const active=block&&!block.effectiveDeletedRootId;
    return{...reference,blockId:active?block.id:null,...!active?{reason:block?'Target is in Trash':'Target is not registered in this workspace'}:{},excerpt:excerpt(input.text,reference)};
   });
   // An unreferenced answer never becomes an automatic saved note or retained message.
   if(references.length){
    const message:StoredMessage={...input,key,receivedAt:new Date().toISOString(),references,notChecked};
    this.store.database.query('INSERT INTO agent_mention_messages(message_key,payload_hash,message_json) VALUES (?,?,?)').run(key,payloadHash,JSON.stringify(message));
    this.store.database.query('DELETE FROM agent_mention_messages WHERE sequence NOT IN (SELECT sequence FROM agent_mention_messages ORDER BY sequence DESC LIMIT ?)').run(MENTION_MESSAGE_LIMIT);
   }
   return{messageKey:key,deduplicated:false,references:references.length,notChecked};
  })();
 }
 private scope(scope?:MentionScope):void{if(scope){required(scope.agent,'agent',64);required(scope.sessionId,'sessionId');}}
 private messages(scope?:MentionScope):StoredMessage[]{
  this.scope(scope);
  const rows=this.store.database.query('SELECT message_json FROM agent_mention_messages ORDER BY sequence DESC').all() as {message_json:string}[];
  return rows.map(r=>JSON.parse(r.message_json) as StoredMessage).filter(m=>!scope||(m.agent===scope.agent&&m.sessionId===scope.sessionId));
 }
 list(scope?:MentionScope,limit=100):MentionCollection{
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Mention limit must be 1–100');
  const messages=this.messages(scope),entries:MentionEntry[]=[],seen=new Set<string>();
  for(const message of messages)for(const reference of message.references){
   const block=reference.blockId?this.store.get(reference.blockId):reference.kind==='address'?this.store.resolvePageAddress(reference.value).block:this.store.get(reference.value);
   const active=block&&!block.effectiveDeletedRootId?block:null;
   const key=block?.id??`${reference.kind}:${reference.value.toLowerCase()}`;
   if(seen.has(key))continue;seen.add(key);
   entries.push({key,messageKey:message.key,address:reference.value,block:active,...!active?{unavailableReason:reference.reason??'Mentioned target is no longer available'}:{},agent:message.agent,sessionId:message.sessionId,messageId:message.messageId,mentionedAt:message.receivedAt,excerpt:reference.excerpt});
  }
  return{entries:entries.slice(0,limit),completeness:entries.length>limit?{kind:'truncated',limit}:{kind:'complete'},retention:{messages:messages.length,maximum:MENTION_MESSAGE_LIMIT},notChecked:[...new Set(messages.flatMap(m=>m.notChecked))]};
 }
 message(key:string):StoredMessage{
  required(key,'messageKey');
  const row=this.store.database.query('SELECT message_json FROM agent_mention_messages WHERE message_key=?').get(key) as {message_json:string}|null;
  if(!row)throw Error('Mention message expired or was cleared');return JSON.parse(row.message_json) as StoredMessage;
 }
 clear(scope?:MentionScope):{removed:number}{
  const messages=this.messages(scope);
  this.store.database.transaction(()=>{for(const message of messages)this.store.database.query('DELETE FROM agent_mention_messages WHERE message_key=?').run(message.key);})();
  return{removed:messages.length};
 }
 save(key:string){
  const message=this.message(key);
  const content=`Conversation excerpt — ${message.agent}\n\n${message.text}\n\nFrom ${message.agent}, session ${message.sessionId}, message ${message.messageId}, ${message.receivedAt}.`;
  return this.store.capture(`mention-save:${key}`,content,'cli',undefined,'agent',{actorId:'mention-shelf',sessionId:message.sessionId});
 }
}
