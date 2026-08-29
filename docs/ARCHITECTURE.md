# Architecture

Pi Herdr Outliner is a service-backed terminal application. SQLite and the block graph live in one canonical process; every UI and agent surface is a client.

## Process topology

```mermaid
flowchart LR
    Pi[Pi / OMP extension] -->|JSON-lines RPC| Service
    CLI[CLI] -->|JSON-lines RPC| Service
    Tree[Tree pane] -->|snapshot + events + commands| Service
    Detail[Detail pane] -->|snapshot + events + commands| Service
    Service[Outliner service] --> Store[(SQLite store)]
    Service --> Registry[Disposable Herdr runtime registry]
    Herdr[Herdr plugin action] --> Service
    Herdr --> Tree
    Herdr --> Detail
```

### Service

[`src/server-main.ts`](../src/server-main.ts) owns:

- one [`OutlinerStore`](../src/store.ts),
- one [`OutlinerServer`](../src/server.ts),
- the workspace Unix socket,
- an ephemeral browsing-context target registry,
- service-pane registration, and
- the optional Herdr runtime-registry runner.

The service is the only process that opens the workspace SQLite database. It logs the resolved socket and database paths after startup and handles orderly shutdown on `SIGINT`, `SIGTERM`, or `SIGHUP`.

### Tree client

[`src/outliner.ts`](../src/outliner.ts) is a standalone terminal process using:

- [`TreeController`](../src/tree-controller.ts) for behavior,
- [`renderTreeFrame`](../src/tree-renderer.ts) for ANSI rendering,
- [`virtual-branches.ts`](../src/virtual-branches.ts) for projections, and
- [`OutlinerClient.watch()`](../src/client.ts) for reactive updates.

Tree holds no canonical block state. It reconstructs canonical data from service snapshots and events, then owns its cursor, occurrence selection, filter, collapsed canonical IDs, multiline-expanded row IDs, viewport, explicit-navigation history, and browsing-context publication in-process. Closing a Tree discards only that Tree's presentation state.

Cursor changes publish the selected canonical block to exactly one browsing context. Only subscribers registered to that context receive the event. Global `selection` events are ignored by Tree panes; exact-client `focus` and `reveal` commands move only their addressed Tree and locally expand ancestors when required. The legacy saved workspace selection may seed a newly created Tree once, but it is not continuing pane authority.

PageUp/PageDown move the selected expanded row's offset by one Tree body viewport and clamp to its wrapped row count. Cursor changes, multiline expansion changes, and reconnects reset the offset.

### Detail client

[`src/detail-main.ts`](../src/detail-main.ts) selects the Pi TUI Detail implementation, which separates:

- [`DetailController`](../src/detail-controller.ts) — modes, effects, optimistic saves, completion, file/annotation behavior, and cursor visibility;
- [`detail-pi.ts`](../src/detail-pi.ts) — terminal lifecycle, input, and Pi layout switching;
- [`detail-pi-preview.ts`](../src/detail-pi-preview.ts) — Markdown `ScrollView` preview;
- [`detail-editor-layout.ts`](../src/detail-editor-layout.ts) — grapheme-safe wrapped visual rows, cursor mapping, and selection spans;
- [`detail-renderer.ts`](../src/detail-renderer.ts) — fixed custom frames for edit, comment, file, and annotation modes; and
- [`text-buffer.ts`](../src/text-buffer.ts) — raw text, grapheme/word movement, and selections.

The legacy ANSI Detail entrypoint remains available in [`src/detail.ts`](../src/detail.ts), but the Herdr manifest starts [`src/detail-main.ts`](../src/detail-main.ts).

Detail owns an exact target, a bounded in-process target history, and a visible
`Follow | Independent` connection mode. Follow subscribes to one browsing
context; Independent retains its exact target across unrelated context events.
Content events refresh the current exact block without changing that target.
History navigation and reference opening enter Independent mode. Closing Detail
discards only this ephemeral navigation state.

### Pi / OMP extension

[`pi-extension/index.ts`](../pi-extension/index.ts) is a host adapter. It:

