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
    Service --> Registry[Ephemeral live Herdr runtime registry]
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
- the live Herdr runtime-registry runner when Herdr is available.

The service is the only process that opens the workspace SQLite database. It logs the resolved socket and database paths after startup and handles orderly shutdown on `SIGINT`, `SIGTERM`, or `SIGHUP`.

### Tree client

[`src/outliner.ts`](../src/outliner.ts) is a standalone terminal process using:

- [`TreeController`](../src/tree-controller.ts) for behavior,
- [`renderTreeFrame`](../src/tree-renderer.ts) for ANSI rendering,
- [`virtual-branches.ts`](../src/virtual-branches.ts) for projections, and
- [`OutlinerClient.watch()`](../src/client.ts) for reactive updates.

Tree holds no canonical block state. It reconstructs canonical data from service snapshots and events, then owns its cursor, occurrence selection, filter, collapsed canonical IDs, multiline-expanded row IDs, viewport, explicit-navigation history, and browsing-context publication in-process. Closing a Tree discards only that Tree's presentation state.

Cursor changes publish the selected canonical block together with the source Tree client ID. The service retains the browsing-context target and emits a `preview` UI command to the first spatially unlocked Detail in the same tab; preview never focuses the destination. Global `selection` events are ignored by Tree panes. Tree `Enter` dispatches `open` to focus the same unlocked reader without entering edit mode. Exact-client `focus` and `reveal` commands move only their addressed Tree and locally expand ancestors when required. The legacy saved workspace selection may seed a newly created Tree once, but it is not continuing pane authority.

PageUp/PageDown move the selected expanded row's offset by one Tree body viewport and clamp to its wrapped row count. Cursor changes, multiline expansion changes, and reconnects reset the offset.

### Detail client

[`src/detail-main.ts`](../src/detail-main.ts) selects the Pi TUI Detail implementation, which separates:

- [`DetailController`](../src/detail-controller.ts) — modes, effects, optimistic saves, PreviewRegion actions, property-inspector state, lazy backlink state, file/annotation behavior, and cursor visibility;
- [`detail-pi.ts`](../src/detail-pi.ts) — terminal lifecycle, input, Pi layout switching, and dedicated-inspector startup;
- [`detail-pi-preview.ts`](../src/detail-pi-preview.ts) — authored Markdown, callouts, property rows, and generated Backlinks in one `ScrollView`;
- [`open-destination-chooser.ts`](../src/open-destination-chooser.ts) — shared destination state, fixed key handling, routing fallback, and idle dismissal for every open-capable Detail surface;
- [`backlink-peek.ts`](../src/backlink-peek.ts) and [`backlink-peek-main.ts`](../src/backlink-peek-main.ts) — immutable source-set traversal, reversible outcomes, and the non-routable Herdr preview surface;
- [`detail-editor-layout.ts`](../src/detail-editor-layout.ts) — grapheme-safe wrapped visual rows, cursor mapping, and selection spans;
- [`detail-renderer.ts`](../src/detail-renderer.ts) — fixed custom frames for edit, comment, file, and annotation modes; and
- [`text-buffer.ts`](../src/text-buffer.ts) — raw text, grapheme/word movement, and selections.

The legacy ANSI Detail entrypoint remains available in [`src/detail.ts`](../src/detail.ts), but the Herdr manifest starts [`src/detail-main.ts`](../src/detail-main.ts).

Detail owns an exact target, a bounded in-process target history, and a visible
`Unlocked | Locked` state. An unlocked Detail is eligible for same-tab Tree
previews and confirmed reference opens. Ordinary navigation can target only an
unlocked Detail. A locked Detail also rejects directly addressed ordinary
`preview` and `open` commands; explicit `replace` alone may retarget it without
changing its lock state. `L`, `i`, `Ctrl+L`, or `Meta+L` toggles the current
target's lock. Block editing and annotation commenting lock before opening a
mutable buffer.

