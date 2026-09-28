# Contributing

Pi Herdr Outliner is developed through live dogfooding. Changes must preserve canonical data, make incomplete results explicit, and prove behavior in the actual Tree or Detail surface.

## Setup

```sh
bun install --frozen-lockfile
herdr plugin link . --enabled
bun run check
bun test
```

`herdr plugin link` does not execute manifest `[[build]]` commands. Install
dependencies in the checkout first. Plugin pane entrypoints execute from the
linked plugin root; pass the target project through `OUTLINER_WORKSPACE_ROOT`
rather than overriding `herdr plugin pane open --cwd`.
Outliner terminals report that project through OSC 7 so Herdr's global actions
resolve its connection. This terminal metadata does not change the process cwd
or the base used by relative configuration paths.

Open the live topology from a Herdr-managed pane:

```sh
herdr plugin action invoke open --plugin float.pi-outliner
```

The manifest also ships:

```sh
herdr plugin action invoke ensure-detail --plugin float.pi-outliner
herdr plugin action invoke open-here --plugin float.pi-outliner
```

`ensure-detail` focuses or creates a Detail for the Tree selected from the
invoking pane/tab. `open-here` always creates a new linked Tree/Detail browsing
context beside the invoking pane. Tree and Detail
`Option+Shift+Right` / `Option+Shift+Down` create ordinary independent right/down Details.
All pane identities come from live Herdr topology rather than labels or
remembered pane IDs.

Pi/OMP users can invoke `/outliner`; supported coding clients can use the project `/outline` command.

## Source boundaries

The pinned Pi TUI patch in `patches/` supplies rendered lines and exact normalized
selection ranges to `copySelection`. Its third argument identifies the originating
ScrollView, the exact layout output and a snapshot of its lines. Reader copy uses
that identity to select from the corresponding immutable document frame; copied
text is never searched to reconstruct source positions. Other surfaces retain
ordinary rendered copying. Install through Bun with the lockfile so the patch is
applied. When upgrading Pi, retain or replace this hook, run `reader-copy.test.ts`
and the document-folding application journey. Plain-text copying cannot establish
source evidence or distinguish authored glyphs from controls.

- `src/store.ts` owns persistence and canonical graph invariants.
- `src/server.ts` owns protocol dispatch, sequence, and subscriptions.
- `src/tree-controller.ts` / `src/tree-renderer.ts` own Tree behavior and presentation.
- `src/detail-controller.ts` plus `src/detail-*` own Detail behavior and presentation.
- `src/virtual-branches.ts` owns projection semantics.
- `pi-extension/index.ts` is a host adapter, not a second implementation of the service.

Reuse these seams. Do not add a second property parser, query path, authoritative block cache, or independent persistence layer. A bounded disposable Detail preview cache may retain service-owned revisions but never authorizes writes.

## Workboard lifecycle

### Connecting to the running service