- starts or locates the service,
- opens Herdr panes through the plugin action,
- exposes outliner tools and commands, and
- injects bounded selection context before agent turns.

Persistence, protocol, and rendering do not depend on the agent process surviving.

## Workspace identity and runtime paths

[`resolvePaths()`](../src/paths.ts) resolves a workspace root from `OUTLINER_WORKSPACE_ROOT` or `process.cwd()`. The first 12 hexadecimal characters of its SHA-256 hash identify a workspace state directory:

```text
${OUTLINER_STATE_DIR:-~/.local/state/pi-herdr-outliner}/<workspace-hash>/
```

The directory contains the SQLite database, Unix socket, and remembered
**service-pane** metadata. Every process must resolve the same workspace root;
Herdr pane commands explicitly pass the invoking pane's foreground working
directory to new plugin panes.

A workspace root scopes canonical data, not browsing authority. Tree/Detail
client identity, browsing-context identity, targets, histories, tab numbers,
labels, and pane titles are not stored in role-keyed files or canonical tables.

## Canonical data model

The SQLite schema is created in [`OutlinerStore.migrate()`](../src/store.ts):

### `blocks`

| Column | Meaning |
| --- | --- |
| `id` | Stable UUID primary key |
| `parent_id` | Canonical parent; cascading delete |
| `position` | Sibling order beneath the parent |
| `text` | Canonical raw block text |
| `author` | `user`, `agent`, or `system` |
| `actor_id`, `session_id`, `task_id` | Optional immutable creator provenance for agent-authored blocks |
| `deleted_at` | Direct tombstone timestamp; null for blocks not independently deleted |
| `effective_deleted_root_id` | Materialized nearest direct deleted ancestor, including self |
| `created_at`, `updated_at` | Version and audit timestamps |

### `block_properties`

Derived index of eligible `[key::value]` tokens. `(block_id, key, ordinal)` preserves repeated keys and text order. `(key, value)` is indexed for queries.

Canonical text is authoritative. Property updates patch text with optimistic concurrency, then re-index it. The parser version is persisted in `metadata`; a newer parser can rebuild the derived index without changing canonical block timestamps.

Literal property-looking text inside inline code, fenced code, or escaped syntax is not indexed.

### Other tables

- `metadata` — service sequence, parser version, and legacy navigation cursor.
- `selection` — legacy workspace selection used by CLI/agent context and as an optional one-time seed for a new Tree; never live pane authority.
- `navigation_history` — legacy workspace-selection history for compatibility clients; Tree and Detail panes maintain independent in-process histories.
- `virtual_occurrence_ranks` — durable `(virtual-branch ID, canonical block ID) -> branch-local rank`; both foreign keys cascade on deletion.
- `page_addresses` — unique normalized symbolic address to canonical block mapping for page declarations, Work IDs, and explicit aliases; foreign keys cascade only on physical purge.
- `reserved_work_ids` — immutable Work-ID reservation ledger with the original canonical owner UUID retained after purge.
- `work_id_allocator` — singleton workspace prefix and next monotonic sequence number.

## Protocol

The current protocol version is `14`, defined in [`src/types.ts`](../src/types.ts). Requests and responses are newline-delimited JSON over the workspace Unix socket.

### Important request families

- health: `ping`
- canonical reads: `get`, `children`, `blocks.context`, `workspace.snapshot`
- bounded search: `blocks.query`
- browsing contexts: `browsing-context.get`, `browsing-context.publish`
- selection-neutral capture: `capture.create`
- mutations: `create`, `update`, `move`, `delete` (move to Trash), `trash.restore`, `trash.purge`
- properties: `properties.patch`, `properties.catalog`
- virtual ordering: `virtual.occurrences.reorder`
- references: `references.resolve`
- symbolic addresses: `pages.resolve`, `pages.follow`, `pages.complete`, `pages.rename`, `pages.alias`, `pages.remove`
- Work IDs: `work-ids.status`, `work-ids.configure`, `work-ids.allocate`
- legacy workspace selection/history: `selection.get`, `selection.set`, `navigation.state`, `navigation.back`, `navigation.forward`
- reactive clients: `events.subscribe`, `clients.list`
- exact-client behavior: `ui.command.send`