Authored block/page/Work-ID links and typed Property targets bind one target to
the shared destination chooser before resolution or navigation. `Shift+R`
replaces the current Detail, `f` dispatches to the first spatially unlocked
same-tab Detail, and `r`/`d` create an independent right/down Detail. `Enter`
uses the first unlocked destination and falls back to a right split; explicit
`f` never falls back. Block-fragment identity is carried through replace,
first-unlocked, and split routes. `Esc`, target changes, pane exit, or the
configurable idle timeout dispose the bound target without navigation. Chooser
input is consumed before the ordinary Detail keymap and resets the idle timer.
Closing Detail discards its target, history, chooser, and lock state.

The generated Backlinks section is collapsed by default and therefore performs
no relation query during ordinary Tree cursor previews. Expansion calls the
bounded `references.backlinks` action, caches the result by exact target, and
invalidates it on canonical content/address events. One relation primitive
reverses exact block references, normalized page addresses, Work IDs, and
block-valued properties such as `[source-block::<block-id>]`. Each projected
source carries canonical created/updated timestamps plus normalized relation
groups. Detail keeps only transient filter, sort, selection, and per-source
disclosure state: fuzzy matching spans source title, parent context, relation
type, and snippets; sorting cycles created/updated timestamps in both
directions. The authored Markdown and generated backlink Markdown remain
separate components; edit/save paths only read canonical block text. `Tab` or a
plain source-row click selects generated sources, `.` toggles the selected
source's occurrence rows, `Enter` or a Ctrl/Meta-click opens a non-routable
Herdr popup, and `R` reveals one. The popup captures the visible filtered/sorted
source set, renders one source at a time, and moves only within that snapshot.
`Esc` sends an exact-client `backlinks.select` command before closing. `Enter`
opens the shared destination chooser instead of immediately mutating pane
topology. Backlink Peek supplies reversible source-selection behavior to the
same chooser used by authored Detail links and typed Property targets. Splits
seed a fresh browsing context without a source preview dispatch. The generated
`+`/`−` controls use a Detail-local action URI and do not enter canonical text.

Obsidian-style callouts are parsed into source-spanned PreviewRegions with stable
parent/child identity. Nested callout bodies remain Pi Markdown, `+`/`-` fold
markers produce ephemeral disclosure, and generated action links never enter
canonical text. Generated embed backgrounds compose with callout bodies rather
than replacing them.
Callout presentation is a Detail-process theme boundary. `OUTLINER_CALLOUT_THEME`
is parsed once at startup into validated partial overrides for canonical type
styles and the neutral fallback. Rendering reapplies each card's foreground and
background after nested Markdown resets, pads every card row to the available
terminal width, and keeps aliases on their canonical style. Invalid colors,
multi-column glyphs, alias-specific keys, and unknown fields retain defaults.

The read-only property inspector calls the same scoped property parser used by
the property index and retains every occurrence's scope, ordinal, line/column,
span, syntax, placement, and typed target. `p` toggles the inline disclosure;
`P` launches a locked dedicated Detail presentation for the same block/model.
Filter, grouping, focus, and viewport state are process-local. Every rendered
property cell carries a Detail-local focus action so a plain click highlights
the occurrence. Actionable block/page/Work-ID values use Ctrl/Meta-click or the
existing keyboard reference route to resolve and dispatch `open | reveal`;
plain values remain nonnavigable. Neither presentation owns or rewrites
canonical source.

Tree rows and the Detail header derive compact summaries from the same canonical
block-property array. `OUTLINER_PROPERTY_SUMMARY_KEYS` supplies the
workspace-ordered allowlist; virtual branches can override it for their
occurrences with `[summary-properties::…]`. Width fitting drops trailing
configured fields before truncating the property-free Tree title. Summary
rendering is presentation-only and never reparses into or mutates source.

### Pi / OMP extension

