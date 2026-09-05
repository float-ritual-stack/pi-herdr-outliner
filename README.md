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
- JSON-lines RPC protocol v32 over a Unix socket.
- Reactive canonical content/view broadcasts, per-process Tree/Detail registration with Detail lock availability, exact-client UI commands, and source-aware `preview | open | reveal` navigation.
- Each Tree owns its cursor, occurrence selection, filter, viewport, collapsed rows, multiline expansion, explicit-navigation history, and browsing context; moving a Tree previews only in the first unlocked same-tab Detail and never replaces a locked anchor.
- Indexed `[property::value]` metadata with optimistic property patching and catalog queries.
- Exact block and fragment references using `((block-id))` and `((block-id^fragment-id))`, resolved to display titles in read mode while raw text remains editable.
- Unique normalized symbolic addresses from explicit `[page::address]` declarations and Work IDs, with aliases, explicit removal, bounded completion, dangling links, and transactional create-on-follow.
- Workspace-scoped monotonic Work-ID allocation adopts a clean existing prefix or requires explicit configuration, optimistically assigns the next immutable ID, and never reuses reserved or purged identifiers.
- Atomic canonical roadmap-item creation discovers the single project work queue, validates UUID relationships and complete routing metadata, allocates the immutable Work ID, and returns matching virtual-branch memberships in one transaction.
- Plain-clickable Work IDs, canonical UUIDs, exact references, and `[[address]]` links inside Tree/Detail, with OSC 8 `pi-outliner://` links retained for external terminal interoperability.
- Property-driven virtual branches with ranked or timestamp-sorted canonical roots, read-only contextual descendants through relative depth 2, independent occurrence disclosure, a 1,000-row branch budget, property-aware creation, and persisted manual root ordering.
- Agent-created blocks retain immutable creator provenance. Every later text or property mutation records its own `user`, `agent`, or `system` identity plus available actor, session, and task IDs, so edit attribution never depends on the creator.
- Recoverable deletion preserves canonical structure and identity, excludes Trash content from normal queries/completions, and requires explicit identifier-confirmed purge.
- Idempotent zero-context-loss Tree capture writes ordinary canonical children under one stable workspace Inbox without moving selection or navigation history.
- Client-local multiline-expanded Tree rows support viewport-sized intra-block PageUp/PageDown without changing the Tree cursor.
- Pi Markdown preview with line, page, endpoint, and mouse/trackpad scrolling.
- Detail renders source-spanned Markdown, nested Obsidian callouts, generated embeds, Backlinks, and a structured property inspector through one PreviewRegion focus/action model while canonical source remains authoritative.
- The property inspector preserves repeated keys and block/line/inline scope, offers inline disclosure plus a locked dedicated Detail pane, and routes typed block/page/Work-ID values through existing navigation.
- Grapheme-safe wrapped Detail editing, word motion, selection, deletion, bounded per-session undo/redo, completion, optimistic save, and whole-session Esc cancellation.
- Targeted ephemeral attention marks exact block/file source ranges in one addressed Tree or Detail without mutating content, selection, navigation history, or durable annotations. Marks expire, become stale instead of drifting when source changes, retain one current plus bounded supporting cues, and coalesce missed activity into a return summary.
- Each Detail visibly reports `Unlocked` or `Locked`; unlocked Details form a spatial preview/open pool, while locked Details retain exact context anchors.
- Durable UTF-16 source-range annotations for blocks and referenced files, with resilient reanchoring, explicit ambiguous/orphan states, threaded replies, lifecycle/promotion links, anchored two-column Detail gutter markers, session-only inline disclosure, and exact-range reveal.
- Herdr-owned pane placement/focus and current-pane recovery, one remembered service pane, per-process live client discovery, and an ephemeral runtime registry.
- Pi/OMP commands, tools, selection-context injection, canonical `/send-to-outline` capture, and deterministic configured `PREFIX-XXX` work-placeholder nudging.

Planned work is tracked inside the outliner itself; this document describes only
behavior already shipped on the current branch.

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

The manifest exposes three workspace/tab/pane actions:

- `open` preserves one **Outliner Service** tab. With no live Tree it opens an
  **Outliner** Tree and **Outliner Detail** beside the invoking pane with one
  fresh browsing context, then focuses the Tree. Otherwise it selects the Tree
  by the invoking pane, then an unambiguous Tree in the current tab, workspace,
  or project, and focuses that exact client. Ambiguity fails explicitly.