### Live client identity

Each Tree and Detail process generates a fresh client UUID and registers
`{ clientId, role, contextId, runtime? }` on `events.subscribe`. `open-here`
generates one context UUID and passes it to the Tree and Detail it creates.
Standalone processes use their client UUID as a private context.

Runtime pane, terminal, workspace, and tab fields are advisory topology
snapshots. Opaque live IDs may be routing inputs; tab numbers, labels such as
`oi`, and pane titles are mutable display metadata and are never routing keys.
Herdr remains authoritative for current placement and focus.

The subscription socket owns its registration. The service rejects duplicate
live client IDs and removes exactly that socket's entry on disconnect. When the
last subscriber for a browsing context disconnects, its target is pruned.
`clients.list` returns the live registry, optionally filtered by role.

`content`, legacy `selection`, and `view` events are workspace broadcasts.
`browsing-context` events are written only to registrations with the matching
`contextId`. A `ui` command is written only to its `targetClientId`. Pair-local
handoffs first resolve a client with the requested role inside the source
context; role-global uniqueness is not used for paired Tree/Detail behavior.
Tree and Detail recover their current pane through Herdr when focusing instead
of treating registration snapshots as durable pane handles.

### Agent provenance

`author` remains the coarse `user | agent | system` role used by renderers and existing clients. Agent creation requests may additionally carry `{ actorId, sessionId?, taskId? }`; the service accepts that provenance only with `author: "agent"`, stores it on the new block, and never rewrites it during later content updates.

The Pi/OMP adapter forces `author: "agent"`. It identifies the host as `pi` or `omp`, reads the durable session ID from Pi's `ExtensionContext.sessionManager`, and records the tool-call ID as the originating task ID. Legacy and user-authored blocks omit these optional fields.

### Clickable outliner identities

Herdr recognizes plain terminal text as a URL only for `http://` and `https://`. Outliner renderers therefore generate trusted OSC 8 hyperlinks with private URIs instead of expecting link-handler regexes to scan arbitrary text:

- `pi-outliner://block/<uuid>` — exact canonical block;
- `pi-outliner://goto/<encoded-query>` — shared fuzzy goto resolution;
- `pi-outliner://work/<PIE-NNN>` — resolve-only Work-ID registry lookup;
- `pi-outliner://page/<encoded-address>` — unique symbolic page resolution and explicit create-on-follow.

Inside the live panes, navigation stays in-process. Tree enables SGR mouse reporting, keeps the last rendered frame, resolves an unmodified primary click against that frame's OSC 8 cell metadata, and delegates to `navigateOutlinerLink`. Detail supplies the same helper as Pi TUI's `openUrl` callback. Exact block and resolved symbolic links select one canonical UUID directly, so deleted targets cannot degrade into fuzzy text matches. Deleted targets open read-only in Detail; active targets send exact Tree focus/reveal.

Authored text is sanitized before link generation. Tree adds OSC 8 only after plain-text wrapping/truncation; Detail generates safe Markdown links after sanitization. Under `HERDR_ENV=1`, Detail enables Pi TUI hyperlink emission because nested panes advertise generic `TERM=xterm-256color` even though Herdr captures OSC 8 metadata. Tree ignores modified, release, motion, and wheel reports for link activation; Shift remains available for terminal-native selection.

The `outliner-navigation` manifest handler and `src/herdr-link-open.ts` remain the external/interoperability path for rendered output outside the active TUI. They validate/decode the private URI, resolve the clicked pane workspace, and enter the same shared navigation helper. `[[address]]` remains visible when dangling; the explicit follow action creates exactly one root stub through the transactional registry path.


### macOS native URL bridge

Real Ghostty/Warp/xterm-based clients do not reliably deliver Herdr's documented Control-modified left click: macOS may translate it to secondary click, while Command-click is consumed by the local terminal and sent to LaunchServices. `macos/pi-outliner-link` is an optional local app bundle for that boundary.