[`pi-extension/index.ts`](../pi-extension/index.ts) is the shared host adapter. It:

- starts or locates the service,
- opens Herdr panes through the plugin action,
- exposes Outliner tools and commands,
- injects bounded selection context before agent turns, and
- inspects the live invocation-local Git checkout through `pi.exec`.

[`pi-extension/work-environment.ts`](../pi-extension/work-environment.ts) uses
argument-array `git -C <ctx.cwd>` calls with cancellation and short timeouts.
[`src/work-environment.ts`](../src/work-environment.ts) classifies active-task
orientation without host or Git side effects. Session start refreshes compact UI
status; each active-task turn receives the same bounded invariant and actionable
guidance while the checkout is on the default branch, mismatched, detached, or
outside Git. This substrate is deliberately read-only.

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

Derived, lossless index of deliberate non-literal property records. Each row stores `(block_id, ordinal)`, normalized key/value, raw source text, UTF-16 span, line/column, placement, syntax, and `block | line | inline` scope. `(scope, key, value, block_id)` supports scoped queries while preserving repeated keys and text order.

Canonical text is authoritative. Property updates patch text with optimistic concurrency, then re-index it. The parser version is persisted in `metadata`; schema or parser changes rebuild the derived index from every canonical block without changing block timestamps. Literal property-looking text inside inline code, fenced code, or escaped bracket syntax is not indexed.

Scope classification is structural. After leading blank lines, the first nonblank line may be a subject or a property-only line. A trailing bracket run on the subject and the first contiguous property-only run after the optional subject are block metadata. Once a blank or non-property body line ends that preamble, later bare `key:: value` records are line-scoped and bracket records are inline-scoped, including later standalone bracket-only lines.

### Other tables

- `metadata` — service sequence, parser version, and legacy navigation cursor.
- `selection` — legacy workspace selection used by CLI/agent context and as an optional one-time seed for a new Tree; never live pane authority.
- `navigation_history` — legacy workspace-selection history for compatibility clients; Tree and Detail panes maintain independent in-process histories.
- `virtual_occurrence_ranks` — durable `(virtual-branch ID, canonical block ID) -> branch-local rank`; both foreign keys cascade on deletion.
- `page_addresses` — unique normalized symbolic address to canonical block mapping for page declarations, Work IDs, and explicit aliases; foreign keys cascade only on physical purge.
- `reserved_work_ids` — immutable Work-ID reservation ledger with the original canonical owner UUID retained after purge.
- `work_id_allocator` — singleton workspace prefix and next monotonic sequence number.

## Protocol

The current protocol version is `28`, defined in [`src/types.ts`](../src/types.ts). Requests and responses are newline-delimited JSON over the workspace Unix socket.

### Important request families

- health: `ping`
- canonical reads: `get`, `children`, `blocks.context`, `workspace.snapshot`
- bounded search: `blocks.query`
- browsing contexts and Tree previews: `browsing-context.get`, `browsing-context.publish`
- typed navigation: `navigation.resolve` preflight and `navigation.dispatch` with `preview | open | reveal`, plus optional transient source preservation
- selection-neutral capture: `capture.create`
- mutations: `create`, `update`, `move`, `delete` (move to Trash), `trash.restore`, `trash.purge`
- properties: `properties.patch`, `properties.catalog`
- virtual ordering: `virtual.occurrences.reorder`
- references: `references.resolve`, `references.backlinks`
- symbolic addresses: `pages.resolve`, `pages.follow`, `pages.complete`, `pages.rename`, `pages.alias`, `pages.remove`
- Work IDs: `work-ids.status`, `work-ids.configure`, `work-ids.allocate`
- legacy workspace selection/history: `selection.get`, `selection.set`, `navigation.state`, `navigation.back`, `navigation.forward`
- reactive clients: `events.subscribe`, `clients.list`, `clients.update`
- exact-client behavior: `ui.command.send`; `open` respects the destination lock, while explicit `replace` retargets the invoking Detail and preserves that lock state

