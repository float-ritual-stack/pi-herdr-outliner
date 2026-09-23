import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir, platform, arch } from 'node:os';
const snapshot=resolve(process.argv[2] ?? 'missing-snapshot');
const output=resolve(process.argv[3] ?? 'results.json');
const scratch=mkdtempSync(join(tmpdir(),'turso-spike-'));
const results=[];
const cases=['startup-pragmas','copied-read','schema-replay','copied-write','recursive','nested-transaction','savepoint','foreign-key-check','foreign-key-actions','legacy-alter','trigger','trigger-enabled','json-window-index','vector','fts','cdc'];
for(const engine of ['sqlite','turso-stable','turso-preview']) {
  for(const name of cases) {
    if(engine==='sqlite' && ['trigger-enabled','vector','fts','cdc'].includes(name)) continue;
    const proc=Bun.spawn([process.execPath,join(import.meta.dir,'probe.mjs'),engine,name,join(scratch,`${engine}-${name}`),snapshot],{stdout:'pipe',stderr:'pipe'});
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;proc.kill('SIGKILL');},20000);
    const [stdout,stderr,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
    clearTimeout(timer);
    let result;
    try { result=JSON.parse(stdout.trim().split('\n').at(-1)); }
    catch { result={engine,name,status:timedOut?'timeout':'process-failure',code,error:stderr.slice(-1000)}; }
    results.push(result);
    console.log(`${engine} ${name}: ${result.status}${result.phase ? ` (${result.phase})` : ''}`);
    mkdirSync(dirname(output),{recursive:true});
    writeFileSync(output,JSON.stringify({recordedAt:new Date().toISOString(),bun:Bun.version,platform:platform(),arch:arch(),versions:{'turso-stable':'0.7.2','turso-preview':'0.8.0-pre.12'},scratch,results},null,2)+'\n');
  }
}
console.log(`Results: ${output}\nPrivate scratch: ${scratch}`);
// Turso incompatibilities are experiment results; a broken SQLite control or
// crashed/timed-out probe invalidates the run rather than looking successful.
if(results.some(r=>(r.engine==='sqlite' && r.status!=='pass') || ['timeout','process-failure'].includes(r.status))) process.exitCode=1;