- `ensure-detail` applies the same Tree selection. It focuses an existing Detail
  in that Tree's tab, preferring the Tree's browsing context, an unlocked pane,
  and then spatial pane order; if the tab has none, it opens one below the Tree
  in the Tree's context. With no Tree it opens a complete pair.
- `open-here` always creates a new Tree/Detail pair beside the invoking pane in
  the current tab. The pair shares a fresh ephemeral browsing context and the
  new Tree receives focus.

Invoke any action as
`herdr plugin action invoke <action> --plugin float.pi-outliner`.

Tab labels, tab numbers, pane titles, and labels such as `oi` are display
metadata—not routing keys. The CLI and Pi/OMP `outliner_clients` tool expose
live client and context IDs for diagnostics and explicit targeting.

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

Press `d` in Tree to create and focus an independent Detail to the right, or
`Shift+D` to create it below. The new pane receives a fresh browsing context
seeded with the selected canonical block, so later Tree cursor movement does
not replace it. It remains unlocked for explicit opens until you lock it.

When a block becomes a context anchor, focus its Detail and press `L`, `i`,
`Ctrl+L`, or `Command/Meta+L`. The header changes to **Locked**, and that pane
is removed from the preview/open pool. The next Tree selection therefore
appears in the next unlocked Detail. Entering block edit or annotation-comment
mode locks the Detail automatically. Locking never silently expires; explicitly
unlock the pane to make it eligible again.

`o`, plain-clicked references, and typed Property targets inside Detail open one
destination chooser without navigating first. `Shift+R` explicitly replaces
the current Detail while preserving its lock state, `f` uses the first unlocked
same-tab Detail, `r` splits right, and `d` splits down. `Enter` uses the first
unlocked Detail or creates a right split when none is available. `f` remains in
the chooser when every Detail is locked, so fallback topology is always an
explicit choice. `Esc` dismisses without resolving or opening the target. `R`
outside the chooser reveals the reference in the paired or unique same-tab Tree.
Block-fragment targets retain their exact anchor across every destination.

Activating an inline Backlinks source opens a transient preview over the
invoking Detail instead of consuming another reader. `Left` and `Right` traverse
the captured filtered/sorted source set. `Esc` restores the exact inline row
without navigation. `Enter` opens the same destination chooser used by Detail
references and typed Property targets.

An idle chooser dismisses after 7,500 ms. Any chooser input resets the timer.
Set `OUTLINER_OPEN_DESTINATION_TIMEOUT_MS` on the Herdr process to an integer
from 1,000 through 60,000 milliseconds; invalid values retain the default.

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

The footer in each pane is generated from the effective action registry and is
authoritative for the current mode. The tables below list defaults. Press `?`
or click the pane-corner `[⋯]` target to open the same contextual action menu.
Type to fuzzy-filter action labels, descriptions, bindings, and IDs; Backspace
edits the query. Use Up/Down and Enter, click an action, or press Esc to close.
The menu also includes currently unbound actions.

Detail resolves each terminal chord once against an ordered context stack:
global close, active chooser/filter/completion/editor, focused projection, then
the base preview, annotation, file, or Property mode. Resolution produces a
semantic action ID that keyboard input, rebound chords, the action menu, and
clickable action links execute through one direct dispatcher; resolved actions
are never converted back into synthetic keystrokes. Only input not owned by an
application action reaches the active text editor or transient text field.

Herdr owns secondary-click by default. Set `OUTLINER_RIGHT_CLICK=outliner` when
launching Tree and Detail to make content secondary-click open the same menu at
the pointer. Outliner registers `right_click=pane` only while it is running and
restores `herdr` on exit; the surrounding pane frame remains Herdr-owned in
either mode.

Tree and Detail expose configured block properties as compact one-line summaries.
Set `OUTLINER_PROPERTY_SUMMARY_KEYS` on the Herdr process to a comma-separated
property order; the default is `status,work-stage,priority,track`. An explicit
empty value hides summaries. Detail places the summary beneath its prominent
title. Collapsed Tree rows right-align summaries against the row's available
width, omit a lone property's repeated key, remove lower-priority fields before
truncating the title, and never add a second row.
The complete authored metadata remains available in expanded rows and the
property inspector. Detail also right-aligns the clickable `🔓`/`🔒` lock and
`[⋯]` action controls.

