# Pi Herdr Outliner

A persistent, local-first block outliner shared by a person and coding agents.

Pi Herdr Outliner runs as a workspace-scoped SQLite service with two terminal clients:

- **Tree** — navigate, create, edit, move, filter, and project blocks.
- **Detail** — read Markdown, inspect referenced files, annotate line ranges, and edit long-form block text.

The same service is exposed to Pi/OMP as agent tools, so notes, decisions, questions, work status, and file annotations live in one substrate instead of disappearing with a chat session.

> **Status:** active dogfood. The service, Tree, Detail editor, agent tools, properties, references, and virtual branches are working. This is not yet a packaged release; schema and interaction details can still change.

## Why this exists

The project started as a small Friday-night experiment and grew into a durable workspace with a few explicit constraints:

1. **One canonical block graph.** UI projections and agent views never duplicate canonical content.
2. **Service-owned persistence.** Closing or restarting Tree does not destroy the workspace or Detail state.
3. **Human and agent collaboration.** Both use the same optimistic, evented API.
4. **Visible incompleteness.** Bounded queries report whether their result is complete or truncated.
5. **Properties remain text.** `[key::value]` tokens are readable canonical text and also indexed for queries.

## Current capabilities

- SQLite-backed hierarchical blocks with stable UUIDs, sibling order, authors, timestamps, and one canonical graph per workspace root.
- Workspace-isolated service and runtime paths.
- JSON-lines RPC protocol v20 over a Unix socket.
- Reactive canonical content/view broadcasts, per-process Tree/Detail registration with Detail lock availability, exact-client UI commands, and source-aware `preview | open | reveal` navigation.
- Each Tree owns its cursor, occurrence selection, filter, viewport, collapsed rows, multiline expansion, explicit-navigation history, and browsing context; moving a Tree previews only in the first unlocked same-tab Detail and never replaces a locked anchor.
- Indexed `[property::value]` metadata with optimistic property patching and catalog queries.
- Exact block and fragment references using `((block-id))` and `((block-id^fragment-id))`, resolved to display titles in read mode while raw text remains editable.
- Unique normalized symbolic addresses from explicit `[page::address]` declarations and Work IDs, with aliases, explicit removal, bounded completion, dangling links, and transactional create-on-follow.
- Workspace-scoped monotonic Work-ID allocation adopts a clean existing prefix or requires explicit configuration, optimistically assigns the next immutable ID, and never reuses reserved or purged identifiers.
- Plain-clickable Work IDs, canonical UUIDs, exact references, and `[[address]]` links inside Tree/Detail, with OSC 8 `pi-outliner://` links retained for external terminal interoperability.
- Property-driven virtual branches with canonical projected occurrences, property-aware creation, and persisted branch-local occurrence order.
- Agent-authored blocks retain immutable actor, session, and originating tool-call/task provenance while preserving the coarse `agent` author role.
- Recoverable deletion preserves canonical structure and identity, excludes Trash content from normal queries/completions, and requires explicit identifier-confirmed purge.
- Idempotent zero-context-loss Tree capture writes ordinary canonical children under one stable workspace Inbox without moving selection or navigation history.
- Client-local multiline-expanded Tree rows support viewport-sized intra-block PageUp/PageDown without changing the Tree cursor.
- Pi Markdown preview with line, page, endpoint, and mouse/trackpad scrolling.
- Grapheme-safe wrapped Detail editing, word motion, selection, deletion, bounded per-session undo/redo, completion, optimistic save, and whole-session Esc cancellation.
- Each Detail visibly reports `Unlocked` or `Locked`; unlocked Details form a spatial preview/open pool, while locked Details retain exact context anchors.
- Referenced text/Markdown file viewing and durable line-range annotations.
- Herdr-owned pane placement/focus and current-pane recovery, one remembered service pane, per-process live client discovery, and a disposable runtime registry.
- Pi/OMP commands, tools, and selection-context injection.
- A disposable Pi report pane shows only the latest settled assistant message in service memory; selection-aware promotion creates an ordinary provenance-bearing agent block, while replacement, discard, pane close, and service restart leave no canonical report artifact.