The app registers `pi-outliner://`, accepts exact block, fuzzy goto, symbolic page, and resolve-only Work-ID routes, rejects terminal controls and URL decorations, reads a local host/workspace/Bun configuration, and invokes `/usr/bin/ssh` in batch mode. The installer stores the selected configuration path in bundle metadata because apps opened by LaunchServices do not inherit the installer's shell environment. The remote command forwards the validated private URL through `src/cli.ts link --url`, so registry resolution, canonical selection, and Tree reveal remain server-owned. Host and paths are validated and shell-quoted; authored URL content never becomes an unchecked remote command.

The default bridge targets `evan@float-box:/home/evan/test`, which resolves over Tailscale MagicDNS without exposing a public service. Warp activates it with Command-click; Ghostty uses Shift-Command-click to bypass mouse capture. This bridge is an immediate per-device workaround, not a replacement for the requested opt-in plain-click Herdr plugin-handler mode tracked upstream.

Every response carries the service sequence. Every mutation increments it and emits an event.

### Complete versus bounded collections

`blocks.query` requires a positive limit and returns:

```ts
interface VisibleBlockCollection {
  blocks: VisibleBlock[];
  completeness:
    | { kind: "complete" }
    | { kind: "truncated"; limit: number };
}
```

Clients must never infer absence from a truncated collection. Workspace snapshots carry separate visible and complete physical collections so projections are not derived from a collapse-pruned tree.

### Normalized block queries

`BlockSearchQuery` is the sole semantic query model:

```ts
interface BlockSearchQuery {
  filters?: Array<{ key: string; value?: string }>;
  text?: string;
  subtreeRootId?: string;
  rankViewId?: string;
  includeDeleted?: "roots" | "all";
  limit: number;
}
```

The service normalizes every query before regular graph traversal or ranked virtual-branch SQL. It validates limits from 1 through 1000 without clamping, lowercases property keys, preserves exact interior value spaces, distinguishes presence from equality, removes exact duplicate clauses, validates subtree roots, and translates the reserved `deleted=true` compatibility filter into explicit deleted-root mode.

Human text surfaces share one minimal property-filter parser: whitespace-separated positive-AND clauses, `key` presence, `key=value`/`key::value` equality, and double-quoted spaced values with `\\` and `\"` escapes. Tree and Pi commands use the expression parser; each repeated CLI `--filter` is parsed as one clause so a shell-quoted value containing spaces remains exact. Virtual branches persist the canonical expression in `[query::…]`. Agent tools remain structured and bypass the shorthand.

`workspace.snapshot.view.query` uses the same model for bounded Tree filtering while retaining a separate complete physical collection for canonical ancestry and projection construction. `rankViewId` is internal projection context and is rejected from snapshot queries.

### Idempotent capture

`capture.create` accepts an explicit request ID, text, source surface, optional captured-from block UUID, and ordinary author/provenance. The store resolves exactly one active `[system-view::inbox]`, creates one canonical child, and returns:

```ts
interface CaptureReceipt {
  block: Block;
  inboxBlockId: string;
  deduplicated: boolean;
}
```

`capture_requests` persists request ID → block/Inbox receipts without a foreign-key cascade. A retry returns the original block with `deduplicated: true`, including after reconnect/service restart, and emits no second content event. A purged receipt target fails explicitly rather than creating a duplicate.

Capture text remains ordinary editable/movable content. The service appends indexed lifecycle/context properties (`type=capture`, `status=unprocessed`, source, timestamp, optional captured-from UUID) and stores immutable agent provenance through the existing block fields. The mutation never calls selection or navigation operations.


Capture adapters remain clients. CLI text/stdin/heredoc, Pi/OMP `/capture`, `outliner_capture`, and standalone `float.dispatch(…)` interception all send one `capture.create` request and return the same compact receipt. Adapter differences are limited to source, author/provenance, optional captured-from context, and request-ID generation.