### Live client identity

Each Tree and Detail process generates a fresh client UUID and registers
`{ clientId, role, contextId, locked?, runtime? }` on `events.subscribe`.
Details register unlocked and publish every explicit lock-state transition
through `clients.update`. `open-here` generates one context UUID and passes it
to the Tree and Detail it creates. Standalone processes use their client UUID
as a private context.

Client registrations retain terminal identity as their stable Herdr join key.
When Herdr is available, the service reconciles pane, workspace, tab, and
coordinate fields from the live runtime registry before returning client reads;
launch-time runtime fields are only a fallback. The service orders same-tab
Detail candidates by horizontal then vertical pane position, with client ID only
as a deterministic fallback. Herdr remains authoritative for current placement
and focus.

The subscription socket owns its registration. The service rejects duplicate
live client IDs and removes exactly that socket's registration. When the last
subscriber for a browsing context disconnects, its target is pruned.
`clients.list` returns the live registry, optionally filtered by role.

`content`, legacy `selection`, and `view` events are workspace broadcasts. A
`ui` command is written only to its `targetClientId`.

For `preview` and `open`, `navigation.resolve` and `navigation.dispatch` select
the first unlocked Detail in the source's current tab. Locked Details and every
other tab/workspace are excluded. If the source lacks Herdr topology, its
browsing context is the fallback pool boundary. When the pool exists but every
Detail is locked, navigation fails with an instruction to unlock one or open
another Detail; no anchor is overwritten. `reveal` targets the source Tree,
then one same-context Tree, then one unambiguous same-tab Tree. There are no
persisted or manual per-source open routes.

Direct dangling page activation preflights the unlocked destination before
transactional create-on-follow. Detail chooser activation instead defers
resolution and create-on-follow until a destination is confirmed, so dismissal
and idle expiry leave canonical content unchanged.

### Agent provenance

`author` remains the coarse `user | agent | system` role used by renderers and existing clients. Agent creation requests may additionally carry `{ actorId, sessionId?, taskId? }`; the service accepts that provenance only with `author: "agent"`, stores it on the new block, and never rewrites it during later content updates.

The Pi/OMP adapter forces `author: "agent"`. It identifies the host as `pi` or `omp`, reads the durable session ID from Pi's `ExtensionContext.sessionManager`, and records the tool-call ID as the originating task ID. Legacy and user-authored blocks omit these optional fields.

### Clickable outliner identities

Herdr recognizes plain terminal text as a URL only for `http://` and `https://`. Outliner renderers therefore generate trusted OSC 8 hyperlinks with private URIs instead of expecting link-handler regexes to scan arbitrary text:

- `pi-outliner://block/<uuid>` — exact canonical block;
- `pi-outliner://goto/<encoded-query>` — shared fuzzy goto resolution;
- `pi-outliner://work/<PIE-NNN>` — resolve-only Work-ID registry lookup;
- `pi-outliner://page/<encoded-address>` — unique symbolic page resolution and explicit create-on-follow.

Inside live panes, reference activation carries one exact canonical target identity. Tree keyboard `o` and Ctrl/Meta-click resolve and dispatch `open`; `R` dispatches `reveal`. Authored Detail links, typed Property targets, and Pi TUI's Detail `openUrl` bind the unresolved target to the shared destination chooser, which resolves and dispatches only after confirmation. A plain Tree-row click changes Tree selection and publishes that canonical row to its linked Detail. Ctrl/Meta-click selects and opens the canonical row unless the clicked cell carries a reference target, which opens instead. Detail breadcrumb links explicitly emit `reveal`, so selecting an ancestor moves the paired Tree rather than opening another Detail. Generated Backlink and Property links resolve first to local PreviewRegion focus on plain click; Ctrl/Meta-click activates the focused source or typed target.

