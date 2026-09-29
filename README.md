# Pi Herdr Outliner

A persistent, local-first block outliner shared by a person and coding agents.

Pi Herdr Outliner runs as a workspace-scoped SQLite service with two terminal clients:

- **Tree** — navigate, create, edit, move, filter, and project blocks.
- **Detail** — read Markdown, inspect referenced files, annotate line ranges, and edit long-form block text.

The same service is exposed to Pi/OMP as agent tools, so notes, decisions, questions, work status, and file annotations live in one substrate instead of disappearing with a chat session.

> **Status:** active dogfood. The plugin is installable from the GitHub source checkout, but there is not yet a stable tagged release; schema and interaction details can still change.

See [`CHANGELOG.md`](CHANGELOG.md) for notable changes after the first dogfood tag.

After [opening the workspace](#open-the-workspace), start with these controls.
`?` in either pane shows the effective bindings and every available action.
Fresh workspaces also include **Explore the Outliner** beneath **Documentation**,
addressable as `[[outliner-tour]]`.

| To… | Start here |
| --- | --- |
| Find a note and preview it | Tree `g`: [Goto search](#tree-browse-mode) |
| Keep a reference beside your work | [Current, Preview, and linked Details](#working-with-multiple-details) |
| Read files and comment on a particular use | [Authored Resources](#inspect-authored-links) and [reference comments](#comments-on-individual-resource-references) |
| Capture a thought and inspect its cleanup | Tree `c`, then `Shift+I`: [Capture and Inbox](#capture-and-inbox) |
| Tune the AI's instructions | [Editable prompt files](#editing-ai-prompts) |
| Share notes and track work with an agent | [Agent tools, stages, and batches](#agent-integration) |

The [combined Tree/Detail surface](#combined-tree-and-detail-experiment) and
[automatic Inbox editor](#automatic-inbox-agent) are shipped experiments. The
normal separate-pane layout remains the default.

Inbox history search: click **Search /** or press `/` in Inbox. Search original capture titles, result summaries and current Source/Output text across the complete stored history. Up/Down selects an attempt while typing; Enter returns to result controls, and Alt+Enter opens its content in Detail. Escape or × restores the previous browsing position. Attempts retain their date and identity. Text results appear first; optional Jev reranking uses the same editable `goto-ranking.json` prompt as Goto. Session transcripts are diagnostics, excluded from this search. The shortlist is bounded and says when matches were omitted; Jev reranks that shortlist rather than searching missing candidates.

When Open has no linked reader (or that reader closed), a recovery bar offers
**Enter: Open here**, **L: Choose destination**, and **Esc: Cancel**. The first Open
only shows the choice. Confirming opens that exact target once: in the local
Preview for Tree/Inbox, or the current Detail with its existing edit protections.
The clickable controls do the same thing; no saved pane link changes.

## Why this exists

The project started as a small Friday-night experiment and grew into a durable workspace with a few explicit constraints:

1. **One canonical block graph.** UI projections and agent views never duplicate canonical content.
2. **Service-owned persistence.** Closing or restarting Tree does not destroy the workspace or Detail state.
3. **Human and agent collaboration.** Both use the same optimistic, evented API.
4. **Visible incompleteness.** Bounded queries report whether their result is complete or truncated.
5. **Properties remain text.** `[key::value]` tokens are readable canonical text and also indexed for queries.


## Combined Tree and Detail experiment

Herdr’s **Outliner: open combined Tree + Detail experiment** action opens a fixed
Tree/Detail split in one pane. The normal separate-pane action remains available.
From a Herdr pane, invoke it with:

```sh
herdr plugin action invoke open-composed --plugin float.pi-outliner
```

Tree owns its selected occurrence, history and scroll. Detail owns its target,
Current and Preview targets, retained Resource revisions, draft, undo/redo and scroll. Enter opens the
selected target in the primary Detail; `F6` switches regions, and `q` returns from
Detail to Tree. Ordinary navigation and focus remain usable while Herdr discovery
is unavailable, provided the Outliner service is healthy. Current remains in place during passive inspection; drafts and explicit source-selection mode
protect it from replacement.

The existing `o` destination chooser can replace the primary reader or open a
separate Detail to the right/below. Herdr still places, moves and closes detached
panes. Closing a view does not delete its blocks, Resources or annotations.
`Ctrl+Q` refuses to close a composed surface while a text or comment draft is
active. This is a keyboard guard, not draft persistence after a forced pane close
or process kill.

Native pointer selection inside Detail followed by `c` keeps source coordinates
through the split and resize. Herdr’s external copy-mode comment action is refused
for composed panes: its handoff identifies a pane and quote but cannot prove the
internal region. Use Detail’s pointer selection and `c`, or a standalone Detail.
Standalone copy-mode comments keep their existing behavior.

One live `role: "composed"` registration represents the host pane. Its
`treeSelection` and `currentTarget` describe different facts; `focusedRegion`
identifies the active region. Agent `ui.command.send` requests and attention
reveal/focus requests must name `targetRegion: "tree" | "detail"` for this client.
Walkthrough document steps target Detail. Resource retention uses Detail’s target,
including its exact revision, regardless of which region has keyboard focus.

Run `bun run test:e2e:composed` for the isolated actual-application journeys.
They record frames, state, native pointer input, registry fault/restoration,
detached movement/closure and process cleanup. A held publication/draft-protection
interleaving verifies that delayed Tree previews cannot change a draft's owner.
Generated Outlinks and Resources also open locally during discovery failure.
No shared user host is used.

## Current capabilities

- SQLite-backed hierarchical blocks with stable UUIDs, sibling order, authors, timestamps, and one canonical graph per workspace root.
- Workspace-isolated service and runtime paths.
- Versioned JSON-lines RPC over a Unix socket. `ping` reports the service protocol, the oldest client protocol it serves and its capabilities; clients accept any service at or above their minimum that offers the capabilities they use (see [Protocol and schema changes](CONTRIBUTING.md#protocol-and-schema-changes)).
- Reactive canonical content/view broadcasts, per-process Tree/Detail/observer registration with operation protection, exact-client UI commands, and source-aware `preview | open | reveal` navigation.
- Durable resources have UUID identities independent of blocks and mutable locators. Provider-qualified Sources bind filesystem roots or remote namespaces; overlapping Sources remain distinct, relocations preserve Resource IDs, provider revisions remain explicit, and capability resolution reports blockers across provider, credentials, workspace policy, host, and connectivity. Registered Detail hosts declare Surface, Placement, renderer, capability, credential, and connectivity facts; open/describe/refresh deterministically negotiate cached Markdown, embedded-browser, native-document, metadata, or external-link representations without changing Resource identity. PDF is a media type reachable through filesystem and web Sources: one captured binary snapshot can produce both native PDF and page-aware Markdown representations through versioned replaceable extractors.
- Each Tree owns its cursor, occurrence selection, filter, viewport, collapsed rows, multiline expansion, explicit-navigation history, and browsing context; moving a standalone Tree updates its own local Preview; composed Tree updates its embedded Detail Preview, while Current stays in place.
- Indexed `[property::value]` metadata with optimistic property patching and catalog queries.
- Exact block and fragment references using `((block-id))` and `((block-id^fragment-id))`, resolved to display titles in read mode while raw text remains editable.
- Unique normalized symbolic addresses from explicit `[page::address]` declarations and Work IDs, with aliases, explicit removal, bounded completion, dangling links, and transactional create-on-follow.
- Workspace-scoped monotonic Work-ID allocation adopts a clean existing prefix or requires explicit configuration, optimistically assigns the next immutable ID, and never reuses reserved or purged identifiers.
- Atomic canonical roadmap-item creation discovers the single project work queue, validates UUID relationships and complete routing metadata, allocates the immutable Work ID, and returns matching virtual-branch memberships in one transaction.
- Plain-clickable Work IDs, canonical UUIDs, exact references, and `[[address]]` links inside Tree/Detail, with OSC 8 `pi-outliner://` links retained for external terminal interoperability.
- Tree can project a selected block's Outlinks, Resources and Backlinks as read-only generated branches. Enumeration never creates pages, Resources, Sources, or provider traffic. Explicit activation follows or creates unresolved ordinary `[[page]]` links and human-authored `[file::…]`, `[web::…]`, `[jira::…]`, and `[app::…]` Resources; unresolved Work IDs stay unavailable.
- Property-driven virtual branches with ranked or timestamp-sorted canonical roots, contextual descendants through relative depth 2, independent occurrence disclosure, a 1,000-row branch budget, property-aware creation, and persisted manual root ordering.
- Fresh databases seed version 5 of the Documentation hub: an addressable feature tour, the agent documentation guide, native transclusions, a working virtual branch, and authored block, page, file, web, SSH-application, and Jira reference examples. Existing workspaces keep their customized content.
- Agent-created blocks retain immutable creator provenance. Every later text or property mutation records its own `user`, `agent`, or `system` identity plus available actor, session, and task IDs, so edit attribution never depends on the creator.
- Recoverable deletion preserves canonical structure and identity, excludes Trash content from normal queries/completions, and requires explicit identifier-confirmed purge.
- Idempotent quick capture retains drafts and writes ordinary canonical children under one workspace Inbox without moving selection or navigation history. The automatic Inbox agent can organize them using the configured Pi model, with optional Jev judgments, inspectable results, Pause/Resume, guarded Undo, and directed reconsideration.
- Canonical bookmarks use one strict record per target beneath the durable Bookmarks system view; Tree and Detail toggle them optimistically, and the generic split navigator resolves each record back to its live target without rewriting target text.
- Goto search combines immediate text matches, location context, and a document preview with optional bounded Jev ranking; exact UUIDs, pages, aliases, and Work IDs remain deterministic.
- Client-local multiline-expanded Tree rows support viewport-sized intra-block PageUp/PageDown without changing the Tree cursor.
- Pi Markdown preview with line, page, endpoint, and mouse/trackpad scrolling.
- Detail renders source-spanned Markdown, nested Obsidian callouts, generated embeds, Backlinks, and a structured property inspector through one PreviewRegion focus/action model while canonical source remains authoritative.
- The property inspector preserves repeated keys and block/line/inline scope, offers inline disclosure plus a dedicated Detail pane, and routes typed block/page/Work-ID values through existing navigation.
- Grapheme-safe wrapped Detail editing, word motion, selection, deletion, bounded per-session undo/redo, completion, optimistic save, and whole-session Esc cancellation.
- Targeted ephemeral attention marks exact block/file source ranges in one addressed Tree or Detail without mutating content, selection, navigation history, or durable annotations. Marks expire, become stale instead of drifting when source changes, retain one current plus bounded supporting cues, and coalesce missed activity into a return summary.
- Detail retains Current alongside a separate passive Preview. Explicit Open uses the source’s saved destination link; drafts and explicit source-selection mode protect Current from replacement.
- Durable annotations use ordinary blocks for comment and reply content, lifecycle, and promotion presentation. One relational sidecar owns immutable original targets and append-only resolution history for block, filesystem Resource, rendered, web, and provider evidence. Typed anchors share one codec seam. Reconciliation follows a deterministic ladder: unchanged representation, provider-native identity, structural quote verification, unique exact quote, context ranking, then bounded local fuzzy matching. High-confidence matches apply automatically; medium candidates remain probable, low candidates remain unresolved, and candidate targets and scores remain in history. Detail reveals only currently resolved text-quote positions and keeps probable, unresolved, ambiguous, orphaned, unsupported, and rejected outcomes inspectable.
- Herdr-owned pane placement/focus and current-pane recovery, one remembered service pane, per-process live client discovery, and an ephemeral runtime registry.
- Pi/OMP commands, tools, selection-context injection, canonical `/send-to-outline` capture, and deterministic configured `PREFIX-XXX` work-placeholder nudging.

Tree loads a complete structural index with bounded previews and fetches exact
bodies when needed. Detail paints the primary document before optional link and
projection enrichment; a bounded 32-target cache speeds revisits while revisions
remain service-owned. Ranked views reuse projection/query work rather than
introducing another persistent index.

Planned work is tracked inside the outliner itself; this document describes
behavior implemented on the current branch. Experiments are labeled explicitly.

### Web Resource snapshots

Opening a Web Resource never contacts the provider. Detail shows the latest
locally selected Markdown representation, or an `unknown` status with explicit
no-cache guidance when the Resource has no local snapshot. Press `r` to refresh.
Refresh is the only operation that performs provider reconciliation.

Each successful observation stores an immutable source snapshot with the
provider revision, source hash, fetched time, and full HTML. Markdown is a
separate immutable representation named by its adapter and version. An
unchanged source observation reuses its snapshot, while an extractor change can
create a new representation for that snapshot. The mutable Resource state only
points at the latest selected snapshot and representation and records freshness,
check time, refresh errors, and a compare-and-swap version.

Detail displays selected snapshot and representation provenance plus retained
history independently of the nullable current document. Relocation clears the
current pointers for the new address while prior snapshots and representations
remain inspectable offline. Annotations are queried through the shared
annotation repository rather than embedded in `ResourceDescription.webHistory`.
Legacy evidence is preserved exactly: an unmatched legacy file remains a
`legacy-file` subject with an orphaned migration event, and missing source bytes
or provenance stay unknown rather than being fabricated. Refresh failure does
not alter selected content or prior annotation resolution history.

### PDF Resource representations

Filesystem and HTTP PDF Resources retain the same Resource identity across
native and extracted presentations. Each successful observation stores one
immutable binary source snapshot. The built-in PDF.js adapter derives
page-aware Markdown plus text spans with PDF-point rectangles. TUI hosts receive
the extracted Markdown; when negotiation selects `native-document`, the service
delivers the exact retained PDF bytes to that native-capable Detail as a
representation-bound base64 payload. Extractor upgrades can derive a new text
representation from retained bytes during local open without changing the
source snapshot or fetching the provider again. A failed filesystem or HTTP
refresh leaves any retained PDF presentation visible with explicit diagnostics.

PDF annotation targets retain the source snapshot, derived representation,
page, exact quote and context, UTF-16 offsets, and page regions. Reconciliation
maps the deterministic quote ladder back through the current page spans, so
refreshes and extractor changes append an auditable PDF-specific result while
leaving the immutable original target unchanged. Retention protects PDF
evidence named by annotation history, allows native or extracted
representations to be pinned/referenced independently, propagates that
protection to source bytes, and records the same explicit
available/evicted/purged lifecycle for every PDF artifact.

### Remote entities and application deep links

Jira and Linear Sources represent one provider instance without storing
credentials. A remote entity Resource is keyed by the Source plus the
provider's immutable entity ID; Jira keys and Linear identifiers remain
mutable display locators. Opening is local-only. Explicit refresh performs the
provider request, stores an immutable structured snapshot and a versioned
Markdown representation, updates a changed display locator without changing
the Resource UUID, and keeps prior retained content visible after failure.

Provider commands are a closed, schema-checked protocol union rather than
generic mutation authority. The current Jira and Linear adapters expose
`comment.create` only when the provider supports it and credentials,
workspace policy, connectivity, and the destination host all allow
`command`. The server resolves the Resource and immutable entity identity
before execution; clients cannot select an entity through a mutable key.

Application Resources may contain only a validated deep link. They still
negotiate useful metadata in the TUI and an `external-link` on external hosts
without fabricating an inline document. `Alt+O` launches only the negotiated
current-Resource URL after `open-external` policy and host checks. Opening a
deep link does not imply read or command authority.

An SSH URI authored through `[file::user@host/path]` uses this application
path. It does not read the remote file or produce commentable source text.

### Computed Resources

Computed Sources name an in-process producer registry and carry the workspace
permission allowlist for that registry. A producer registration declares a
stable ID, positive version, TypeBox input schema, required permissions,
determinism, cache policy, output media types, and one async callback. The
service includes the deterministic `builtin.markdown-template` producer.

`computed.invocations.create` persists structured inputs and exact dependency
Resource revisions, then creates one computed Resource whose address is the
invocation UUID. `computed.invocations.revise` uses optimistic invocation
versions. Input changes increment the input version. Input or dependency
changes invalidate only that invocation's selected result.
Each immutable computed revision names its exact execution plus producer, input,
and dependency versions, so pinned reads cannot drift to a later nondeterministic output.

Authored text can refer to a producer only as `producer:<invocation-uuid>`.
`computed.handlers.resolve` performs an exact persisted invocation lookup. It
never evaluates note text, commands, module names, or executable snippets.

Execution is explicit. `computed.execute`, or `resources.refresh` from Detail's
`r` action, requires a registered Detail destination whose negotiated `refresh`
capability is available. Before calling the producer, the registry checks every
declared permission against the computed Source allowlist, validates and bounds
canonical structured input to 256 KiB by default, and starts a 15-second
abort-signaled execution deadline. Text output is limited to 1 MiB by default.
Schema, permission, timeout, output, provider, and callback failures are typed,
persisted, and available through `computed.executions.list`.

Producers can return a transient representation, immutable snapshot, durable
Resource reference, or typed failure. Transient content appears only in the
execution receipt. A successful deterministic content-addressed result reuses
the matching cache entry. Detail renders selected immutable Markdown before
metadata, followed by the exact dependency provenance and latest failure when
one exists. Opening or reopening the Resource reads local state only and never
runs its producer.

## Quick start

### Requirements

- Linux or macOS
- [Bun](https://bun.sh/) 1.3 or newer
- Herdr 0.9 or newer
- Git, for a Herdr-managed GitHub install
- Optional: [Gum](https://github.com/charmbracelet/gum) for the helper's
  polished interactive prompts; the plain POSIX interface remains available
- Pi/OMP only if you want the agent extension and slash commands

### Install with the helper

```sh
curl -fsSL https://raw.githubusercontent.com/float-ritual-stack/pi-herdr-outliner/main/install.sh | sh
```

The helper supports Linux and macOS. It checks Bun 1.3+, Herdr 0.9+, and Git,
offers to install missing dependencies, installs or refreshes the managed
plugin, and reconciles its `[[keys.command]]` entries in
`~/.config/herdr/config.toml`. Existing Outliner bindings become the prompt
defaults; stale action entries are removed, unrelated config is preserved, and
every changed config is backed up before Herdr reloads it.

When Gum is available in an interactive terminal, the helper automatically
uses its styled status, input, confirmation, and summary surfaces. No extra
flag is required. Use `--plain` to force the minimal interface; `--yes` stays
plain and non-interactive for automation.

The default shortcuts are `prefix+u` for a new Tree + Detail,
`prefix+shift+a` for commenting on retained Detail text, and `prefix+shift+c`
for Quick Capture from any pane. With Herdr's default prefix, capture is
Ctrl+B, then Shift+C. The helper moves the old default comment binding from
Shift+C to Shift+A when Capture takes that key; custom bindings remain defaults.
Capture uses the invoking project's running Outliner service,
including its configured remote connection. Press Enter to accept the keys,
type alternatives at the prompts, or pass them explicitly:

```sh
curl -fsSL https://raw.githubusercontent.com/float-ritual-stack/pi-herdr-outliner/main/install.sh |
  sh -s -- --open-key prefix+y --comment-key prefix+shift+y --capture-key prefix+shift+c
```

Use `--yes` for a non-interactive install with existing or default shortcuts,
`--plain` to disable Gum, `--no-config` to leave `config.toml` untouched, and
`--ref <tag-or-commit>` for a reproducible plugin revision. Run
`sh install.sh --help` for all options.

When Claude Code is installed, an interactive run also offers the
[Claude Code mod](claude-mod/README.md), which sends completed Claude replies to
Recent Mentions. It asks for the Outliner workspace (default: the current
directory), then updates the `env` block of `~/.claude/settings.json`: function
hooks on, the installed `claude-mod/` in `CLAUDE_CODE_PLUGIN_DIRS` in place of
any other copy, and the workspace added to `PI_OUTLINER_MENTIONS_WORKSPACES`.
The file is backed up first. Pass `--claude-workspace /absolute/project`
(repeatable) to install it without prompting, or `--no-claude-mod` to skip it.

### Install manually from GitHub

```sh
herdr plugin install float-ritual-stack/pi-herdr-outliner --ref main
herdr plugin list --plugin float.pi-outliner
```

Herdr clones the repository, previews its executable commands, runs the
manifest's dependency build step, and registers the plugin. Re-run the same
install command to refresh the managed checkout; Herdr plugin v1 has no
separate update command. Pin `--ref` to a tag or commit instead of `main` when
you need a reproducible revision.

### Link a development checkout

```sh
git clone https://github.com/float-ritual-stack/pi-herdr-outliner.git
cd pi-herdr-outliner
bun install --frozen-lockfile
herdr plugin link . --enabled
```

Run these commands from the repository root. `plugin link` registers the
working directory but does not run manifest build commands. A GitHub install
cannot replace a locally linked copy; run
`herdr plugin unlink float.pi-outliner` before switching that installation to
the managed GitHub source.

The plugin manifest is [`herdr-plugin.toml`](herdr-plugin.toml). Runtime
entrypoints execute from the installed or linked plugin root. The invoking
project is passed separately through `OUTLINER_WORKSPACE_ROOT`, so opening the
Outliner from another project does not change where Herdr resolves
`src/*.ts`.

Manifest commands launch Bun through `scripts/run-bun.sh`. The launcher checks
`BUN_INSTALL`, the server's inherited `PATH`, and the standard
`~/.bun/bin/bun` location. Installing Bun after Herdr started therefore does
not require a server restart just to make plugin actions resolve the runtime.

### Verify or diagnose installation

```sh
herdr --version
bun --version
herdr plugin list --plugin float.pi-outliner --json
herdr plugin action list --plugin float.pi-outliner
herdr plugin log list --plugin float.pi-outliner --limit 20
```

The plugin requires Herdr 0.9 or newer and Bun 1.3 or newer. The install
command reports missing runtimes, dependency-build failures, and manifest
validation errors; `plugin log` reports runtime entrypoint failures. If Herdr
itself was updated while its server remained running, restart that session
before diagnosing server-side behavior.

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
- `ensure-detail` applies the same Tree selection and focuses its saved linked
  Detail, wherever that pane has moved. If the Tree has no link, this explicit
  host action creates a Detail below it and links the pair. An unavailable linked
  destination reports an error. With no Tree it opens a complete pair.
- `open-here` always creates a new Tree/Detail pair beside the invoking pane in
  the current tab. The pair shares a fresh ephemeral browsing context and the
  new Tree receives focus.

Opening never creates an outline by itself. A folder has an outline when it has
a project `client.json` (local or remote), an existing database in its state
directory, or remote mode set through `OUTLINER_REMOTE=1`. Otherwise every
action above (and `prefix+u`) shows a **Choose outline** popup instead. It says
which folder was resolved and from where (the invoking pane's directory or the
Herdr workspace root), lists the outlines this machine knows about (state
directories that hold a database, and project configs that point at a socket)
with running or stopped status, and offers **New outline here**. Use ↑/↓ or
j/k and Enter, or click a row; the wheel scrolls and Esc closes without creating
anything. Choosing an outline writes the folder's `client.json` in remote mode
with that outline's socket, so the next open in that folder connects directly;
a stopped local outline whose folder is known is started first. **New outline
here** writes a local `client.json` and only then creates the database. The Pi
extension's background `service-only` start refuses a folder without an outline
rather than creating one.

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
content updates. Each view keeps its own cursor, target, filter, viewport,
draft, and navigation history.

Standalone Tree cursor movement updates its own read-only **Preview**, even when
detached Details exist. The composed application shows Tree selection in its
embedded Detail Preview. Neither replaces **Current**, takes focus, or creates a
pane. Within Detail, wide readers show Current and Preview beside each other;
taller narrow readers stack them.
`Alt+P` (also `F7`) switches focus, or the visible reader when neither layout fits.
`Esc` closes a focused Preview, `Shift+F7` also closes it, and `Alt+Enter`
keeps Preview as Current. Current retains its history, scroll, and draft while
another target is inspected. Keeping Preview or opening another target is
refused while Current has a draft or is in explicit source-selection mode.

Text selection and copying in Detail or Preview do not lock navigation. A copied quote can be used for commenting while its document remains current; navigating or replacing that document discards the retained quote. Actual edit/comment drafts and explicit source-selection mode still protect in-progress work.

Tree and Inbox Preview links can be clicked to browse in place. Dragging still
copies text. Focus Preview and use `Tab`/`Shift+Tab`, then `Enter` to follow a
link; `Esc` returns focus to the list. `Alt+Left`/`Alt+Right` or the **‹ / ›** buttons revisit local history.
**Open** or `Alt+Enter` opens the currently previewed target in Detail, offering
a destination picker when needed. A new list selection starts a new Preview
trail. Missing pages are reported without creating notes; unsupported links
remain visible as such. Tree and Detail selection stay unchanged while browsing.

Tree `Enter` explicitly opens the selected target through that Tree's saved
Detail destination link and keeps focus in Tree. Press Enter again within one
second on the same row and destination to focus Detail, or use **Alt+Enter**
to open and focus immediately. Moving the selection or performing another action
ends that repeat sequence. **Alt+L**, **Shift+L**, or the clickable **Opens in / Change** header sets or changes the link; **Open once
in…** chooses a destination for one action. Several sources can share a reader,
and receiving a target never forwards it through the receiver's own link.
Moving or resizing panes does not change links. An absent destination reports
recovery choices; ordinary Open never selects a nearby pane or creates a split.

Press `Option+Shift+Right` in Tree to create and focus an independent Detail to
the right, or `Option+Shift+Down` to create it below. Creating a split is an
explicit action. Closing any view does not delete its documents or annotations.

`o`, plain-clicked references, and typed Property targets inside Detail open one
destination chooser before resolving the target. `Shift+R` replaces here,
`f` or `Enter` uses the saved link, `c` chooses an existing reader once, and
`r`/`d` creates a right/down split. Replacement respects the destination's draft
and source-selection protection. `Esc` dismisses without resolving or opening
the target. Outside the chooser, `Shift+R` reveals the block currently shown by
the Detail, while `Option+Shift+R` reveals its first authored reference.
Block-fragment targets retain their exact anchor across every destination.

#### Collect and rank several items

In Tree, `x` or **Note → Select / unselect item** starts a working selection.
Once started, row checkboxes toggle items with the pointer. Cursor navigation
and reading remain independent of the collected set. `Shift+X` or the selected
count opens its menu: inspect/read items, copy IDs, block references or verified
page links, and move the group up, down, to the top or to the bottom.

Bulk ranking applies only to matched roots in one unsorted virtual-branch
appearance. It preserves canonical parents and other branches' ranks. Up/down
moves each selected run past one adjacent unselected item. Hidden targets stay
counted; unavailable targets must be removed before copying or ranking. Unpaged
items offer block-reference copy rather than an invented page address.

Selections survive a restart. **Selected items** offers explicit recovery from a
closed pane; it never takes a selection from a live pane. **Clear** removes the
working set. These are temporary selections, not bookmarks or editing locks.
Service and clients need protocol 77 for the selection and bulk-placement RPCs.

#### Inspect authored links

Select a block in Tree, press `?`, and invoke **View · Show authored links**.
Tree inserts connection groups under that exact occurrence. **Backlinks** lists bounded incoming sources, alongside **Outlinks** and **Resources** below.

Click a resolved block row's disclosure triangle or press Right to inspect its own connections one level deeper. Left collapses it. Each occurrence retains its own state, so siblings remain open and you can explicitly follow A → B → A without automatic recursion. Reopening a parent restores its disclosed descendants; browsing does not write to the notes. Truncated reads and failed groups stay visible.

- **Outlinks** contains authored block references, `[[page]]` addresses, and Work
  IDs. Bare uppercase ticket keys such as `PC-7` and `PC-515` also link through
  registered page addresses, even when this workspace allocates `HUB-001`.
  Give an issue's local notes a `[page::PC-515]` address; recognition preserves
  the external key's spelling and does not allocate it. The same references
  participate in Backlinks and Recent Mentions. Unknown bare keys remain
  unresolved, and explicit `[jira::PC-515]` selects the provider Resource path.
  Resolved rows open through the Tree's saved Detail link. Merely showing or
  selecting an unresolved page is read-only; pressing `Enter` follows the
  address and transactionally creates its registered page only when necessary.
  An unresolved Work ID is never created implicitly.
- **Resources** recognizes human-authored provider references:
  - `[file::docs/plan.md]` addresses a file on the Outliner service's host.
    Relative paths use the service workspace; `~/` uses the service user's home.
    Tree and both Detail renderers read and complete these paths through the
    service, including in remote mode. Line ranges and rendering stay in the
    client. Passive previews and completion do not create Sources or Resources;
    explicit activation still owns registration.
  - `[file::evan@evans-box/path/to/file]` addresses an SSH application
    Resource. The Source and Resource are created only when the row is opened.
  - `[web::https://example.com/guide]` addresses a web Resource.
  - `[jira::PC-515]` addresses an issue through the single configured Jira
    Source for project `PC`. Activation resolves the provider's immutable issue
    identity before interning it.
  - `[app::scheme://authority/namespace/item]` addresses a generic configured
    application Resource.
  - `[label](pi-outliner://resource/<resource-uuid>)` remains the canonical
    syntax for an already cataloged Resource.

  A `jira::` line shows the ticket's stored details under it in Detail (a
  *resource projection*; Jira tickets are the first kind). With no key after
  `::`, the ticket is the nearest one in context: a key on the line, the nearest
  line above it within its section, the block's own `[jira::…]` property, the
  block's first line, then its ancestors. Keys in code or `<!-- literal -->`
  regions do not count. Two different keys at the nearest level are reported
  rather than guessed. The floatty form `- jira::` works
  too. `--compact` shows one line. `--comments` and `--full` are accepted for
  later slices: comments are not stored yet, and the description stays in the
  opened Resource. A block with a `[jira::KEY]`
  property shows its ticket at the top of the body. The region is read-only
  and shows when the details were fetched; Tab focuses its key and Enter (or a
  click) opens the Resource. Backlink Peek and Goto previews show it too. It never registers or fetches: an
  unregistered ticket shows how to register it, and `r` in the opened Resource
  still refreshes explicitly. `bun run cli ticket <block-uuid>` returns the same
  projection to agents.

  Showing the branch and moving selection are read-only. An unregistered
  human-authored row is labeled **Enter creates**. Pressing `Enter` performs
  provider resolution or local interning, creates the Source only for safe
  filesystem, web, or application defaults, creates the Resource, and opens
  its canonical identity in the linked Detail after destination preflight. Missing files,
  ambiguous Sources, unavailable credentials, and policy denials remain
  explicit errors rather than creating placeholders.

Fresh databases include **Authored links example** beneath **Documentation**.
It has one resolved block link, one initially unregistered page link, and
human-authored local-file, web, SSH-application, and Jira Resources. Showing
the branches is read-only. Activation demonstrates create-on-navigation,
missing-file errors, application metadata, and the configured-Source
requirement for Jira without fixture Resource UUIDs. With a live Tree, focus
the example from the project root with:

```sh
bun run goto "Authored links example"
```

Known limits in the current dogfood build:

- Tree-generated Resource opens require a valid linked Detail. Set **Link
  destination** before activation; an absent or protected destination fails
  before Resource registration. Inside Detail, Resource references use the
  shared destination chooser.
- `[file::user@host/path]` creates an SSH application deep link, not a
  source-backed remote file. SSH-backed text and `[ssh::host/path]` authoring
  are tracked as PIE-261.
- Metadata-only Resource fields are readable but do not support direct Detail
  comments. That interaction is tracked as PIE-262.
- Direct Detail comments work on filesystem text, cached web Markdown, and
  extracted PDF text. Computed and remote-entity cached Markdown support is
  tracked as PIE-264.

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
bun run cli list --filter work-stage=queued --limit 20
bun run cli list --filter 'status="in progress"' --filter project=pi-outliner --limit 20
bun run cli capture --text "A quick thought"
bun run cli capture <<'EOF'
Multiline capture with literal $VARIABLE and Unicode 🐢.
EOF
bun run cli list --subtree <block-uuid> --text "route snapshot" --limit 20
bun run cli list --filter type=roadmap-item --limit 400 --fields title,properties,revision
bun run cli read <block-uuid> <block-uuid> --fields title,properties
bun run cli list --query "type=task (work-stage=review OR work-stage=validate) updated >= -7d"
bun run cli view <saved-virtual-branch-uuid>
bun run cli view <saved-virtual-branch-uuid> --limit 500 --expected <revision>
bun run cli view <saved-virtual-branch-uuid> --limit 50 --offset 50
bun run cli create --text "A durable note [type::note]"
bun run cli properties-preview --text "Draft title [stage::queued]"
bun run cli ticket <block-uuid>
bun run cli ticket <block-uuid> --line 3
bun run cli update --id <block-uuid> --text "Revised note" --expected <revision>
bun run cli update --id <block-uuid> --text "Revised note" --expected <revision> --author agent --actor claude-code
bun run cli create --text "Agent's note" --author agent --actor claude-code [--session <id>]
bun run cli move --id <block-uuid> --parent <block-uuid|root> [--position 0] [--author agent --actor claude-code]
bun run cli delete --id <block-uuid> [--author agent --actor claude-code]
bun run cli restore --id <block-uuid> [--author agent --actor claude-code]
bun run cli activity --limit 50 [--since 2026-09-27T00:00:00Z] [--after <cursor>] [--author agent] [--kinds text,properties,move,delete,restore]
bun run cli selection
bun run cli changes --since <sequence> --limit 50
bun run cli clients --role tree
bun run goto 40bd0864
bun run goto --query "roadmap review"
bun run goto --client <client-uuid> --query "roadmap review"
bun run cli link 'pi-outliner://block/<block-uuid>' --tree-client <tree-client-uuid>
bun run cli link 'pi-outliner://resource/<resource-uuid>' --detail-client <detail-client-uuid>
bun run cli link 'pi-outliner://block/<block-uuid>' --source-client <source-client-uuid> --source-region tree
bun run cli link 'pi-outliner://reference/<source-block-uuid>?revision=1&start=7&end=22' --source-client <source-client-uuid> --source-region detail
bun run cli work-id-status
bun run cli work-id-configure --prefix PIE
bun run cli work-id-allocate --id <block-uuid> --expected <revision>
```

Text updates require the integer `revision` returned by the read before editing. Omitting `--expected` or saving an old revision fails without replacing newer text. Sibling moves do not invalidate an unchanged text draft.

`create`, `update`, `move`, `delete` (to Trash) and `restore` (from Trash) record who wrote: `--author user|agent|system` (default `user`), `--actor <id>` (default `cli` for the person's writes; required with `--author agent`) and `--session <id>`. An agent passes `--author agent --actor <its id>`, so the change feed, activity and Detail attribute the write to it, not to the person. `activity` reads the same record (`activity.recent`): edits by default, and moves, trashing and restores with `--kinds`. Attributed moves and Trash operations need a service with the `mutations.provenance` capability.

`view` and the agent tool `outliner_view` read a saved virtual branch's matching
canonical roots in branch order through the service's `views.read`, the same
evaluator Tree uses. They do not inspect or change pane focus, disclosure or
viewport. Context children and nested view expansions are presentation, not
additional query matches. Block-scoped properties, authored sorting and manual
ranks retain the existing Tree semantics.

The result includes `viewId`, `revision`, workspace `sequence`, configured/effective
limits, `offset`, `total` (every eligible member), `blocks`, `completeness`,
`nextOffset` when more members follow, and `status`. Only `ready` is a valid
result set; `invalid`, `unsupported`, `missing`, `failed` and `changed` carry
`errors` plus structured `problems` (`code`, and for query syntax the property
and 0-based position) and no matches. The service evaluates the whole view in
one read transaction, so a result never mixes two workspace states. An optional
expected revision guards the saved definition. The authored result limit applies
by default; an explicit override from 1 through 1,000 and `--offset` page through
the view without changing it. Check completeness even with an override. Other
kinds, including checklist views, are reported as unsupported rather than
reinterpreted. Agent responses also report presentation omissions separately
from query completeness; use the CLI or read individual blocks when large bodies
exceed the tool budget. `views.read` requires a service that reports the
`views.read` capability.

Clients that need to follow the outline subscribe with `events.subscribe`;
content events carry the changed block's parent, revision, change kind and
declared actor. After a disconnect, `changes.since` returns what was missed, in
order, or an explicit reset when history is no longer retained. Services that
support it advertise the `changes.since` capability. See
[Change feed](docs/ARCHITECTURE.md#change-feed).

The CLI resolves the same workspace-scoped socket and database as the service. `goto` accepts a full UUID, unique short prefix, or unambiguous fuzzy title/content query. Eight-character IDs are convenience labels, not a uniqueness guarantee; ambiguous queries return full-UUID candidates without changing selection. Work-ID configuration is normally one-time; allocation requires the exact block UUID and its latest integer `revision`, available in bounded `list` results. A successful allocation atomically persists both the immutable reservation and the block's `[work-id::…]` property/address; a failed request consumes neither the number nor a reservation.

`link` accepts one URL, positional or `--url`. Use `--source-client` to follow
that view's saved Detail link; composed sources also require `--source-region
tree|detail`. For a source-free Resource or authored-reference URL, supply
`--detail-client` explicitly. Reference URLs must retain the exact source block
revision and token span emitted by Outliner; the numbers above are placeholders.
Missing or protected destinations fail before Resource registration. Use
`--tree-client` for source-free block, page, Work-ID, or goto URLs. These three
client options are mutually exclusive; goto URLs accept Tree targeting only.

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
property inspector. Detail also provides the `[⋯]` action control and labels
Current and Preview separately.

Resource properties use the same activation for metadata and inline mentions.
Pi Detail links the authored `[file::…]`, `[web::…]`, `[jira::…]`, and `[app::…]`
tokens without changing source text. Properties exposes every occurrence,
including repeated mentions of one Resource, in both Detail renderers. Press
`o` on a document with several Resource references to choose one in Properties;
`Tab` selects an occurrence. Click an ordinary value to copy it; link text follows its target, while the adjacent **Copy** control copies the complete original value. On a focused property, `y` copies, `o` follows, and `Enter`/`e` edits. Multiple links in one value have separate Tab stops. Copy sends the canonical value to the terminal clipboard without wrap breaks or changing the note. These actions work in inline and dedicated Properties. Activating a `[file::…]` occurrence opens the file
in local Preview beside Current, retaining the note, scroll and draft; Escape
closes Preview. Paths resolve on the service host within its configured Resource
policy, including when the reader is remote. Recognized outline links in rendered
Markdown use the existing link navigation. Other Resource kinds retain their
destination chooser. Displaying or
copying a reference never creates a Resource. Activation verifies the source
revision and span before using the service's existing follow/create operation.
After a source edit, stale links require reopening the block.

The legacy file preview still honors block-level `line-start`/`line-end`.
Explicit Resource navigation opens the complete Resource; those block-wide
ranges are not applied to an arbitrary inline mention. References projected
from embedded content without a known source mapping remain nonactionable in
the host's body; open their source block to act on its actual occurrences.

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

Tree reorder actions are `tree.reorder.up` / `tree.reorder.down`;
`tree.move.up` / `tree.move.down` move selection. Reorder defaults to Option/Alt
arrows and appears in `?`. Independent Detail placement uses Option/Alt+Shift
arrows in both surfaces. The former hard-coded Shift-arrow reorder and Tree
`d` / `Shift+D` split paths are removed. Existing configuration overrides still
apply: remove old Shift-arrow split overrides to use the new defaults, or
explicitly choose nonconflicting chords. Text-editor Shift-arrow selection is
unchanged.

### Tree browse mode

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move selection |
| `PageUp` / `PageDown` | Scroll within the selected multiline-expanded block |
| `Left` / `Right` | Collapse/go to parent; expand/go to first child |
| `Option+Up` / `Option+Down` | Reorder canonical siblings, or branch-local projected occurrences |
| `Enter` | Open the selected target in the linked Detail |
| `Option+Shift+Right` / `Option+Shift+Down` | Create and focus a new independent Detail to the right / below |
| `e` | Edit a single-line block inline; open a multiline edit in the linked Detail |
| `a` / `s` | Add child / sibling |
| `c` | Open the Herdr quick-capture popup; Enter adds a line, Ctrl+S saves to Inbox, Esc retains and closes, Ctrl+D twice discards |
| `Tab` / `Shift+Tab` | Indent / outdent |
| `Space` | Toggle collapse |
| `.` or `Command+.` | Expand/collapse multiline block detail in Tree |
| `Ctrl+E` or modified Enter | Explicitly edit the selected block in the linked Detail |
| `g` | Search blocks with a document preview and optional Jev ranking |
| `Shift+I` | Inspect the automatic Inbox agent, its results, Pause/Resume, Undo, and reconsideration |
| `o` | Open the first exact `((block-id))` or symbolic `[[address]]` reference in the linked Detail |
| `R` | Reveal this row's canonical physical source, clearing filters, expanding its ancestors, and focusing this Tree |
| `Option+Shift+R` | Reveal the first authored reference in this Tree |
| `Shift+V` | Open the selected virtual branch in the generic split navigator |
| `m` / `Shift+M` | Toggle a bookmark for the selected block / open Bookmarks |
| `Option+Left` / `Option+Right` | Move backward / forward through block navigation history |
| `/` | Temporarily fuzzy-filter descendants of this occurrence |
| `f` | Open a referenced file |
| `Delete`, then `y` | Confirm moving the selected canonical subtree to Trash |
| `r` | Restore a selected direct Trash root |
| `p` | Type the work ID/short UUID to permanently purge a Trash root |
| `Ctrl+Q` | Close the pane |

In Herdr, Goto opens a large popup over the workspace so a narrow Tree pane does
not constrain the search and preview. Outside Herdr it opens inside the current
Outliner surface, including the combined Tree/Detail layout. Type a title,
description, UUID/prefix, registered page/alias, or Work ID.
Text matches arrive immediately; arrows/Tab or a plain click select a result for
preview. Enter reveals it in Tree; Option/Alt+Enter opens it in Detail. Escape
returns to the invoking Tree with its selection and scroll intact. PageUp/PageDown or the mouse wheel
over the preview scrolls its document. Narrow terminals stack results above the
preview. Long previews explicitly show that they are shortened; opening the
result always loads the canonical document.

Set `TYPESAFE_API_KEY` in the **Outliner service's environment** to enable Jev.
After a short typing pause, the service sends the query and up to 80 candidates'
titles, ancestry labels, and bounded text excerpts to TypeSafe for relevance
scoring. The credential stays in the service. The first 30 results are displayed,
with omitted matches marked. Jev reranks this candidate pool; it cannot recover
notes outside it. Missing credentials, provider failure, or a 2.2-second deadline
leave ordinary search usable. Once you select a result, delayed ranking keeps
your displayed list and selection stable. Exact identities bypass ranking.
The actions and displayed shortcuts use the normal keybinding configuration.

Reveal source preserves exact occurrence history: after jumping from a virtual
occurrence to its canonical physical row, `Option+Left` returns to that
occurrence. User-triggered reveals focus the target Tree; programmatic reveal
commands only focus it when they explicitly request focus.

Plain-clicking a Tree row selects it and updates its local Preview (the embedded Detail Preview in composed mode).
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
invoking pane's live client and uses the source’s saved destination link. On macOS,
the optional `macos/pi-outliner-link` app remains an explicit compatibility
path: Warp uses Command-click; Ghostty with mouse capture uses
Shift-Command-click.

Projected virtual occurrences deliberately constrain hierarchy and collapse. Branch-local sibling reorder changes only that projection; editing and confirmed deletion still target the canonical block.

### Reader layout and menus

Tree, Detail and nested Preview use Compact layout by default. Ordinary reading
keeps one internal menu row; the current document title appears in the Herdr
frame when the host supports it. Authored headings remain document content.
Nested Preview retains its own title and controls without renaming the host.

Use **Note**, **View**, **Links**, **Props** or **[⋯]** for the existing actions and
their effective shortcuts. **?** opens the full searchable action list. In an
open menu, Left/Right changes category and Escape returns to the reader. Narrow
panes keep whole labels and put the remaining actions behind **[⋯]**.

- **View → Expanded layout** restores location, routing and helper rows.
  **Compact layout** returns the space to the document while retaining the
  authored reading position.
- **Location / ancestors** opens navigation through the current ancestry.
  **Links** contains the linked destination and its Change action.
- **Props** opens the existing inspector. Tree's **View status** shows counts,
  workspace, Inbox and projection diagnostics on demand.
- Drafts, recovery decisions and service failures remain visible. Routine Open
  receipts expire rather than occupying a permanent footer.

Density is stored on the client host in `view.json` beside the resolved project
`client.json`, with `OUTLINER_VIEW_PREFERENCES_PATH` as an optional override.
The file contains `{"density":"compact"}` or `{"density":"expanded"}`; it is
not note metadata and does not change canonical text. Existing panes keep their
current choice; new panes load the saved preference.

Application title metadata expires if the reader exits unexpectedly. A custom
Herdr pane label takes precedence after the next title heartbeat (up to five
seconds); the reader then keeps its identity inside the menu row. Hosts without
title reporting use that same in-app fallback.

### Detail preview

| Key | Action |
| --- | --- |
| `Up` / `Down` | Scroll one visual line |
| `Ctrl+U` / `Ctrl+D` | Scroll one viewport |
| `PageUp` / `PageDown` | Scroll one viewport |
| `g` / `G` | Top / bottom |
| Mouse wheel / trackpad | Scroll preview |
| `E` | Toggle subtle full-width backgrounds around generated embed regions in this Detail |
| `b` | Expand/collapse the generated Backlinks section; the first expansion loads results lazily |
| `/` | Edit a fuzzy backlink-source filter; Enter applies and Esc cancels |
| `s` | Cycle updated/created/title sorting in descending/ascending order; open items stay first |
| `k` / `t` | Backlinks: show one kind at a time / one stage (open, waiting, draft, active, done), then all |
| `h` / `n` | Backlinks: show or hide resolved comments / this note and its descendants |
| `Tab` / `Shift+Tab` | In Pi Detail, traverse Properties, visible document links, callouts, annotations and expanded Backlinks in reading order; scroll follows focus |
| `.` | Expand/collapse the focused backlink group, or occurrence details for the selected source |
| Backlink/Property row click | Select and highlight that generated row; a backlink group header or status-line toggle activates |
| `Ctrl`/`Meta`-click | Peek a Backlink source or open a typed Property target |
| `Enter` | Activate the focused control or document link; a focused backlink source opens Peek |
| Peek: `Left` / `Right` | Preview the previous / next source in the captured filtered/sorted set |
| Peek: `Esc` | Cancel, restore the exact inline source row, and leave this Detail unchanged |
| Peek: `Enter` | Open the shared destination chooser |
| Peek: configured Detail right/below binding | Open the current preview directly in a new right/down Detail |
| Chooser: configured Detail right/below binding or `r` / `d`; `Shift+R` / `f` | Split right/down; replace this Detail / use linked Detail |
| Chooser: `c`; `Enter` / `Esc` | Choose once; use the saved link / dismiss without navigation |
| Primary-button drag | Select and copy an exact rendered block or cached Resource passage |
| `c` | Comment on the most recently dragged passage without entering another selection mode |
| configured Herdr `float.pi-outliner.comment-selection` key | Alternate copy-mode path for commenting on a retained native rendered selection |
| `e` | Edit raw canonical text; an active draft protects Current |
| `f` | Open referenced file |
| `o` | Open the first authored reference in the shared destination chooser |
| `R` | Reveal the block currently shown by this Detail in its paired or unique same-tab Tree |
| `Option+Shift+R` | Reveal the first authored reference in the paired or unique same-tab Tree |
| `Shift+V` | Open the current virtual branch in the generic split navigator |
| `m` / `Shift+M` | Toggle a bookmark for the current block / open Bookmarks |
| `Alt+P` (also `F7`) / `Shift+F7` / `Alt+Enter` | Switch Current/Preview focus, close Preview, or keep Preview as Current |
| `Option+Shift+Right` / `Option+Shift+Down` | Open the current target in a new independent Detail to the right / below |
| `Option+Left` / `Option+Right` | Move backward / forward through Current's local history |
| `r` | Restore the selected block when it is a direct Trash root |
| `q` | Focus Tree; close a dedicated Property Detail |
| `Ctrl+Q` | Close Detail |

Detail navigation history is local to that Detail process and retains at most 200 exact targets. Explicitly opening or keeping a target records a visit. Passive Tree selection updates Preview independently and leaves Current history in place. Soft-deleted targets reopen read-only; a purged target remains visible as unavailable. Closing Detail discards this history.

Detail parses the complete projected Markdown document before applying generated
embed decoration. Exact character and line spans are recovered from the parsed
block stream, then only decoration boundaries are rendered as separate Pi
Markdown components. This keeps following authored text outside a lifted table,
list, quote, or code fence while preserving structural syntax and full-width
embed backgrounds at narrow and wide terminal widths.

#### Folding a document

In Pi Detail and local Preview, click a heading label or its disclosure to fold
the section. A list disclosure hides nested items and continuation paragraphs
while retaining the leading item and task mark. Links keep their own targets.
`Tab` reaches visible disclosures; `Enter` toggles the focused one.

Folding changes only this reader's view. Nested choices survive reopening their
parent and resizing; another reader can show the same note differently. Exact
fragment navigation and comment reveal open the necessary ancestors. Anonymous
folds reset after a source edit rather than hiding a different section; unique
explicit fragment IDs retain their identity. Editor draft previews stay expanded.
Dragging copies visible text without the generated disclosure arrow; authored
arrows remain text. Whole-source copy still includes the full document.

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
the service for at most 200 source blocks and groups repeated exact, page,
Work-ID, and block-valued property references per source. Property references
such as `[source-block::<block-id>]` retain their normalized property key in the
result and are summarized by property type. Empty and truncated states remain
explicit.

Sources are grouped by the kind the service reports (see
`references.backlinks` below). Each group header shows its count and stage
counts, such as `Letter 4 (1 waiting · 1 draft · 2 done)`. Groups start
collapsed but keep their open (waiting, draft, active) sources listed; groups
with open sources come first, then the most recently updated. Inside a group,
open sources come first, then the chosen sort. Each source is one line: the
title, then a dim suffix with its stage, breadcrumb and reference counts such as
`Work ID ×2`, shortened to the pane width. By default the note itself, its
descendants and resolved comments are hidden. The status line always says what
is shown and what is hidden, for example
`5 of 12 match · 2 this note hidden · 1 resolved hidden · Kind: all · Stage: all ·
Sort: Updated ↓`, and each part is a clickable toggle. `/` fuzzily filters
source title, context, kind, stage, relation type, and occurrence text; any
narrowing filter opens every group. `k` and `t` cycle the kind and stage
filters, `h` and `n` show resolved comments and this note, and `s` cycles
updated, created and title sorting in both directions. A group header's `+`/`−`,
`Enter` on a focused header, or `.` toggles the group. `.` or the clickable
`+`/`−` on a source row expands only that source's occurrence snippets. Against
a service without the facets capability, Detail shows one flat list. Results are cached for that target and
invalidated by canonical content/address events. Generated rows never enter the
edit buffer or saved `Block.text`; clicking a source row selects and highlights
it, while `Enter` or `Ctrl`/`Meta`-click opens a reversible preview over the
invoking Detail. The popup captures the current filtered/sorted source set once:
`Left`/`Right` traverse it and `Esc` restores the exact inline row without
navigation. `Enter` opens the destination chooser. Inside that chooser,
`Shift+R` replaces the invoking Detail subject to operation protection, `c`
chooses a reader once, `f` or a second `Enter` uses the saved link, `r` splits
right, and `d` splits down. An absent link reports recovery choices. Back in the
invoking Detail, outside the popup, pane-level `Shift+R` reveals the current
Detail block's canonical physical source in Tree.

### Detail rendered-passage and source comments

Primary-button drag in a Detail preview is the default rendered-passage flow for
ordinary blocks and cached text Resources. Drag the passage once, then press
`c`; the same application-owned selection is copied and opened in the compact
annotation composer. For blocks, Detail captures the selected text with the
current Herdr pane revision. For Resources, it maps the rendered endpoints back
to the current immutable representation. It rejects either capture if its block,
Resource representation, or browsing context changes before the composer opens.

Herdr copy mode remains an alternate path for selections retained outside the
active Detail viewport. Bind the plugin action through a Herdr `plugin_action`
command:

```toml
[[keys.command]]
key = "prefix+shift+c"
type = "plugin_action"
command = "float.pi-outliner.comment-selection"
description = "Comment on the selected Outliner Detail passage"
```

Focus an Outliner Detail, enter Herdr copy mode (`prefix+[` by default), select
the displayed passage once, then press that key. The action accepts only Herdr's
keybinding handoff, preserves its exact validated text, and brackets live-Detail
discovery with two identical recent-pane snapshots. It aborts if the pane
revision, captured output, registered Detail/context/host block changes, or the
exact quote is absent from that bounded pane history. No clipboard is read. Both
paths protect that exact Detail while the composer is open over the existing reader;
`Ctrl+S` creates the comment and `Esc` cancels without creating anything.
The composer shows three body rows and scrolls to keep the cursor visible as you
type or resize the pane.

Every capture constructs one typed `AnnotationTarget`: a representation with
block, Resource, rendered, or unknown source-snapshot evidence plus one of the
supported typed anchors. Canonical block selections and filesystem text
Resource selections use positioned text quotes. Direct cached web selections
map the rendered drag back to the exact source snapshot and retain its derived
representation, adapter, hash, and quote. PDF selections additionally retain
the page, UTF-16 range, quote context, and PDF-point regions from the extracted
page map. Rendered block selections retain the validated host/pane/revision
observation as representation evidence instead of inventing canonical source
coordinates.

Pane-capture comments appear in an **Unpositioned comments** disclosure below the
document. Expand it to read the original quote, comment and replies, or open the
thread. Screen offsets include chrome, wrapping and history, so they never place
a marker in Markdown or choose a source scroll position after reflow. Positioned
source and Resource comments retain their inline markers.
When a Resource opens as metadata, comments on its available source text remain
unpositioned. Metadata rows cannot be selected or revealed as source passages.

`v` remains the keyboard-first source-comment operation. It freezes the current
read projection, maps Shift-motion or primary-button drag to UTF-16 source text,
and opens the same composer with `c`. Mouse users can drag cached block or
Resource text directly in preview without pressing `v`. File selection first
interns the path as a filesystem Resource; file paths are locators, not
annotation identity. Annotation view preserves original evidence and the stored
resolution history; it does not preview a file found in an ancestor's properties.
Press `r` to open the annotation's actual block or Resource and reveal a currently
resolved positioned text quote. A pane-capture comment opens its host with an
explicit unpositioned status. Probable, unresolved,
ambiguous, orphaned, unsupported, and rejected records remain valid, visible
history rather than being coerced into a location.

### Comments in the Tree

A note's root comment threads appear beneath a **Comments** disclosure row.
It starts collapsed; click its triangle or press Space/Enter to unfold it.
Left collapses it, and Left again returns to the owning note. Ordinary child
notes stay outside the group. The count describes root threads available in
this projection, not replies or unseen results beyond a view's depth/row limit.

Expansion is temporary and independent for each physical or virtual occurrence.
New background comments do not unfold a closed group. Explicitly revealing a
comment opens its path; temporary branch filtering exposes matching discussion
without changing the saved disclosure state. Comments is a presentation row,
so it cannot be edited, collected, moved or deleted as a block. Existing thread
IDs, replies, anchors and lifecycle actions are unchanged; Preview shows the
same discussion.

### Comments on individual Resource references

The same file can appear several times in a block without becoming several
Resources. In Detail, `o` opens the existing Properties choices when there are
multiple references. Select a particular row with `Tab`, then press `c` to
comment on that use. This does not open the file or create a Resource. Selecting
an exact reference token with the source-selection controls also preserves its
occurrence.

Opening that row with `o` carries its context into the Resource reader. A passage
comment there keeps both the host occurrence and the file representation/version
and quote. Opening the Resource directly gives a file-global view; its comments
have no reference context. Navigation history keeps repeated uses distinct.

Original source evidence is immutable. Moving an unchanged reference line can
retain placement only when that line is unique in both the captured and current
block. Deleting or ambiguously copying a reference leaves the thread recoverable
under Unpositioned comments. Editing the reference's own line also requires
explicit reattachment through the existing annotation approval operation. A
later unique survivor does not silently inherit an earlier comment. Reattachment
never erases the original target or history. Contextual Resource reveals request
the recorded revision; unavailable old file bytes are not replaced by newer bytes.

In Pi Detail, `[` and `]` select the previous or next comment in document order,
then the unpositioned threads. Navigation wraps with an explicit status. The
selected thread expands beside its passage or in **Unpositioned comments**;
its pointer controls perform the same operations. `Shift+C` opens a multiline
reply to that root thread. `Shift+D` resolves or reopens it. User and agent
replies appear together. These actions retain the current document and reader
viewport; explicit thread navigation scrolls its controls into view.

Comments identify **Resource-wide**, **This reference**, or **Other reference**
scope. Other occurrences and lost/ambiguous anchors stay reachable, with their
original evidence. Failed saves remain in the composer with a visible status;
`Esc` cancels the reply without returning focus to Tree. The ANSI reader shares
thread actions and appends complete, wrapped threads to the source preview.
`[` and `]` reveal the selected thread; scrolling reaches unpositioned quotes,
bodies and replies. Appended evidence is not selectable as source text. The
annotation document also scrolls through its full evidence and history with `G`.

### Detail edit and comment modes

| Key | Action |
| --- | --- |
| Arrow keys | Grapheme-safe character/physical-line movement |
| `Option+Left/Right`, `Ctrl+Left/Right`, `Option+B/F` | Previous/next word start |
| `Home` / `Ctrl+A`; `End` | Physical line start / end (`Ctrl+E` opens the external editor in block edit mode) |
| `Shift` + a supported motion | Extend selection |
| Primary-button drag | Select exact authored text across wrapped rows and Unicode graphemes; dragging over a viewport edge scrolls and extends |
| `Command+A` or `Ctrl+Shift+A` | Select all authored source |
| `Ctrl+C` or `Command+C` | Explicitly copy the selected authored source through the terminal clipboard |
| `Ctrl/Command+Z` | Undo the previous edit group |
| `Ctrl+Shift+Z` or `Ctrl+Y` | Redo |
| `Backspace` / `Delete` | Delete selection or one grapheme |
| `[[`, `((`, `[file::` while typing; `Tab` or `Ctrl+Space` | Inline reference completion; keep typing to filter, ↑↓ choose, Enter/Tab or click inserts, Escape dismisses suggestions |
| `Ctrl+W` | Move focus between the wide editor and draft preview |
| `Ctrl+L` | Toggle source-line-linked editor/preview scrolling |
| `Ctrl+E` or `Option+E` / `Alt+E` (block edit or preview) | Yield this Detail pane to `$VISUAL` or `$EDITOR`; `Ctrl+E` avoids AltGr/dead-key layouts. Imports a block draft as one undoable edit, or revision-checks and writes a changed filesystem Resource |
| `Ctrl+S` | Save a block or writable filesystem Resource, or add an annotation |
| `Esc` | Cancel the complete edit session and return to Tree |

Inline completion shares bounded lookup, insertion and contextual rows with Tree editing. The selected candidate loads its ancestry and short body context. Named pages/aliases/Work IDs remain distinct from canonical blocks/fragments. Empty, failed and truncated lookup states are visible; newer typing or dismissal invalidates older replies. Acceptance rechecks targets and symbolic addresses, replaces the complete active token, and preserves surrounding text. Local fragment creation and insertion form one undo step. No Jev call is made per keystroke.

Long physical lines wrap without changing raw text. Continuation rows remain associated with one physical line number, and keyboard or pointer selection maps back to exact authored source. Bracketed paste replaces the selection and remains one edit even when terminal payload chunks arrive separately. Keyboard cursor movement keeps the active edge visible.

External block editing never writes the canonical block directly. From preview it first opens an ordinary protected Detail draft; from edit mode it sends the exact unsaved buffer. The client retains the base, pre-launch draft and returned UTF-8 writing under its workspace state directory, then transfers recovery to the service before removing local files. Independent concurrent changes combine automatically into the editable draft, with a visible notice and the exact returned writing retained. Adding a missing final newline also combines without treating meaningful spaces or indentation as noise. Overlapping edits or incomplete comparisons open **Writing history** instead of rejecting the returned text. Compare Base, Draft, Latest and Proposal; ask the configured Pi model for a reviewable proposal or edit manually. Using a proposal opens a draft: `Ctrl+S` still saves against the exact reviewed canonical revision. `Esc` cancels model work or leaves review while retaining the writing. The header, **? → Writing history**, and `Alt+R` reopen retained drafts after closing Detail or restarting. Ordinary Detail save conflicts use the same recovery flow; a retry can use a complete mechanical merge without a review detour. Retained drafts are writing history, not necessarily conflicts. **Save separate** creates a note containing the exact draft as fenced text, so it cannot accidentally declare a second Work-ID owner. Discard removes the pending reminder while retaining its evidence in recovery history. **? → Writing history** also opens saved history: **Restore draft** recovers the original returned text and **Undo save** recovers the note as it stood before that save. Both create a new review against the current revision; neither immediately changes the note. The Problems tab names damaged local journals, whose files remain intact while other drafts remain usable.

Writable, unpinned text filesystem Resources keep their provider revision checks: changed external drafts are written back only if the source revision is unchanged; `e` opens the built-in buffer and commits through `Ctrl+S`. Detail uses exported `$VISUAL` or `$EDITOR` directly; when Herdr's plugin environment omits them, it reads those values and `PATH` from the user's interactive shell without evaluating the editor value as shell code. The editor runs in the same local or SSH/Herdr PTY. Failed launches, nonzero exits and restoration failures preserve recovery files.

Recovery drafts are service-owned evidence, not notes sent through background assistance. Client-local journals live in `editor-drafts/` under the resolved workspace state directory; the service stores acknowledged versions in SQLite. Merge assistance uses editable `prompts/edit-merge.md`, the existing Pi configuration and native session traces. It has no filesystem, shell or note-writing tools. Its limit is three model turns, 120 seconds and 120,000 input characters; oversized inputs remain available for manual review. Cancellation and stale responses cannot authorize a save. Proposal quality still requires human review. These new recovery RPCs require protocol 72 and a coordinated client/service restart.

Filesystem saves compare the opened file's content hash, size, and modification
time. A stale edit retains its Detail draft and leaves the source unchanged.
During commit, Outliner first persists the submitted draft, then moves the current
file into a private sibling recovery directory and publishes the draft only if
the original pathname is still absent. A writer that changes the displaced file
or creates a new file at that pathname produces a conflict; it is never silently
replaced. The error names the recovery directory and Detail keeps the draft.

Each attempted commit retains `.outliner-save-<UUID>/` beside the source:
`draft` contains the submitted text, `original` retains the displaced file when
displacement occurred, and `save.json` identifies the target and opened revision.
The directory is private (0700), drafts are 0600, and the published file preserves
the source's permission bits. These copies are **not automatically deleted**:
an external editor can continue writing through an old descriptor after a save,
and those later bytes remain in `original`. To recover, inspect the directory
named by the error (or the directories beside the file), compare `draft` and
`original` with the current source, and copy the desired text to a new filename.
Only remove a recovery directory after closing other editors and confirming
that neither retained version is needed.

This is a recoverable replacement contract, not atomic compare-and-swap. There
is a brief interval where the source pathname is absent. An interrupted save's
pending marker lets service startup (or the next Resource read) restore the
displaced original **only when that pathname is absent**; an external replacement
always stays in place. The submitted draft remains available after interruption.
Files and parent directories are flushed before a save is acknowledged. This
requires a local filesystem supporting hard links, rename, and directory fsync;
unsupported primitives fail the save. Filesystem or hardware durability failures,
hostile replacement of source directories, and concurrent deletion of recovery
files are outside this contract. Fault tests cover Linux process interruption;
power-loss and network-filesystem behavior have not been verified.

In edit mode, wheel/trackpad input scrolls the region under the pointer. Editor scrolling changes only its visual viewport; it never moves the text cursor. The next keyboard cursor movement restores cursor-follow. A primary press-drag-release gesture in the editor maps through headers, split geometry, line-number width, wrapping, tabs, grapheme boundaries, and Unicode display width to a valid source range, with edge dragging scrolling the editor viewport. Preview clicks retain their existing link and region actions.

Wide split scrolling is independent by default. `Ctrl+L` enables an ephemeral linked mode, shown by `↔` in the editor header. Linked movement uses draft source-line anchors rather than proportional row offsets; generated projections without a shared raw-source anchor leave the peer unchanged. Link state and manual viewport state reset on edit-session or viewport changes and never modify block text.

Undo history is bounded to the current edit/comment session. Consecutive typing and deletion coalesce; cursor/selection state is restored; a divergent edit clears redo. Save or Esc-cancel ends the history.

## Blocks, properties, and references

A block stores canonical text plus structural fields. Properties are written directly in that text:

```text
Investigate page navigation [type::roadmap-item] [work-stage::queued]
```

Every deliberate non-literal property is indexed in `block_properties`; canonical `Block.text` remains the source of truth. The first contiguous property-only run after an optional subject line is block metadata, as is the trailing bracket-property run on the subject. Bare `key:: value` properties later in the body have `line` scope; later bracket tokens have `inline` scope. Literal examples inside inline/fenced code and escaped bracket syntax are not indexed.

To show outline syntax as ordinary text without backticking each token, wrap it
in a literal region. Each marker is an HTML comment alone on its line (up to
three leading spaces; spacing inside the comment and letter case are ignored):

```text
Property syntax brief [type::note]

<!-- literal -->
Put [stage::queued] on the subject line, or write stage:: doing on its own line.
Tag it #example.
<!-- /literal -->
```

Inside the region, bracket `[key::value]`, bare `key:: value` and `#hashtag`
properties are not parsed, so they are not stored, queried, indexed or reported by
`properties.preview`. Everything else still works: formatting, `[[page]]`,
`((block))`, Work-ID and ticket links resolve and count as backlinks. Markers
inside fenced code are code, a fence inside a region keeps its contents
(including any marker lines) as code, regions do not nest, and the first closing
marker ends the region. An opening marker without a closing line protects
nothing, and Detail shows a warning. Detail hides matched marker lines (each
reads as a paragraph break, as GitHub renders an HTML comment); Markdown
renderers hide them too. Titles in Tree, links, workflows and Inbox skip matched
marker lines, so they show the note's first visible line, as Detail does. An
embedded note's markers are judged by that note's own text, so an embedded slice
that holds only one marker of a closed region hides it without a warning.

A note may start with a region. The region then takes the subject position:
its first line is the title, and because a marker line ends the property-only
run, a property line after the closing marker is not block metadata. Block
metadata for such a note goes on a property line before the opening marker:

```text
[type::note] [work-id::DEMO-1]
<!-- literal -->
Put [stage::queued] on the subject line.
<!-- /literal -->
```

Appending a property (`properties.patch`, Work-ID allocation) to a note that
starts with a region writes it there. Property parser version 4 introduced
regions; startup re-indexes existing notes without changing their text.

Clients that edit text should ask the service how a draft will parse rather than
copying these rules. The read-only `properties.preview` request takes `text` and
returns the block `properties` a save would index, plus every `tokens` record with
its `scope` (`block`, `line`, `inline`), `placement` (`metadata-line`,
`trailing-metadata`, `inline`), syntax, ordinal, line, column and source span, and
the `parserVersion`. It uses the save-time parser, creates or changes nothing and
emits no event. For example, `Card [stage::queued]` has block property `stage`,
while `Card [stage::queued] more` has only an inline token: a client can compare
the preview with the block it read and warn before a save drops a property.
CLI: `bun run cli properties-preview --text '<draft>'` or `--stdin`.

### Bounded block queries

The service owns one structured `BlockSearchQuery` used by Tree filters, virtual branches, CLI, Pi commands, and agent tools. Property filters are positive AND clauses with presence or exact equality:

```text
status=open priority
status="in progress" project=pi-outliner
work-stage::review type::roadmap-item
```

Whitespace separates clauses outside double quotes. `key` checks property presence; `key=value` and `key::value` check case-insensitive exact equality. Double-quoted values preserve spaces and support only `\\` and `\"` escapes. Invalid syntax reports a character position instead of becoming an accidental query. Aggregation and reference traversal are not part of the query language.

Saved-view `[query::…]` values, CLI `list --query` and the `expression` field of
`blocks.query` / `outliner_query` also accept `OR`, `NOT`, parentheses and
timestamp ranges:

```text
work-stage=review OR work-stage=validate
type=roadmap-item NOT status=done
type=task NOT priority
type=task (priority=high OR due) updated > 2026-09-20
updated >= -7d
created < 2026-09-01T12:00Z
```

- **Precedence:** `NOT` binds tightest, then `AND` (written or implied by
  whitespace), then `OR`. Keywords are case-insensitive. Parentheses group; a
  clause may start with `(` and end with `)` (`(a=x OR b=y)`). A trailing `)`
  that balances a `(` in the same value stays in the value, so `((k=f(x)))`
  matches `f(x)`. Quote a value that contains a space or ends with an
  unbalanced `)` inside a group (`(k=":)" OR a)`).
- **NOT:** `NOT key=value` excludes blocks with that value; `NOT key` selects
  blocks without the property (in the query's property scope).
- **Ranges:** `created` or `updated`, then `<`, `<=`, `>` or `>=`, then a time,
  with or without spaces. A `YYYY-MM-DD` date is a whole UTC day:
  `> 2026-09-20` starts on the 21st and `<= 2026-09-20` includes all of the
  20th. `today` and `yesterday` are UTC days too. ISO datetimes (UTC unless an
  offset is given), `now` and `-N` followed by `h`, `d` or `w` are instants;
  an impossible date or time such as `2026-02-30T10:00Z` is an error. Relative
  values resolve each time the service evaluates the query (every `views.read`
  or `blocks.query`). Tree re-reads a saved view when the workspace changes, not
  on a timer, so an open `updated >= -7d` view shows blocks aging out at the next
  change or refresh. Only `created` and `updated` compare; `updated=…` is still
  a property equality clause.
- **Compatibility:** a query with no keywords, parentheses or ranges keeps its
  exact meaning, including the special `deleted=true` Trash query.
  `deleted=true` cannot be combined with the boolean grammar.
- **Errors:** invalid queries fail, and are never treated as empty results.
  `blocks.query` rejects them with a `problem` giving `code`, the request
  `field` (`expression`) and the 0-based `position` within it; `views.read` reports `status: "invalid"` with the
  `query` property and position.
- **Service:** the grammar requires a service that reports the
  `query.expression` capability. CLI `list --query` and
  `outliner_query.expression` check for it before sending, and Tree and bookmark
  navigators, which send a parsed `where` for the Advanced property filter, when
  admitting new children or when scoping a bookmark, require it at startup.
  Queries without `expression` or `where` need no capability.

The Tree **Advanced property filter** accepts the same grammar. A clause list
still reaches the service as plain `filters` (so `deleted=true` still selects
Trash); a query using `OR`, `NOT`, parentheses or ranges is sent as a
structured `where`. `expand-when`, checklist views and repeated CLI `--filter`
flags keep the positive-AND clause syntax.

Property filters and catalogs default to `block` scope, so body examples and line-local annotations cannot silently change workflow semantics. Callers can explicitly request `block`, `line`, `inline`, or `all` through `propertyScope`; broader block-query results include each matching record’s scope, ordinal, line, column, and source span. Text substring, subtree root, deleted-content mode, projection rank context, timestamp sort, and limit remain explicit structured fields rather than reserved filter words. Timestamp sorting accepts `created` or `updated` with `asc` or `desc`, orders the full matched collection before applying the limit, and cannot be combined with manual projection ranks. Every query carries a limit from 1 through 1000 and returns `complete` or `truncated` metadata. Tree **Advanced property filter** uses the block-scoped property catalog for key/value completion; agents call `outliner_query` with structured filters and never parse the shorthand. CLI `list` exposes the same parser through repeatable `--filter` flags and accepts `--limit` (default 500).

### Reading many blocks

List views should not fetch full documents to show titles and metadata.
`blocks.read` takes up to 1000 `ids` and returns the found blocks in request
order, reduced to `fields`: `id` (always), `parent` (`parentId`, `position`),
`title` (first content line without property tokens), `properties` (block
scope), `revision`, `timestamps` (`createdAt`, `updatedAt`), `author` (with any
actor/session/task provenance), `hasChildren` and opt-in `text`. Omitting
`fields` returns everything except `text`. Every other id appears once in
`unavailable` as `missing` or `trashed` (with its `deletedRootId`); one absent
id never fails the batch. Duplicate ids collapse to their first occurrence.
`blocks.query` accepts the same optional `fields` and then returns
`{ blocks, completeness, fields }`, each block carrying its query `depth` and,
when the property scope attaches them, its `propertyMatches`. Trashed
matches (`includeDeleted: "roots"` or `"all"`) also carry the full query's Trash
metadata, with no field to request: `effectiveDeletedRootId` (the
`deletedRootId` that `blocks.read` reports) and, on each Trash root, `deletedAt`
and `deletedDescendantCount`. Active matches never carry these keys. The
matches, order and completeness are unchanged. Without `fields`, `blocks.query`
keeps its full-block shape. Projected results echo `fields`; a response without
it came from an older service that ignored the projection. Prefer one `blocks.read` to per-block `get`
calls: over a forwarded socket each request pays a network round trip.
CLI: `bun run cli read <id>… --fields title,properties` and
`bun run cli list … --fields title,properties`.

### References and transclusions

Exact references use stable block IDs:

```text
Depends on ((516e1754-7741-4c9e-83a6-7b703a8f0798|the approved boundary))
```

Exact references accept `((block-id))`, `((block-id|label))`, `((block-id^fragment-id))`, and `((block-id^fragment-id|label))`. The optional authored label controls only presentation: following and backlinks retain the canonical block ID and optional fragment. Read views resolve untitled references to current target titles and titled references to their labels; edit views, exports, and storage retain the exact raw syntax. A label cannot be empty, whitespace-only, multiline, or contain the closing `))` delimiter. Symbolic links use `[[address]]`; a block registers an address through `[page::address]`, and existing Work IDs participate in the same unique normalized registry. Accepting completion for a Work-ID inserts `[[WORK-ID|title]]`, or `[[WORK-ID]]` if the title contains nested reference delimiters; ordinary pages and aliases retain `[[address]]`. Parsing or saving a dangling link never creates content. Only explicit follow creates a root stub, transactionally; unresolved Work-ID-shaped addresses fail instead of squatting the stable Work-ID namespace. Explicit rename preserves the old address as an alias, and explicit removal unregisters an alias or primary declaration. A human edit that removes `[page::address]` also unregisters that primary address when the revision-guarded save succeeds; the note UUID and existing aliases remain. Agent text updates still use the explicit page operations, and Work IDs remain immutable. Deleted targets remain resolvable and purged targets become dangling.

Detail preview removes the authored `((…))` and `[[…]]` delimiters from valid links and applies one semantic link treatment to only the resolved title or label. Missing titled block targets render as an unlinked `label · Missing target`; invalid syntax stays raw. Keyboard follow, click navigation, edit mode, storage, and export continue to use the canonical authored target.

Stable fragments are inline anchors attached to a heading, paragraph terminus or list-item header:
`## Description ^description`. Read mode hides the marker. Exact links use
`((block-id^description))`; completion can resolve a heading name to its stable
ID, and Detail navigation/history retain the fragment target. A heading fragment
spans through the next equal-or-shallower heading; a paragraph fragment spans
from its preceding blank line or heading through the anchored terminus. Missing
and duplicate anchors remain explicit. A list-item fragment includes its
continuation lines and nested items, never the preceding siblings or introduction.
IDs inside fenced or indented code examples do not declare addresses.

The checklist service operations and identity-preserving write contract are
documented in [Checklist items](docs/CHECKLIST_ITEMS.md). Reader controls and
item projections are still under development on the PIE-367 branch.

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
bounded by source block and report `complete` or `truncated`. A service with
the `references.backlinks.facets` capability adds `facets` to each source: its
`kind` and `kindLabel`, its `placement` relative to the target (`self`, `descendant` or
`other`), its `stage` (the first declared of `work-stage`, `outbox`, `stage` or
`status`, with a `waiting`/`draft`/`active`/`done` bucket for known values) and,
for comments, whether the thread is `resolved`. The kind comes from the source's
own `type::`, else from the nearest typed block up to and including its
containing page; comments and replies are `comment`. An untyped containing page
is a `day-page` when it has a `day::<YYYY-MM-DD>` or its whole `page::` address
is such a date; anything else is a `note`. The stage is the source's own, else
the stage of the block that supplied the kind. The mapping is the data table `DEFAULT_BACKLINK_FACET_RULES` in
`src/backlink-facets.ts`, not a list of workspace types.

Work IDs are allocated through the service rather than by scanning in a client. `work-ids.status` reports the configured prefix, observed legacy prefixes, and next ID; `work-ids.configure` explicitly chooses the workspace prefix; `work-ids.allocate` optimistically appends the next ID to an opted-in canonical block or atomically replaces its single configured `[work-id::<PREFIX>-XXX]` self-assignment marker. A clean existing prefix is adopted automatically, while ambiguous legacy prefixes remain visible but unconfigured. Canonical manual IDs for the configured prefix advance the same allocator; malformed, noncanonical, or out-of-prefix property values remain inert text metadata. The reservation ledger retains owning UUIDs after purge.

For a human writing notes, the intended promotion flow is: write freely, decide a block has become durable work, then ask the agent to assign it a Work ID. The agent calls `outliner_work_id` rather than guessing a number. Typing `PIE-NNN` or `[[PIE-NNN]]` only references an existing assignment; it never allocates one.

The configured `<PREFIX>-XXX` marker requests semantic work resolution. `[work-id::PIE-XXX]` asks whether the containing block should reuse existing work or receive a newly allocated ID; `[[PIE-XXX]]` requests a related work reference; `[issue::PIE-XXX]` preserves a typed issue relation. Before each agent turn, the shared Pi/OMP extension checks the raw prompt and full focused block. Textual `outliner_*` tool results are also checked. At most one compact reminder is injected per turn, only for the configured prefix.

Detection never searches, creates, allocates, relates, or rewrites by itself. The bundled `work-placeholder-resolver` skill directs the agent to perform a bounded existing-work search, reuse one confident match, leave ambiguous markers intact, otherwise create or promote canonical work, allocate through `outliner_work_id`, connect UUIDs, and optimistically replace only the exact marker. Failures preserve `XXX`; self-assignment allocation replaces the placeholder transactionally.

### Virtual branches

A normal physical block becomes a virtual branch through properties:

```text
Queued work
[type::virtual-branch]
[query::type=roadmap-item work-stage=queued]
[sort::updated]
[direction::desc]
[limit::20]
[summary-properties::work-stage,priority]
```

Roadmap stage views project existing records; create new work through
`outliner_roadmap_create`. Ordinary content views may use `[create::key=value]`
and `[create-parent::<canonical-parent-id>]` when the defaults and physical
destination are unambiguous.

Spaced values use the same canonical filter syntax:

```text
[query::status="in progress" project=pi-outliner]
```

A virtual branch can override the workspace Tree summary order for its projected
occurrences with `[summary-properties::key,key,…]`. The override is
presentation-only; ordinary and projected rows continue to read the same
canonical parsed properties.

Matches appear as disposable `◇` root occurrences. Each matched root also projects
its canonical descendants as contextual rows through relative depth 2 by default.
`[child-depth::0]` shows matches only, `1` adds their children, and `2` adds
children and grandchildren; integers through `8` are supported within the row budget.
`[expanded::false]` starts matched roots collapsed; `true` starts them expanded.
Omitting these properties preserves the existing behavior. Manual opening and
closing wins over defaults in that Tree, even after refresh or policy changes.
Use **Reset view expansion** in `?` on a definition or result to discard that
view's local overrides. New occurrences use current defaults; a new Tree starts
fresh. Nested copies retain independent disclosure. A configured depth that hides
children is labeled **CHILD DEPTH n · DEPTH LIMITED**, separately from row/query
truncation. These controls apply to Tree and navigator projections; authored
Detail embeds remain their existing compact result-link lists. Context
has independent, ephemeral disclosure; `Left` and `Right` navigate its projected
parent/children without changing canonical text or storage. A canonical block may
therefore appear beneath a matched ancestor and independently as a matched root,
and may still appear in multiple branches.

In Tree, **Add child** (`a`, also in `?`) on a projected result creates a
canonical first child under that result and selects it in the same occurrence.
Only the selected occurrence opens; other collapsed results stay collapsed.
The child does not need to match the view's query. Depth or row-budget limits
are checked before creation and again on save; a refusal offers Reveal source
(`Shift+R`) or changing the view bounds. Nested definition rows whose canonical
children cannot be projected are refused rather than creating an invisible child.
Adding siblings and indenting/outdenting projected rows remain disabled.

Each branch reserves its bounded, deduplicated roots before allocating contextual
descendants in root/canonical-preorder order. Unsorted branches apply persisted
manual ranks before the limit. `[sort::created]` and `[sort::updated]` instead
order the complete match set by timestamp before limiting; `[direction::asc]` or
`[direction::desc]` chooses the direction and defaults to `desc`. Roots and
context share a 1,000-row budget. Nested virtual branches compose through at
most four branch boundaries, with cycle detection. Root-query, depth, and
row-budget truncation are reported separately, and allocation does not depend
on disclosure state.

Press `Shift+V` on a virtual-branch definition in Tree or Detail to open its
generic read-only navigator popup. The left pane uses the same projected roots,
context descendants, occurrence identities, disclosure, ranking, and truncation
states as Tree; the right pane uses the same Detail read projection and rendering
path, including property-metadata exclusion, embeds, and callouts. `Up`/`Down`
selects without retargeting the invoking pane, `Left`/`Right` navigates
disclosure, and `/` filters the popup rows transiently. `Enter` opens the shared
destination chooser. `Shift+R` dispatches Reveal for the selected row's physical
source and closes after the service accepts that dispatch. Outside the chooser,
`Esc` or `q` closes without changing canonical data, Tree selection, viewport,
Detail Current, or occurrence ranks; inside the chooser, `Esc` first dismisses
that chooser. At narrow widths, `Tab` switches between the independently usable
list and preview.

In Tree, `Option+Up` / `Option+Down` reorders matched roots within an unsorted branch using
persisted occurrence ranks. Timestamp-sorted branches disable manual occurrence
reorder. Contextual descendants never participate. Canonical parent/position
order stays unchanged, and ranks survive temporary query mismatches.

### Bookmarks

Bookmarks are ordinary canonical records under the single
`[system-view::bookmarks]` virtual-branch root. `m` toggles the current Tree or
Detail target; removal moves only the bookmark record to Trash, while
the target remains unchanged. Each active record has one `[type::bookmark]`,
one `[target::<canonical-block-id>]`, and one
`[bookmark-created::<ISO-UTC>]`; its display label is captured separately from
the stable target identity, and child blocks remain available for notes.

`Shift+M` opens the same navigator with the bookmark adapter. Root rows
preview and route to the current target, so later target renames and moves
remain valid. Missing or trashed targets are explicit and cannot be opened or
revealed; `m` in the popup removes the selected bookmark record and
chooses the deterministic adjacent row. Default record order is creation order,
while ordinary virtual-occurrence ranks provide optional manual order.

## Capture and Inbox

### Workspace and connection diagnosis

In Tree, open `?` and choose **Workspace and connection** for a read-only report of the invoking workspace, project config, endpoint, protocol and storage paths. Or run `bun src/cli.ts doctor` from the plugin checkout with `OUTLINER_WORKSPACE_ROOT` set to the workspace to inspect (`--json` for structured output). The command works when startup fails and exits nonzero for configuration, transport or protocol errors.

The report groups Client, Connection, Storage and Backup information. Drag to copy visible text, or click a field's **Copy** action for its complete value. `Tab` / `Shift+Tab` focus fields and `c` copies the focused value; `?` lists actions and configured bindings. Arrow/Page keys scroll, and `Esc` returns to Tree. Copy values omit labels, existence notes and visual wrap breaks. Copying never changes the connection or protects navigation. “Sent to terminal clipboard” reports the request; clipboard acceptance still depends on the terminal/SSH host.

For local connections the report gives the exact state/database paths and the presence of a conventional backup directory. Manual backup locations are not registered and may be elsewhere. For remote connections it distinguishes the forwarded client socket from the service host and canonical storage reported by that service. Older services may not report storage identity. A missing local database can mean either a new workspace or moved storage: diagnosis does not initialize it, restore backups, migrate data, or start a service. A failed remote connection names the socket and suggests checking its SSH tunnel and canonical service.

### Quick capture Inbox

Tree `c` opens Quick Capture without navigating away from the selected row. Enter adds a line. **Save to Inbox** / Ctrl+S submits; **Retain** / Esc closes while keeping the draft; **Discard** / Ctrl+D requires confirmation. Text, cursor, selection, request identity and the original captured-from context are retained in one workspace-owned draft. Reopening Capture in that workspace resumes it. If a Capture surface is already active in the same Herdr session, Tree and global entry return to that surface, including an editor with unsaved writing. A different host/session is reported explicitly rather than opening a competing writer.

Use **Dock** / Ctrl+O, then Left, Right or Down to keep writing beside or below the Outliner. **Popup** returns to the floating editor. Docking transfers the same draft and cursor/selection; it does not submit or duplicate the note. Focus can move to Tree, Preview or another Detail while the capture stays open. Placement shares the Detail sidebar's layout preservation and rollback path.

**Editor** / Ctrl+E opens the draft in VISUAL/EDITOR using the existing local recovery journal. Opening Capture allocates one canonical Inbox draft before accepting keystrokes, including when blank, so closing or reconnecting can retain writing against that identity. Both assistance workers exclude that note until explicit submission. Returning from the editor retains its writing; use **Save to Inbox** when it is ready for processing. A launch failure keeps the draft available for retry. Concurrent changes are revision guarded, and returned editor writing is retained in the note's recovery history.

**History** / Ctrl+R opens retained writing and the existing Base/Draft/Latest comparison. Choosing a version brings it back into Capture without immediately changing the note. Continue editing, retain it, or submit with Ctrl+S; the reviewed save checks the latest revision and keeps the replaced text available through history. If the note changes again, refresh the review instead of overwriting it. Closing a conflicted capture retains its local writing in that same recovery journal.

Short docked panes collapse the controls before hiding the editor; the cursor stays visible while resizing. Ctrl+O still opens placement choices when the full toolbar cannot fit.

For direct entry from an ordinary Herdr shell, the `capture-editor` action creates or resumes the same protected draft in a right sidebar and opens VISUAL/EDITOR immediately. The workspace's compatible service must already be running; an Outliner view need not be open in the current tab. Invoke the action or bind it in the active Herdr config:

```sh
herdr plugin action invoke capture-editor --plugin float.pi-outliner
```

```toml
[[keys.command]]
key = "prefix+shift+n"
type = "plugin_action"
command = "float.pi-outliner.capture-editor"
```

Merge that optional binding with existing shortcuts and check for collisions; it is not installed automatically. The capture contract requires protocol **76**, so update the service and clients together.

`capture.create` writes one ordinary canonical child beneath the active `[system-view::inbox]` block. Tree, CLI, Pi/OMP tools/commands, and exact standalone dispatch markers are adapters over this same mutation. Captures include:

```text
Useful title [type::capture] [status::unprocessed] [capture-source::tree] [captured-at::<ISO timestamp>] [captured-from::<optional canonical block UUID>]
Optional supporting detail on later lines.
```

Quick Capture shares Tree and Detail's inline reference list: type `[[` for named pages/Work IDs, `((` for blocks/fragments, or `[file::` for file paths. Keep typing to filter; use Up/Down and Enter/Tab or click a result to insert. Escape first dismisses suggestions and leaves the draft open; another Escape retains and closes it. Completion preserves the multiline cursor and undo history, and does not change capture receipt/retry behavior.

The optional captured-from block is context evidence, not the capture’s parent. Lifecycle metadata is a trailing block-scoped property run on the first authored line, so the useful title remains first; compact Tree rows hide that metadata and supporting lines until expanded. The Inbox can be renamed or moved while retaining its canonical identity, and new captures appear at its top. Persistent receipts bind each request ID to normalized text, source, captured-from context, author, and actor. Changed submissions under the same ID are rejected; same-payload retries remain idempotent after restart. Quick Capture retains the original submitted text while its outcome is uncertain. If the user edits after a failure, retry acknowledges the original submission and leaves the changed draft open under a new identity; another explicit Ctrl+S captures that draft. Cleanup clears only its acknowledged draft revision, and revisions are not reused after clearing. Capture never changes workspace selection/history; the Tree restores the exact prior row and shows a compact receipt. Automatic Inbox editing starts after that durable save, independently of the popup.

CLI accepts `--text`, explicit `--stdin`, or automatic non-TTY stdin/heredoc input. `--request-id` provides caller-controlled retry identity and `--captured-from` records optional context. Receipt JSON is written to stdout; service failure exits nonzero without a local fallback. Retry with the same text and context. New CLI and popup clients reject an incompatible service before capture; restart the service and clients together for protocol upgrades. Legacy receipts without payload evidence reject replay and identify the existing capture for manual inspection; migration preserves retained drafts rather than guessing what was submitted.

The Pi extension registers `/capture` and `outliner_capture`. An exact standalone `float.dispatch(…)` input is intercepted by the Pi/OMP input hook, durably captured, acknowledged, and handled without starting an agent turn. Embedded/conversational markers are left untouched; malformed markers report a warning and continue as ordinary input.

`/send-to-outline` copies the latest completed assistant Markdown from the
current Pi/OMP session into Inbox as an ordinary agent-authored canonical
capture with session provenance. After durable capture, the active model generates a concise plain title while the complete Markdown remains unchanged as the body. Title generation or revision conflicts never remove the original capture: the command reports the full block UUID for recovery and leaves its initial title intact.
When a recently focused or unique Tree is available, the command focuses the new
block there and dispatches an ordinary open to the first eligible Detail; if
Tree or Detail routing is unavailable, the durable Inbox block remains and the
command reports that presentation failure. Links, backlinks, block references,
embeds, and bounded queries therefore use the ordinary Detail projection.
Responses remain chat-only unless the command is invoked; there is no disposable
report slot or report pane.

### Inbox editing budget

Inbox cleanup and bounded-answer editing have a five-minute total budget across Pi turns and tools. Set `OUTLINER_INBOX_TIMEOUT_MS` on the service to override it (positive integer milliseconds, at most 30 minutes); restart the service to apply it. Progress does not reset the deadline. Classification keeps its own bounded requests.

Five minutes is a provisional background-work allowance: two real attempts exhausted the former two-minute policy during a multi-turn edit. Those older runs lacked transcripts, so they do not establish an optimal budget or prove a longer run will succeed. Inspect the saved Pi session before increasing it further.

A deadline leaves that note unchanged with a failed result and continues other pending work. The same revision is not retried automatically; reconsider it explicitly. Provider/configuration failures still pause assistance. Pause cancels the active run and retains its session evidence.

### Inspecting assistant sessions

Inbox editing and bounded note answers retain a separate native Pi JSONL session
for each attempt under the workspace state directory's `assistant-sessions/`.
Open Tree's Inbox activity with `Shift+I`, select a result, then press `t` to open
its session as a file Resource in Detail. Tab/Enter also follows the session links
in the result. Files are resolved by the service, including for remote clients.
Jev-only classifications have no Pi session.

Results retain the session identity, outcome, last phase and start/end timestamps.
Completed assistant messages and tool calls/results are inspectable with Pi's
native session tools. If interrupted before Pi's first assistant message, the
result points to a clearly labelled snapshot of the SDK entries available then;
partial streamed output is not promised. Each retry starts a new session. Opening
a transcript does not resume the attempt or replay writes. Canceled attempts stay
in recent activity without consuming the pending note or becoming failures that
pause unrelated work. Protocol 65 adds this canceled result state; restart the
service and clients together when upgrading.

### Automatic Inbox agent

Inbox Open selects a live Output, otherwise the current Source. Saved Pi sessions
are explicit diagnostics (`t`), never the default for an in-place cleanup.
`Alt+Enter` opens content in the linked reader while retaining the Inbox result;
with no available destination it offers the shared chooser. Use **Link destination**
or **Open once** in the Inbox header (also available through `?`). Cancel returns
to the result; Escape from Inbox returns to Tree.


The service uses the default model and authentication already configured in Pi.
It processes existing unprocessed Inbox notes and newly saved captures without a
separate run command. Set `OUTLINER_INBOX_AGENT=0` on the service to disable it.
Optional `TYPESAFE_API_KEY` enables Jev comparisons of duplicate and related notes;
the editor still works without Jev. Missing Pi configuration is visible in the
Inbox view. Restart the service after configuring its model.

Press `Shift+I` in Tree (also available in `?`). The view shows progress, results,
links, and observed model usage. It opens on **Needs attention** when any questions
or errors remain, otherwise on **Recent results**. `a` switches between those
views; the footer names the destination and follows configured shortcuts. A
background refresh preserves your choice. Left/Right page through recent results.
The attention count includes items outside the current page. `p` pauses/resumes, `u` undoes the
selected cleanup, and `r` reconsiders a held, failed, or undone note with optional
direction. `Tab` selects an output/source link, `Enter` reveals it in Tree, and
`Alt+Enter` opens it in Detail. Closing the view leaves the agent running.
Pause and reconsideration instructions survive service restart. History and Undo
remain available when the model is disabled or unavailable.

The editor can rewrite, split, combine useful context, and file ordinary notes.
General notes, lists, and meetings stay notes. Concrete Outliner tasks use the
existing PIE allocator and enter Backlog; cleanup never commits or executes them.
The original source keeps its identity and children. Clean primary notes move to
**Filed notes**; sources whose content moved elsewhere become concise linked
summaries in **Processed captures**. Cleaned notes and split outputs expose **Original capture** through protected
`raw-capture` Resource properties. **Before this rewrite** names the immediate
before-image on an edited source or merge target. Tree Authored links, Detail
Properties and Preview reach these read-only snapshots directly; Preview Back
returns to the cleaned note. Split outputs share one original; merges keep each
source. The content reuses Inbox recovery records, without another raw-copy note
or background processing of historical requests. Missing historical evidence is
shown as unavailable. This applies to new cleanups; existing notes gain the
connection when rewritten, using their earliest preserved applied attempt.
No automatic expiry is introduced. These Resource-reference semantics require
protocol 73 and a coordinated client/service restart.

Each cleanup and its recovery record commit together. Apply and Undo reject stale
edits; Undo refuses to overwrite later changes to affected blocks or their children,
or remove a new output that has since acquired references or annotations. If its
bounded reference inspection is incomplete, Undo refuses rather than guessing.
An undone note is held until edited or explicitly reconsidered. Questions do not
block the remaining Inbox. Provider failures stop automatic processing and remain
visible; Resume retries the failed note. A single note exceeding its editor budget
needs attention without stopping unrelated notes. Jev failures are shown with the
result; the Pi editor can still complete the cleanup. Costs are estimates from observed usage,
not billing receipts; cancellation may interrupt final usage reporting. This is a
single-user editorial experiment: inspect the results and use Undo when a judgment
is wrong.

### Automatic note organization and requests

With Pi configured and `TYPESAFE_API_KEY` available, the same service worker also
assists new or meaningfully edited ordinary notes throughout the workspace.
Captures get one combined filing/assistance operation and one Undo receipt.
Jev chooses a useful content type and a few retrieval tags;
authored prose, manual types and tags, and the note's identity stay intact.
Removing an inferred tag or changing its type is a remembered correction, including
after restart. Managed records such as tickets, batches, annotations and generated
sections keep their existing contracts. Historical types are not bulk-renamed.

Ordinary categories are `note`, `idea`, `design-note`, `decision`, `finding`,
`feedback`, `review`, `implementation-proof`, `progress`, `reference`, `synthesis`,
and `hub`. Topics such as rabbit holes belong in tags rather than new categories.
Write `#rabbit-hole` or `#y2026/q1` anywhere in prose: these use the same property
index as `[tag::rabbit-hole]`. Hashtags remain visible. Code, link destinations,
escaped hashes, headings and numeric references such as `#134` are not tags.
Tag queries match the complete value; `y2026` does not imply every descendant tag.
Suggested calendar tags come from the content's stated period, not its import date.

A fresh direct request can be fulfilled in the same note. Complete property
inventories use the indexed `properties.inventory` operation, independently of
autocomplete's 100-value limit. Prose answers use Pi with read-only Outliner
tools. A successful answer records `request-status::fulfilled`; unsupported or
unanswered requests stay open. Answering cannot run shell commands, change tickets,
or send messages. Inbox triage can still record a bug or feature as backlog work;
its receipt distinguishes that filing from actually executing the request.
Activity distinguishes **organized**, **fulfilled**, and
**unfulfilled**, with the existing Pause, Undo and Reconsider controls.

The first startup checkpoints existing notes without executing old instructions.
To opt an older note in, select it in Tree and choose **Assist this note** from
`?`. New notes need no invocation. Set `OUTLINER_NOTE_ASSISTANCE=0` to disable this
part while keeping Inbox filing, or `OUTLINER_INBOX_AGENT=0` to disable both.
`bun run test:e2e:notes` exercises real Jev and Pi inside a private Herdr instance.

Inbox effort routing (PIE-331) keeps coherent captures on Jev-only keep/metadata paths, archives clear test noise reversibly, and sends ambiguity, mixed work and explicit reconsideration to Pi. Activity shows the route and reason. The editable `inbox-routing.json` is read per job; set `enabled` to `false` there to disable routing. [The trial report](experiments/inbox-routing/REPORT.md) documents the measured tradeoffs and limits.

### Editing AI prompts

The service keeps editable prompt files in its workspace state directory:
`~/.local/state/pi-herdr-outliner/<workspace-key>/prompts/` (or beneath the configured
`OUTLINER_STATE_DIR`). They are seeded once from the versioned `prompts/` defaults.
Restarting or upgrading does not replace existing files. `OUTLINER_PROMPT_DIR`
selects another complete directory; explicit directories are never populated or
silently mixed with defaults.
An existing default installation gains the two note-assistance files once during
upgrade; later removal or edits are preserved.

| File | Controls |
| --- | --- |
| `inbox-editor.md` | Pi's Inbox editing instructions |
| `inbox-relationships.json` | Jev's duplicate/related and coverage questions |
| `goto-ranking.json` | Jev's Goto scoring instructions and four score levels |
| `inbox-routing.json` | Jev Inbox effort selection and reversible-archive trial thresholds |
| `note-assistance.json` | Jev's ordinary types, tag relevance, request classification and confidence thresholds |
| `note-answer.md` | Pi's bounded read-only answer instructions |

Add ordinary `[file::/absolute/path/to/prompts/inbox-editor.md]` references to an
**AI prompts** block. Open each Resource in Detail, press `e`, edit, and save with
`Ctrl+S`. The runtime reads those same files: the block does not contain a second
copy of the instructions. Files are on the service host, including for remote clients.

Each Inbox job reads its prompt files once when it starts; each eligible Goto
search reads its ranking file. Saving affects the next job/search without a rebuild
or restart. Jobs already running retain their captured versions. Results record
the exact file text, path and SHA-256 hash; Inbox shows the filenames and short
hashes alongside model usage. Historical results keep their old snapshots after
later edits. Routine `inbox.status` responses include only prompt paths and hashes;
`inbox.result` with a `resultId` retrieves a receipt's full prompt snapshots. These
are evidence, never another editable configuration source.

JSON instructions and criteria are editable, while the result keys and score count
remain the contract enforced by code. Tool permissions, mutation checks and work
allocation are also code-owned. Empty, missing, oversized or malformed files report
the affected path. Fix the file and Resume Inbox; Goto retries on the next search
and retains text matches while its prompt is invalid. No stale prompt is silently
used. The separate older-note survey remains an experiment, outside automatic Inbox processing.

`bun run test:e2e:prompts` tests Resource editing and prompt reload in a private
Herdr session using real Pi/Jev calls. It requires configured Pi authentication;
the service environment supplies `TYPESAFE_API_KEY` for relationship judgments.



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
- `outliner_checklist_query`
- `outliner_checklist_update`
- `outliner_property_patch`
- `outliner_property_catalog`
- `outliner_query`
- `outliner_page`
- `outliner_work_id`
- `outliner_move`
- `outliner_clients`
- `outliner_selection`
- `outliner_annotations`
- `outliner_annotation_reconcile`
- `outliner_comment` (revision-guarded block/quote convenience)
- `outliner_annotate`
- `outliner_annotation_reply`
- `outliner_annotation_lifecycle`
- `outliner_annotation_batch`
- `outliner_attention`
- `outliner_workflow`

`outliner_query` accepts structured filters such as `{ key: "status", value: "in progress" }`, plus optional text and subtree fields. The service normalizes keys/values and applies the same bounded semantics used by human surfaces. `outliner_focus` targets an explicit or unique live Tree client and returns compact structural context.

For a block comment, prefer `outliner_comment` with `blockId`, `expectedRevision`,
`comment`, and `passage: {quote: "exact source text"}`. It creates the canonical
representation and anchor inside the annotation transaction. Repeated quotes
require a UTF-16 `start` offset, exact adjacent `prefix`/`suffix`, or a unique
checklist `itemId` that bounds the search. Missing or ambiguous quotes fail without
writing; omit `passage` only for an intentional whole-block comment. Source quote
bytes are preserved, including Unicode and line endings. Reading the note first
provides the required revision. Comments do not focus or navigate any pane.

Provide a stable `requestId` when retrying across tool calls; the default is the
session and tool-call identity. A retry with the same input returns the existing
comment even if the first write assigned a checklist ID or the source later
changed. Reusing that ID with different input fails. A new request with an old
revision fails, even if the quote still exists. The receipt includes original
and resolved targets and placement status. Existing reply/lifecycle and reader
reconciliation apply unchanged; checklist comments follow stable item identity.

CLI equivalent (quote is source text, not rendered text):

```sh
bun run cli comment --id <block-uuid> --expected <revision> \
  --quote 'Review the release' --text 'Check the dependency first' \
  --request-id <stable-request-id>
bun run cli comment --id <block-uuid> --expected <revision> \
  --whole --stdin --request-id <stable-request-id> < comment.md
```

The public `createBlockComment` helper in `src/block-comments.ts` accepts request
identity, a `BlockCommentInput`, author and provenance. Protocol80 adds the
`block-comment` operation to the existing `annotations.batch` transaction and
ledger, alongside typed creates and replies. It does not add a second comment
store. Existing `outliner_annotate` remains available for typed Resource and
representation targets. Reader source selections share the same quote resolver
while keeping their captured representation and source mapping.

Annotation tools use the same ordinary comment and reply blocks as Detail and the same relational target sidecar. `outliner_annotations` queries a block or Resource subject.

`outliner_annotate` accepts a representation plus one of `whole-subject`, `text-quote`, `dom-range`, `pdf-page-region`, `structured-entity-field`, or `provider-comment-id`; it does not treat a file path as identity or use a web-specific creation path. `whole-subject` deliberately comments on the note or Resource without a passage; its captured representation remains evidence, and it is displayed separately from lost passage anchors.

Inbox Before previews comment on the saved source from that processing attempt,
not the latest text. Their block snapshot includes `inboxAttemptId`; the service
checks its block identity, timestamp and content hash against retained recovery
bytes. Missing historical evidence does not fall back to current text. The
comment still belongs to the canonical note, so it appears in ordinary readers
as well. Historical captures without timestamp evidence remain readable but
cannot create a comment from that preview.

In local Tree and Inbox Preview, drag to select a passage, then use Comment or
`c`. For keyboard selection, focus Preview and press `v`: arrows position the
cursor, Shift+arrows extend the selection, and `c` opens the comment composer.
Selection is limited to the visible reader viewport. Escape clears selection.
The composer shows the captured quote before saving. A single-line selection
gets exact source coordinates only when the complete rendered document matches
the captured canonical text without transformation or wrapping. Other captures
retain their rendered text and source identity as unpositioned passage comments;
terminal wrapping is not treated as a Markdown character offset. Fragment
captures also retain the fragment ID. Without a
selection, Comment targets the whole note. Inbox source/version controls, result
navigation and incoming receipt updates cannot displace an active comment draft.
Save or cancel keeps the displayed source; deferred receipts apply on the next
result navigation or refresh.

Historical readers can display a proven range from that saved version even if
the latest note has changed. Current-note readers still respect unresolved
placement. Short comment composers retain a writing row and save/cancel hints;
finishing composition clears obsolete draft-retention warnings.

While Preview owns focus, `?` exposes its comment actions and effective bindings.
The `tree.reader.*` actions can be remapped independently of Tree browsing:
`comment` (`c`), `select` (`v`), `previous` / `next` (`[` / `]`),
`reply` (`Shift+C`) and `lifecycle` (`Shift+D`, resolve or reopen).


For an occurrence-scoped comment, pass `target.referenceContext` with the containing block representation, exact authored-reference anchor, and original `sourceText`; omit it for a subject-wide comment. File-passage comments retain the Resource representation and passage anchor alongside that context.

Create and batch calls are idempotent, replies inherit the root target and history, and lifecycle changes can link promoted canonical blocks. The immutable original target is returned beside the current resolution and complete append-only history. Text and PDF quote anchors use deterministic unchanged, exact, contextual, and bounded local-fuzzy reconciliation; PDF results are mapped back to current page regions. Probable, unresolved, ambiguous, orphaned, unsupported, and rejected records remain preserved history rather than being coerced into a location.

`outliner_attention` requires an explicit live client ID. It can mark, advance,
acknowledge, clear, or inspect short-lived block/file attention. Exact UTF-16
anchors carry source version/hash evidence; stale source is rejected on create
and existing marks become visibly stale after a source change. `reveal` and
`focus` are explicit, independent opt-ins. Without them, the target pane's
selection, navigation history, drafts, and canonical content do not change.

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

Roadmap items use `work-stage` as their only lifecycle field:
`unprioritized`, `later`, `queued`, `doing`, `review`, `validate`, `done`, or
`superseded`. They have no `status` property; other block types keep their own
status meanings. Done means accepted delivery with proof. Superseded records
link a replacement and do not count as shipped.

One optional `work-batch` UUID on each item owns its membership in an agreed
batch. Batch views query those references, so the commitment remains visible as
items advance, pause, or finish. Priority, arc/track classification, dependencies,
and branch-local ranking do not change membership. A small standalone fix can
be queued without a batch. Scope changes and deferrals belong on the batch.
The live **How this workboard works** block owns the operating flow; the
[`roadmap operations reference`](pi-extension/skills/outliner-workflow/references/roadmap-items.md)
documents creation, lifecycle, ranking, and migration.

`outliner_task` persists one active roadmap block per Pi session. Starting a
code-delivery item ensures its canonical `[type::delivery]` child and safely
attaches or creates the recorded Work-ID-bearing branch before advancing work.
Starting unprioritized, later, or queued work enters Doing; resuming Review or
Validate preserves that stage and reuses the same delivery identity. Pausing
Doing returns it to Queued; pausing Review or Validate only clears the session
binding. Batch membership remains intact. Completion requires linked proof and,
for recorded code delivery, an observed merged PR at Validate. It sets Done and
clears the binding. Agent lifecycle events never infer semantic completion.

The durable delivery block owns `delivery-key`, `repository`, `base-branch`,
`work-branch`, `delivery-stage`, and observed pull-request facts. It never owns
another `work-id`. `outliner_delivery` exposes status, deterministic ensure,
and live GitHub synchronization. Git and GitHub remain authoritative for branch,
PR, review, and merge facts; the Outliner stores identity and observed lifecycle
state. Historical lifecycle-override properties remain readable but no operation
creates them.

The shared Pi/OMP extension inspects the invocation-local checkout through
bounded, argument-array `pi.exec` calls. Every active-task turn receives a
compact repository/branch/dirty/ahead invariant. Task start reuses a recorded
local or remote branch, creates a missing branch from the recorded base, and
returns another-worktree paths instead of stealing them. Dirty wrong branches,
detached HEAD, wrong repositories, missing bases, and Git conflicts leave both
Git and roadmap stage unchanged. It never stages, stashes, commits, or opens a
pull request.

Delivery orientation is advisory after task start. The extension does not
intercept tools or block session switch, fork, or tree navigation based on the
active delivery branch. This deliberately disables the premature lifecycle gate;
PIE-214 owns any future enforcement after repository, worktree, delivery,
agent/subagent ownership, recovery, and publication boundaries are modeled.

Synchronizing the exact open PR advances the item to Review; merge advances it
to Validate. Repeated synchronization of unchanged PR facts preserves explicit
rework in Doing. Session reentry reuses the same delivery identity and preserves
Review or Validate until an explicit transition.

Before each agent turn, the extension uses Herdr pane-focus history to locate the most recently focused registered Outliner client, reads that client's browsing context, and injects the focused block body, breadcrumb, properties, and children. A different active task is appended as separate session context rather than replacing the user's focus. Without a focused Outliner client it falls back to the active task and then the legacy shared selection.

The same bounded context budget can include up to five distinct blocks recently edited by the user. The first turn considers a seven-day horizon; later turns request only activity newer than a session-persisted cursor. Entries use current block text, deduplicate the focused block and active task, and report exact UUID and edit time. Failed or timed-out activity queries add nothing and do not advance the cursor. Agent and system mutations never enter this user-activity section.

[`outliner-workflow`](pi-extension/skills/outliner-workflow/SKILL.md) defines when to publish durable findings, decisions, roadmap reviews, syntheses, progress, and implementation proof through `outliner_publish` rather than leaving useful workspace knowledge only in chat. Context and presence integration fail open when their optional surfaces are unavailable. Deterministic configured `PREFIX-XXX` nudging is shipped: the extension inspects prompts, focused block text, and textual `outliner_*` tool results and injects at most one resolver reminder per turn without performing the resolution itself.
[`outliner-documentation`](pi-extension/skills/outliner-documentation/SKILL.md) is a compact context pointer for project-documentation work. It queries the workspace-local `[system-doc::agent-documentation-guide]` block and reads that canonical guide before writing; legacy or intentionally customized databases fall back to the same ownership invariant without silently installing seed content.

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
Only the service and an explicit **New outline here** create this directory;
opening a folder without an outline does not.

Browsing contexts, Detail targets/history, Tree presentation state, and live
Herdr client identities are intentionally ephemeral and are not stored in
`outliner.sqlite`. Canonical content remains shared and durable.

Back up `outliner.sqlite` before experimenting with migrations. Do not copy a live database without also accounting for SQLite WAL files.

A truly empty database receives the default Workspace roots plus one canonical
Documentation hub. Seed version 5 keeps the agent documentation guide and adds
**Explore the Outliner** (`[[outliner-tour]]`) for navigation, Resources, comments, Inbox and
prompts, work stages and batches, and the combined-surface experiment. The seed
is ordinary, editable workspace content and runs only once; restarts and package
upgrades never overwrite local guide changes.
The schema remains migration-owned rather than being distributed as a prebuilt
SQLite database.

`bun run test:e2e:documentation` opens that actual seed in an isolated Herdr
session, finds the tour through Goto, reads an embedded source fragment, and
navigates the projected example notes. It does not touch your workspace.

### Remote client mode

A workstation can render Tree and Detail panes locally while another host owns
the canonical service and SQLite database. Forward the service's Unix socket
over SSH:

```sshconfig
Host float-box-outliner
  HostName float-box
  User evan
  LocalForward /absolute/local/float-box.sock /absolute/remote/outliner.sock
  StreamLocalBindUnlink yes
  ExitOnForwardFailure yes
```

Keep that tunnel running with `ssh -NT float-box-outliner`. Client endpoint
selection is project-scoped. From the invoking project, print its config path:

```sh
bun -e 'import { resolveClientConfigPath } from "/path/to/pi-herdr-outliner/src/paths.ts"; console.log(resolveClientConfigPath({ ...process.env, OUTLINER_WORKSPACE_ROOT: process.cwd() }))'
```

The path has the form
`~/.config/pi-herdr-outliner/projects/<workspace-name>--<stable-hash>/client.json`.
Create it with the local invoking workspace identity and forwarded socket:

```json
{
  "workspaceRoot": "/absolute/local/project",
  "mode": "remote",
  "socketPath": "/absolute/local/float-box.sock",
  "label": "float-box:/absolute/remote/project"
}
```

Projects without this file use their local per-project database when one
exists; opening one with neither shows the outline chooser described under
[Open the workspace](#open-the-workspace) rather than creating a database. The chooser
writes this same file when you pick another outline.
`OUTLINER_CONFIG_PATH` explicitly selects another config. For one-off shells,
`OUTLINER_REMOTE=1` with an absolute `OUTLINER_SOCKET_PATH` overrides project
configuration; `OUTLINER_REMOTE=0` forces local mode.

The former machine-global `~/.config/pi-herdr-outliner/client.json` is not
applied automatically. If it remains and no project config exists, startup
reports a migration error with the derived destination path. Move the file,
replace `"remote": true` with `"mode": "remote"`, and retain `socketPath`.

Install or link the same Outliner revision on both hosts, start the service only
on the canonical host, then invoke `open` normally on the workstation. Remote
mode never creates a local service pane or database. Tree and Detail register
their workstation hostname and live Herdr topology with the canonical service,
so routing remains local to that host even when pane IDs overlap.

Each Detail process keeps a disposable 32-target block cache. Revisiting a
cached block paints its context and projection immediately, then revalidates
against the canonical service; changed revisions replace the cached paint and
stale responses cannot replace a newer target. Resources continue to use their
provider-specific immutable revision model and are not stored in this cache.
Rapid passive Tree previews are latest-wins in both the publisher and Detail
event queue. Explicit opens, edits, and navigation retain ordered delivery.

The forwarded socket exposes the complete Outliner RPC to the local account.
Keep it in a user-private directory and use an authenticated SSH connection.
Client and service protocols must be compatible: `doctor` shows both and the
service's capabilities.

## Development

```sh
bun run check
bun test
bun run profile:tree --check-budget
```

The deterministic Tree profile defaults to 24,000 physical blocks and five
200-root virtual branches. `--check-budget` enforces p50 below 25 ms and p95 below
50 ms for projection/controller initialization, p95 below 5 ms for viewport
layout/render, and p95 below 1 ms for input handling and terminal-frame writes.
Omit the flag to report timings without a pass/fail gate.

The separate real-application scale journey uses the private Herdr runner:

```sh
bun run test/e2e/tree-scale.ts 1000
bun run test/e2e/tree-scale.ts 5000
```

It checks complete projection and authored ordering, then drives Tree navigation
while mutations and reorders revalidate two active browsing contexts. It retains
frames and forwarded request counts. Parse plus projection p95 must stay below
100/250 ms at 1,000/5,000 blocks, and mutation-to-frame p95 below one second.
These are same-host measurements; they do not establish SSH or bandwidth latency.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workboard lifecycle, verification rules, and PR/restart workflow. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for service boundaries, protocol flow, persistence, projections, and failure behavior.

### Real Herdr keyboard E2E

```sh
bun run test:e2e:herdr
```

This opt-in scenario requires Linux, Herdr 0.9.1 with protocol 22, and the
checkout's installed Bun dependencies. It starts a private named headless Herdr
server with a fresh project and tab, isolated XDG configuration, Outliner state,
and keybindings. Its private plugin registry links this checkout. Existing
Herdr workspaces and plugin registrations are unchanged.

It first interrupts fixture preparation and verifies that cancellation cannot
leave a private server running after cleanup.

The scenario types `[file::README.md]` through Tree, reveals and selects its
generated Resource row, then activates it twice. Read-only SQLite assertions
check that passive authoring and discovery create no Sources or Resources.
Activation must render the fixture in the actual Detail and preserve its
canonical Resource identity on repeat.

The command prints JSON containing `status` and `artifactDirectory`, and exits
nonzero on failure. Every run retains its temporary project and artifacts,
including the command timeline, assertion records, invocation log, process
provenance, visible text and ANSI, topology, client registrations, and consistent
SQLite snapshots. The runner stops its owned processes even on failure. Remove
the printed artifact directory's parent when the evidence is no longer needed.

Reusable lifecycle and terminal controls live in `test/e2e/herdr-runner.ts`.
Product actions and assertions stay in `test/e2e/resource-authoring.ts`.
This covers the keyboard path through real PTYs, not mouse input, an attached
Herdr GUI, or live terminal resize.

The workspace-ownership journey is a separate service regression:

```sh
bun run test:e2e:ownership
```

It holds a real HTTP refresh at a fixture barrier, starts a competing service,
checks that the live refresh, sequence, and service-pane registration stay
unchanged, and displays the original owner's completed result in Detail. It
uses the same private Herdr runner and retained artifacts. Resource setup and
refresh use production RPC; this is a service/visible-result check, not a
keyboard authoring claim. `test/workspace-ownership-process.test.ts` additionally
covers simultaneous service starts and legitimate recovery after `SIGKILL`.

The capture safety journey drives a real attached Herdr client:

```sh
bun run test:e2e:capture
```

It saves through the actual popup, rejects one draft cleanup, types more, and
verifies that retry retains the new draft. It also drops a committed reply,
closes/reopens, and checks same-submission deduplication, then returns to Tree
keyboard navigation and its `c` command. A private socket proxy injects faults;
production code has no test switches. Raw PTY output and current rendered screens
(decoded with test-only `@xterm/headless`) accompany database snapshots. The
fixture owns and stops its attached client. This is a local forwarding fixture,
not two-host SSH evidence, mouse coverage, or multi-client verification.

The editing safety journeys also use the private attached client:

```sh
bun run test:e2e:edit-conflicts
bun run test:e2e:file-revisions
```

They verify stale Detail/CLI rejection, retained drafts, sibling reordering,
metadata-preserving external file replacement, and explicit cancellation/reload
before a fresh save. The file journey does not claim to close the separate
validation/rename race.

`bun run test:e2e:file-authority` runs the file ownership journey for both Pi and
ANSI Detail. The fixture opens one additional remote-mode Tree/Detail pair with
its own workspace root, deliberately writes different contents at the same path,
and checks service-owned previews, path completion, preserved line ranges, and
explicit Resource activation. Passive reads leave catalog identities unchanged.
The runner records those clients' roots, socket, registrations, and process
provenance. This is a same-host ownership test, not two-host SSH evidence.

`bun run test:e2e:tree-index` prepares 1,000 blocks through the service and runs
the Tree journey with direct and privately forwarded sockets. Real keys search
full text beyond the preview, edit exact text, expand virtual rows, and navigate
contextual children after another client edits and reorders blocks. The fixture
compares complete projections and records response bytes, parse/projection time,
Tree request counts, visible frames, and cleanup. First-frame timing runs from
launch to the first observed populated frame and includes host/polling overhead.
The forwarding observer records its own parsing cost; this is not two-host SSH
latency evidence.

`bun run test:e2e:detail-progressive` drives cold Detail reads and cached revisits
with direct and privately forwarded sockets. Matched optional reference or
annotation replies can be held, failed, or released after navigation. Real keys
verify that primary content stays readable and editable, late replies preserve
drafts and newer targets, unresolved links stay disabled, and block/Resource
comments retain exact source ranges and provider revisions. The fixture records
selection-to-primary timing, forwarded request counts, checkpoints, and cleanup.
These same-host observations do not establish two-host SSH latency or host mouse
behavior; emitted hyperlinks have separate renderer regressions.

`bun run test:e2e:annotation-threads` uses real keys in a private Herdr session
for contextual/Resource-wide thread navigation, multiline replies, visible save
validation, resolve/reopen and cancellation. It verifies preserved target and
viewport, other-occurrence and orphan reachability, a narrow Detail, and ANSI
ordinary-thread/evidence scrolling and operations. One real Pi Reply control
click and cancellation runs through the attached Herdr client's mouse input.
Existing threads and an agent reply are seeded through public APIs.

## Project documents

- [Architecture](docs/ARCHITECTURE.md)
- [Contributing and delivery workflow](CONTRIBUTING.md)
- [Proposed safety and Herdr/Pi implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [OpenCode port requirements](docs/OPENCODE_PORT.md)
- [Archived early feedback](docs/archive/misc-feedback.md)

## Non-goals

- Replacing Herdr as the pane/workspace manager.
- Becoming a full Vim/Emacs competitor; use Pi TUI’s editor substrate if the custom editor grows beyond a narrow baseline.
- Treating projected occurrences as duplicated canonical blocks.
- Hiding query truncation or persistence failures behind silent fallbacks.
- Creating symbolic page stubs merely because unresolved `[[text]]` was typed; accepted design creates a stub only when that link is followed.

### Linked explicit opens

Each live Tree or Detail region can link to one Detail destination. Several sources may share a destination; receiving a document does not follow the receiver's own link. Moving panes leaves these links unchanged. New Tree/Detail pairs start linked; independent Trees use **Alt+L**, **Shift+L**, or the clickable **Opens in / Change** header. Detail uses the same shortcut. The menu marks the current link and previews the selected reader’s document. Destinations show document titles and Herdr workspace/tab locations; nearby readers come first. Readers on other hosts or without a known pane location are behind **Show other connected views**. Local panes proven absent by a ready Herdr snapshot are excluded. Connected readers without location evidence are retained, not assumed dead.

Tree **? → Open once in…** and Detail's reference destination chooser (**c**) choose an existing Detail for one action without changing its link. The chooser also offers **R** to replace here and **r/d** to create a right/down split. Cancelling never resolves an authored Resource or refreshes its provider. An unlinked or closed destination produces an explicit recovery message, with no automatic destination or split. Drafts and active source selections reject replacement.

Agent RPCs use `navigation.link.get` / `navigation.link.set` with `{source: {clientId, region}, destination: {clientId, region: "detail"} | null}`. `navigation.resolve` and `navigation.dispatch` accept `sourceRegion` (required for composed clients) and a one-off `destination`. Runtime links are cleared when either client disconnects; they are not saved pane IDs. Passive preview remains a separate operation.
The Link destination picker also offers **New Detail right/below another reader**.
Choose the existing local reader that should anchor the split. **Sidebar left/right ·
Outliner area** wraps the smallest existing layout subtree containing this tab's
Outliner panes; unrelated panes stay untouched. **Sidebar left/right · Whole Herdr
tab** places the reader at the tab's outer edge, including beside chat/terminals.
Creation from **Link destination** also links the invoking Tree or Detail to the
new reader once it registers. Other views keep their links; no reverse link is added.
Failed creation keeps the previous destination. Ordinary split shortcuts remain
create-only. Placement keeps existing terminal sessions alive.
If Outliner panes are interleaved with unrelated panes, Outliner-area placement
refuses and offers whole-tab scope instead. Failed placement attempts to restore
the original layout; incomplete restoration reports a retained recovery-record path.
Finish or cancel active edits/filters before changing destinations. Plain uppercase
`L` remains text inside editors; on terminals that send a printable character for
Option+L, use Shift+L in reading mode or click **Change**.

### Focused Tree views

Use the Tree actions menu (`?`) to **focus branch**, **return to workspace**, or open **Tree right/below**. A focused Tree shows that exact occurrence as its root, including nested queries. New Tree splits have their own root, selection, disclosure, scroll and navigation history, and do not create another Detail automatically. Closing a view never deletes its blocks.

`Shift+Right` reveals one additional hierarchy layer under the selected occurrence. `Shift+Left` folds its deepest expanded layer. These leave other branches and inline note previews alone; the shortcuts can be changed in the keybindings configuration. Existing `Alt+Shift+Right/Down` still create Details. Goto or Reveal Source can deliberately leave the current root; Back returns to the earlier root and viewport.

Collapsed source folders no longer empty a query displayed through another projection. Missing or no-longer-visible roots retain a **return to workspace** action. This is local navigation state, not another database or a smaller network payload.

Each Detail reader retains **Current** alongside its own local **Preview** for
references and backlinks. Composed Tree selection also updates that embedded Preview. At wide widths they sit beside each other; at narrower widths,
`Alt+P` (also `F7`) switches between them. Taller narrow readers stack them instead. `Alt+Enter` keeps Preview as Current; `Esc` closes a focused Preview and `Shift+F7` closes it from either reader. Keeping or editing Preview first protects any Current
draft or source selection. Current keeps its own history, scroll, editor undo,
and document identity while another item is inspected.

Standalone Tree always owns its read-only Preview (`Alt+P` or `F7` to focus it,
`Esc` when focused or `Shift+F7` to close); selection never creates a pane. It uses the shared rich Markdown reader with wrapping and callouts. Dragging in this Tree-local Preview selects and copies only its displayed text through OSC 52; clipboard delivery depends on the terminal. Pointer input stays inside its owning region. Explicit Open continues to
use the source's saved destination link. Resource Preview reads an existing
representation and retains its revision; it does not intern or refresh a Resource.

### Inspecting received keys

Use **? → Inspect received keys** in Tree or Pi Detail. The in-place panel shows
received bytes, Unicode code points, decoded keys/modifiers, and matching reading-mode
shortcuts. It observes the input reaching that pane, with its existing terminal
protocol settings. Escape is displayed for inspection; **Ctrl+Q closes only the
inspector**. Inspected keys do not edit documents or execute shortcuts. No key log
is written to disk or sent to the service. Raw chunks are bounded and are not assumed
to be individual physical keypresses.

For the ANSI Detail runtime, launch with `OUTLINER_DEBUG_KEYS=1` to open the same
inspector on startup. This is useful when the host intercepts a shortcut: injected
Herdr keys test the application, while pressing the physical keys in this panel
also tests the terminal input path.

### Sticky Tree breadcrumbs

The sticky path follows the selected occurrence, including the query through which you reached it. A `◇` marks a projected path segment. Click an ancestor to focus that branch; **Back** restores your former root, selection and vertical viewport. `⌂` returns to the workspace. The `<` / `>` controls scroll only the path, with configurable `Alt+[` / `Alt+]` equivalents. **? → Focus parent branch** provides keyboard ancestor navigation.

The **Indent** badge, **Alt+I**, or **? → Toggle indentation follow** switches between two behaviors, independently for each Tree:

- **Viewport** (default): reclaim indentation shared by all visible rows. Moving selection within that viewport keeps the content stable.
- **Selection**: follow the selected occurrence’s depth even while shallow rows remain visible. A `‹` marks a row whose indentation extends off the left edge; select it to bring its ancestry back into view. Its hidden disclosure control is not clickable.

The choice lasts for the Tree process. It changes presentation only: root, selection, order and canonical hierarchy stay unchanged. Breadcrumbs follow the selected occurrence in both modes.

### New Tree without a Detail

The installer assigns **prefix, Shift+U** to `float.pi-outliner.open-tree`.
Use `--tree-key CHORD` to customize it. **? → New Tree** in Tree or Detail
opens an independent Tree at the workspace root. Existing **Tree right/below**
actions instead use the selected branch. Prefix+U retains Tree+Detail launch.

### Local Tree Preview controls

Each Tree has its own **Show/Hide Preview** control and `?` menu actions.
Hiding persists while browsing until you show it again. In Preview's header,
**→** docks right, **↓** docks below, **Auto** follows available space, **−/+**
resize, and **×** hides. Drag the divider to resize directly. Keyboard equivalents
are `Alt+Shift+P` (toggle), `Alt+=` (grow), and `Alt+-` (shrink); all are configurable.
Dock and size preferences survive hide/show and terminal resizing within that Tree;
they do not change Herdr panes or persist after closing the Tree. Small windows use
a compact reader; `Alt+P` switches focus between Tree and Preview.

### Read Inbox source and output in place

On larger panes, Inbox places results and Activity above side-by-side Source and
Output readers. Drag the horizontal divider to give documents more room; drag the
vertical divider to change their relative widths. Without a separate output,
Source takes the full bottom width. Numbered tabs select among multiple outputs.
Technical details expands session, prompt and usage information; errors remain visible.

**Before** / **3** reads the source saved before the selected attempt. **Current** /
**4** reads its current canonical content. A before-image may already contain edits
from earlier attempts; it is not necessarily the original capture. Missing snapshots
are labelled explicitly, and inspecting one never performs Undo. Historical text
renders as saved, without resolving today's live queries or embeds into it.

Use **1** for Source, **2** for the first Output, **Tab** for other targets,
**Shift+A** for Activity, and **Alt+P** for List/Preview focus. Clicking the list
or either reader changes focus. Wheel over a reader scrolls that document; drag
inside it to copy. Escape first leaves reader focus, then returns to Tree.
Narrow panes retain a single reader with Source/Output/Activity choices. Before and
Current remain available in the Source toolbar and action menu. Explicit Open follows
the linked destination and opens the current canonical note, never the saved snapshot.

Inbox activity summaries describe the metadata actually applied, including no-op
organization, alongside the editor's explanation of prose changes. Technical
usage labels **model work** as wall time from entry to return/failure of model
work, summed for sequential organization/edit phases. It excludes queue waiting
and the store commit; it is not Jev latency. `notChecked` records observed search,
read and judge limits. Those omissions remain visible with technical details
collapsed. Historical attempts without this field say coverage was not recorded;
an empty omissions list is not an exhaustive search guarantee.

### Repairing Inbox proposals

`finish_cleanup` validates ordinary note metadata and the existing roadmap allocator without reserving a Work-ID. Field errors return to Pi inside the same session and budget; the service repeats revision checks and commits atomically. Reconsider and Resume remain explicit retry paths. Unchanged failed revisions are suppressed instead of automatically looping.

New activity receipts show the retry trigger, prior attempt and observed cost, plus a failure category. Prompt evidence compares active and packaged hashes; differences are informational and never overwrite your editable files. Historical receipts retain unknown trigger/coverage information.

### Recent agent mentions

Tree and Detail's `?` menu includes **recent mentions**, a split navigator of notes
referenced by completed agent responses. It resolves `[[page]]`, `((block-id))`,
Work IDs and existing bare UUIDs against the explicit workspace. Selecting previews
the canonical note; Enter chooses where to open it. The toolbar supports mouse and
keyboard: conversation/workspace scope, surrounding Message/Note, Clear, Save
message to Inbox, and Bookmark. This is a navigation history, separate from note
metadata: at most 200 referenced responses and 100 distinct targets per view are
retained. Oversized input is rejected; omitted references and missing targets are
visible. Clear removes history, not notes or explicitly saved messages.

To enable completed Codex responses for a workspace:

```sh
bun scripts/install-codex-mentions.ts /absolute/workspace
```

This installs Codex's user-level `notify` command and backs up `config.toml`.
Restart Codex to load it. An existing different notification command is preserved;
compose adapters explicitly instead of overwriting it. Only the configured exact
workspace is ingested. Protocol 71 requires updating the service and clients together. A reachable service is required; delivery
failures are reported by the adapter, without blocking the agent. There is no
background retry queue or import of earlier conversations. The adapter also
accepts Codex Stop hook payloads, but installation uses completion notifications.
Other hosts can post the same `{workspaceRoot, agent, sessionId, messageId, text}`
contract using `mentions.ingest`, or JSON stdin to `bun src/cli.ts mentions ingest`.
Repeated message identity with identical text is idempotent; different text under
the same identity is rejected. No Pi or Claude adapter is installed automatically;
for Claude Code, load the mod in [`claude-mod/`](claude-mod/README.md).


### Conditional virtual-branch disclosure

Add `[expanded::false] [expand-when::type=annotation annotation-status=open priority=high]`
to reveal paths to open, explicitly high-priority comments. Annotation blocks carry
`annotation-status`; anchor relocation state is separate. Set `priority::high` in the metadata header of
comments you want to highlight. The condition uses the same positive-AND property
presence/equality syntax as `query`, including quoted values.

Inspection uses only canonical rows inside the existing depth/row budget. It never
follows Resources, nested query results or model judgments. `ATTENTION n` counts
matches in that scope; `ATTENTION LIMITED` means a depth, nesting, row or query
limit prevents a complete assessment. Query failure says `ATTENTION UNAVAILABLE`.
No claim is made about material outside the view's bounded canonical context.

Only ancestors of matches open; unrelated branches and replies stay folded. Revealed
paths remain open until collapse/reset, so resolving the last match cannot displace
the selected row. An `! attention`
marker remains when you manually collapse a matching path. Manual open/collapse
wins over later attention changes; resolving a comment cannot close a path you
explicitly opened. **Reset view expansion** discards those choices and reevaluates.

### Installed Resource extensions

Jira requests use an installed process on the service host. Installation, code updates,
and enable/disable changes do not require rebuilding the Outliner. See
[the process contract and configuration guide](docs/extensions/resource-process.md).
The initial binding is read-only Jira; other Resource providers retain their existing paths.


### Temporary branch filtering

In Tree, select a block or virtual branch and press `/` (or **View → Filter this branch**).
Type to fuzzy-find text within its descendants, including collapsed descendants
within the projection's configured depth and limits. Work-ID prefixes such as
`DEM-3` match literally. Results keep their original rank and show matching
ancestors for context. The filter reads bounded full bodies once per revision;
keystrokes use that temporary cache. A partial-coverage notice identifies limits
or unavailable content. The cue shows the match count, query and scope.

Enter browses the narrowed list; Escape or **Clear filter** restores the original
occurrence, expansion and viewport. Selection, Preview and copying stay in that
branch. **Move selected before/after** chooses a visible unselected anchor but
places against the full branch order. Up/down moves one position in that full
order, including hidden items. Neither operation changes canonical parents or
another branch's ranks. **Advanced property filter** retains the workspace
property-query interface as a separate View action.

### Responsive status summaries

The optional [status-summary renderer](extensions/status-summary/README.md)
turns readable `component:status` fences into labelled counts that fit the pane.
Install its manifest on the reader host; Detail, Tree Preview and Inbox Preview
share its links, selection and comments. No app rebuild is required. Disabled or
missing renderers retain the original source with an explanation. Reopen the
note after changing the renderer configuration.
