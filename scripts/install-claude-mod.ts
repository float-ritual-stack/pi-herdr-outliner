import {readFile,writeFile,copyFile,rename,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join,dirname,isAbsolute,delimiter} from 'node:path';
import {boundFolderOf} from '../src/paths';

// Loads claude-mod/ in every Claude Code session. Each session then follows its
// folder: the nearest folder bound to an outline (client.json, or an outline
// root the host serves) feeds that outline; an unbound folder feeds nothing.
//
//   install-claude-mod.ts                        load the mod; the folder list and mode are kept
//   install-claude-mod.ts --exclude FOLDER…      and opt these folders out
//   install-claude-mod.ts --folder               folder mode, dropping an allowlist (strict
//                                                mode's, or a list from before folder mode)
//   install-claude-mod.ts [--allowlist] FOLDER…  strict mode: only these folders feed
//
// A list with no PI_OUTLINER_MENTIONS_MODE is opted out. One written before
// folder mode was the allowlist, so its folders now feed nothing (it fails
// closed); the installer says so, and --folder drops it, naming the listed
// folders bound to no outline.
const usage='Usage: install-claude-mod.ts [--exclude FOLDER]... | --folder | [--allowlist] FOLDER...';
const excluded:string[]=[];
const allowed:string[]=[];
let toFolderMode=false;
let allowlistFlag=false;
for(let i=2;i<process.argv.length;i++){
 const argument=process.argv[i]!;
 if(argument==='--exclude'){
  const folder=process.argv[++i];
  if(!folder)throw Error(`--exclude needs a folder. ${usage}`);
  excluded.push(folder);
 }else if(argument==='--folder')toFolderMode=true;
 else if(argument==='--allowlist')allowlistFlag=true;
 else if(argument.startsWith('-'))throw Error(`Unknown option ${argument}. ${usage}`);
 else allowed.push(argument);
}
if(allowlistFlag&&!allowed.length)throw Error(`--allowlist needs at least one folder. ${usage}`);
if((excluded.length||toFolderMode)&&allowed.length)throw Error(`Opting folders out (folder mode) and an allowlist (strict mode) don't mix. ${usage}`);
for(const folder of [...excluded,...allowed])if(!isAbsolute(folder))throw Error(`Folder must be absolute: ${folder}`);

