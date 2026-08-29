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

- SQLite-backed hierarchical blocks with stable UUIDs, sibling order, authors, timestamps, collapse state, and selection.
- Workspace-isolated service and runtime paths.
- JSON-lines RPC protocol v10 over a Unix socket.
- Reactive content, selection, view, and UI-command events, with service-owned block navigation history.
- Indexed `[property::value]` metadata with optimistic property patching and catalog queries.
- Exact block references using `((block-id))`, resolved to display titles in read mode while raw text remains editable.
- Unique normalized symbolic addresses from explicit `[page::address]` declarations and Work IDs, with aliases, explicit removal, bounded completion, dangling links, and transactional create-on-follow.
- Workspace-scoped monotonic Work-ID allocation adopts a clean existing prefix or requires explicit configuration, optimistically assigns the next immutable ID, and never reuses reserved or purged identifiers.
- Plain-clickable Work IDs, canonical UUIDs, exact references, and `[[address]]` links inside Tree/Detail, with OSC 8 `pi-outliner://` links retained for external terminal interoperability.
- Property-driven virtual branches with canonical projected occurrences, property-aware creation, and persisted branch-local occurrence order.
- Agent-authored blocks retain immutable actor, session, and originating tool-call/task provenance while preserving the coarse `agent` author role.
- Recoverable deletion preserves canonical structure and identity, excludes Trash content from normal queries/completions, and requires explicit identifier-confirmed purge.
- Selected multiline-expanded Tree blocks support viewport-sized intra-block PageUp/PageDown without changing block selection.
- Pi Markdown preview with line, page, endpoint, and mouse/trackpad scrolling.
- Grapheme-safe wrapped Detail editing, word motion, selection, deletion, bounded per-session undo/redo, completion, optimistic save, and whole-session Esc cancellation.
- Referenced text/Markdown file viewing and durable line-range annotations.
- Herdr pane discovery, restart reconstruction, and a disposable runtime registry.
- Pi/OMP commands, tools, and selection-context injection.

Planned work is tracked inside the outliner itself. Notable accepted designs include normalized query construction, agent-assisted `PREFIX-XXX` placeholder resolution, backlinks, scoped property semantics, retained Detail targets, and projected canonical descendants.

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

The action opens or reuses:

1. an **Outliner Service** tab,
2. an **Outliner** Tree split, and
3. an **Outliner Detail** split.

It focuses Tree and prints the three returned pane IDs. Repeated invocation is idempotent.

When the project Pi extension is loaded, `/outliner` performs the same open/focus action. The project-local `/outline` command in [`.claude/commands/outline.md`](.claude/commands/outline.md) invokes and verifies the Herdr action.

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
bun run cli list --subtree <block-uuid> --text "route snapshot" --limit 20
bun run cli create --text "A durable note [type::note]"
bun run cli selection
bun run goto 40bd0864
bun run goto --query "roadmap review"
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
| `Enter` | Inline edit a single-line block; hand multiline blocks to Detail |
| `a` / `s` | Add child / sibling |
| `Tab` / `Shift+Tab` | Indent / outdent |
| `Space` | Toggle collapse |
| `.` or `Command+.` | Expand/collapse multiline block detail in Tree |
| `Ctrl+E` or modified Enter | Open the selected block in Detail |
| `g` | Fuzzy goto by UUID, short prefix, title, or content |
| `o` | Follow the first exact `((block-id))` or symbolic `[[address]]` reference in the selected block |
| `Option+Left` / `Option+Right` | Move backward / forward through block navigation history |
| `/` | Filter visible blocks |
| `f` | Open a referenced file |
| `d`, then `y` | Confirm moving the selected canonical subtree to Trash |
| `r` | Restore a selected direct Trash root |
| `p` | Type the work ID/short UUID to permanently purge a Trash root |
| `Ctrl+Q` | Close the pane |

Plain-click any linked `PIE-NNN`, canonical UUID, exact reference, or symbolic `[[address]]` inside Tree or Detail. Registered Work IDs resolve without fuzzy matching and never create content when missing. Resolved page addresses focus their canonical block; following another dangling address creates one canonical page stub and then focuses it. Shift remains the terminal-native text-selection escape while Tree mouse reporting is active.