Tree rows also apply a fixed presentation-only treatment to direct canonical
`status` and `work-stage` values. Blocked, doing/active, review/validate,
done/complete, and unprioritized rows receive distinct one-column glyphs and
semantic terminal colors; unknown, planned, and absent values remain neutral.
Blocked wins over active state, selection keeps its background across inline
styles, and canonical plus projected occurrences use the same derived treatment.

Virtual branches compose other virtual branches encountered inside projected
hub descendants through four bounded nesting levels. Cycle detection and the
existing 1,000-row projection budget remain hard stops; the branch badge reports
depth or budget truncation rather than silently recursing without bound.

Override bindings with
`$XDG_CONFIG_HOME/pi-herdr-outliner/keybindings.json` (falling back to
`~/.config/pi-herdr-outliner/keybindings.json`), or set
`OUTLINER_KEYBINDINGS_PATH`. The file is a JSON object from stable action ID to
an array of chords; an empty array leaves that action unbound:

```json
{
  "tree.move.down": ["j"],
  "detail.edit.begin": ["x"],
  "detail.preview.down": ["j"],
  "detail.buffer.save": ["Ctrl+S"],
  "tree.file.open": []
}
```

`Ctrl+R` reloads the file in browse/preview modes. Reload is atomic: malformed
chords, unknown action IDs, active-scope collisions, or removing the only
cancel route rejects the entire candidate and preserves the prior bindings.

### Tree browse mode

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move selection |
| `PageUp` / `PageDown` | Scroll within the selected multiline-expanded block |
| `Left` / `Right` | Collapse/go to parent; expand/go to first child |
| `Shift+Up` / `Shift+Down` | Reorder canonical siblings, or branch-local projected occurrences |
| `Enter` | Focus the current block in the first unlocked same-tab Detail; remain unlocked |
| `d` / `Shift+D` | Create and focus a new independent Detail to the right / below |
| `e` | Edit a single-line block inline; open and lock a multiline block in the first unlocked Detail |
| `a` / `s` | Add child / sibling |
| `c` | Open the Herdr quick-capture popup; Enter adds a line, Ctrl+S saves to Inbox, Esc cancels |
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
| `Delete`, then `y` | Confirm moving the selected canonical subtree to Trash |
| `r` | Restore a selected direct Trash root |
| `p` | Type the work ID/short UUID to permanently purge a Trash root |
| `Ctrl+Q` | Close the pane |

Plain-clicking a Tree row selects it and publishes that row to its linked Detail.
`Ctrl`/`Meta`-clicking a Tree row selects and opens it; when the clicked cell is
an authored `PIE-NNN`, canonical UUID, exact reference, or `[[address]]`, the
referenced target opens instead. Authored links in Detail retain direct
plain-click opening. Generated Backlink and Property rows use plain click for
selection and `Ctrl`/`Meta` click for activation. SGR mouse reporting exposes
Ctrl and Meta/Alt; Command-click works when the host maps Command to Meta.
Shift remains the terminal-native text-selection escape while Tree mouse
reporting is active; Detail edit mode owns drag selection directly.
Registered Work IDs resolve without fuzzy matching and never create content when
missing. Following another dangling address creates
one canonical page stub before dispatch. Each Detail breadcrumb segment is an
exact link that reveals that ancestor or leaf in Tree rather than opening
another Detail.

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
| `E` | Toggle subtle full-width backgrounds around generated embed regions in this Detail |
| `b` | Expand/collapse the generated Backlinks section; the first expansion loads results lazily |
| `/` | Edit a fuzzy backlink-source filter; Enter applies and Esc cancels |
| `s` | Cycle updated/created timestamp sorting in descending/ascending order |
| `Tab` / `Shift+Tab` | Select the next / previous backlink source while Backlinks is expanded |
| `.` | Expand/collapse occurrence details for the selected backlink source |
| Backlink/Property row click | Select and highlight that generated row |
| `Ctrl`/`Meta`-click | Peek a Backlink source or open a typed Property target |
| `Enter` | Peek at the focused backlink source without navigating this Detail |
| Peek: `Left` / `Right` | Preview the previous / next source in the captured filtered/sorted set |
| Peek: `Esc` | Cancel, restore the exact inline source row, and leave this Detail unchanged |
| Peek: `Enter` | Open the shared destination chooser |
| Peek: configured Detail right/below binding | Open the current preview directly in a new right/down Detail |
| Chooser: configured Detail right/below binding or `r` / `d`; `Shift+R` / `f` | Split right/down; replace this Detail / use first unlocked Detail |
| Chooser: `Enter` / `Esc` | Use the default destination / dismiss without navigation |
| `e` | Lock this Detail and edit raw canonical text |
| `f` | Open referenced file |
| `o` | Open the first authored reference in the shared destination chooser |
| `R` | Reveal the block currently shown by this Detail in its paired or unique same-tab Tree |
| `L`, `i`, `Ctrl+L`, or `Command/Meta+L` | Lock this block as an anchor, or unlock the Detail for previews and opens |
| `Option+Shift+Right` / `Option+Shift+Down` | Open the current target in a new independent Detail to the right / below |
| `Option+Left` / `Option+Right` | Move backward / forward through this Detail's local history without changing lock state |
| `r` | Restore the selected block when it is a direct Trash root |
| `q` | Focus Tree; close a dedicated Property Detail |
| `Ctrl+Q` | Close Detail |

