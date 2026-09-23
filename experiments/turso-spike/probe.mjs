// Each invocation runs one case in a disposable process/database.
import { Database as SQLite } from 'bun:sqlite';
import { copyFileSync, mkdirSync, existsSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const [engine, name, scratch, snapshot] = process.argv.slice(2);
mkdirSync(scratch, { recursive: true });
const Engine = engine === 'sqlite' ? SQLite : (await import(`${engine}/compat`)).Database;
const flags = name === 'fts' ? ['index_method'] : name === 'trigger-enabled' ? ['triggers'] : [];
const path = join(scratch, 'probe.sqlite');
if(existsSync(path)) throw new Error('Use a new scratch directory; refusing to overwrite a database');
const options = engine === 'sqlite' ? { create: true } : { experimental: flags };
const open = (p = path) => new Engine(p, options);
const rows = (db, sql, ...params) => db.prepare(sql).all(...params);
const one = (db, sql, ...params) => db.prepare(sql).get(...params);
const run = (db, sql, ...params) => db.prepare(sql).run(...params);
const count = (db, table) => one(db, `SELECT count(*) AS n FROM "${table}"`).n;
const expectReject = (fn) => {
  try { fn(); } catch (e) { return String(e.message); }
  throw new Error('Expected rejection but operation succeeded');
};
const canonical = value => {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
};
const digest = records => createHash('sha256').update(records.map(r => JSON.stringify(canonical(r))).sort().join('\n')).digest('hex');
let db;
const start = performance.now();
let phase = 'open';
let result;
try {
  if (['copied-read', 'copied-write'].includes(name)) copyFileSync(snapshot, path, constants.COPYFILE_EXCL);
  db = open();
  phase = name;
  switch (name) {
    case 'startup-pragmas': {
      db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
      const settings=Object.fromEntries(['foreign_keys','journal_mode','busy_timeout'].map(key=>[key,Object.values(one(db,`PRAGMA ${key}`) ?? {})[0]]));
      assert.equal(settings.foreign_keys,1);
      assert.equal(settings.journal_mode,'wal');
      assert.equal(settings.busy_timeout,5000);
      result=settings;
      break;
    }
    case 'copied-read': {
      const baseline = new SQLite(snapshot, { readonly: true });
      const tables = rows(baseline, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      const checks = [];
      for (const { name: table } of tables) {
        phase = `read table ${table}`;
        const sql = `SELECT * FROM "${table.replaceAll('"', '""')}"`;
        const expected = rows(baseline, sql);
        const actual = rows(db, sql);
        assert.equal(digest(actual), digest(expected));
        checks.push({ table, rows: actual.length, digest: digest(actual) });
      }
      baseline.close();
      result = { tables: checks };
      break;
    }
    case 'schema-replay': {
      const baseline = new SQLite(snapshot, { readonly: true });
      const ddl = rows(baseline, "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid");
      let applied = 0;
      for (const item of ddl) {
        phase = `DDL ${item.type} ${item.name} (${applied}/${ddl.length})`;
        db.exec(item.sql);
        applied++;
      }
      baseline.close();
      result = { applied };
      break;
    }
    case 'copied-write': {
      // Synthetic note through the real store is a separate case. This checks SQL
      // writes/rollback and SQLite readback without modifying copied user rows.
      db.exec('CREATE TABLE spike_note(id TEXT PRIMARY KEY, text TEXT, revision INTEGER NOT NULL);');
      db.transaction(() => {
        run(db, 'INSERT INTO spike_note VALUES(?,?,?)', 'synthetic', 'spike note', 1);
      })();
      assert.equal(run(db, 'UPDATE spike_note SET text=?,revision=revision+1 WHERE id=? AND revision=?', 'revised', 'synthetic', 1).changes, 1);
      assert.equal(run(db, 'UPDATE spike_note SET text=?,revision=revision+1 WHERE id=? AND revision=?', 'stale', 'synthetic', 1).changes, 0);
      expectReject(db.transaction(() => { run(db, 'UPDATE spike_note SET text=?', 'rollback'); throw new Error('injected'); }));
      assert.equal(one(db, 'SELECT text FROM spike_note').text, 'revised');
      db.close(); db = open();
      assert.equal(one(db, 'SELECT revision FROM spike_note').revision, 2);
      db.close(); db = undefined;
      const sqlite = new SQLite(path, { readonly: true });
      assert.equal(one(sqlite, 'SELECT text FROM spike_note').text, 'revised');
      sqlite.close();
      result = { commit: true, staleWriteRejected: true, rollback: true, reopen: true, sqliteReadback: true };
      break;
    }
    case 'recursive': {
      db.exec("CREATE TABLE blocks(id TEXT PRIMARY KEY,parent_id TEXT); INSERT INTO blocks VALUES('a',NULL),('b','a'),('c','b'),('d','a');");
      const actual = rows(db, 'WITH RECURSIVE subtree(id) AS (SELECT id FROM blocks WHERE id=? UNION ALL SELECT block.id FROM blocks block JOIN subtree ON block.parent_id=subtree.id) SELECT id FROM subtree ORDER BY id', 'a');
      assert.deepEqual(actual.map(r => r.id), ['a','b','c','d']);
      result = { descendants: actual.length };
      break;
    }
    case 'nested-transaction':
    case 'savepoint': {
      db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY);');
      db.transaction(() => {
        db.exec('INSERT INTO items VALUES(1)');
        if (name === 'savepoint') {
          db.exec('SAVEPOINT nested');
          db.exec('INSERT INTO items VALUES(2)');
          db.exec('ROLLBACK TO nested; RELEASE nested');
        } else {
          const error = expectReject(db.transaction(() => { db.exec('INSERT INTO items VALUES(2)'); throw new Error('inner injected failure'); }));
          assert.equal(error, 'inner injected failure');
          db.transaction(() => db.exec('INSERT INTO items VALUES(4)'))();
        }
        db.exec('INSERT INTO items VALUES(3)');
      })();
      assert.deepEqual(rows(db,'SELECT id FROM items ORDER BY id').map(r => r.id), name === 'savepoint' ? [1,3] : [1,3,4]);
      result = { outerPreserved: true, innerRolledBack: true };
      break;
    }
    case 'foreign-key-check': {
      db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER PRIMARY KEY,pid INTEGER REFERENCES p(id)); INSERT INTO c VALUES(1,999);');
      const violations = rows(db, 'PRAGMA foreign_key_check');
      assert.equal(violations.length, 1, 'foreign_key_check must expose deliberately invalid row');
      result = { detectedInvalidRows: violations.length };
      break;
    }
    case 'foreign-key-actions': {
      db.exec('PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER PRIMARY KEY,pid INTEGER REFERENCES p(id) ON DELETE CASCADE); CREATE TABLE s(id INTEGER PRIMARY KEY,pid INTEGER REFERENCES p(id) ON DELETE SET NULL); CREATE TABLE r(id INTEGER PRIMARY KEY,pid INTEGER REFERENCES p(id) ON DELETE RESTRICT);');
      const error = expectReject(() => db.exec('INSERT INTO c VALUES(1,999)'));
      db.exec('INSERT INTO p VALUES(1); INSERT INTO c VALUES(1,1); INSERT INTO s VALUES(1,1); INSERT INTO r VALUES(1,1);');
      expectReject(() => db.exec('DELETE FROM p WHERE id=1'));
      db.exec('DELETE FROM r; DELETE FROM p WHERE id=1;');
      assert.equal(count(db,'c'),0);
      assert.equal(one(db,'SELECT pid FROM s').pid,null);
      result = { rejectedInvalidInsert: error, cascade: true, setNull: true, restrict: true };
      break;
    }
    case 'legacy-alter': {
      db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(pid INTEGER REFERENCES p(id)); ALTER TABLE p RENAME TO old_p;');
      const reference = rows(db, 'PRAGMA foreign_key_list(c)')[0];
      assert.equal(reference.table,'p', 'legacy mode must not rewrite reference to old_p');
      result = { retainedReference: reference.table };
      break;
    }
    case 'trigger':
    case 'trigger-enabled': {
      db.exec("CREATE TABLE item(id INTEGER PRIMARY KEY,v TEXT); INSERT INTO item VALUES(1,'original'); CREATE TRIGGER guard BEFORE UPDATE ON item BEGIN SELECT RAISE(ABORT,'protected'); END;");
      expectReject(() => db.exec("UPDATE item SET v='changed'"));
      assert.equal(one(db,'SELECT v FROM item').v,'original');
      result = { protected: true };
      break;
    }
    case 'json-window-index': {
      db.exec(`CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT CHECK(json_valid(body)), active INTEGER); CREATE UNIQUE INDEX key_active ON docs(json_extract(body,'$.key')) WHERE active=1;`);
      run(db,'INSERT INTO docs VALUES(?,?,?)',1,JSON.stringify({key:'a',tags:['x','y']}),1);
      expectReject(() => run(db,'INSERT INTO docs VALUES(?,?,?)',2,'{"key":"a"}',1));
      run(db,'INSERT INTO docs VALUES(?,?,?)',3,'{"key":"b"}',1);
      const actual=rows(db,"SELECT id,ROW_NUMBER() OVER(PARTITION BY active ORDER BY id) AS rn FROM docs ORDER BY id");
      assert.deepEqual(actual,[{id:1,rn:1},{id:3,rn:2}]);
      assert.equal(one(db,"SELECT json_group_array(value) AS tags FROM docs,json_each(docs.body,'$.tags') WHERE docs.id=1").tags,'["x","y"]');
      expectReject(() => run(db,'INSERT INTO docs VALUES(?,?,?)',4,'invalid',1));
      result = { window: true, json: true, partialExpressionUniqueIndex: true };
      break;
    }
    case 'vector': {
      db.exec('CREATE TABLE embeddings(id INTEGER PRIMARY KEY,v BLOB);');
      for (const [id,v] of [[1,'[1,0,0]'],[2,'[0,1,0]'],[3,'[0.9,0.1,0]']]) run(db,'INSERT INTO embeddings VALUES(?,vector32(?))',id,v);
      const hits=rows(db,"SELECT id,vector_distance_cos(v,vector32('[1,0,0]')) AS distance FROM embeddings ORDER BY distance");
      assert.deepEqual(hits.map(r=>r.id),[1,3,2]);
      result = { exactScan: hits };
      break;
    }
    case 'fts': {
      db.exec("CREATE TABLE docs(id INTEGER PRIMARY KEY,title TEXT,body TEXT); CREATE INDEX docs_fts ON docs USING fts(title,body); INSERT INTO docs VALUES(1,'Pane navigation','link reader panes'),(2,'Other topic','grocery list');");
      const search=term=>rows(db,'SELECT id FROM docs WHERE fts_match(title,body,?) ORDER BY id',term).map(r=>r.id);
      assert.deepEqual(search('panes'),[1]);
      db.exec("UPDATE docs SET body='linked windows' WHERE id=1;");
      assert.deepEqual(search('panes'),[]);
      assert.deepEqual(search('windows'),[1]);
      expectReject(db.transaction(()=> { db.exec("UPDATE docs SET body='rollbackword' WHERE id=1"); throw new Error('injected'); }));
      assert.deepEqual(search('rollbackword'),[]);
      assert.deepEqual(search('windows'),[1]);
      db.close(); db=open();
      assert.deepEqual(search('windows'),[1]);
      db.exec('DELETE FROM docs WHERE id=1');
      assert.deepEqual(search('windows'),[]);
      result = { insert:true,update:true,rollback:true,reopen:true,delete:true };
      break;
    }
    case 'cdc': {
      db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,v TEXT); PRAGMA capture_data_changes_conn('full');");
      db.transaction(()=>db.exec("INSERT INTO items VALUES(1,'original'); UPDATE items SET v='changed' WHERE id=1;"))();
      const before=count(db,'turso_cdc');
      expectReject(db.transaction(()=> { db.exec("INSERT INTO items VALUES(2,'rollback')"); throw new Error('injected'); }));
      assert.equal(count(db,'turso_cdc'),before);
      const columns=rows(db,'PRAGMA table_info(turso_cdc)').map(r=>r.name);
      const events=rows(db,'SELECT change_type,count(*) AS n FROM turso_cdc GROUP BY change_type ORDER BY change_type');
      assert.deepEqual(events,[{change_type:0,n:1},{change_type:1,n:1},{change_type:2,n:1}]);
      assert.equal(one(db,'SELECT count(DISTINCT change_txn_id) AS n FROM turso_cdc').n,1);
      assert.equal(one(db,'SELECT count(*) AS n FROM turso_cdc WHERE change_type=0 AND "before" IS NOT NULL AND "after" IS NOT NULL').n,1);
      db.close(); db=open(); db.exec("INSERT INTO items VALUES(3,'after reopen');");
      assert.equal(count(db,'turso_cdc'),before, 'CDC is connection scoped');
      result={columns,events,transactionGrouped:true,beforeAfterPresent:true,rollback:true,reopenRequiresOptIn:true};
      break;
    }
    default: throw new Error(`Unknown case ${name}`);
  }
  db?.close(); db=undefined;
  console.log(JSON.stringify({engine,name,status:'pass',ms:Math.round((performance.now()-start)*100)/100,result}));
} catch(error) {
  try { db?.close(); } catch {}
  console.log(JSON.stringify({engine,name,status:'fail',phase,ms:Math.round((performance.now()-start)*100)/100,error:String(error.message).slice(0,1200)}));
  process.exitCode=1;
}
