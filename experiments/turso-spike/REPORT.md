# Turso in the Outliner: close enough to experiment, not a drop-in replacement

> **Recommendation:** Keep SQLite as the authoritative Outliner store. Turso's preview release ran a real note lifecycle with a small synchronous adapter, but both tested releases silently fail migration checks we depend on. Its search features are worth a separate, disposable derived-index experiment if we want to explore passage retrieval.

PIE-321 · 2026-09-23 · application baseline `11eded4` · Linux x64, Bun 1.3.14. Packages: stable **0.7.2**, preview **0.8.0-pre.12**, both using `/compat`. No production engine change, service restart, or live database write was part of this spike. The laptop launch repair during the session is separate work, PIE-322.

## What we built

Two executable probe suites: one for SQL and file compatibility, another loading the actual Outliner store through a process-local adapter. Each case gets its own process and disposable database. SQLite runs the same relevant cases as a control.

The private snapshot was taken through SQLite's read-only backup API, including committed WAL pages. It contains **44 application tables, 12,343 rows, and 1,363 block rows including deleted content**. Both Turso versions read every table with matching canonical row hashes. Both replayed all **88 schema objects** into an empty database.

Synthetic writes also committed, rejected stale revisions, rolled back, survived close/reopen, and could subsequently be read by SQLite. These are narrow file/read/write results, not proof that every Outliner behavior is compatible.

Reproduce with the [README commands](README.md). Full sanitized evidence: [SQL results](evidence/sql-results.json) and [store results](evidence/store-results.json).

## Results that decide whether a swap is practical

| Probe | SQLite control | Turso 0.7.2 | Turso 0.8.0-pre.12 |
| --- | --- | --- | --- |
| Startup pragmas read back: foreign keys, WAL, busy timeout | Pass | Pass | Pass |
| Read all copied tables and compare hashes | Pass | Pass | Pass |
| Replay current schema | Pass | Pass | Pass |
| Commit, stale revision, rollback, reopen, SQLite readback | Pass | Pass | Pass |
| Recursive descendant CTE | Pass | **Rejected** | Pass |
| Native nested transaction callback | Pass | **Rejected** | **Rejected** |
| Explicit nested savepoint rollback | Pass | Pass | Pass |
| Foreign-key insert rejection, CASCADE, SET NULL, RESTRICT | Pass | Pass | Pass |
| `foreign_key_check` detects a deliberately invalid row | Pass | **Returns no violations** | **Returns no violations** |
| `legacy_alter_table` preserves old FK target during rename | Pass | **Wrong target** | **Wrong target** |
| Trigger with `RAISE(ABORT)` | Pass | Pass | Pass |
| JSON checks/functions, partial expression unique index, window query | Pass | Pass | Pass |

The foreign-key distinction matters: **ordinary enforcement worked, but the integrity-audit pragma did not**. We inserted an orphan with enforcement disabled; SQLite reported it, Turso returned an empty result. An application that treats that result as a clean audit would get false reassurance. Outliner's annotation/resource migrations use this check.

Likewise, `legacy_alter_table=ON` was accepted but did not preserve the expected reference during table rename. The child FK changed to the renamed table. That breaks an assumption in Outliner's existing table-rebuild migration path. Replaying today's schema does not exercise historical upgrades.

These two findings are enough to reject a drop-in migration today, even though opening the database looks successful.

## How far the actual application got

The default Turso API is asynchronous, but its **synchronous `/compat` API works under Bun**. My initial expectation that we might need an async storage rewrite was too pessimistic.

The first adapter only mapped `query(sql)` to `prepare(sql)` and converted a missing `.get()` result from `undefined` to `null`. With that adapter:

- Fresh Outliner startup failed on both versions because the driver starts `BEGIN` inside an existing transaction.
- A copied current database booted and created/read notes, but updating one hit the same nested-transaction error.

The engine supports savepoints, so a second adapter used those for nested callbacks. It also preserves deferred/immediate/exclusive entrypoints. **This was additional compatibility code**, not native behavior.

With that addition:

- **Stable:** fresh and copied stores booted; created parent/child notes; read and filtered metadata; edited with revision checks; rolled back an outer transaction; and reopened successfully. Deleting the parent failed at the real recursive subtree SQL.
- **Preview:** completed that entire journey on both fresh and copied stores, including deleting the subtree and checking the child's effective deletion root.

The store's property/subtree filtering step is distinct from the direct recursive SQL probe; the stable failure occurred in deletion. The dedicated SQL case makes the recursive capability explicit.

The adapter deliberately retained SQLite for the workspace ownership sidecar. It does not establish Turso lock/error-code parity or multi-process safety. We did not remove validation calls or catch their failures to make startup pass: the audit problem is that an unsupported check itself returns a misleadingly empty result.

## The useful extras actually worked

These probes used synthetic content and made no model calls.

| Capability | Both versions | What the probe established |
| --- | --- | --- |
| Full-text index (`USING fts`, `index_method` enabled) | Pass | Search reflects insert, update, rollback, reopen, and delete |
| Exact vector cosine search | Pass | Three fixed vectors return the expected nearest-first order |
| Change data capture (`full`) | Pass | Insert/update plus commit record; shared transaction ID; before/after data; rollback removes captured changes; reopen requires opting in again |