For links rendered outside the active Outliner, the Herdr Control-click handler remains available where the terminal delivers that modifier. On macOS, the optional `macos/pi-outliner-link` app handles the native path instead: Warp uses Command-click; Ghostty with mouse capture uses Shift-Command-click. The bridge forwards validated targets over SSH/Tailscale and preserves the live workspace navigation semantics.

Projected virtual occurrences deliberately constrain hierarchy and collapse. Branch-local sibling reorder changes only that projection; editing and confirmed deletion still target the canonical block.

### Detail preview

| Key | Action |
| --- | --- |
| `Up` / `Down` | Scroll one visual line |
| `Ctrl+U` / `Ctrl+D` | Scroll half a viewport |
| `PageUp` / `PageDown` | Scroll one viewport |
| `g` / `G` | Top / bottom |
| Mouse wheel / trackpad | Scroll preview |
| `Enter` or `e` | Edit raw canonical text |
| `f` | Open referenced file |
| `o` | Follow the first exact `((block-id))` or symbolic `[[address]]` reference |
| `Option+Left` / `Option+Right` | Move backward / forward through block navigation history |
| `r` | Restore the selected block when it is a direct Trash root |
| `q` | Focus Tree |
| `Ctrl+Q` | Close Detail |

Navigation history belongs to the workspace service, not either pane. Every distinct `selection.set` from a user or agent records a visit; going back and then selecting another block discards the forward branch. The latest 200 visits persist across pane/service restarts. History can reopen a Trash target for read-only Detail inspection; purged targets are skipped.

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

Exact references use stable block IDs:

```text
Depends on ((516e1754-7741-4c9e-83a6-7b703a8f0798))
```

Read views resolve exact-reference titles while edit views retain raw IDs. Symbolic links use `[[address]]`; a block registers an address through `[page::address]`, and existing Work IDs participate in the same unique normalized registry. Parsing or saving a dangling link never creates content. Only explicit follow creates a root stub, transactionally; unresolved Work-ID-shaped addresses fail instead of squatting the stable Work-ID namespace. Explicit rename preserves the old address as an alias, and explicit removal unregisters an alias or primary declaration. Deleted targets remain resolvable and purged targets become dangling.

Work IDs are allocated through the service rather than by scanning in a client. `work-ids.status` reports the configured prefix, observed legacy prefixes, and next ID; `work-ids.configure` explicitly chooses the workspace prefix; `work-ids.allocate` optimistically appends the next ID to an opted-in canonical block. A clean existing prefix is adopted automatically, while ambiguous legacy prefixes remain visible but unconfigured. Canonical manual IDs for the configured prefix advance the same allocator; malformed, noncanonical, or out-of-prefix property values remain inert text metadata. The reservation ledger retains owning UUIDs after purge.

For a human writing notes, the intended promotion flow is: write freely, decide a block has become durable work, then ask the agent to assign it a Work ID. The agent calls `outliner_work_id` rather than guessing a number. Typing `PIE-NNN` or `[[PIE-NNN]]` only references an existing assignment; it never allocates one.

`PIE-XXX` intent markers are planned in PIE-152 but are not shipped yet. Today they remain inert text and do not trigger an extension nudge, candidate search, allocation, relationship creation, or rewrite. PIE-152 will add deterministic prompt/focused-block/tool-result nudges plus a `work-placeholder-resolver` skill after the normalized query primitive in PIE-146.

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
- `/outliner-goto <query>`
- `/goto <query>` through the project command
- `/outliner-filter`
- `outliner_create`
- `outliner_update`
- `outliner_property_patch`
- `outliner_property_catalog`
- `outliner_query`
- `outliner_page`
- `outliner_work_id`
- `outliner_move`
- `outliner_selection`
- `outliner_annotate_file`

`outliner_query` accepts structured filters such as `{ key: "status", value: "in progress" }`, plus optional text and subtree fields. The service normalizes keys/values and applies the same bounded semantics used by human surfaces.

Before each agent turn, the extension injects a bounded view of the selected block, breadcrumb, and children. This injection fails open when the service is unavailable. It does not yet interpret `PREFIX-XXX`; that deterministic nudge is explicitly tracked by PIE-152.

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