Authored text is sanitized before link generation. Tree adds OSC 8 only after plain-text wrapping/truncation; Detail generates safe Markdown links after sanitization. Under `HERDR_ENV=1`, Detail enables Pi TUI hyperlink emission because nested panes advertise generic `TERM=xterm-256color` even though Herdr captures OSC 8 metadata. Tree accepts unmodified and Ctrl/Meta primary-button presses, uses rendered row identity independently from link hit testing, and ignores release, motion, and wheel reports for activation. Shift remains available for terminal-native selection.

The `outliner-navigation` manifest handler and [`src/herdr-link-open.ts`](../src/herdr-link-open.ts) are the external Herdr path. They validate/decode the private URI, resolve the invoking pane to its live source registration, and dispatch through the same route. `[[address]]` remains visible when dangling; explicit activation creates exactly one root stub through the transactional registry path before navigation dispatch.


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
  propertyScope?: "block" | "line" | "inline" | "all";
  sort?: {
    field: "created" | "updated";
    direction: "asc" | "desc";
  };
  limit: number;
}
```

The service normalizes every query before regular graph traversal or ranked virtual-branch SQL. It validates limits from 1 through 1000 without clamping, lowercases property keys, preserves exact interior value spaces, distinguishes presence from equality, removes exact duplicate clauses, validates `propertyScope`, validates subtree roots, validates timestamp sort fields and directions, rejects timestamp sorting combined with `rankViewId`, and translates the reserved `deleted=true` compatibility filter into explicit deleted-root mode. Created/updated sorting orders every match before limit truncation with a deterministic timestamp/id tie break.

Property filters default to block metadata. Explicit `line`, `inline`, or `all` queries use the same derived index and return matching record context—scope, ordinal, line, column, and source span—on each result. Human text surfaces share one minimal property-filter parser: whitespace-separated positive-AND clauses, `key` presence, `key=value`/`key::value` equality, and double-quoted spaced values with `\\` and `\"` escapes. Tree and Pi commands use the expression parser; each repeated CLI `--filter` is parsed as one clause so a shell-quoted value containing spaces remains exact. Virtual branches persist the canonical expression in `[query::…]`; their omitted scope therefore remains block-only. Agent tools remain structured and bypass the shorthand.

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

Capture text remains ordinary editable/movable content. The service preserves authored newlines and appends indexed lifecycle/context properties (`type=capture`, `status=unprocessed`, source, timestamp, optional captured-from UUID) as the trailing block-scoped property run on the first authored line. This keeps the useful title first while retaining query semantics. Immutable agent provenance stays in the existing block fields, and the mutation never calls selection or navigation operations.


Capture adapters remain clients. CLI text/stdin/heredoc, Pi/OMP `/capture`, `outliner_capture`, and standalone `float.dispatch(…)` interception all send one `capture.create` request and return the same compact receipt. Adapter differences are limited to source, author/provenance, optional captured-from context, and request-ID generation.

The input hook intercepts only a complete standalone marker while idle and without images. It uses a balanced parenthesis/quote parser with no `eval` or shell interpretation. Embedded markers continue to the agent unchanged. A valid exact marker is handled without an LLM turn only after durable service confirmation; service failure reports the error and returns `continue` so the original input is preserved.
Store startup creates one canonical `Inbox [type::inbox] [system-view::inbox]` when absent and rejects multiple active Inbox markers. The block may move or be renamed; the marker/UUID remains the destination identity.

## Reactive flow

1. A client obtains a workspace snapshot or exact block context.
2. It registers a fresh process identity, role, browsing-context identity, and
   Detail lock state.
3. Tree publishes its local cursor with its source client identity.
4. The service retains the context target, chooses the first spatially unlocked
   same-tab Detail, and sends that one client a `preview` UI command.
5. Canonical mutations broadcast `content` events to every client under the
   workspace root; receiving content refreshes data but never transfers browsing
   authority.