Detail navigation history is local to that Detail process and retains at most 200 exact targets. Opening a reference, receiving an exact target, or following the paired Tree records a visit. Back/forward pins the historical target so a later Tree cursor event cannot immediately replace it. Soft-deleted targets reopen read-only; a purged target remains visible as unavailable. Closing Detail discards this history.

Detail parses the complete projected Markdown document before applying generated
embed decoration. Exact character and line spans are recovered from the parsed
block stream, then only decoration boundaries are rendered as separate Pi
Markdown components. This keeps following authored text outside a lifted table,
list, quote, or code fence while preserving structural syntax and full-width
embed backgrounds at narrow and wide terminal widths.

#### Callout appearance

Detail gives each canonical Obsidian callout type a terminal-safe one-column glyph
and a semantic foreground, card background, and accent rail. Aliases such as
`faq`, `attention`, and `check` inherit the `question`, `warning`, and `success`
styles. Unknown types keep their authored title and use the neutral fallback.

Sibling callouts preserve authored whitespace. Adjacent headers—and headers
separated only by a quoted blank line (`>`)—render as touching cards. One or
more unquoted blank source lines render as the same number of empty rows between
the cards.

Set `OUTLINER_CALLOUT_THEME` on the Herdr process to override only the roles you
need. Values are JSON, colors are `#RRGGBB`, glyphs must occupy exactly one
terminal column, and keys must be canonical types or `fallback`:

```sh
OUTLINER_CALLOUT_THEME='{"warning":{"background":"#302714","accent":"#FFD166","glyph":"!"},"fallback":{"accent":"#8B98A5"}}' herdr
```

Invalid fields retain their defaults and emit a startup diagnostic instead of
making the Detail unreadable. Configuration affects presentation only; authored
callout syntax and fold state remain unchanged.

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
edit buffer or saved `Block.text`; clicking a source row selects and highlights
it, while `Enter` or `Ctrl`/`Meta`-click opens a reversible preview over the
invoking Detail. The popup captures the current filtered/sorted source set once:
`Left`/`Right` traverse it and `Esc` restores the exact inline row without
navigation. `Enter` opens the destination chooser. `Shift+R` replaces the
invoking Detail regardless of lock state, `f` uses the first unlocked Detail,
`r` splits right, and `d` splits down. A second `Enter` uses the first unlocked
Detail or falls back to a right split. `R` outside the popup still reveals the
selected source in Tree.

### Detail source comments

Press `v` in block preview to begin a locked, read-only selection without replacing or reflowing the rendered reader. Shift-motion or primary-button drag selects an exact authored UTF-16 range; the range stays highlighted in place. `c` mounts a reusable contextual buffer over the bottom of the reader, quotes the selected excerpt, and leaves the resource, layout, and scroll position intact. `Ctrl+S` stores the comment and closes the buffer; `Esc` cancels without creating a block. File view retains line-range selection with the same contextual buffer. Annotation view `r` returns to the source with the resolved block range or file lines selected; ambiguous and orphaned anchors are reported instead of guessed.

