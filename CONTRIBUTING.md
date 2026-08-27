# Contributing

Pi Herdr Outliner is developed through live dogfooding. Changes must preserve canonical data, make incomplete results explicit, and prove behavior in the actual Tree or Detail surface.

## Setup

```sh
bun install
herdr plugin link --enabled .
bun run check
bun test
```

Open the live topology from a Herdr-managed pane:

```sh
herdr plugin action invoke open --plugin float.pi-outliner
```

Pi/OMP users can invoke `/outliner`; supported coding clients can use the project `/outline` command.

## Source boundaries

- `src/store.ts` owns persistence and canonical graph invariants.
- `src/server.ts` owns protocol dispatch, sequence, and subscriptions.
- `src/tree-controller.ts` / `src/tree-renderer.ts` own Tree behavior and presentation.
- `src/detail-controller.ts` plus `src/detail-*` own Detail behavior and presentation.
- `src/virtual-branches.ts` owns projection semantics.
- `pi-extension/index.ts` is a host adapter, not a second implementation of the service.

Reuse these seams. Do not add a second property parser, query path, local block cache, or independent persistence layer.

## Workboard lifecycle

The durable roadmap lives inside Pi Outliner. Roadmap items remain under the physical roadmap and appear in the workboard through virtual branches.

Every actionable item needs both:

- a domain lifecycle property such as `[status::planned]`, and
- an explicit board placement such as `[work-stage::next]`.

`status` does not imply `work-stage`.

Default flow:

```text
planned → [work-stage::next]
implementation starts → [work-stage::doing]
PR opens → [work-stage::review]
merge completes → [work-stage::done]
```

When starting work:

1. Move the roadmap item to Doing.
2. Record the branch on the canonical item.
3. Link implementation proof beneath that item.

When opening a PR, move it to Review and record the PR number. After merge, record the main commit, mark the item Complete/Done, update the proof, and update the current-status block.

After batch triage, verify both the `work-stage::next` query count and live `Next [V:N]` count. A correctly tagged canonical block should appear as one projected occurrence.

## Branches and commits

Use one focused branch per roadmap item:

```text
feature/<behavior>
fix/<bug>
docs/<topic>
```

Keep commits reviewable. Do not include runtime databases, sockets, logs, session exports, screenshots, or unrelated local command files.

Prefer clean cutovers: migrate every caller, test, and import, then remove obsolete code. Do not leave compatibility aliases unless an external consumer requires one.

## Correctness invariants

### Canonical service

- Only the service process opens SQLite.
- Tree, Detail, CLI, and agent tools are clients.
- Workspace root resolution must be identical across processes.
- Restarts reconstruct from service snapshots and events.

### Queries

- `blocks.query` always has a positive limit.
- Every bounded collection carries `complete` or `truncated` metadata.
- Never infer absence from a truncated collection.
- Projections must use a complete physical snapshot, not a collapse-pruned visible tree.

### Mutations

- Agent and long-form Detail updates use `expectedUpdatedAt` optimistic concurrency.
- Property patches change eligible textual tokens and rebuild the derived index.
- A projected occurrence always mutates its canonical block.
- Reject ambiguous projected hierarchy/order operations rather than guessing.

### Work IDs

- Configure one workspace prefix explicitly unless the v9 migration adopts one clean existing prefix.
- Allocate opted-in work through `work-ids.allocate` / `outliner_work_id`; never scan and guess the next number in a client.
- Keep UUID as canonical identity and Work ID as an immutable human/symbolic address.
- Preserve reservation owner UUIDs after purge; neither allocator nor manual canonical declarations may reuse them.
- Treat malformed, unpadded, duplicate-owner, and out-of-prefix legacy properties as inert metadata during migration rather than blocking startup.
- Preserve an existing valid legacy Work-ID address from another prefix only when its reservation still names the same canonical owner; do not create new bare links or allocations outside the configured prefix.

### Terminal safety

- Sanitize user- and file-controlled text before emitting terminal frames.
- Measure terminal display columns, not JavaScript string length.
- Preserve grapheme clusters when wrapping, moving, selecting, and deleting.
- Keep fixed frame height and cursor visibility across terminal resize.

## Verification

### Static and behavioral checks

Run the complete suite once after the implementation is stable:

```sh
bun run check
bun test
```

During development, focused tests are appropriate. Final proof must include the full suite.

Tests should defend observable contracts:

- canonical graph and cycle invariants,
- optimistic conflicts,
- query completeness,
- virtual occurrence behavior,
- terminal width/security,
- cursor/selection transitions, and
- restart reconstruction.

Avoid tests that merely inspect source text or implementation plumbing.

### Live smoke test

Changes to Tree, Detail, pane orchestration, or the service require a live Herdr smoke test.

For Detail-only feature work, restart Detail on the feature branch and exercise the changed path. Cancel any destructive editing smoke without saving.

For a merged change, restart all plugin panes in this order:

1. Detail
2. Tree
3. Service

Then invoke:

```sh
herdr plugin action invoke open --plugin float.pi-outliner
```

Read returned pane IDs from the plugin log. Wait for the service output `herdr_registry_ready`. Verify Tree and Detail against the merged main checkout.

Do not reuse remembered pane IDs after closing panes.

## Pull requests

A PR should state:

- the observable problem,
- the chosen behavior and invariants,
- preserved contracts,
- exact verification commands/results, and
- live pane proof when applicable.

Address actionable review comments with minimal fixes. Reply with the validating evidence and resolve the review thread. Re-run affected checks after the fix and wait for follow-up review before merging.

CodeRabbit’s generic docstring warning is advisory in this repository. Add comments only when they explain a non-obvious invariant; do not add weightless comments to satisfy a percentage.

## Protocol and schema changes

If request/response semantics change:

1. Update types and every client/server caller.
2. Increment `OUTLINER_PROTOCOL_VERSION` when old and new processes are incompatible.
3. Add round-trip protocol coverage.
4. Confirm the plugin waits for the matching service version.
5. Restart the complete topology.

If SQLite schema or property-parser behavior changes:

1. Make migration idempotent.
2. Preserve canonical text and timestamps unless the user actually edited the block.
3. Rebuild only derived indexes when possible.
4. Exercise existing-workspace startup, not only a fresh database.
5. Back up the live workspace database before manual migration experiments.

## Documentation

Update documentation when a change affects:

- installation or startup,
- keyboard controls,
- protocol/schema invariants,
- process boundaries,
- runtime paths, or
- shipped versus planned behavior.

Do not duplicate the full roadmap into Markdown. The workboard is canonical; repository docs describe durable architecture and workflow.

## Historical and future-port notes

- [`docs/OPENCODE_PORT.md`](docs/OPENCODE_PORT.md) is a port assessment, not the current implementation contract.
- [`docs/archive/misc-feedback.md`](docs/archive/misc-feedback.md) preserves early feedback; resolved roadmap state lives in the outliner.