FTS could provide passage candidates before Jev judges relevance. Exact vectors provide another retrieval primitive. CDC could help refresh a derived index. None automatically solves note splitting, thread identity, topic naming, relevance, or editorial decisions.

Tradeoffs:

- **FTS:** Turso's Tantivy-backed index has its own syntax and behavior; it is not an FTS5 drop-in. The two-document probe says nothing about search quality or large-corpus latency. Compare it with a SQLite FTS5 baseline before adopting another engine just for retrieval.
- **Vectors:** the probe is an exact scan with fixed vectors. It does not test embeddings, recall, or a production approximate-nearest-neighbor index.
- **CDC:** row changes and transaction boundaries are useful, but application actor/task provenance, subscriber checkpoints, retention, and replay remain our responsibility. Full capture also stores extra copies of data.
- **Separate derived index:** preserves the proven canonical store and is rebuildable, but adds synchronization work and a second artifact to manage. That is worthwhile only if it produces a useful retrieval experiment.

## Timing: observations, not a performance verdict

Each recorded `ms` is one subprocess's probe-body duration, including setup and assertions, excluding process/package-import startup. The copied-read test hashes results from both engines in the same case; it is not a query benchmark. Store timings include migration/seed checks and note operations.

These tiny cases finished in milliseconds to well under a second on this host. Do not use those numbers to declare an engine faster. The useful observation is that we can run this compatibility investigation cheaply; performance has not been established as a reason to migrate.

## What surprised us, and what went wrong in the experiment

1. **The current compatibility document understated preview support.** It lists recursive CTEs as unsupported, but the pinned preview package passed the direct test and the real deletion path. Stable still failed. Executable version-specific evidence changed the conclusion.
2. **Schema compatibility looked better than behavioral compatibility.** Every current schema object loaded, and all copied table hashes agreed. Neither fact caught the silent migration-check failures.
3. **Nested transactions were a driver mismatch we could bridge.** Explicit savepoints worked in both engines, turning fresh-start failures into successful note journeys. That does not fix SQL migration semantics.
4. **The harness needed correcting too.** Initially I passed an empty options object to Bun's SQLite constructor; the SQLite controls failed before testing anything. Setting `create:true` corrected that. The first module mock also rewired the imported SQLite binding and recursively constructed the adapter; capturing the original class before mocking fixed it. Finally, the deletion assertion checked a child's direct deletion timestamp instead of its effective deleted-root ID. These were harness mistakes, not Turso defects; the retained results are from the corrected runs.

## Recommendation and next decision

**Do not replace Outliner's SQLite backend in this batch.** File-format compatibility is real, and the preview is close enough for an experiment, but the migration audit failures are material. A nominally successful boot must not weaken our evidence for data integrity.

For the passage-search idea, the more useful next experiment is a **rebuildable passage index**: source block ID + revision + passage location, lexical candidate retrieval, then Jev judgments on the actual passages. Try Turso FTS/vectors there alongside a SQLite baseline if that answers a concrete question. That experiment can be discarded without moving the canonical notes.

If we later revisit the storage swap, rerun these probes first. Require correct integrity checks and historical migration behavior, then test lock contention, annotation/resource operations, failure recovery, and the full service/application suite. Keep the adapter disposable until those results justify a permanent database seam.

## Not checked

- Historical databases upgraded through every migration; mixed-version applications.
- Crash/power-loss recovery, database repair, multi-process contention, or Turso ownership-sidecar behavior.
- Full annotation, resource retention, inbox, delivery, and UI workflows on Turso; the whole production test suite with the replacement engine.
- Large-corpus FTS quality, multilingual/tokenizer behavior, filtered retrieval, embedding generation, ANN performance, or end-to-end Jev relevance.
- Cloud service, replication/sync, AgentFS integration, macOS Turso bindings, or the C ABI route.

The report completes a compatibility spike. It is not a production migration approval.

## Primary-source references

- [Turso compatibility matrix](https://github.com/tursodatabase/turso/blob/main/COMPAT.md): useful checklist, but moving documentation; the preview result above overrides its recursive-CTE claim for the tested case.
- [JavaScript bindings](https://github.com/tursodatabase/turso/blob/main/bindings/javascript/README.md) and [compat implementation](https://github.com/tursodatabase/turso/blob/main/bindings/javascript/packages/common/compat.ts): synchronous API and transaction wrapper. Installed version-specific code and the lockfile are the evidence for this run.
- [Bun SQLite documentation](https://bun.sh/docs/runtime/sqlite): nested transaction/savepoint semantics; `setCustomSQLite` is a macOS facility and a documented no-op elsewhere, so it is not the Linux route tested here.
- [Turso FTS design and syntax](https://github.com/tursodatabase/turso/blob/main/docs/fts.md), [vector manual](https://github.com/tursodatabase/turso/blob/main/cli/manuals/vector.md), and [CDC manual](https://github.com/tursodatabase/turso/blob/main/cli/manuals/cdc.md).
