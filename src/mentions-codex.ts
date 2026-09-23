import {resolve} from 'node:path';
import {createOutlinerClient} from './client';
import {resolveClientPaths} from './paths';
import type {MentionMessage} from './mentions-types';

/** Both documented Stop hooks and the installed CLI's completion notification map here. */
export function codexMentionMessage(value:unknown,allowedWorkspaces:readonly string[]):MentionMessage|null{
 if(!value||typeof value!=='object')throw Error('Expected a Codex completion event');
 const event=value as Record<string,unknown>;
 const stop=event.hook_event_name==='Stop',notify=event.type==='agent-turn-complete';
 if(!stop&&!notify)return null;
 if(typeof event.cwd!=='string')throw Error('Codex completion has no cwd');
 const workspaceRoot=resolve(event.cwd);
 if(!allowedWorkspaces.some(root=>resolve(root)===workspaceRoot))return null;
 const sessionId=event[stop?'session_id':'thread-id'],messageId=event[stop?'turn_id':'turn-id'];
 const text=event[stop?'last_assistant_message':'last-assistant-message'];
 if(text===null||text===undefined||text==='')return null;
 if(typeof sessionId!=='string'||typeof messageId!=='string'||typeof text!=='string')throw Error('Codex completion lacks session, turn, or final message text');
 return{workspaceRoot,agent:'codex',sessionId,messageId,text};
}

if(import.meta.main){
 let hook=false;
 try{
  const args=process.argv.slice(2),workspaces:string[]=[];let payload:string|undefined;
  for(let i=0;i<args.length;i++){
   if(args[i]==='--workspace'){const root=args[++i];if(!root)throw Error('--workspace requires a path');workspaces.push(root);}
   else payload=args[i];
  }
  if(!workspaces.length)throw Error('Specify at least one --workspace; global ingestion is not enabled');
  const event=JSON.parse(payload??await Bun.stdin.text());hook=event.hook_event_name==='Stop';
  const message=codexMentionMessage(event,workspaces);
  if(message){
   // Resolve from the event workspace, never the hook process's inherited working directory.
   const client=createOutlinerClient(resolveClientPaths({...process.env,OUTLINER_WORKSPACE_ROOT:message.workspaceRoot}));
   await client.request({action:'mentions.ingest',message});
  }
  if(hook)console.log('{}');
 }catch(error){
  const message=`Outliner recent mentions unavailable: ${error instanceof Error?error.message:String(error)}`;
  if(hook)console.log(JSON.stringify({systemMessage:message}));else console.error(message);
  process.exitCode=0; // A navigation shelf must not prevent the agent completing its response.
 }
}