6. Exact `ui` commands are delivered only to their target client.
7. On service reconnect, Detail republishes its lock state and Tree republishes
   its retained cursor. A restarted process receives a new client identity;
   `open-here` creates a new pair context.

While Detail is editing/commenting, it is locked before the mutable buffer
opens. Content and exact-target refreshes are marked pending instead of
replacing that buffer. Save uses `expectedUpdatedAt`; conflicts preserve the
buffer and surface the error.

Tree and Detail navigation histories are process-local and bounded to 200 exact
targets. History navigation does not change Detail lock state. Soft-deleted
targets remain exact and read-only; purged targets surface as unavailable.
Legacy service-owned `selection` history remains only for CLI/agent
compatibility.

## Properties and references

Properties are Roam-style textual metadata:

```text
Question [type::question] [status::open]
```

Every deliberate non-literal property is indexed with source context, but normal block semantics and query filters use only block-scoped metadata. Callers must explicitly request line/inline/all scope for body annotations, and those query results identify the matched records. Property patches address global indexed ordinals so an agent can replace/remove/append metadata without rewriting unrelated prose.

Exact references use `((block-id))`. Read paths replace a resolvable ID with the target’s first non-property content line. Edit paths retain the raw ID. Dangling exact references remain unchanged.

Symbolic references use `[[address]]`. The registry compares trimmed, Unicode-normalized, caseless, whitespace-collapsed keys while preserving the authored address label. One `[page::address]` declaration registers a page; `[work-id::PIE-NNN]` registers the same canonical block under its Work ID. Bare Work IDs navigate through a resolve-only registry path rather than fuzzy goto, and unresolved Work-ID-shaped addresses cannot create page stubs. Parsing and ordinary saves never create a referenced block. `pages.follow` transactionally resolves or creates one ordinary root stub. General edits cannot silently change or remove a registered declaration: `pages.rename` uses optimistic concurrency, changes the primary declaration, and retains the former address as an alias; `pages.alias` adds another explicit address; `pages.remove` explicitly unregisters an alias or primary declaration. Registry rebuilds preserve aliases.

[`reference-occurrences.ts`](../src/reference-occurrences.ts) is the shared pure
scanner for actionable exact, page, and bare Work-ID occurrences. It excludes
inline/fenced/indented code, authored Markdown links, and property tokens before
either first-reference navigation or backlink reversal consumes occurrences.
[`backlinks.ts`](../src/backlinks.ts) owns the reusable reverse-relation
primitive: symbolic occurrences resolve through the address registry, repeated
occurrences group under one source, snippets and source rows are bounded, and
deleted source inclusion is explicit. `references.backlinks` is the current
delivery seam; a later typed block-set source must call this same primitive
rather than implement a second resolver.

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
- `[sort::created]` or `[sort::updated]` — order the complete matched set by timestamp before applying the limit.
- `[direction::asc]` or `[direction::desc]` — timestamp direction; requires `sort` and defaults to `desc`.
- `[create::key=value]` — one property applied to new canonical children.
- `[create-parent::<block-id>]` — physical parent for branch-created blocks.
- `[summary-properties::key,key,…]` — ordered Tree summary allowlist for projected occurrences in this view.

Tree builds canonical parent-to-children adjacency once from the complete physical
snapshot, never from the collapse-pruned visible collection. It queries, ranks,
deduplicates, and bounds matched roots first, then allocates read-only contextual
descendants through relative depth 2. The branch reserves every bounded root before
using the remaining portion of its 1,000-row budget for descendants in
ranked-root/canonical-preorder order. Disclosure is applied only after allocation,
so collapse state cannot redirect the budget to a different root.

A root occurrence carries `(viewId, canonicalId)` identity. A contextual descendant
carries `(viewId, matchRootCanonicalId, canonicalId)` identity plus its contextual
parent row ID. Consequently, one canonical child can appear beneath a matched
ancestor and as an independent matched root without identity collision. A physical
virtual-definition block encountered as a descendant is an inert leaf and never
recurses.