The input hook intercepts only a complete standalone marker while idle and without images. It uses a balanced parenthesis/quote parser with no `eval` or shell interpretation. Embedded markers continue to the agent unchanged. A valid exact marker is handled without an LLM turn only after durable service confirmation; service failure reports the error and returns `continue` so the original input is preserved.
Store startup creates one canonical `Inbox [type::inbox] [system-view::inbox]` when absent and rejects multiple active Inbox markers. The block may move or be renamed; the marker/UUID remains the destination identity.

## Reactive flow

1. A client obtains a workspace snapshot or exact block context.
2. It registers a fresh process identity, role, and browsing-context identity.
3. Tree publishes its local cursor to that browsing context.
4. The service delivers that event only to clients in the same context.
5. Canonical mutations broadcast `content` events to every client under the
   workspace root; receiving content refreshes data but never transfers browsing
   authority.
6. Exact `ui` commands are delivered only to their target client.
7. On service reconnect, Tree republishes its retained cursor. A restarted
   process receives a new client identity; `open-here` creates a new pair
   context.

While Detail is editing/commenting, content, context, and exact-target refreshes
are marked pending instead of replacing the active raw buffer. An exact UI
target is retained and applied after save/cancel. Save uses `expectedUpdatedAt`;
conflicts preserve the buffer and surface the error.

Tree and Detail navigation histories are process-local and bounded to 200 exact
targets. Detail history navigation enters Independent mode, preventing the next
paired Tree event from replacing the historical target. Soft-deleted targets
remain exact and read-only; purged targets surface as unavailable. Legacy
service-owned `selection` history remains only for CLI/agent compatibility.

## Properties and references

Properties are Roam-style textual metadata:

```text
Question [type::question] [status::open]
```

Query filters compare indexed keys and optional exact values. Property patches address token ordinals so an agent can replace/remove/append metadata without rewriting unrelated prose.

Exact references use `((block-id))`. Read paths replace a resolvable ID with the target’s first non-property content line. Edit paths retain the raw ID. Dangling exact references remain unchanged.

Symbolic references use `[[address]]`. The registry compares trimmed, Unicode-normalized, caseless, whitespace-collapsed keys while preserving the authored address label. One `[page::address]` declaration registers a page; `[work-id::PIE-NNN]` registers the same canonical block under its Work ID. Bare Work IDs navigate through a resolve-only registry path rather than fuzzy goto, and unresolved Work-ID-shaped addresses cannot create page stubs. Parsing and ordinary saves never create a referenced block. `pages.follow` transactionally resolves or creates one ordinary root stub. General edits cannot silently change or remove a registered declaration: `pages.rename` uses optimistic concurrency, changes the primary declaration, and retains the former address as an alias; `pages.alias` adds another explicit address; `pages.remove` explicitly unregisters an alias or primary declaration. Registry rebuilds preserve aliases.

Work-ID allocation is workspace-scoped and transactional. A one-time v9 migration adopts a clean existing reservation prefix; an empty or ambiguous legacy workspace requires explicit `work-ids.configure`, and later manual values never auto-configure on restart. Prefix configuration can be corrected until the chosen prefix owns an immutable reservation. The allocator tracks the next number monotonically and formats a minimum three-digit suffix. Allocation uses optimistic block concurrency, appends canonical text, rebuilds the property/address indexes, and reserves the ID with its owning UUID in one transaction. Canonical manual declarations for the configured prefix pass through the same ownership, sequence, and never-reuse enforcement. Malformed, noncanonical, duplicate legacy, and out-of-prefix values remain indexed inert metadata rather than blocking startup or text saves. Existing valid legacy Work-ID addresses for other prefixes are retained, but bare Work-ID linking and new allocation are scoped to the configured prefix.

The initial registry migration backfills active declarations only. Pre-PIE-132 Trash content can contain indexed property-shaped examples and copied Work IDs that never established symbolic identity; importing those would either create false addresses or block startup. Registry rebuilds retain addresses already owned by deleted blocks. Restoring a legacy Trash subtree registers newly active declarations only when they are unambiguous and unclaimed. Legacy registration is block-atomic: one ambiguous declaration suppresses every address on that block until repair. The block still restores as ordinary editable content and can register through a subsequent valid edit. Reservation migration and allocator reconciliation leave malformed, duplicate-owner, and foreign-prefix legacy Work-ID values as inert indexed metadata instead of failing workspace startup.