const modDir=resolve(import.meta.dir,'../claude-mod');
const settingsPath=join(process.env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude'),'settings.json');
let settingsExist=true;
const source=await readFile(settingsPath,'utf8').catch((error:NodeJS.ErrnoException)=>{
 if(error.code!=='ENOENT')throw error;
 settingsExist=false;
 return '{}';
});
const settings=JSON.parse(source) as {env?:Record<string,string>};
if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error(`${settingsPath} is not a JSON object; no configuration was changed.`);
const env={...settings.env};

/** Another checkout or worktree of this mod: replaced, so only one copy loads. */
async function isOutlinerMod(dir:string){
 const manifest=await readFile(join(dir,'.claude-plugin/plugin.json'),'utf8').catch(()=>null);
 try{return manifest!==null&&JSON.parse(manifest).name==='pi-outliner';}catch{return false;}
}
const split=(value:string|undefined,separator:RegExp|string)=>(value??'').split(separator).map(part=>part.trim()).filter(Boolean);
const pluginDirs:string[]=[];
for(const dir of split(env.CLAUDE_CODE_PLUGIN_DIRS,delimiter))
 if(resolve(dir)!==modDir&&!await isOutlinerMod(dir))pluginDirs.push(dir);
env.CLAUDE_CODE_PLUGIN_DIRS=[...pluginDirs,modDir].join(delimiter);
env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS='1';

// The folder list and its mode, as the mod reads them (mentionsModeOf in claude-mod/hooks/mention-message.ts).
const listed=split(env.PI_OUTLINER_MENTIONS_WORKSPACES,/[:,]/);
const setMode=(env.PI_OUTLINER_MENTIONS_MODE??'').trim();
const notes:string[]=[];
const unbound=(folders:string[])=>folders.filter(folder=>{
 try{return !boundFolderOf(folder);}catch{return true;}
});
const write=(nextMode:'folder'|'allowlist',folders:string[])=>{
 if(folders.length)env.PI_OUTLINER_MENTIONS_WORKSPACES=folders.join(':');
 else delete env.PI_OUTLINER_MENTIONS_WORKSPACES;
 // Folder mode with nothing opted out needs no setting; a list the installer writes always says its mode.
 if(nextMode==='folder'&&!folders.length)delete env.PI_OUTLINER_MENTIONS_MODE;
 else env.PI_OUTLINER_MENTIONS_MODE=nextMode;
};
if(allowed.length){
 const kept=setMode==='allowlist'?listed:[];
 if(setMode!=='allowlist'&&listed.length)notes.push(`Dropped the listed folders (${listed.join(', ')}): strict mode lists the folders that feed instead.`);
 write('allowlist',[...new Set([...kept,...allowed.map(folder=>resolve(folder))])]);
 notes.push(`Strict mode: only ${env.PI_OUTLINER_MENTIONS_WORKSPACES} feed an outline, bound or not.`);
}else if(setMode==='allowlist'&&!toFolderMode){
 if(excluded.length)throw Error('PI_OUTLINER_MENTIONS_MODE=allowlist is set (strict mode); pass --folder to leave it, then opt folders out.');
 notes.push(`Strict mode kept (PI_OUTLINER_MENTIONS_MODE=allowlist): only ${listed.join(', ')||'the listed folders'} feed. Pass --folder for folder mode.`);
}else if(toFolderMode&&setMode!=='folder'&&listed.length){
 // An allowlist (strict mode's, or a list from before folder mode) is dropped, never kept as opt-outs.
 notes.push(`Folder mode: each session feeds the outline its folder is bound to. Dropped the allowlist (${listed.join(', ')}).`);
 const loose=unbound(listed);
 if(loose.length)notes.push(`Bound to no outline, so these feed nothing: ${loose.join(', ')}. Bind each with the choose-outline action, or keep strict mode with --allowlist.`);
 write('folder',excluded.map(folder=>resolve(folder)));
}else if(excluded.length||toFolderMode){
 write('folder',[...new Set([...listed,...excluded.map(folder=>resolve(folder))])]);
 if(env.PI_OUTLINER_MENTIONS_WORKSPACES)notes.push(`Opted out: ${env.PI_OUTLINER_MENTIONS_WORKSPACES}.`);
}else if(listed.length&&!setMode){
 notes.push(`PI_OUTLINER_MENTIONS_WORKSPACES lists ${listed.join(', ')} with no mode: those folders are opted out. If it was your allowlist from before folder mode, run again with --folder to drop it (bound folders feed on their own), or with --allowlist to keep strict mode.`);
}else if(listed.length){
 notes.push(`Opted out: ${listed.join(', ')}.`);
}

const next=`${JSON.stringify({...settings,env},null,2)}\n`;
if(settingsExist&&JSON.stringify(JSON.parse(source))===JSON.stringify(JSON.parse(next))){
 console.log([`Claude Code mod already installed from ${modDir}.`,...notes].join('\n'));
 process.exit(0);
}
const backup=`${settingsPath}.before-claude-mod-${Date.now()}`;
if(settingsExist)await copyFile(settingsPath,backup);
else await mkdir(dirname(settingsPath),{recursive:true});
const temporary=`${settingsPath}.claude-mod-${process.pid}`;
await writeFile(temporary,next,{mode:0o600});
await rename(temporary,settingsPath);
console.log([`Installed the Claude Code mod from ${modDir}. New Claude Code sessions load it.${settingsExist?` Backup: ${backup}`:''}`,...notes].join('\n'));