Resolve the endpoint through `resolveClientPaths()` in `src/paths.ts`, so the
CLI and agent requests use the same project configuration and environment.
Remote clients connect to the configured SSH-forwarded socket; see
[remote client mode](README.md#remote-client-mode).

An agent sandbox can expose a socket file while a connection to its host
listener returns `ENOENT`. That error alone does not establish a service outage.
Check the resolved endpoint and socket, then repeat the same read-only `ping`
through the execution tool's approved host-access path. With Codex
`exec_command`, request `sandbox_permissions: "require_escalated"`; follow the
approval result. A successful host ping identifies an execution-boundary issue;
use that approved path for subsequent service requests.

If `OutlinerClient.requireCompatibleService()` reports an incompatible
`protocolVersion`, the service is reachable but its protocol differs from the
client's. Restart the service and all clients together on the same version,
then retry. This is recovery from a confirmed protocol mismatch, not a
connection probe.

Use the running service's CLI/RPC for workboard writes. If access remains
blocked, record the endpoint, execution context, and exact error. Service
restarts, socket removal, and writable database access are not connection probes.

If a Herdr launch fails, Outliner reports the cause with a Herdr notification
(when notification delivery is enabled) and retains the most recent failure in
`service-startup-error.log` or `open-startup-error.log` in the resolved workspace
state directory. These files include a timestamp; an old error is not evidence
that the current process failed. Action output is also available through
`herdr plugin log list --plugin float.pi-outliner --limit 3`.

Bookmarks query, limit and summary columns are editable view preferences.
They do not change bookmark ownership and must not prevent service startup.

### Task status

Before planning, changing roadmap state or reporting delivery, read the live
**How this workboard works** block `d5b3e557-a166-4c50-baad-7a0ed8db8fe6` through
the configured Outliner service. It owns the working flow and scope decisions.
The [roadmap operations reference](pi-extension/skills/outliner-workflow/references/roadmap-items.md)
documents creation, batch membership, lifecycle transitions, ranking and migration.
Keep current task status and verification evidence on the canonical work item.

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

- Only the service process opens writable SQLite. E2E oracles may use read-only connections for assertions and consistent backups.
- Tree, Detail, CLI, and agent tools are clients.
- Workspace root resolution must be identical across processes.
- Restarts reconstruct from service snapshots and events.

### Queries

- `blocks.query` always has an integer limit from 1 through 1000.
- Every bounded collection carries `complete` or `truncated` metadata.
- Never infer absence from a truncated collection.
- Human filter shorthand is positive-AND property presence/equality only; quote spaced values and keep text/subtree/deletion/rank/limit as structured fields.
- Tree, virtual branches, CLI, Pi commands, and agent tools must converge on the same normalized `BlockSearchQuery`.
- Projections must use a complete physical snapshot, not a collapse-pruned visible tree.

### Capture

- `capture.create` is idempotent by explicit request ID across retries and restarts.
- Capture creates ordinary canonical content under exactly one active `[system-view::inbox]`.
- Capture must not mutate workspace selection or navigation history.
- Replayed captures return the original receipt and emit no duplicate content event.
- Empty/invalid/ambiguous capture requests fail without partial content.
- Every adapter must call `capture.create`; never open SQLite or create an adapter-specific Inbox.
- CLI heredoc/stdin payloads and dispatch markers are literal data, never shell/eval input.
- Exact standalone dispatch may bypass the agent only after durable capture confirmation; embedded markers remain ordinary conversation.

### Mutations

- Every normal block text writer requires the positive integer `expectedRevision` from its original read. Text changes advance `Block.revision`; timestamps and sibling moves do not authorize or invalidate an edit.
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

Verify integrated main in a fresh private fixture after merge. For an authorized
batch, group shared-session deployment into one coordinated cutover unless an
urgent field repair requires an earlier one. At that cutover, restart all plugin
panes in this order:

1. Detail
2. Tree
3. Service

Then invoke:

```sh
herdr plugin action invoke open --plugin float.pi-outliner
```

Read returned pane IDs from the plugin log. Wait for the service output `herdr_registry_ready`. Verify Tree and Detail against the merged main checkout.

Do not reuse remembered pane IDs after closing panes.

### User-workflow walkthrough

For interaction changes, exercise a short ordinary-work journey after the
mechanical checks. Start from the user's relevant layout and record:

1. **Discover:** can the visible control/menu explain how to begin?
2. **Understand:** can the user identify focus, Current/Preview, the target and
   destination without knowing registry IDs or launch history?
3. **Act:** use both pointer and keyboard paths for the changed operation. Verify
   the same target and application action, including focus and scroll following.
4. **Recover:** cancel, retry or return; preserve the draft, selection and browsing
   position that the operation promises to retain. For asynchronous work, exercise
   a newer intent arriving before the older operation completes.
5. **Change context:** repeat the relevant part after resize, reopen or a different
   pane arrangement. Inspect final geometry and visible state, not clipped text
   or remembered coordinates.

Keep the journey bounded to the change. Retain initial, action, recovery and final
frames with semantic target/state assertions. Treat confusion as evidence about
the interaction model; record any resulting follow-up rather than attributing it
to the user. Reuse a shared action or reader when a second concrete caller exposes
duplication; larger architectural work belongs in a separately scoped item.

Label input coverage precisely: injected terminal keys, attached-terminal input,
and physical host keyboard delivery prove different portions of the path. A
successful injected Alt chord does not establish macOS/terminal/SSH delivery.
Record owner-device verification as pending when it has not been exercised.

### Delivery claims

Report implemented, exercised (with the actual journey), merged, deployed and
owner-accepted separately. Lead with what the user can now do and remaining
limits; test counts support that claim. A private merged-main run is not evidence
that the shared session or another device runs that version. Apply task transitions
through the live workboard guide referenced by AGENTS.md; link new ideas separately
from the scope whose acceptance is being recorded.
Keep exact source revisions, protocol, artifacts and untested paths in the proof.

## Pull requests

A PR should state:

- the observable problem,
- the chosen behavior and invariants,
- preserved contracts,
- exact verification commands/results, and
- live pane proof when applicable.

Address actionable review comments with minimal fixes. Reply with the validating evidence and resolve the review thread. Re-run affected checks after the fix and wait for follow-up review before merging.

Before patching a finding, fetch and inspect the current remote head and any bot
patch already in flight. Assign one active writer for that finding; defer
overlapping automation where supported. If automation cannot be paused, reconcile
its result before another patch. After a remote change, verify the combined source
and update the PR's evidence and description to the exact revision being reviewed.

CodeRabbit’s generic docstring warning is advisory in this repository. Add comments only when they explain a non-obvious invariant; do not add weightless comments to satisfy a percentage.

## Protocol and schema changes

The current wire protocol is `OUTLINER_PROTOCOL_VERSION` in [src/types.ts](src/types.ts).

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
