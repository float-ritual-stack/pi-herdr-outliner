import {readFile,writeFile,copyFile,rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';

const workspace=resolve(process.argv[2]??process.cwd());
const configPath=join(process.env.CODEX_HOME??join(homedir(),'.codex'),'config.toml');
const source=await readFile(configPath,'utf8');
const config=Bun.TOML.parse(source) as {notify?:unknown};
const script=resolve(import.meta.dir,'../src/mentions-codex.ts');
const command=[process.execPath,script,'--workspace',workspace];
if(config.notify!==undefined){
 if(JSON.stringify(config.notify)===JSON.stringify(command)){console.log('Recent mentions already installed for '+workspace);process.exit(0);}
 throw Error('Codex already has a notify command. Preserve it and compose the two adapters explicitly; no configuration was changed.');
}
const backup=`${configPath}.before-mentions-${Date.now()}`;
await copyFile(configPath,backup);
const temporary=`${configPath}.mentions-${process.pid}`;
await writeFile(temporary,`# Outliner completed-response navigation shelf\nnotify = ${JSON.stringify(command)}\n\n${source}`,{mode:0o600});
await rename(temporary,configPath);
console.log(`Installed for ${workspace}. New Codex sessions use it; existing sessions retain their loaded config. Backup: ${backup}`);
