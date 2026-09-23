# PIE-321: Turso compatibility spike

Disposable experiment, not an alternative production database driver. See [the report](REPORT.md) for outcomes, tradeoffs, and the recommendation. The application source is unchanged.

## Reproduce

Run from the repository root, with Bun and Python 3 installed:

```sh
bun install --frozen-lockfile
bun install --cwd experiments/turso-spike --frozen-lockfile
```

Make a consistent SQLite backup. The source connection is read-only; SQLite's backup API includes committed WAL pages. Use a new destination outside the repository:

```sh
python3 experiments/turso-spike/snapshot.py /absolute/path/to/outliner.sqlite /tmp/my-turso-spike/source.sqlite
bun experiments/turso-spike/run.mjs /tmp/my-turso-spike/source.sqlite /tmp/my-turso-spike/results.json
bun experiments/turso-spike/run-store.mjs /tmp/my-turso-spike/source.sqlite /tmp/my-turso-spike/store-results.json
```

The runners make a new temporary directory, then a separate database and subprocess per case. They never open the supplied source database with Turso. Temporary copies contain private notes: keep them local and remove the reported scratch directories when finished. Do not commit databases or raw transcripts.

For a completely synthetic run, create a fresh Outliner store instead of taking a live backup, then use that closed database as the source:

```sh
bun -e 'import {OutlinerStore} from "./src/store"; const s=new OutlinerStore("/tmp/my-synthetic-outliner/source.sqlite"); s.create("Synthetic research note\n[type::note]"); s.close();'
```

Use a new path for each synthetic run. The snapshot helper and individual probes refuse an existing destination. Read-only source comparisons return hashes and counts, never note bodies. A runner returns nonzero if its SQLite control fails or a child crashes/times out. Expected Turso incompatibilities are recorded as `fail` results without invalidating the experiment; inspect the JSON rather than interpreting the runner's exit status as compatibility approval.

## Files

- `probe.mjs`: SQL/file-format, integrity, transaction, FTS, vector, and CDC probes.
- `store-probe.mjs`: actual `OutlinerStore` methods, loaded after a process-local driver substitution. The ownership sidecar remains SQLite.
- `run.mjs` and `run-store.mjs`: bounded subprocess runners, 20 seconds per case.
- `snapshot.py`: consistent read-only source backup.
- `evidence/`: sanitized recorded results from the private snapshot.

The experimental adapter maps `query` to `prepare`, normalizes missing rows to `null`, and optionally replaces nested transactions with savepoints. It is deliberately inside the probe, not a runtime abstraction to maintain. It does not cache statements or implement Bun's full driver API. No migrations or integrity checks are bypassed to get the experiment running.

Pinned packages: `turso-stable` aliases `@tursodatabase/database@0.7.2`; `turso-preview` aliases `@tursodatabase/database@0.8.0-pre.12`. The lockfile pins their separate common/native dependencies, too.