Planned work is tracked inside the outliner itself. Notable accepted designs include normalized query construction, agent-assisted `PREFIX-XXX` placeholder resolution, backlinks, scoped property semantics, and projected canonical descendants.

## Quick start

### Requirements

- Linux or macOS
- [Bun](https://bun.sh/) 1.3 or newer
- Herdr 0.8 or newer
- Pi/OMP only if you want the agent extension and slash commands

### Install and link

```sh
bun install
herdr plugin link --enabled .
```

Run these commands from the project root. The plugin manifest is [`herdr-plugin.toml`](herdr-plugin.toml).

### Open the workspace

Inside a Herdr-managed pane:

```sh
herdr plugin action invoke open --plugin float.pi-outliner
```

The action preserves one **Outliner Service** tab. With no live Tree it opens an
**Outliner** Tree and **Outliner Detail** split beside the invoking pane, then
focuses the new Tree. With one live Tree it focuses that exact client. With
multiple live Trees it fails explicitly and lists client IDs instead of choosing
an arbitrary pane.

Use `open-here` to create another Tree/Detail pair in the current tab. Every
invocation creates a fresh ephemeral browsing context shared only by that pair.
Tab labels, tab numbers, pane titles, and labels such as `oi` are display
metadata—not routing keys. `focus-existing` focuses the unique Tree. The CLI and
Pi/OMP `outliner_clients` tool expose live client and context IDs for diagnostics
and explicit targeting.

When the project Pi extension is loaded, `/outliner` performs the same
focus-or-open action. The project-local `/outline` command in
[`.claude/commands/outline.md`](.claude/commands/outline.md) invokes and
verifies the Herdr action.

#### Working with multiple Details

Trees and Details under the same filesystem root share canonical blocks and
content updates, but not cursors, targets, filters, viewport state, lock state,
or navigation history.

Every Detail starts **Unlocked**. Tree cursor movement previews the selected
canonical block in the first unlocked Detail in the same Herdr tab, ordered by
pane position from left to right and then top to bottom. Preview updates never
steal focus. Press `Enter` in Tree to focus that reader without locking it.

Press `Shift+D` in Tree to create and focus another Detail below that Tree. The
new pane receives a fresh browsing context seeded with the selected canonical
block, so later Tree cursor movement does not replace it. It remains unlocked
for explicit opens until you lock it.

When a block becomes a context anchor, focus its Detail and press `L`, `i`,
`Ctrl+L`, or `Command/Meta+L`. The header changes to **Locked**, and that pane
is removed from the preview/open pool. The next Tree selection therefore
appears in the next unlocked Detail. Entering block edit or annotation-comment
mode locks the Detail automatically. Locking never silently expires; explicitly
unlock the pane to make it eligible again.

`o`, plain-clicked references, and external Herdr link activation open in the
first unlocked same-tab Detail and focus it without locking it. `R` reveals the
reference in the paired or unique same-tab Tree. Manual per-source destination
routes and temporary Peek mode do not exist. If every same-tab Detail is locked,
the source shows **All Details in this tab are locked — unlock one or open
another Detail** and preserves every anchor.
Backlink rows use the same unlocked same-tab pool with a source-preserving
constraint: the originating Detail is excluded before destination selection. If
no other unlocked Detail exists, activation fails without replacing the
backlink hub.

Closing a pair discards its browsing context. Renaming its tab or panes changes
nothing. A newly opened pair receives a new context and initially seeds its Tree
from the workspace's saved selection only as a starting point.

### Headless service and CLI

The service can run without Herdr:

```sh
bun run server
```

In another terminal, from the same workspace root:

```sh
bun run cli list
bun run cli list --filter work-stage=next --limit 20
bun run cli list --filter 'status=in progress' --filter project=pi-outliner --limit 20
bun run cli capture --text "A quick thought"
bun run cli capture <<'EOF'
Multiline capture with literal $VARIABLE and Unicode 🐢.
EOF
bun run cli list --subtree <block-uuid> --text "route snapshot" --limit 20
bun run cli create --text "A durable note [type::note]"
bun run cli selection
bun run cli clients --role tree
bun run goto 40bd0864
bun run goto --query "roadmap review"
bun run goto --client <client-uuid> --query "roadmap review"
bun run cli work-id-status
bun run cli work-id-configure --prefix PIE
bun run cli work-id-allocate --id <block-uuid> --expected <updatedAt>
```

The CLI resolves the same workspace-scoped socket and database as the service. `goto` accepts a full UUID, unique short prefix, or unambiguous fuzzy title/content query. Eight-character IDs are convenience labels, not a uniqueness guarantee; ambiguous queries return full-UUID candidates without changing selection. Work-ID configuration is normally one-time; allocation requires the exact block UUID and its latest `updatedAt`, available in bounded `list` results. A successful allocation atomically persists both the immutable reservation and the block's `[work-id::…]` property/address; a failed request consumes neither the number nor a reservation.

## Keyboard controls

The footer in each pane is authoritative and context-sensitive. These are the primary controls.

### Tree browse mode

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move selection |
| `PageUp` / `PageDown` | Scroll within the selected multiline-expanded block |
| `Left` / `Right` | Collapse/go to parent; expand/go to first child |
| `Shift+Up` / `Shift+Down` | Reorder canonical siblings, or branch-local projected occurrences |
| `Enter` | Focus the current block in the first unlocked same-tab Detail; remain unlocked |
| `Shift+D` | Create and focus a new independent Detail pane on the selected block |
| `e` | Edit a single-line block inline; open and lock a multiline block in the first unlocked Detail |
| `a` / `s` | Add child / sibling |
| `c` | Open quick capture; Shift+Enter/Ctrl+E adds a line, Enter saves to Inbox, Esc cancels |
| `Tab` / `Shift+Tab` | Indent / outdent |
| `Space` | Toggle collapse |
| `.` or `Command+.` | Expand/collapse multiline block detail in Tree |
| `Ctrl+E` or modified Enter | Explicitly edit and lock the selected block in the first unlocked Detail |
| `g` | Fuzzy goto by UUID, short prefix, title, or content |
| `o` | Open the first exact `((block-id))` or symbolic `[[address]]` reference in the first unlocked Detail |
| `R` | Reveal the first reference in this Tree |
| `L` | Explain that locking is controlled from a Detail pane |
| `Option+Left` / `Option+Right` | Move backward / forward through block navigation history |
| `/` | Filter visible blocks |
| `f` | Open a referenced file |
| `d`, then `y` | Confirm moving the selected canonical subtree to Trash |
| `r` | Restore a selected direct Trash root |
| `p` | Type the work ID/short UUID to permanently purge a Trash root |
| `Ctrl+Q` | Close the pane |

Plain-click any linked `PIE-NNN`, canonical UUID, exact reference, or symbolic
`[[address]]` inside Tree or Detail. Clicks open in the first unlocked same-tab
Detail without changing workspace-global selection. Registered Work IDs resolve
without fuzzy matching and never create content when missing. Following another
dangling address creates one canonical page stub before dispatch. Shift remains
the terminal-native text-selection escape while Tree mouse reporting is active.
Each Detail breadcrumb segment is an exact link that reveals that ancestor or
leaf in Tree rather than opening another Detail.

For links rendered outside the active Outliner, the Herdr handler identifies the
invoking pane's live client and uses the same unlocked-pool routing. On macOS,
the optional `macos/pi-outliner-link` app remains an explicit compatibility
path: Warp uses Command-click; Ghostty with mouse capture uses
Shift-Command-click.

Projected virtual occurrences deliberately constrain hierarchy and collapse. Branch-local sibling reorder changes only that projection; editing and confirmed deletion still target the canonical block.

### Detail preview

| Key | Action |
| --- | --- |
| `Up` / `Down` | Scroll one visual line |
| `Ctrl+U` / `Ctrl+D` | Scroll half a viewport |
| `PageUp` / `PageDown` | Scroll one viewport |
| `g` / `G` | Top / bottom |
| Mouse wheel / trackpad | Scroll preview |
| `b` | Expand/collapse the generated Backlinks section; the first expansion loads results lazily |
| `/` | Edit a fuzzy backlink-source filter; Enter applies and Esc cancels |
| `s` | Cycle updated/created timestamp sorting in descending/ascending order |
| `Tab` / `Shift+Tab` | Select the next / previous backlink source while Backlinks is expanded |
| `.` | Expand/collapse occurrence details for the selected backlink source |
| `Enter` | Inspect the selected backlink source in another unlocked Detail while preserving this hub |
| `e` | Lock this Detail and edit raw canonical text |
| `f` | Open referenced file |
| `o` | Open the first authored reference in the first unlocked same-tab Detail; the destination remains unlocked |
| `R` | Reveal the selected backlink source when expanded; otherwise reveal the first authored reference in the paired or unique same-tab Tree |
| `L`, `i`, `Ctrl+L`, or `Command/Meta+L` | Lock this block as an anchor, or unlock the Detail for previews and opens |
| `Option+Left` / `Option+Right` | Move backward / forward through this Detail's local history without changing lock state |
| `r` | Restore the selected block when it is a direct Trash root |
| `q` | Focus Tree |
| `Ctrl+Q` | Close Detail |

Detail navigation history is local to that Detail process and retains at most 200 exact targets. Opening a reference, receiving an exact target, or following the paired Tree records a visit. Back/forward pins the historical target so a later Tree cursor event cannot immediately replace it. Soft-deleted targets reopen read-only; a purged target remains visible as unavailable. Closing Detail discards this history.

Backlinks are a generated read projection beneath the canonical Markdown
document. The collapsed section performs no reference scan. Expanding it asks
the service for at most 50 source blocks and groups repeated exact, page,
Work-ID, and block-valued property references per source. Property references
such as `[source-block::<block-id>]` retain their normalized property key in the
result and are summarized by property type. Empty and truncated states remain
explicit. `/` fuzzily filters source title, context, relation type, and
occurrence text. `s` cycles updated/created timestamp sorting in both
directions. `.` or the clickable `+`/`−` disclosure expands only the selected
source's occurrence snippets. Results are cached for that target and
invalidated by canonical content/address events. Generated rows never enter the
edit buffer or saved `Block.text`; `Enter` or a row click opens its source in
another unlocked Detail while preserving the current hub, and `R` explicitly
reveals it in Tree.

### Detail edit and comment modes

| Key | Action |
| --- | --- |
| Arrow keys | Grapheme-safe character/physical-line movement |
| `Option+Left/Right`, `Ctrl+Left/Right`, `Option+B/F` | Previous/next word start |
| `Home` / `End`, `Ctrl+A` / `Ctrl+E` | Physical line start / end |
| `Shift` + a supported motion | Extend selection |
| `Command+A` or `Ctrl+Shift+A` | Select all |
| `Ctrl/Command+Z` | Undo the previous edit group |
| `Ctrl+Shift+Z` or `Ctrl+Y` | Redo |
| `Backspace` / `Delete` | Delete selection or one grapheme |
| `Tab` or `Ctrl+Space` | Open completion in block edit mode |
| `Ctrl+S` | Save block or add annotation |
| `Esc` | Cancel the complete edit session and return to Tree |

Long physical lines wrap without changing raw text. Continuation rows remain associated with one physical line number, and the viewport follows the active cursor edge.

Undo history is bounded to the current edit/comment session. Consecutive typing and deletion coalesce; cursor/selection state is restored; a divergent edit clears redo. Save or Esc-cancel ends the history.

## Blocks, properties, and references

A block stores canonical text plus structural fields. Properties are written directly in that text:

```text
Investigate page navigation [type::roadmap-item] [status::planned] [work-stage::next]
```

Eligible property tokens are indexed in `block_properties`; canonical `Block.text` remains the source of truth. Literal examples inside inline/fenced code are not indexed.

### Bounded block queries

The service owns one structured `BlockSearchQuery` used by Tree filters, virtual branches, CLI, Pi commands, and agent tools. Property filters are positive AND clauses with presence or exact equality:

```text
status=open priority
status="in progress" project=pi-outliner
status::"in review" type::roadmap-item
```

Whitespace separates clauses outside double quotes. `key` checks property presence; `key=value` and `key::value` check case-insensitive exact equality. Double-quoted values preserve spaces and support only `\\` and `\"` escapes. Invalid syntax reports a character position instead of becoming an accidental query. OR, NOT, ranges, grouping, aggregation, sorting, and reference traversal are intentionally not supported.

Text substring, subtree root, deleted-content mode, projection rank context, and limit remain explicit structured fields rather than reserved filter words. Every query carries a limit from 1 through 1000 and returns `complete` or `truncated` metadata. Tree `/` mode uses the indexed property catalog for key/value completion; agents call `outliner_query` with structured filters and never parse the shorthand.

### Quick capture Inbox

Tree `c` opens a pane-local capture composer without navigating away from the selected row. Single-line typing and multiline paste are supported; Shift+Enter or Ctrl+E adds a line, Enter submits, and Esc/Ctrl+C cancels.

`capture.create` writes one ordinary canonical child beneath the active `[system-view::inbox]` block. Tree, CLI, Pi/OMP tools/commands, and exact standalone dispatch markers are adapters over this same mutation. Captures include:

```text
[type::capture] [status::unprocessed]
[capture-source::tree] [captured-at::<ISO timestamp>]
[captured-from::<optional canonical block UUID>]
```

The optional captured-from block is context evidence, not the capture’s parent. The Inbox can be renamed or moved while retaining its canonical identity. Persistent request receipts make retries idempotent across reconnects and service restarts. Capture never changes workspace selection/history; the Tree restores the exact prior row and shows a compact receipt. Routing, enrichment, Inbox processing, and concrete third-party launcher integrations remain later work.

CLI accepts `--text`, explicit `--stdin`, or automatic non-TTY stdin/heredoc input. `--request-id` provides caller-controlled retry identity and `--captured-from` records optional context. Receipt JSON is written to stdout; service failure exits nonzero without a local fallback.

The Pi extension registers `/capture` and `outliner_capture`. An exact standalone `float.dispatch(…)` input is intercepted by the Pi/OMP input hook, durably captured, acknowledged, and handled without starting an agent turn. Embedded/conversational markers are left untouched; malformed markers report a warning and continue as ordinary input.

On `agent_settled`, the Pi extension publishes only the latest assistant Markdown
to one service-memory report slot and reuses its Herdr report pane. The report
supports block, page, and Work-ID links. `v` selects an excerpt, `k` promotes the
selection or whole report to an ordinary agent-authored block, and `x` discards
it. Promotion is the only path from this disposable surface into the canonical
block graph.

Exact references use stable block IDs:

```text
Depends on ((516e1754-7741-4c9e-83a6-7b703a8f0798))
```

Read views resolve exact-reference titles while edit views retain raw IDs. Symbolic links use `[[address]]`; a block registers an address through `[page::address]`, and existing Work IDs participate in the same unique normalized registry. Accepting completion for a Work-ID address inserts its exact `((block-id))` reference, so read mode renders the full current block title instead of only the identifier; ordinary pages and aliases retain `[[address]]`. Parsing or saving a dangling link never creates content. Only explicit follow creates a root stub, transactionally; unresolved Work-ID-shaped addresses fail instead of squatting the stable Work-ID namespace. Explicit rename preserves the old address as an alias, and explicit removal unregisters an alias or primary declaration. Deleted targets remain resolvable and purged targets become dangling.

Stable fragments are inline anchors attached to a heading or paragraph terminus:
`## Description ^description`. Read mode hides the marker. Exact links use
`((block-id^description))`; completion can resolve a heading name to its stable
ID, and Detail navigation/history retain the fragment target. A heading fragment
spans through the next equal-or-shallower heading; a paragraph fragment spans
from its preceding blank line or heading through the anchored terminus. Missing
and duplicate anchors remain explicit.

Detail read mode projects `!((block-id))` without changing authored text.
Ordinary targets render their full canonical Markdown once.
`!((block-id^fragment-id))` renders only the deterministic fragment slice.
Canonical `[type::virtual-branch]` targets execute their existing bounded query.
Generated embed output is read-only, refreshes after canonical content events,
and is never recursively evaluated. Missing/deleted targets, fragment failures,
invalid definitions, query failures, truncation, and the 16-embed document limit
remain explicit.

A bounded one-hop relation projection is another canonical definition block:

```text
Dependencies [type::relation-view]
[source::embedding-source]
[relations::depends-on,related-to]
[fragment::description]
[order::source]
[limit::10]
```

`source` may instead name an explicit block ID. Relation keys are an explicit
allowlist; repeated `fragment` properties select stable target fragments.
Traversal deduplicates canonical targets, supports source or target-ID order,
and rejects limits outside 1–25. Generated rows do not create backlinks.
Recursion, joins, aggregation, templates, and an unrestricted local query
language are intentionally unsupported.

`references.backlinks` exposes the inverse semantic relation: each source text
is parsed with the same protected-range-aware exact/page/Work-ID scanner used by
navigation, symbolic occurrences resolve through `page_addresses`, and only
occurrences resolving to the requested canonical target become backlinks.
Unresolved symbolic text is not a backlink. Deleted source blocks are opt-in;
querying an existing deleted target remains supported and explicit. Results are
bounded by source block and report `complete` or `truncated`.

Work IDs are allocated through the service rather than by scanning in a client. `work-ids.status` reports the configured prefix, observed legacy prefixes, and next ID; `work-ids.configure` explicitly chooses the workspace prefix; `work-ids.allocate` optimistically appends the next ID to an opted-in canonical block or atomically replaces its single configured `[work-id::<PREFIX>-XXX]` self-assignment marker. A clean existing prefix is adopted automatically, while ambiguous legacy prefixes remain visible but unconfigured. Canonical manual IDs for the configured prefix advance the same allocator; malformed, noncanonical, or out-of-prefix property values remain inert text metadata. The reservation ledger retains owning UUIDs after purge.

For a human writing notes, the intended promotion flow is: write freely, decide a block has become durable work, then ask the agent to assign it a Work ID. The agent calls `outliner_work_id` rather than guessing a number. Typing `PIE-NNN` or `[[PIE-NNN]]` only references an existing assignment; it never allocates one.

The configured `<PREFIX>-XXX` marker requests semantic work resolution. `[work-id::PIE-XXX]` asks whether the containing block should reuse existing work or receive a newly allocated ID; `[[PIE-XXX]]` requests a related work reference; `[issue::PIE-XXX]` preserves a typed issue relation. Before each agent turn, the shared Pi/OMP extension checks the raw prompt and full focused block. Textual `outliner_*` tool results are also checked. At most one compact reminder is injected per turn, only for the configured prefix.

Detection never searches, creates, allocates, relates, or rewrites by itself. The bundled `work-placeholder-resolver` skill directs the agent to perform a bounded existing-work search, reuse one confident match, leave ambiguous markers intact, otherwise create or promote canonical work, allocate through `outliner_work_id`, connect UUIDs, and optimistically replace only the exact marker. Failures preserve `XXX`; self-assignment allocation replaces the placeholder transactionally.

### Virtual branches

A normal physical block becomes a virtual branch through properties:

```text
Next
[type::virtual-branch]
[query::work-stage=next]
[create::work-stage=next]
[create-parent::<canonical-work-queue-id>]
[limit::20]
```

Spaced values use the same canonical filter syntax:

```text
[query::status="in progress" project=pi-outliner]
```

Matches appear as disposable `◇` occurrences. Creating beneath the branch creates one canonical block under `create-parent` and applies the configured property. The same canonical block may appear in multiple branches.

`Shift+Up` / `Shift+Down` reorders projected siblings within that branch using persisted occurrence ranks. Canonical parent/position order stays unchanged, and ranks survive temporary query mismatches.

## Agent integration

The project Pi extension is auto-discovered through [`.pi/extensions/outliner.ts`](.pi/extensions/outliner.ts). It registers:

- `/outliner`
- `/outliner-task [status|start <address>|pause|complete <proof-block-id>|clear]`
- `/outliner-goto <query>`
- `/goto <query>` through the project command
- `/outliner-filter`
- `/capture <text>`
- `outliner_task`
- `outliner_focus`
- `outliner_publish`
- `outliner_create`
- `outliner_capture`
- `outliner_update`
- `outliner_property_patch`
- `outliner_property_catalog`
- `outliner_query`
- `outliner_page`
- `outliner_work_id`
- `outliner_move`
- `outliner_clients`
- `outliner_selection`
- `outliner_annotate_file`

`outliner_query` accepts structured filters such as `{ key: "status", value: "in progress" }`, plus optional text and subtree fields. The service normalizes keys/values and applies the same bounded semantics used by human surfaces. `outliner_focus` targets an explicit or unique live Tree client and returns compact structural context.

`outliner_task` persists one active roadmap block per Pi session. Starting moves its canonical `work-stage` to `doing`; pausing returns it to `next`; completion requires a child or `source-block` proof, moves the item to `done`, and clears the session binding. Agent lifecycle events only project working/idle presence into Herdr metadata—they never infer semantic completion.

Before each agent turn, the extension uses Herdr pane-focus history to locate the most recently focused registered Outliner client, reads that client's browsing context, and injects the focused block body, breadcrumb, properties, and children. A different active task is appended as separate session context rather than replacing the user's focus. Without a focused Outliner client it falls back to the active task and then the legacy shared selection. [`outliner-workflow`](pi-extension/skills/outliner-workflow/SKILL.md) defines when to publish durable findings, decisions, roadmap reviews, syntheses, progress, and implementation proof through `outliner_publish` rather than leaving useful workspace knowledge only in chat. Context and presence integration fail open when their optional surfaces are unavailable. Deterministic `PREFIX-XXX` nudging remains tracked by PIE-152.

## Persistence and isolation

By default, runtime state lives at:

```text
~/.local/state/pi-herdr-outliner/<workspace-hash>/
```

Each resolved workspace root receives a distinct 12-character SHA-256 key containing:

- `outliner.sqlite`
- `outliner.sock`
- remembered plugin-pane metadata

Override the root with `OUTLINER_WORKSPACE_ROOT` and the base state directory with `OUTLINER_STATE_DIR`.

Browsing contexts, Detail targets/history, Tree presentation state, and live
Herdr client identities are intentionally ephemeral and are not stored in
`outliner.sqlite`. Canonical content remains shared and durable.

Back up `outliner.sqlite` before experimenting with migrations. Do not copy a live database without also accounting for SQLite WAL files.

## Development

```sh
bun run check
bun test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workboard lifecycle, verification rules, and PR/restart workflow. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for service boundaries, protocol flow, persistence, projections, and failure behavior.

## Project documents

- [Architecture](docs/ARCHITECTURE.md)
- [Contributing and delivery workflow](CONTRIBUTING.md)
- [OpenCode port requirements](docs/OPENCODE_PORT.md)
- [Archived early feedback](docs/archive/misc-feedback.md)

## Non-goals

- Replacing Herdr as the pane/workspace manager.
- Becoming a full Vim/Emacs competitor; use Pi TUI’s editor substrate if the custom editor grows beyond a narrow baseline.
- Treating projected occurrences as duplicated canonical blocks.
- Hiding query truncation or persistence failures behind silent fallbacks.
- Creating symbolic page stubs merely because unresolved `[[text]]` was typed; accepted design creates a stub only when that link is followed.
