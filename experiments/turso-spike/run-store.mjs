import {mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const snapshot=resolve(process.argv[2]);
const output=resolve(process.argv[3]);
const scratch=mkdtempSync(join(tmpdir(),'turso-store-'));
const results=[];
for(const engine of ['sqlite','turso-stable','turso-preview']) {
  for(const mode of ['fresh','copy']) {
    for(const adapt of engine==='sqlite'?['basic']:['basic','savepoints']) {
      const proc=Bun.spawn([process.execPath,join(import.meta.dir,'store-probe.mjs'),engine,mode,join(scratch,`${engine}-${mode}-${adapt}`),snapshot,adapt],{stdout:'pipe',stderr:'pipe'});
      let timedOut=false;
      const timer=setTimeout(()=>{timedOut=true;proc.kill('SIGKILL');},20000);
      const [stdout,stderr,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
      clearTimeout(timer);
      let result;
      try { result=JSON.parse(stdout.trim().split('\n').at(-1)); }
      catch { result={engine,mode,adapt,status:timedOut?'timeout':'process-failure',code,error:stderr.slice(-1000)}; }
      results.push(result);
      console.log(`${engine} ${mode} ${adapt}: ${result.status}${result.phase?` (${result.phase})`:''}`);
      writeFileSync(output,JSON.stringify({recordedAt:new Date().toISOString(),bun:Bun.version,scratch,results},null,2)+'\n');
    }
  }
}
if(results.some(r=>(r.engine==='sqlite' && r.status!=='pass') || ['timeout','process-failure'].includes(r.status))) process.exitCode=1;