## Recoverable deletion and Trash

Deletion changes canonical block state, not canonical location. `parent_id`, `position`, UUID, text, properties, descendants, and branch-local ranks remain intact. A direct deletion sets `deleted_at`; `effective_deleted_root_id` materializes the nearest direct deleted ancestor for every block. The service recomputes that field transactionally on delete/restore/purge and backfills it in the same transaction that introduces the column during migration. This deliberately pays bounded descendant/all-row writes on rare Trash mutations so every common read can exclude deleted content with one indexed scalar check instead of an ancestry walk or recursive CTE.

Canonical deletion does not choose a replacement selection or write navigation history. The initiating Tree selects a projection-local fallback before issuing delete: the visual successor after removing every affected canonical/owned projection row, otherwise the previous surviving row. It publishes that canonical selection first, then deletes and reloads by the fallback's exact row identity. For external content events that make the current row vanish, Tree reconciles at the same visual position and republishes the resulting selection; it never jumps to a physical, Trash, or unrelated branch occurrence merely because it shares the vanished row's canonical ID. This visual fallback is intentional even when a property edit merely removes an occurrence while its canonical block remains active. A headless delete leaves workspace selection on the resolvable tombstone until a Tree or another client explicitly selects a new target.

Normal traversal, workspace snapshots, bounded/ranked queries, property catalogs, completions, goto candidates, and virtual branches centrally require `effective_deleted_root_id IS NULL`. Exact `get` remains identity-aware and can inspect a tombstone. Mutation APIs reject effectively deleted blocks except explicit Trash operations.

The store ensures one ordinary canonical system view:

```text
Trash [type::virtual-branch] [system-view::trash] [query::deleted=true]
```

The special `deleted=true` query returns direct deletion roots only. It is read-only because it has no create configuration. Root rows include an effective descendant count; Detail previews deleted selection read-only. `r` clears only the selected root's direct marker, so independently deleted descendants stay deleted. `p` requires the exact work ID or eight-character block prefix before physical purge.

References resolve to three states. Active targets render normally; effectively deleted targets retain their title with a Trash marker and deletion-root identity; purged/missing targets remain dangling. Following an exact deleted block link selects it for read-only Detail inspection rather than silently failing or restoring it.

Symbolic addresses use the same lifecycle distinction. Soft deletion retains the registry row and resolves to the read-only tombstone. Purge cascades registry rows, so the former address becomes genuinely missing and may create a new stub only on a later explicit follow.

Permanent purge is manual and irreversible. It physically deletes the canonical subtree through existing foreign-key cascades. Before deletion, every subtree Work ID is confirmed in `reserved_work_ids`; the ledger retains its original canonical owner UUID, so neither the allocator nor later manual declarations can reuse a deleted or purged identifier.

## Virtual branches

A virtual branch is an ordinary canonical block with exactly one `[type::virtual-branch]` token and exactly one `[query::…]` token.

Optional properties:

- `[limit::N]` — bounded query size, from 1 through 1000.
- `[create::key=value]` — one property applied to new canonical children.
- `[create-parent::<block-id>]` — physical parent for branch-created blocks.

Tree queries the service and inserts disposable occurrence rows. Each occurrence carries:

- `rowId` — occurrence identity,
- `canonicalId` — mutation target,
- `viewId` — virtual branch definition, and
- canonical `Block` data.

Occurrences do not have hierarchy. Tree allows canonical edit/reveal and explicit canonical deletion, rejects projected indent, outdent, and collapse, and maps `Shift+Up` / `Shift+Down` to branch-local reorder.

`workspace.snapshot` carries every persisted occurrence rank in the same transactional read as the block graph. Tree supplies the branch `viewId` on its bounded match query; storage orders matching ranked blocks first, then deterministic unranked results, and returns only the configured window plus overflow detection. Projection reapplies the snapshot ranks defensively before the branch limit. Reorder ranks the complete currently projected sibling sequence without changing canonical parents/positions or another branch. Rank rows survive temporary query mismatches and cascade when either the branch definition or canonical block is deleted.