Context disclosure and multiline expansion are Tree-local ephemeral state.
`Left`, `Right`, `Space`, and disclosure-marker mouse clicks operate on contextual
row and parent identities; canonical edit, reveal, and explicit deletion still
target `canonicalId`. Projected indent/outdent and add operations remain disabled.

Branch count, completeness, and truncation remain root-only. Root-query truncation
is distinct from depth and 1,000-row budget truncation, and all three are surfaced.
Unsorted branches use persisted ranks and `Shift+Up` / `Shift+Down` reorder;
`workspace.snapshot` carries every occurrence rank in the same transactional read
as the block graph, and projection reapplies those ranks before the root limit.
Timestamp-sorted branches order all matched roots before the limit, ignore
persisted ranks, and disable manual occurrence reorder. Rank rows survive
temporary query mismatches and cascade when either the branch definition or
canonical block is deleted.

## Detail rendering and editing invariants

### Preview

- Complete resolved block text is passed to Pi Markdown.
- Header and footer remain fixed while the primary `ScrollView` scrolls.
- Raw source and Markdown renders are cached when unchanged.
- Selection changes and transitions into preview reset scroll to the top.
- Callouts, Backlinks, and property-inspector rows reconcile through one ordered PreviewRegion focus/action state.
- Embed source ranges remain decorated when their generated text appears inside a callout body.

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

[`src/herdr-open.ts`](../src/herdr-open.ts) enforces service-first startup for
the four actions exported by the plugin manifest:

- `open` reuses or opens the service, then focuses the Tree selected by invoking
  pane, unambiguous current tab, workspace, or project. If none exists, it runs
  the same pair creation as `open-here`; ambiguity is an error.
- `ensure-detail` applies the same Tree selection, focuses an existing Detail in
  that Tree's tab (preferring its context, unlocked state, and spatial order),
  or opens one below the Tree with the Tree's browsing context. With no Tree it
  opens a complete pair.
- `open-here` always generates a browsing-context UUID, opens a Tree to the right
  of the invoking pane and a Detail below that Tree with the same UUID, and
  focuses the Tree.
- `open-layout` requires an otherwise empty tab. It retains the invoking shell,
  creates a Tree and primary Detail in one context plus a second Detail in an
  independent context, applies the `detail-b` four-pane layout, and focuses the
  Tree.

Tree quick capture opens the manifest `capture` entrypoint with Herdr `placement = "popup"` anchored to the active Tree. The popup process reuses the same text-buffer command mapping, layout, and editor-row renderer as Detail; only Ctrl+S save and Esc/Ctrl+C cancellation are wired to `capture.create` and popup exit. It is not a Tree or Detail registry client and never changes browsing context or selection.

Each `open-here` invocation creates a new pair even under the same workspace
root. Closing both clients prunes the context. Renaming or renumbering tabs and
panes has no effect because labels are not identity. Pane IDs are read from
Herdr responses and never predicted.

Layout reshaping is serialized on Linux and macOS with an atomic lock directory.
Its path appends `.layout.lock` to `HERDR_SOCKET_PATH`, or to
`~/.config/herdr/herdr.sock` when that variable is absent. Acquisition has a
bounded 30-second wait, recovers dead or stale owners, and releases in a
`finally` path. Timeout and errors remain visible; layout mutation never runs
unlocked and does not depend on the external `flock` utility.

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
src/herdr-registry.ts         ephemeral live Herdr runtime metadata
pi-extension/index.ts         Pi/OMP commands, tools, context hook
```

## Accepted designs not yet implemented

The durable roadmap lives in the outliner workboard. The current accepted design not yet implemented is projected-child creation.

Do not describe it as shipped behavior until its roadmap item is Complete on main.
