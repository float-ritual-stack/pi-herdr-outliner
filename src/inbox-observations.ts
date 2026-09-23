import type {InboxUsage} from './inbox-types';
import {parsePropertyRecords} from './properties';

/** Observed omissions only: no invented count of candidates outside a bounded search. */
export function recordInboxOmission(usage:InboxUsage,area:string,reason:string):void {
 const omitted=usage.notChecked??=[];
 if(!omitted.some(value=>value.area===area&&value.reason===reason))omitted.push({area,reason});
}

/** Describe the committed text, after writer ownership and normalization rules. */
export function noteMetadataSummary(before:string,after:string):string {
 const values=(text:string,key:string)=>[...new Set(parsePropertyRecords(text).filter(p=>p.scope==='block'&&p.key===key).map(p=>p.value.toLowerCase()))];
 const previousType=values(before,'type'),nextType=values(after,'type');
 const previousTags=values(before,'tag'),nextTags=values(after,'tag');
 const changes:string[]=[];
 if(JSON.stringify(previousType)!==JSON.stringify(nextType))changes.push(`type ${previousType.join(', ')||'unset'} → ${nextType.join(', ')||'unset'}`);
 const added=nextTags.filter(tag=>!previousTags.includes(tag)),removed=previousTags.filter(tag=>!nextTags.includes(tag));
 if(added.length)changes.push(`added ${added.length} tag${added.length===1?'':'s'} (${added.join(', ')})`);
 if(removed.length)changes.push(`removed ${removed.length} tag${removed.length===1?'':'s'} (${removed.join(', ')})`);
 return changes.length?changes.join('; '):'No metadata changes';
}