### Detail edit and comment modes

| Key | Action |
| --- | --- |
| Arrow keys | Grapheme-safe character/physical-line movement |
| `Option+Left/Right`, `Ctrl+Left/Right`, `Option+B/F` | Previous/next word start |
| `Home` / `End`, `Ctrl+A` / `Ctrl+E` | Physical line start / end |
| `Shift` + a supported motion | Extend selection |
| Primary-button drag | Select exact authored text across wrapped rows and Unicode graphemes |
| `Command+A` or `Ctrl+Shift+A` | Select all |
| `Ctrl+C` or `Command+C` | Copy the selected authored text through the terminal clipboard |
| `Ctrl/Command+Z` | Undo the previous edit group |
| `Ctrl+Shift+Z` or `Ctrl+Y` | Redo |
| `Backspace` / `Delete` | Delete selection or one grapheme |
| `Tab` or `Ctrl+Space` | Open completion in block edit mode |
| `Ctrl+W` | Move focus between the wide editor and draft preview |
| `Ctrl+L` | Toggle source-line-linked editor/preview scrolling |
| `Ctrl+S` | Save block or add annotation |
| `Esc` | Cancel the complete edit session and return to Tree |

Long physical lines wrap without changing raw text. Continuation rows remain associated with one physical line number, and keyboard or pointer selection maps back to exact authored source. Bracketed paste replaces the selection and remains one edit even when terminal payload chunks arrive separately. Keyboard cursor movement keeps the active edge visible.

In edit mode, wheel/trackpad input scrolls the region under the pointer. Editor scrolling changes only its visual viewport; it never moves the text cursor. The next keyboard cursor movement restores cursor-follow. A primary press-drag-release gesture in the editor maps through headers, split geometry, line-number width, wrapping, tabs, grapheme boundaries, and Unicode display width to a valid source range, with edge dragging scrolling the editor viewport. Preview clicks retain their existing link and region actions.

Wide split scrolling is independent by default. `Ctrl+L` enables an ephemeral linked mode, shown by `↔` in the editor header. Linked movement uses draft source-line anchors rather than proportional row offsets; generated projections without a shared raw-source anchor leave the peer unchanged. Link state and manual viewport state reset on edit-session or viewport changes and never modify block text.

Undo history is bounded to the current edit/comment session. Consecutive typing and deletion coalesce; cursor/selection state is restored; a divergent edit clears redo. Save or Esc-cancel ends the history.

## Blocks, properties, and references

A block stores canonical text plus structural fields. Properties are written directly in that text:

```text
Investigate page navigation [type::roadmap-item] [status::planned] [work-stage::next]
```

Every deliberate non-literal property is indexed in `block_properties`; canonical `Block.text` remains the source of truth. The first contiguous property-only run after an optional subject line is block metadata, as is the trailing bracket-property run on the subject. Bare `key:: value` properties later in the body have `line` scope; later bracket tokens have `inline` scope. Literal examples inside inline/fenced code and escaped bracket syntax are not indexed.

### Bounded block queries

The service owns one structured `BlockSearchQuery` used by Tree filters, virtual branches, CLI, Pi commands, and agent tools. Property filters are positive AND clauses with presence or exact equality:

```text
status=open priority
status="in progress" project=pi-outliner
status::"in review" type::roadmap-item
```

Whitespace separates clauses outside double quotes. `key` checks property presence; `key=value` and `key::value` check case-insensitive exact equality. Double-quoted values preserve spaces and support only `\\` and `\"` escapes. Invalid syntax reports a character position instead of becoming an accidental query. OR, NOT, ranges, grouping, aggregation, and reference traversal are intentionally not supported by the property expression.

Property filters and catalogs default to `block` scope, so body examples and line-local annotations cannot silently change workflow semantics. Callers can explicitly request `block`, `line`, `inline`, or `all` through `propertyScope`; broader block-query results include each matching record’s scope, ordinal, line, column, and source span. Text substring, subtree root, deleted-content mode, projection rank context, timestamp sort, and limit remain explicit structured fields rather than reserved filter words. Timestamp sorting accepts `created` or `updated` with `asc` or `desc`, orders the full matched collection before applying the limit, and cannot be combined with manual projection ranks. Every query carries a limit from 1 through 1000 and returns `complete` or `truncated` metadata. Tree `/` mode uses the block-scoped property catalog for key/value completion; agents call `outliner_query` with structured filters and never parse the shorthand. CLI `list` exposes the same parser through repeatable `--filter` flags and requires an explicit `--limit`.

