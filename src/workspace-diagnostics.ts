import {statSync} from 'node:fs';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {createOutlinerClient} from './client';
import {resolveClientConfigPath,resolveClientPaths,resolvePaths} from './paths';
import {checkServiceCompatibility} from './service-compatibility';
import {OUTLINER_MIN_SERVICE_PROTOCOL,OUTLINER_PROTOCOL_VERSION,type OutlinerServiceStatus} from './types';
import {sanitizeDynamicText} from './terminal';

export type WorkspaceReportEntry =
 | {kind:'section';title:string}
 | {kind:'field';label:string;value:string;note?:string}
 | {kind:'note';text:string};
export interface WorkspaceReport {ok:boolean;lines:string[];entries:WorkspaceReportEntry[]}

function presence(path:string):string {
 try{const stat=statSync(path);return stat.isSocket()?'socket exists':stat.isDirectory()?'directory exists':'file exists';}
 catch(error){return error instanceof Error&&'code' in error&&error.code==='ENOENT'?'missing':`cannot inspect: ${error instanceof Error?error.message:String(error)}`;}
}
/** Read-only diagnosis: never starts a service, opens SQLite, creates state or searches/moves backups. */
export async function inspectWorkspaceConnection(env:NodeJS.ProcessEnv=process.env):Promise<WorkspaceReport> {
 const entries:WorkspaceReportEntry[]=[];
 const section=(title:string)=>entries.push({kind:'section',title});
 const field=(label:string,value:string,note?:string)=>entries.push({kind:'field',label,value,...(note?{note}:{})});
 const note=(text:string)=>entries.push({kind:'note',text});
 const finish=(ok:boolean):WorkspaceReport=>({ok,entries,lines:entries.map(entry=>sanitizeDynamicText(entry.kind==='section'?`\n${entry.title}`:entry.kind==='note'?entry.text:`${entry.label}: ${entry.value}${entry.note?` (${entry.note})`:''}`))});
 section('Client');
 field('Workspace',resolvePaths(env).workspaceRoot);
 field('Client host',hostname());field('Bun',process.execPath);field('Client protocol',`${OUTLINER_PROTOCOL_VERSION} (needs service ≥ ${OUTLINER_MIN_SERVICE_PROTOCOL})`);field('Config',resolveClientConfigPath(env));
 let paths;
 try{paths=resolveClientPaths(env);}catch(error){note(`Configuration error: ${error instanceof Error?error.message:String(error)}`);note('Fix the named configuration before launching; no state or database was created.');return finish(false);}
 section('Connection');
 field('Connection',paths.mode);field('Endpoint',paths.socket,presence(paths.socket));
 if(env.OUTLINER_REMOTE!==undefined)note('Connection mode selected by OUTLINER_REMOTE; project client.json is bypassed.');
 else field('Config presence',presence(resolveClientConfigPath(env)));
 field('Client startup logs',join(paths.stateDir,'open-startup-error.log'),'check timestamp');
 if(paths.mode==='local'){
  section('Local storage');
  field('Local state',paths.stateDir,presence(paths.stateDir));field('Local database',paths.database,presence(paths.database));
  if(presence(paths.database)==='missing')note('Database is missing at this resolved location. It may be a new workspace or moved storage; this report cannot distinguish them. Locate your saved database/backup before starting a replacement.');
 }else note('Storage belongs to the remote service. The forwarded socket is local; it is not the database.');
 section('Backup');
 if(paths.mode==='local')field('Conventional backup directory (not a catalog)',join(paths.stateDir,'backups'),presence(join(paths.stateDir,'backups')));
 note('Manual backup locations are unknown; saved copies may be elsewhere.');
 section('Service storage');
 try{
  const service=await createOutlinerClient(paths).request<OutlinerServiceStatus>({action:'ping'},1500);
  field('Service',`${service.status}; protocol ${service.protocolVersion}`);
  field('Service capabilities',service.capabilities?.length?service.capabilities.join(', '):'none reported');
  if(service.location){
   field('Service host',service.location.hostname);field('Service workspace',service.location.workspaceRoot);field('Service database',service.location.database);field('Service state',service.location.stateDirectory);note('Service backup locations: not registered; manual copies may be elsewhere.');
  }else note('Service storage identity: not reported by this service version.');
  const problem=checkServiceCompatibility(service);
  if(problem){note(`${problem.message} The endpoint is reachable; this is not a tunnel failure.`);return finish(false);}
  return finish(true);
 }catch(error){
  note(`Connection failed: ${error instanceof Error?error.message:String(error)}`);
  note(paths.mode==='remote'?'Check the SSH socket tunnel and the canonical service on its host. Do not initialize a local database to repair a remote connection.':'Check the service startup log and the resolved database location. If storage was moved, recover or configure its intended location before starting the service.');
  return finish(false);
 }
}
