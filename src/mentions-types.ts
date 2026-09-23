import type {Block} from './types';
export interface MentionMessage {
 workspaceRoot:string;
 agent:string;
 sessionId:string;
 messageId:string;
 text:string;
}
export interface MentionScope { agent:string; sessionId:string; }
export interface MentionEntry {
 key:string;
 messageKey:string;
 address:string;
 block:Block|null;
 unavailableReason?:string;
 agent:string;
 sessionId:string;
 messageId:string;
 mentionedAt:string;
 excerpt:string;
}
export interface MentionCollection {
 entries:MentionEntry[];
 completeness:{kind:'complete'}|{kind:'truncated';limit:number};
 retention:{messages:number;maximum:number};
 notChecked:string[];
}
export interface MentionReceipt {messageKey:string;deduplicated:boolean;references:number;notChecked:string[];}