### Quick capture Inbox

Tree `c` opens the manifest-owned Herdr popup without navigating away from the selected row. The popup reuses the Detail multiline editor’s `TextBuffer`, command mapping, wrapping, cursor, selection, and row renderer: Enter adds a line, Ctrl+S explicitly saves, and Esc/Ctrl+C cancels. Multiline paste is preserved. A failed save leaves the full draft and request identity in the popup for a safe retry.

`capture.create` writes one ordinary canonical child beneath the active `[system-view::inbox]` block. Tree, CLI, Pi/OMP tools/commands, and exact standalone dispatch markers are adapters over this same mutation. Captures include:

```text
Useful title [type::capture] [status::unprocessed] [capture-source::tree] [captured-at::<ISO timestamp>] [captured-from::<optional canonical block UUID>]
Optional supporting detail on later lines.
```

The optional captured-from block is context evidence, not the capture’s parent. Lifecycle metadata is a trailing block-scoped property run on the first authored line, so the useful title remains first; compact Tree rows hide that metadata and supporting lines until expanded. The Inbox can be renamed or moved while retaining its canonical identity. Persistent request receipts make retries idempotent across reconnects and service restarts. Capture never changes workspace selection/history; the Tree restores the exact prior row and shows a compact receipt. Routing, enrichment, Inbox processing, and concrete third-party launcher integrations remain later work.

CLI accepts `--text`, explicit `--stdin`, or automatic non-TTY stdin/heredoc input. `--request-id` provides caller-controlled retry identity and `--captured-from` records optional context. Receipt JSON is written to stdout; service failure exits nonzero without a local fallback.

The Pi extension registers `/capture` and `outliner_capture`. An exact standalone `float.dispatch(…)` input is intercepted by the Pi/OMP input hook, durably captured, acknowledged, and handled without starting an agent turn. Embedded/conversational markers are left untouched; malformed markers report a warning and continue as ordinary input.

`/send-to-outline` copies the latest completed assistant Markdown from the
current Pi/OMP session into Inbox as an ordinary agent-authored canonical
capture with session provenance. Capture succeeds independently of presentation.
When a recently focused or unique Tree is available, the command focuses the new
block there and dispatches an ordinary open to the first eligible Detail; if
Tree or Detail routing is unavailable, the durable Inbox block remains and the
command reports that presentation failure. Links, backlinks, block references,
embeds, and bounded queries therefore use the ordinary Detail projection.
Responses remain chat-only unless the command is invoked; there is no disposable
report slot or report pane.

Exact references use stable block IDs:

```text
Depends on ((516e1754-7741-4c9e-83a6-7b703a8f0798|the approved boundary))
```

Exact references accept `((block-id))`, `((block-id|label))`, `((block-id^fragment-id))`, and `((block-id^fragment-id|label))`. The optional authored label controls only presentation: following and backlinks retain the canonical block ID and optional fragment. Read views resolve untitled references to current target titles and titled references to their labels; edit views, exports, and storage retain the exact raw syntax. A label cannot be empty, whitespace-only, multiline, or contain the closing `))` delimiter. Symbolic links use `[[address]]`; a block registers an address through `[page::address]`, and existing Work IDs participate in the same unique normalized registry. Accepting completion for a Work-ID address inserts its exact `((block-id))` reference, so read mode renders the full current block title instead of only the identifier; ordinary pages and aliases retain `[[address]]`. Parsing or saving a dangling link never creates content. Only explicit follow creates a root stub, transactionally; unresolved Work-ID-shaped addresses fail instead of squatting the stable Work-ID namespace. Explicit rename preserves the old address as an alias, and explicit removal unregisters an alias or primary declaration. Deleted targets remain resolvable and purged targets become dangling.

Detail preview removes the authored `((…))` and `[[…]]` delimiters from valid links and applies one semantic link treatment to only the resolved title or label. Missing titled block targets render as an unlinked `label · Missing target`; invalid syntax stays raw. Keyboard follow, click navigation, edit mode, storage, and export continue to use the canonical authored target.

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

