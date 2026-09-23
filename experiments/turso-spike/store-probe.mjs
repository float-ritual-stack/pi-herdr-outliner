// Run separately: module replacement is intentionally confined to this process.
// The ownership sidecar stays on SQLite; only the Outliner data connection changes.
import { Database as SQLite } from 'bun:sqlite';
import { mock } from 'bun:test';
import { mkdirSync, copyFileSync, existsSync, constants } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const [engine, mode, scratch, snapshot, adapt = 'basic'] = process.argv.slice(2);
const OwnershipDatabase = SQLite; // Capture value before mock.module rewires live exports.
mkdirSync(scratch, {recursive:true});
const path=join(scratch,'store.sqlite');
if(existsSync(path)) throw new Error('Use a new scratch directory; refusing to overwrite a database');
if(mode==='copy') copyFileSync(snapshot,path,constants.COPYFILE_EXCL);
let lastSql='';
let adaptations={queryToPrepare:0,missingRowToNull:0,savepoints:0,ownershipSQLite:true};
if(engine!=='sqlite') {
  const Native=(await import(`${engine}/compat`)).Database;
  let savepointId=0;
  class Adapter extends Native {
    constructor(path, options) {
      // Preserve the existing workspace owner. This is NOT proof of replacing it.
      if(path.endsWith('.owner.sqlite')) return new OwnershipDatabase(path,options);
      super(path);
    }
    exec(sql) { lastSql=sql; return super.exec(sql); }
    query(sql) {
      adaptations.queryToPrepare++;
      lastSql=sql;
      const statement=super.prepare(sql);
      return {
        all:(...args)=> { lastSql=sql; return statement.all(...args); },
        get:(...args)=> { lastSql=sql; const row=statement.get(...args); if(row===undefined) adaptations.missingRowToNull++; return row ?? null; },
        run:(...args)=> { lastSql=sql; return statement.run(...args); },
      };
    }
    transaction(fn) {
      if(adapt!=='savepoints') return super.transaction(fn);
      const wrap=mode=>(...args)=> {
        const nested=this.inTransaction;
        const point=`spike_${++savepointId}`;
        if(nested) adaptations.savepoints++;
        this.exec(nested ? `SAVEPOINT ${point}` : `BEGIN ${mode}`);
        try {
          const value=fn(...args);
          this.exec(nested ? `RELEASE ${point}` : 'COMMIT');
          return value;
        } catch(e) {
          this.exec(nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : 'ROLLBACK');
          throw e;
        }
      };
      const result=wrap('DEFERRED');
      result.deferred=result;
      result.immediate=wrap('IMMEDIATE');
      result.exclusive=wrap('EXCLUSIVE');
      return result;
    }
  }
  mock.module('bun:sqlite',()=>({Database:Adapter}));
}
let store;
let phase='boot';
const steps=[];
const start=performance.now();
try {
  const {OutlinerStore}=await import('../../src/store.ts');
  store=new OutlinerStore(path);
  steps.push('boot');
  phase='create';
  const parent=store.create('Synthetic Turso parent\n[type::note] [tag::turso-spike]',null,'agent',{actorId:'spike:turso'});
  const child=store.create('Synthetic child',parent.id,'agent',{actorId:'spike:turso'});
  steps.push('create parent and child');
  phase='read and query';
  assert.equal(store.get(child.id).parentId,parent.id);
  const matches=store.queryBlocks({filters:[{key:'tag',value:'turso-spike'}],limit:10});
  assert(matches.blocks.some(b=>b.id===parent.id));
  steps.push('read and property filter');
  phase='update';
  const edited=store.update(parent.id,'Synthetic revised\n[type::note] [tag::turso-spike]',parent.revision,{author:'agent',actorId:'spike:turso'});
  assert.equal(edited.revision,parent.revision+1);
  assert.throws(()=>store.update(parent.id,'stale',parent.revision));
  steps.push('update and stale revision rejection');
  phase='nested rollback';
  assert.throws(()=>store.database.transaction(()=> {
    store.update(parent.id,'not committed',edited.revision,{author:'agent',actorId:'spike:turso'});
    throw new Error('injected outer failure');
  })(),/injected outer failure/);
  assert.equal(store.get(parent.id).text,edited.text);
  steps.push('outer rollback preserves text and revision');
  phase='subtree filter';
  const subtree=store.queryBlocks({subtreeRootId:parent.id,limit:10});
  assert(subtree.blocks.some(b=>b.id===child.id));
  steps.push('subtree filter');
  phase='reopen';
  store.close(); store=new OutlinerStore(path);
  assert.equal(store.get(parent.id).text,edited.text);
  assert.equal(store.get(child.id).parentId,parent.id);
  steps.push('reopen persisted note and hierarchy');
  phase='delete subtree';
  store.delete(parent.id);
  assert.equal(store.get(child.id).effectiveDeletedRootId,parent.id);
  steps.push('delete subtree');
  store.close(); store=undefined;
  console.log(JSON.stringify({engine,mode,adapt,status:'pass',steps,adaptations,ms:Math.round(performance.now()-start)}));
} catch(error) {
  try { store?.close(); } catch {}
  // Only schema SQL; never include parameter values or note text.
  console.log(JSON.stringify({engine,mode,adapt,status:'fail',phase,steps,adaptations,sql:lastSql.slice(0,900),error:String(error.message).slice(0,900),ms:Math.round(performance.now()-start)}));
  process.exitCode=1;
}
