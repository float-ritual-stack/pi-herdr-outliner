import {readFile,writeFile,copyFile,rename,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join,dirname,isAbsolute,delimiter} from 'node:path';

// Loads claude-mod/ in every Claude Code session and names the workspaces whose
// completed answers feed Recent Mentions. Usage: install-claude-mod.ts WORKSPACE...
const workspaces=process.argv.slice(2);
if(!workspaces.length)throw Error('Specify at least one absolute workspace; global ingestion is not enabled');
for(const workspace of workspaces)if(!isAbsolute(workspace))throw Error(`Workspace must be absolute: ${workspace}`);
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
const configured=split(env.PI_OUTLINER_MENTIONS_WORKSPACES,/[:,]/);
env.PI_OUTLINER_MENTIONS_WORKSPACES=[...new Set([...configured,...workspaces.map(workspace=>resolve(workspace))])].join(':');

const next=`${JSON.stringify({...settings,env},null,2)}\n`;
if(settingsExist&&JSON.stringify(JSON.parse(source))===JSON.stringify(JSON.parse(next))){console.log(`Claude Code mod already installed from ${modDir}`);process.exit(0);}
const backup=`${settingsPath}.before-claude-mod-${Date.now()}`;
if(settingsExist)await copyFile(settingsPath,backup);
else await mkdir(dirname(settingsPath),{recursive:true});
const temporary=`${settingsPath}.claude-mod-${process.pid}`;
await writeFile(temporary,next,{mode:0o600});
await rename(temporary,settingsPath);
console.log(`Installed the Claude Code mod from ${modDir} for ${env.PI_OUTLINER_MENTIONS_WORKSPACES}. New Claude Code sessions load it.${settingsExist?` Backup: ${backup}`:''}`);
