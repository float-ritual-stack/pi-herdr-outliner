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
context beside the invoking pane. None of them creates an outline: a folder
without a project `client.json` or database gets the **Choose outline** popup
(`src/choose-outline-main.ts`), and only its **New outline here** creates one. Tree and Detail
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
- `src/backlink-facets.ts` owns what a backlink source is (kind, stage, placement,
  comment resolution) as a data table; `src/backlink-view.ts` owns how clients
  hide, filter, group and order those sources.
- `src/transclusions.ts` owns fragment slices and transclusion projection
  (PIE-424): what `((id^fragment))` covers (`readFragment`, over
  `resolveFragmentSlice`), and how `!((…))` nests (depth, cycles, the
  per-document limit, the read budget) and what each failure is called.
  `fragments.read` and `transclusions.read` serve it; Detail's embeds use its
  limit and wording. A client asks rather than re-deriving slices.
- `src/reference-envelopes.ts` owns where a `((…))` ends: parentheses inside a
  label or title balance, so `((uuid|Label (x)))` and `((Title (x)))` close
  after `(x)`. `src/references.ts` parses with it, and envelope checks (links,
  hashtags, completion) use `blockReferenceEnvelopeRanges`. Resolved text is
  never re-parsed to find a reference: `linkOutlinerDocument` places each
  presented `((Title))` by the authored text around it.
- `src/fragment-search.ts` owns fragment completion across every note
  (`fragments.candidates`) and `fragments.ensure` writes a heading's anchor.
  Every client's `((note#…` / `((note^…` completion asks it (Detail, Tree,
  Quick Capture and ep0ch-door).
- `src/property-grammar.ts` owns the property token's grammar: what a property key
  is, what a `[key::value]` token matches, and the backslash escape. The parser
  (`properties.ts`), the query language (`block-query.ts`) and context resolution
  build on it; no other file restates the key rule. It imports nothing, because
  clients that find tokens while they paint copy it byte for byte (ep0ch-door's
  `src/vendor/property-grammar.ts`, checked by its tests). Bump
  `PROPERTY_GRAMMAR_VERSION` with any change to what it matches; `ping` reports it
  (`ping.propertyGrammar`). Where a token counts as a property (code, literal
  regions, scope) stays with `properties.preview`.
- `src/view-writes.ts` owns what a write into a saved view must change
  (`views.planWrite`): the property patch that moves a block into a view, or the
  properties, text or roadmap-item input a new block there is born with, and the
  reason when a patch can't satisfy the query. Clients (ep0ch-door's lanes,
  agents) ask it instead of porting the query language; `query.matches` answers
  which of given blocks a query holds for.
- `src/context-resolution.ts` owns context-scoped resolution ("the nearest key"
  for a line: the line, lines above, the block, ancestors). It is the first
  slice of PIE-408; resource projections and later soft links use it rather than
  resolving context themselves.
- `src/extension-records.ts` owns what an extension record is (wave A of the
  extension design, PIE-445): a remote record kept as ordinary blocks, its
  fields as namespaced block properties (`[jira.status::In Review]`), its
  comments as child blocks, and the refusal a person's or agent's write gets.
  The store owns the `extension_records` and `extension_askers` tables (one
  record block per key, under `extensionRecordHome`; dropped to Trash, never
  deleted, under `ext.<id>.drop-record`/`drop-comment`) and the guard in
  `writeBlockText` (only the owning extension writes an owned block,
  attributed `author: agent`, `actorId: ext:<id>`, and an unchanged text is not
  written). `src/extension-sync.ts` decides when: on save and open
  (`resources.projection.read` with `materialize`), on `resources.projection.refresh`,
  on any refresh (`ResourceCatalog.onRemoteEntityObserved`) and by the poll.
  `ResourceExtensionRuntime` runs one process per call for every extension
  operation, from the registry's folders before the legacy registry.