Generated embed regions use Pi TUI's `Box` background component to preserve
Markdown styling and wrapped-line boundaries while shading the full available
width. Shading is enabled by default. `E` toggles it for the current Detail
process without changing canonical text or any other Detail.

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
[sort::updated]
[direction::desc]
[limit::20]
[summary-properties::work-stage,status,priority]
```

Spaced values use the same canonical filter syntax:

```text
[query::status="in progress" project=pi-outliner]
```

A virtual branch can override the workspace Tree summary order for its projected
occurrences with `[summary-properties::key,key,…]`. The override is
presentation-only; ordinary and projected rows continue to read the same
canonical parsed properties.

Matches appear as disposable `◇` root occurrences. Each matched root also projects
its canonical descendants as read-only context through relative depth 2. Context
has independent, ephemeral disclosure; `Left` and `Right` navigate its projected
parent/children without changing canonical text or storage. A canonical block may
therefore appear beneath a matched ancestor and independently as a matched root,
and may still appear in multiple branches.

Each branch reserves its bounded, deduplicated roots before allocating contextual
descendants in root/canonical-preorder order. Unsorted branches apply persisted
manual ranks before the limit. `[sort::created]` and `[sort::updated]` instead
order the complete match set by timestamp before limiting; `[direction::asc]` or
`[direction::desc]` chooses the direction and defaults to `desc`. Roots and
context share a 1,000-row budget. Physical virtual-branch definitions reached as
context are inert leaves. Root-query, depth, and row-budget truncation are
reported separately, and allocation does not depend on disclosure state.

`Shift+Up` / `Shift+Down` reorders matched roots within an unsorted branch using
persisted occurrence ranks. Timestamp-sorted branches disable manual occurrence
reorder. Contextual descendants never participate. Canonical parent/position
order stays unchanged, and ranks survive temporary query mismatches.

## Agent integration

The project Pi extension is auto-discovered through [`.pi/extensions/outliner.ts`](.pi/extensions/outliner.ts). It registers:

- `/outliner`
- `/outliner-task [status|start <address>|pause|complete <proof-block-id>|clear]`
- `/outliner-goto <query>`
- `/goto <query>` through the project command
- `/outliner-filter`
- `/capture <text>`
- `/send-to-outline`
- `/roadmap-item <create|update|promote|rank> <details>` through the bundled prompt template
- `outliner_task`
- `outliner_delivery`
- `outliner_focus`
- `outliner_publish`
- `outliner_create`
- `outliner_roadmap_create`
- `outliner_branch_rank`
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
- `outliner_annotations`
- `outliner_annotate`
- `outliner_annotation_reply`
- `outliner_annotation_lifecycle`
- `outliner_annotation_batch`
- `outliner_attention`
- `outliner_workflow`

`outliner_query` accepts structured filters such as `{ key: "status", value: "in progress" }`, plus optional text and subtree fields. The service normalizes keys/values and applies the same bounded semantics used by human surfaces. `outliner_focus` targets an explicit or unique live Tree client and returns compact structural context.

Annotation tools use the same canonical child blocks as Detail. Targets carry a block ID or file identity plus UTF-16 offsets, excerpt, bounded before/after context, source version, and hash. Create and batch calls are idempotent; invalid batches create nothing. Replies retain the root target, lifecycle changes can link promoted canonical blocks, and inspection returns explicit anchor state.

`outliner_attention` requires an explicit live client ID. It can mark, advance,
acknowledge, clear, or inspect short-lived block/file attention. Exact UTF-16
anchors carry source version/hash evidence; stale source is rejected on create
and existing marks become visibly stale after a source change. `reveal` and
`focus` are explicit, independent opt-ins. Without them, the target pane's
selection, navigation history, lock, and canonical content do not change.

`outliner_workflow` starts only the typed `walkthrough.plan` action with an
explicit capability allowlist, fan-out bound, call bound, and invocation
(`block`, `callout`, structured query, or the literal `walkthrough` command).
A separate Pi SDK-side orchestrator compares ordinary sequential tool use with
an inert Callscript plan that can call only `outline.structure` and
`outline.route`. Both paths produce the same ordered route of source anchors;
neither copies source bodies or persists narration. Run state records identity,
inputs, provenance, route, current step, completeness, truncation, operations,
model-turn estimate, context bytes, wall time, cancellation, and linked result
blocks. `next`, `previous`, `pause`, `resume`, `skip`, `branch`, and `end`
advance targeted `outliner_attention` without changing selection or canonical
source text. Questions remain ordinary PIE-210 annotation threads. Promotion
requires an exact preview token and an idempotent commit request before creating
one linked canonical decision, follow-up, task, or artifact.

`outliner_roadmap_create` is the canonical new-work path: it fails without a partial block or consumed Work ID when queue discovery, metadata, or relationship validation fails. New work defaults to `unprioritized`. `outliner_branch_rank` updates only persisted virtual occurrence ranks; it neither moves canonical blocks nor changes `work-stage`, and ranks remain available across temporary query mismatches.

`outliner_task` persists one active roadmap block per Pi session. Starting a
code-delivery item first transactionally ensures one canonical child
`[type::delivery]` record, then safely attaches or creates its recorded
Work-ID-bearing branch, and only then moves `work-stage` to `doing`. Reentry
reuses the same repository, base branch, and work branch. Pausing returns the
task to `next`. Completion still requires a child or `source-block` proof; when
a delivery exists it additionally requires an observed merged PR and the
Validate stage before moving the delivery to Complete, the task to `done`, and
clearing the session binding. Agent lifecycle events never infer semantic
completion.

The durable delivery block owns `delivery-key`, `repository`, `base-branch`,
`work-branch`, `delivery-stage`, and observed pull-request facts. It never owns
another `work-id`. `outliner_delivery` exposes status, deterministic ensure,
live GitHub synchronization, and one owner-confirmed policy override with a
printable reason. Git and GitHub remain authoritative for branch, PR, review,
and merge facts; the Outliner stores identity and observed lifecycle state.

The shared Pi/OMP extension inspects the invocation-local checkout through
bounded, argument-array `pi.exec` calls. Every active-task turn receives a
compact repository/branch/dirty/ahead invariant. Task start reuses a recorded
local or remote branch, creates a missing branch from the recorded base, and
returns another-worktree paths instead of stealing them. Dirty wrong branches,
detached HEAD, wrong repositories, missing bases, and Git conflicts leave both
Git and roadmap stage unchanged. It never stages, stashes, commits, or opens a
pull request.

While a delivery is unoriented, `tool_call` blocks file/shell mutation and
matching GitHub PR creation fails preflight. Task start and mutation cannot be
sibling tool calls. Session switch, fork, and tree navigation use the same
gate. Read-only inspection and the lifecycle repair tools remain available.
An explicit owner-confirmed override changes those policy gates while retaining
the observed facts and durable reason.

An exact open PR advances Doing to Review; its exact merged commit advances
Review to Validate. Repeated sync and session reentry select the same delivery
identity and are idempotent.

Before each agent turn, the extension uses Herdr pane-focus history to locate the most recently focused registered Outliner client, reads that client's browsing context, and injects the focused block body, breadcrumb, properties, and children. A different active task is appended as separate session context rather than replacing the user's focus. Without a focused Outliner client it falls back to the active task and then the legacy shared selection.

The same bounded context budget can include up to five distinct blocks recently edited by the user. The first turn considers a seven-day horizon; later turns request only activity newer than a session-persisted cursor. Entries use current block text, deduplicate the focused block and active task, and report exact UUID and edit time. Failed or timed-out activity queries add nothing and do not advance the cursor. Agent and system mutations never enter this user-activity section.

[`outliner-workflow`](pi-extension/skills/outliner-workflow/SKILL.md) defines when to publish durable findings, decisions, roadmap reviews, syntheses, progress, and implementation proof through `outliner_publish` rather than leaving useful workspace knowledge only in chat. Context and presence integration fail open when their optional surfaces are unavailable. Deterministic configured `PREFIX-XXX` nudging is shipped: the extension inspects prompts, focused block text, and textual `outliner_*` tool results and injects at most one resolver reminder per turn without performing the resolution itself.

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
bun run profile:tree
```

The deterministic Tree profile defaults to 24,000 physical blocks and five
200-root virtual branches. The current performance guardrails are p95 below
50 ms for projection/controller initialization, 5 ms for viewport layout/render,
and 1 ms for input handling; generated terminal-frame writes stay below 1 ms.

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
