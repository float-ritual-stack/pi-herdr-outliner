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
- JSON-lines RPC protocol v3 over a Unix socket.
- Reactive content, selection, view, and UI-command events.
- Indexed `[property::value]` metadata with optimistic property patching and catalog queries.
- Exact block references using `((block-id))`, resolved to display titles in read mode while raw text remains editable.
- Property-driven virtual branches with canonical projected occurrences and property-aware creation.
- Pi Markdown preview with line, page, endpoint, and mouse/trackpad scrolling.
- Grapheme-safe wrapped Detail editing, word motion, selection, deletion, bounded per-session undo/redo, completion, optimistic save, and whole-session Esc cancellation.
- Referenced text/Markdown file viewing and durable line-range annotations.
- Herdr pane discovery, restart reconstruction, and a disposable runtime registry.
- Pi/OMP commands, tools, and selection-context injection.

Planned work is tracked inside the outliner itself. Notable accepted designs include branch-local ordering for virtual occurrences, `PIE-NNN` work IDs, symbolic `[[page]]` addresses, backlinks, and pinned reference panes.

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
bun run cli create --text "A durable note [type::note]"
bun run cli selection
bun run goto 40bd0864
bun run goto --query "roadmap review"
```

The CLI resolves the same workspace-scoped socket and database as the service. `goto` accepts a full UUID, unique short prefix, or unambiguous fuzzy title/content query. Eight-character IDs are convenience labels, not a uniqueness guarantee; ambiguous queries return full-UUID candidates without changing selection.

## Keyboard controls

The footer in each pane is authoritative and context-sensitive. These are the primary controls.

### Tree browse mode

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move selection |
| `Left` / `Right` | Collapse/go to parent; expand/go to first child |
| `Shift+Up` / `Shift+Down` | Reorder canonical siblings |
| `Enter` | Inline edit a single-line block; hand multiline blocks to Detail |
| `a` / `s` | Add child / sibling |
| `Tab` / `Shift+Tab` | Indent / outdent |
| `Space` | Toggle collapse |
| `.` or `Command+.` | Expand/collapse multiline block detail in Tree |
| `Ctrl+E` or modified Enter | Open the selected block in Detail |
| `g` | Fuzzy goto by UUID, short prefix, title, or content |
| `/` | Filter visible blocks |
| `f` | Open a referenced file |
| `d` | Enter delete confirmation |
| `Ctrl+Q` | Close the pane |

Projected virtual occurrences deliberately constrain hierarchy, collapse, and sibling reorder. Editing and confirmed deletion target their canonical block.

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
| `q` | Focus Tree |
| `Ctrl+Q` | Close Detail |

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

Exact references use stable block IDs:

```text
Depends on ((516e1754-7741-4c9e-83a6-7b703a8f0798))
```

Read views resolve the target title. Edit views retain the raw reference. Symbolic `[[page]]` addresses are an accepted design but are not implemented yet.

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

Matches appear as disposable `◇` occurrences. Creating beneath the branch creates one canonical block under `create-parent` and applies the configured property. The same canonical block may appear in multiple branches.

Current behavior intentionally rejects projected sibling reorder rather than mutating canonical order. Branch-local occurrence ranks are planned.

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
- `outliner_move`
- `outliner_selection`
- `outliner_annotate_file`

Before each agent turn, the extension injects a bounded view of the selected block, breadcrumb, and children. This injection fails open when the service is unavailable.

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