- `src/extension-manifest.ts` is the one parser of an extension folder
  (contract 2: `extension.json` and `config.json`) and its error wording; the
  registry, the runtime and `outliner ext add` read folders through it.
  `src/extension-registry.ts` owns which extensions an outline has: the outline
  and user folders, watched, rebuilt from scratch on each change (last good copy
  kept on a failure), handler keys bound, and `extensions.list` with the tile
  kinds the door's registry consumes. `src/extension-handlers.ts` is the one
  grammar of a handler line (`key:: argument --option`); `src/extension-calls.ts`
  runs data, output and component handlers by `effects`, keeps their results
  (the store's `extension_outputs`), answers their projections in the
  `resources.projection.read` slot, renders targets and runs actions (writes
  kept inside the block, attributed `ext:<id>`). `src/component-primitives.ts`
  owns the shared primitive catalogue and the render targets with their
  fallback chain; a client draws those primitives, never a component by name.
  `src/agent-requests.ts` owns `@name` request lines (PIE-501): which lines
  are requests, who wrote them (a person's run once quiet, an agent's wait for
  `r`), the `respond` call, and applying its patches through `draft.patch`
  (never its own write path); results show in the same projection slot.
  `src/extension-install.ts` is `outliner ext ls|add|remove|act`. The four kinds
  and their contracts: [docs/extensions/README.md](docs/extensions/README.md).
- `src/door-control.ts` is a client of ep0ch-door's control socket (the door's
  `docs/AGENT-INTERFACE.md`). The door owns what its actions do; the Claude mod's
  `show` only asks it for an agent's `open` when Claude runs in a door tile.
- `src/publish.ts` is the read-only publisher (`outliner publish serve`): a
  client that finds `[publish::…]` blocks with `blocks.query`, resolves `[[page]]`
  links with `pages.resolve`, reads attached `[file::…]` content with
  `files.read` and follows the content event feed as an observer. It never
  writes. `src/publish-attachments.ts` owns which attached files may be served
  (allowed roots, symlinks, `..`, hidden paths, file type and size); widen what
  is published there, not in the HTTP handler. `src/publish-artifacts.ts` owns
  how a claude.ai artifact runs: the pinned package set, the import guard and
  the `Bun.build` step for React (never running the artifact), the compiled
  bundle cache, and the React and mermaid pages; `src/publish-artifact-ui.jsx`
  is its shadcn/ui. Embeds on a published page are projected by the service's
  `transclusions.read` (its limits and cycle rules), never re-derived; the
  `[publish::never]` lock (`blockPublishIntent`) is checked for every page,
  embed and link.