## Detail rendering and editing invariants

### Preview

- Complete resolved block text is passed to Pi Markdown.
- Header and footer remain fixed while the primary `ScrollView` scrolls.
- Raw source and Markdown renders are cached when unchanged.
- Selection changes and transitions into preview reset scroll to the top.

### Editor

- `TextBuffer.text` is raw canonical text.
- Physical lines wrap into visual rows without inserting newlines.
- Wrapping and cursor movement respect Unicode grapheme clusters and terminal display width.
- One software-cursor cell is reserved so frames never overflow.
- Selection is normalized between an anchor and active cursor, may span physical lines, and renders in reverse video across wrapped rows.
- Typing/newline replaces a selection; Backspace/Delete removes it.
- The controller keeps the active visual cursor row inside the editor viewport, including completion-height and terminal-size changes.
- Completion replaces raw line ranges and does not resolve block references into saved text.
- Ctrl+S uses optimistic concurrency. Esc discards the complete edit session.

Editor undo/redo stores at most 100 per-session snapshots. Consecutive typing, backspace, and forward delete coalesce; cursor and selection state restore with text; divergent edits invalidate redo. New edit/comment sessions start with empty history. Modal editing, registers, macros, and programmable operator systems remain explicit non-goals for the custom buffer.

## File annotations

A block containing `[file::path]` can open a workspace-relative text or Markdown file. Detail supports line navigation and range selection. A comment creates a canonical child annotation containing source path, normalized line range, source block ID, and comment text.

The service stores annotation blocks; it does not modify source files.

## Herdr lifecycle

[`src/herdr-open.ts`](../src/herdr-open.ts) enforces service-first startup:

1. Reuse or open the service pane in a tab.
2. Wait for a compatible protocol response.
3. For `open-here`, generate a browsing-context UUID.
4. Open Tree beside the invoking pane with that UUID.
5. Open Detail beneath Tree with the same UUID.
6. Focus Tree.

Each `open-here` invocation creates a new pair even under the same workspace
root. Closing both clients prunes the context. Renaming or renumbering tabs and
panes has no effect because labels are not identity. Pane IDs are read from
Herdr responses and never predicted.

After deploying a merged change, restart Detail, Tree, and service in that order, invoke the plugin action, wait for `herdr_registry_ready`, and exercise the changed surface.

## Repository map

```text
src/store.ts                  SQLite block graph, property index, and symbolic-address registry
src/page-addresses.ts         symbolic-address validation, normalization, and syntax scanning
src/work-ids.ts              Work-ID prefix validation, parsing, and formatting
src/server.ts                 protocol and subscriptions
src/client.ts                 request/watch client
src/server-main.ts            canonical service process
src/outliner.ts               Tree terminal process
src/tree-controller.ts        Tree behavior
src/tree-renderer.ts          Tree ANSI rendering
src/virtual-branches.ts       projection configuration and rows
src/detail-main.ts            Detail implementation selector
src/outliner-links.ts          private URI codec and safe Tree/Markdown link generation
src/herdr-link-open.ts         Herdr link-handler action using shared goto/reveal
src/detail-controller.ts      Detail behavior and effects
src/detail-pi*.ts             Pi TUI preview/input/frame integration
src/detail-editor-layout.ts   wrapped visual rows and selections
src/text-buffer.ts            raw editor state
src/herdr-open.ts             plugin pane orchestration
src/herdr-registry.ts         disposable runtime metadata
pi-extension/index.ts         Pi/OMP commands, tools, context hook
```

## Accepted designs not yet implemented

The durable roadmap lives in the outliner workboard. Current accepted designs include normalized bounded query construction, deterministic agent work-placeholder resolution, backlinks, scoped property semantics, origin-aware link routing, projected canonical descendants, and projected-child creation.

Do not describe these as shipped behavior until their roadmap items are Complete on main.
