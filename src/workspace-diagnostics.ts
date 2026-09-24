import {statSync} from 'node:fs';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {createOutlinerClient} from './client';
import {resolveClientConfigPath,resolveClientPaths,resolvePaths} from './paths';
import {OUTLINER_PROTOCOL_VERSION,type OutlinerServiceStatus} from './types';
import {sanitizeDynamicText} from './terminal';

function presence(path:string):string {
 try{const stat=statSync(path);return stat.isSocket()?'socket exists':stat.isDirectory()?'directory exists':'file exists';}
 catch(error){return error instanceof Error&&'code' in error&&error.code==='ENOENT'?'missing':`cannot inspect: ${error instanceof Error?error.message:String(error)}`;}
}
/** Read-only diagnosis: never starts a service, opens SQLite, creates state or searches/moves backups. */
export async function inspectWorkspaceConnection(env:NodeJS.ProcessEnv=process.env):Promise<{ok:boolean;lines:string[]}> {
 const lines=[`Workspace: ${resolvePaths(env).workspaceRoot}`,`Client host: ${hostname()}`,`Bun: ${process.execPath}`,`Client protocol: ${OUTLINER_PROTOCOL_VERSION}`,`Config: ${resolveClientConfigPath(env)}`];
 const finish=(ok:boolean)=>({ok,lines:lines.map(line=>sanitizeDynamicText(line))});
 let paths;
 try{paths=resolveClientPaths(env);}catch(error){lines.push(`Configuration error: ${error instanceof Error?error.message:String(error)}`,'Fix the named configuration before launching; no state or database was created.');return finish(false);}
 lines.push(`Connection: ${paths.mode}`,`Endpoint: ${paths.socket} (${presence(paths.socket)})`);
 if(env.OUTLINER_REMOTE!==undefined)lines.push('Connection mode selected by OUTLINER_REMOTE; project client.json is bypassed.');
 else lines.push(`Config presence: ${presence(resolveClientConfigPath(env))}`);
 if(paths.mode==='local'){
  lines.push(`Local state: ${paths.stateDir} (${presence(paths.stateDir)})`,`Local database: ${paths.database} (${presence(paths.database)})`,`Conventional backup directory (not a catalog): ${join(paths.stateDir,'backups')} (${presence(join(paths.stateDir,'backups'))})`,'Manual backup locations are unknown; saved copies may be elsewhere.');
  if(presence(paths.database)==='missing')lines.push('Database is missing at this resolved location. It may be a new workspace or moved storage; this report cannot distinguish them. Locate your saved database/backup before starting a replacement.');
 }else lines.push('Storage belongs to the remote service. The forwarded socket is local; it is not the database.');
 lines.push(`Client startup logs: ${join(paths.stateDir,'open-startup-error.log')} (check timestamp)`);
 try{
  const service=await createOutlinerClient(paths).request<OutlinerServiceStatus>({action:'ping'},1500);
  lines.unshift(`Service: ${service.status}; protocol ${service.protocolVersion}`);
  if(service.location){
   lines.push(`Service host: ${service.location.hostname}`,`Service workspace: ${service.location.workspaceRoot}`,`Service database: ${service.location.database}`,`Service state: ${service.location.stateDirectory}`,'Service backup locations: not registered; manual copies may be elsewhere.');
  }else lines.push('Service storage identity: not reported by this service version.');
  if(service.protocolVersion!==OUTLINER_PROTOCOL_VERSION){lines.push('Protocol mismatch: restart service and clients together from the same checkout. The endpoint is reachable; this is not a tunnel failure.');return finish(false);}
  return finish(true);
 }catch(error){
  lines.push(`Connection failed: ${error instanceof Error?error.message:String(error)}`);
  lines.push(paths.mode==='remote'?'Check the SSH socket tunnel and the canonical service on its host. Do not initialize a local database to repair a remote connection.':'Check the service startup log and the resolved database location. If storage was moved, recover or configure its intended location before starting the service.');
  return finish(false);
 }
}
