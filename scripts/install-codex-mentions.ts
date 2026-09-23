import {readFile,writeFile,copyFile,rename,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join,dirname} from 'node:path';

const workspace=resolve(process.argv[2]??process.cwd());
const configPath=join(process.env.CODEX_HOME??join(homedir(),'.codex'),'config.toml');
let configExists=true;
const source=await readFile(configPath,'utf8').catch((error:NodeJS.ErrnoException)=>{
 if(error.code!=='ENOENT')throw error;
 configExists=false;
 return '';
});
const config=Bun.TOML.parse(source) as {notify?:unknown};
const script=resolve(import.meta.dir,'../src/mentions-codex.ts');
const command=[process.execPath,script,'--workspace',workspace];
if(config.notify!==undefined){
 if(JSON.stringify(config.notify)===JSON.stringify(command)){console.log('Recent mentions already installed for '+workspace);process.exit(0);}
 throw Error('Codex already has a notify command. Preserve it and compose the two adapters explicitly; no configuration was changed.');
}
const backup=`${configPath}.before-mentions-${Date.now()}`;
if(configExists)await copyFile(configPath,backup);
else await mkdir(dirname(configPath),{recursive:true});
const temporary=`${configPath}.mentions-${process.pid}`;
await writeFile(temporary,`# Outliner completed-response navigation shelf\nnotify = ${JSON.stringify(command)}\n\n${source}`,{mode:0o600});
await rename(temporary,configPath);
console.log(`Installed for ${workspace}. New Codex sessions use it; existing sessions retain their loaded config.${configExists?` Backup: ${backup}`:''}`);