- `pi-extension/index.ts` is a host adapter, not a second implementation of the service.
- `src/known-outlines.ts` owns whether a folder has an outline (`detectOutline`)
  and the read-only list of outlines on this machine (`listKnownOutlines`,
  reading each database's `outline.json`); the outline chooser, the launcher and
  `outliner outlines` use it. `writeClientConfig` in `src/paths.ts`
  is the one writer of a project `client.json`.
- `resolveFolderOutline` in `src/paths.ts` owns the folder rule (nearest bound
  folder, else repository name, else folder name, never `$HOME`, `/` or `/tmp`);
  `resolveClientPaths` uses it and the door mirrors it, rather than guessing names
  themselves. `resolveInvocationPaths` in `src/outline-host-client.ts` owns
  which outline a Herdr action invoked from a pane uses (the pane's registered
  outline first).
- `src/outline-names.ts` owns every write of an outline's identity: the
  descriptor, the `by-name/<name>.sock` link, `OUTLINER_OUTLINE` resolution for
  the service, and `outline rename|set-root`. A name addresses an outline; the
  hash directory is storage. Derive lists of outlines by scanning; never keep one.
- `src/outline-host.ts` owns the outline host: one listener for every outline
  in `<state root>/outlines/`, routing each connection by its first line's
  `outline` to that outline's `OutlinerServer`, and the host requests
  (`outlines.list|create|adopt`). `OutlinerServer` stays per outline and never
  learns about other outlines; `paths.ts` owns the host's layout
  (`outlineHostPaths`, `hostedOutlinePaths`). `src/outline-inbox.ts` starts an
  outline's Inbox agent for both the host and the single-outline service.
- `resolveClientPaths` in `src/paths.ts` is the one place a client decides its
  endpoint and outline (env, binding, folder guess); `src/outline-host-client.ts`
  is the client side of the host's own requests (`outlines.list|attach`). Every
  pane opener forwards `OUTLINER_OUTLINE`; a new one must too.
- `src/draft-patch.ts` owns `draft.patch` (PIE-501), compare-and-swap on a span
  of a note's text by an agent while the person may be typing: the two
  policies (`edit`, the default, is `droppedLinkedStructure` from
  `src/work-tools.ts`, the guard `outline_edit` has, and refuses as an error,
  never a proposal; `prose`, opt-in, keeps every `^anchor`, `[[page]]`,
  `((ref))` and `[key::value]` of its span and of the whole note, by the
  service's own parsers), the leases doors hold on their live drafts (`DraftHolds`:
  `drafts.hold|heartbeat|release`; a door that misses an answer's deadline
  keeps its hold, so nothing is written under its draft), and the proposal
  block a failed patch becomes (`proposalText`: one proposal however many
  changes it holds, embedded under the mark, its
  hidden `[draft-patch::…]` payload capped; `draft.proposal.apply` applies it
  anyway: forced for the person, the same compare as a patch for an agent,
  and only what the proposal's text shows).
  `src/draft-patch-router.ts` routes: a held note's patch goes to the holding
  door as a `draft` event (answered with `drafts.answer`, never queued behind
  the request waiting for it), any other is written under a revision check;
  several notes apply together or not at all. `src/draft-patch-compare.ts` is
  the compare itself (where the observed text is, what a position becomes). It
  imports nothing, because ep0ch-door runs it against its live draft from a
  byte-for-byte copy: bump `DRAFT_PATCH_COMPARE_VERSION` with any change (`ping`
  reports it). `outliner patch-demo` (`src/draft-patch-demo.ts`) is a proof
  agent for demos and tests, not the @-watcher.
- `src/work-tools.ts` owns agent workboard operations (create, stage/set, PR delivery
  and delivery keys, completion with proof across all of an item's deliveries,
  delivery stage, note sections, item bodies) over the existing RPCs. The CLI
  `work`/`note` commands, the Claude mod tools and Pi's task completion call it;
  add workboard operations there rather than in a host adapter or a one-off script.
- `src/agent-tools.ts` owns the other outline operations an agent makes (read with
  full text and bounded children, find, resolve, revision-checked edit, create,
  comment/reply/resolve as the agent, recent changes, `draft.patch`) over the
  existing RPCs. The CLI `agent` command runs them and the Claude mod's
  `outline_*` tools call that command; add an agent operation there, not in the mod.

Reuse these seams. Do not add a second property parser, context resolver, query path, authoritative block cache, or independent persistence layer. A bounded disposable Detail preview cache may retain service-owned revisions but never authorizes writes.

Before adding a feature, look for the renderer, component or action that already does it; every PR review checks this in its [architecture pass](#architecture-pass).

## Workboard lifecycle

### Connecting to the running service

Resolve the endpoint through `resolveClientPaths()` in `src/paths.ts`, so the
CLI and agent requests use the same project configuration and environment.
`bun src/cli.ts outlines` lists every outline in the state root by name, with
its status, root, by-name socket and storage directory (`--json` for agents).
While a service runs, `<state root>/by-name/<name>.sock` reaches it.
Remote clients connect to the configured SSH-forwarded socket; see
[remote client mode](README.md#remote-client-mode).

An agent sandbox can expose a socket file while a connection to its host
listener returns `ENOENT`. That error alone does not establish a service outage.
Check the resolved endpoint and socket, then repeat the same read-only `ping`
through the execution tool's approved host-access path. With Codex
`exec_command`, request `sandbox_permissions: "require_escalated"`; follow the
approval result. A successful host ping identifies an execution-boundary issue;
use that approved path for subsequent service requests.

If `OutlinerClient.requireCompatibleService()` reports an incompatible service,
the service is reachable but cannot serve this client: it is older than the
client's minimum protocol, it no longer serves the client's protocol, or it lacks
a capability the client is about to use. The error names which one; restart the
named side from the current checkout, then retry. This is recovery from a
confirmed incompatibility, not a connection probe.

Use the running service's CLI/RPC for workboard writes. If access remains
blocked, record the endpoint, execution context, and exact error. Service
restarts, socket removal, and writable database access are not connection probes.

If a Herdr launch fails, Outliner reports the cause with a Herdr notification
(when notification delivery is enabled) and retains the most recent failure in
`service-startup-error.log` or `open-startup-error.log` in the resolved workspace
state directory. Opening never creates that directory: when it does not exist
yet, `open-startup-error.log` goes to the state root (`OUTLINER_STATE_DIR`), or
only to stderr and the notification when the state root is missing too. These files include a timestamp; an old error is not evidence
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
- Human filter shorthand is positive-AND property presence/equality; the query grammar adds OR, NOT, grouping and created/updated ranges without changing any clause list's meaning. Quote spaced values and keep text/subtree/deletion/rank/limit as structured fields.
- Invalid query text is an error with a position, never an empty result.
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

### Architecture pass

Every review, by the author before opening the PR and by the reviewer, checks
that the change used the architecture before checking anything else:

- **Reuse:** it builds on the existing renderers, components and actions instead
  of a parallel implementation: PreviewRegions
  ([src/detail-preview-regions.ts](src/detail-preview-regions.ts)), the property
  inspector ([src/property-inspector.ts](src/property-inspector.ts)), reference
  completion ([src/reference-completion.ts](src/reference-completion.ts)), saved-view
  reads ([src/saved-view-read.ts](src/saved-view-read.ts), `views.read`) and the
  action list ([src/outliner-actions.ts](src/outliner-actions.ts)). See also
  [Source boundaries](#source-boundaries).
- **Boundary:** the service owns truth and meaning; clients own presentation. A
  client asks the service what a view contains, what a property means or what
  changed; it does not re-derive it.
- **Protocol:** an additive change is a capability, as in
  [Protocol and schema changes](#protocol-and-schema-changes).
- **Docs:** a new shared part is named in the docs (Source boundaries or
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)) so the next change finds it.

A parallel implementation needs a reason written in the PR.

Address actionable review comments with minimal fixes. Reply with the validating evidence and resolve the review thread. Re-run affected checks after the fix and wait for follow-up review before merging.

Before patching a finding, fetch and inspect the current remote head and any bot
patch already in flight. Assign one active writer for that finding; defer
overlapping automation where supported. If automation cannot be paused, reconcile
its result before another patch. After a remote change, verify the combined source
and update the PR's evidence and description to the exact revision being reviewed.

CodeRabbit’s generic docstring warning is advisory in this repository. Add comments only when they explain a non-obvious invariant; do not add weightless comments to satisfy a percentage.

## Protocol and schema changes

Clients and the service negotiate compatibility instead of requiring the same
number. `ping` returns the service's `protocolVersion`, its `minClientProtocol`,
and `capabilities`. [src/types.ts](src/types.ts) owns the source of truth:

- `OUTLINER_PROTOCOL_VERSION`: this checkout's protocol.
- `OUTLINER_MIN_SERVICE_PROTOCOL`: the oldest service its clients accept.
- `OUTLINER_MIN_CLIENT_PROTOCOL`: the oldest client its service serves.
- `OUTLINER_CAPABILITIES`: additive actions and request fields the service
  supports.

`checkServiceCompatibility` / `requireCapabilities` in
[src/service-compatibility.ts](src/service-compatibility.ts) apply the rule; a
newer service is accepted. The Herdr launcher and panes wait through
`waitForCompatibleService`.

For an additive change (a new action, or an optional request/response field):

1. Update types and every client/server caller.
2. Append a capability name to `OUTLINER_CAPABILITIES`, usually the action name
   or `action.field`. Do not bump the protocol.
3. Before a client uses it, call
   `client.requireCompatibleService(["<capability>"])` (or pass `needed` to
   `waitForCompatibleService`). Only the clients that use the feature check it.
4. An old service silently ignores an unknown optional request field. Either
   echo the field in the response so the client can detect that it was honored
   (as projected reads echo `fields`) or capability-gate it; never let an
   ignored field silently change the result's meaning.
5. Add round-trip coverage for a service with and without the capability.

For an incompatible change (changed meaning or removal), increment
`OUTLINER_PROTOCOL_VERSION` and raise the minimum that the change breaks:
`OUTLINER_MIN_SERVICE_PROTOCOL` when new clients cannot use an old service,
`OUTLINER_MIN_CLIENT_PROTOCOL` when the new service cannot serve old clients.
Add round-trip coverage, confirm the launcher rejects the old side, and restart
the complete topology.

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
