# Changelog

This file records notable user-facing changes. The project remains active dogfood, so protocol and storage contracts can still change before a stable release.

## [Unreleased]

### Pane bars you choose, glyph dock buttons, and a chrome budget (PIE-525)

- Preview's bar is back to one click for docking: `[▐]` right, `[▄]` below,
  `[◙]`/`[○]` Auto docking on/off and `[×]` close, each the same action as its
  key and menu item.
- In any `[⋯]` menu, right-click an item or press `Alt+Enter` to pin it to that
  pane's bar (Tree, Preview or Detail), or unpin it. Pins are saved in
  `ui.json` beside `keybindings.json`, can be edited by hand, and reload with
  `Ctrl+R`. Defaults ship in code; the shape (`bar` and `chrome` per pane kind)
  is the one ep0ch-door will share.
- Compact chrome is one bar row and one hint row per pane. The hint row is
  generated from the bound actions, every hint is clickable, and statuses flash
  there instead of taking a row. Docked below, Preview's bar is the divider.
  Workspace path, counts, Inbox and "Opens in" moved to the menu's top row.
- `chrome: compact | full` per pane kind replaces `view.json`'s `density`
  (no longer read). **View → Tree/Preview/Detail chrome** switches it.
- Tree and Preview at a 65×20 pane: 10 content rows with the former full chrome,
  18 now; chrome rows around Tree with Preview below went from 11 to 3.

### The Claude mod follows the folder you run Claude in (PIE-526)

- A Claude session's Recent Mentions, links and outline tools use the outline
  its folder is bound to: the nearest folder with a `client.json`, or an
  outline root the host serves. No allowlist to configure, and a folder bound
  to no outline feeds nothing (never the host's default outline).
- `outliner bound-folder [folder]` prints that binding as JSON (never a guess).
- `PI_OUTLINER_MENTIONS_WORKSPACES` (and the mod's `workspaces` option) opts
  folders out. `PI_OUTLINER_MENTIONS_MODE=allowlist` keeps the old behaviour.
  An old allowlist with no mode feeds nothing anywhere (one toast) until the
  mode is set or the list dropped with `install-claude-mod.ts --folder`.
- `install-claude-mod.ts` needs no folder. `--exclude` opts a folder out,
  `--folder` drops an old allowlist (naming listed folders bound to no
  outline), and folders given bare (or `--allowlist`) are strict mode. `install.sh` gains `--claude-exclude`; `--claude-workspace` is
  strict mode, and `--claude-mod` no longer asks for a folder.

### Anyone with the link: `[publish::public]` (PIE-518)

- Tag a note `[publish::public]` or `[publish::public:<slug>]` and anyone with
  its link can open it, including claude.ai and ChatGPT. `publish serve
  --public-port N` adds a public listener from the same publisher: it serves
  only public notes, has no index, and shows "not shared" for an embed of a
  note that isn't public. `[publish::never]` still wins. Expose it with
  Tailscale Funnel on its own port (Funnel opens a whole port, so never beside
  the tailnet mounts on 443).
- `publish list` and the tailnet index gain a PUBLIC column with each public
  note's link (`--public-url`).
- `[publish::public]` used to publish at the slug `public`; it now means the
  above.

### Proposals apply once, never past their passage, and dismiss in the service (PIE-510)

- "Apply anyway" places only the passage the proposal shows. If the person
  changed that passage since, the apply is refused and their text stays. It
  used to replace whatever stood between the context kept around the passage,
  which at a note's end was everything after it. A forced apply also stays
  above the mark. A proposal whose passage was already gone when it was made, or
  is at or below the mark, carries `[proposal-applies::no]`, so clients offer only dismiss.
- A proposal is applied or dismissed once: a second call made at the same time
  is refused. If the applied status can't be written, the answer has a
  `warning`.
- `draft.proposal.dismiss` (capability of the same name) dismisses a proposal
  in one step. Its embed line comes out of the note or of the door's live
  draft, the proposal gets `[proposal-status::dismissed]` and goes to the
  Trash, attributed. An agent can dismiss only its own proposals. A patch the
  service sends a door's live draft to apply or dismiss a proposal carries
  `proposal: { id, op }`.
- An `@name` request whose proposal was applied or dismissed now shows
  `applied` or `dismissed` under its line. A proposal's text no longer names a
  door key.

### Agents addressed while you write (PIE-501)

- An extension can declare `agents[]`. A person's `@name …` line (quiet for a
  moment, outside code) runs that agent's `respond` with the note as the person
  sees it. Its patches apply as an attributed edit through `draft.patch` with the
  `edit` policy, landing in a door's live draft when one holds the note; only a
  failed compare becomes a proposal under the line. A reply shows under the
  line. Each request runs once; `r` asks again; a line an agent wrote waits for
  `r`. Example: `extensions/tidy` (`@tidy`, `@tidy all`).
- PIE-510: every agent's `draft.patch` passes one guard that refuses writing or
  rewording an `@name` line (not only an `@name` agent's own answer). Notes from
  before agent requests keep their old `@name` lines old (a one-time baseline at
  start). A request a restart cut off says so; one still waiting for quiet when
  the service stops waits for `r`. Undoing the removal of an answered line brings
  its answer back instead of asking again. `r` records who pressed it
  (`requestedBy`: `user` or `agent:<id>`), an agent's `r` doesn't release a line
  an agent wrote, and `r` on the note (Detail's) asks the requests not answered
  yet. `drafts.touch { holdId }` lets a door say the person typed in a held
  draft, so a request runs while they write, before any save. Note assistance
  leaves lines addressed to an extension's agent alone.

### Extensions wave B: watched folders and the four kinds (PIE-507)

- Extension folders are watched: `<outline root>/extensions/<id>/` and
  `~/.config/pi-herdr-outliner/extensions/<id>/` load, reload and unload with no
  restart. A broken folder keeps serving its last good version and says what is
  wrong, naming the file and the field. `extensions.list` reports every folder,
  its state, its handlers, actions and tile kinds; an `extensions` event says when
  it changed.
- The four kinds, each with an example in `extensions/`: data put into a block
  (`moon::`, beside `jira::`), inline output under a line (`horoscope::`), a rich
  component composed from shared primitives with its own actions
  (`fancy-horror::`), and a whole tile for the door's tile-kind registry
  (`tarot.reading`). Handler lines share one grammar (argument, typed `--options`,
  display options), run by `effects` (`read`, `spend`, `write`), and show in
  `resources.projection.read` beside Jira's tickets; `r` runs them.
  `extensions.render` gives a result as markdown, blockdown, html, json, csv or
  terminal text; `extensions.act` runs an action (or the built-in `keep`), its
  writes kept inside the block and attributed `ext:<id>`.
- `outliner ext add <name|path>`, `ext remove <name>`, `ext ls` (from the running
  service) and `ext act`. Detail draws handler outputs and its `r` refreshes a
  note's tickets and extension lines. See
  [docs/extensions/README.md](docs/extensions/README.md).

### Merged without an entry, Sep 30 – Oct 1 (added in the PIE-510 cleanup)

Newest first.

- An applied proposal says what was done: "Applied as an ordinary edit." rather
  than "A applies it anyway". The tarot tile fits a door tile 8 to 60 columns
  wide, cutting long lines with `…` (#270).
- Claude mod: a click on a reference, `show` and `door_open` share one open. In
  a door (`EP0CH_CONTROL` set) it asks that door through `door-open --from
  <tile>`, using the `t<n>` id when the tile has no name, and the door's refusal
  is the answer; else Herdr's Detail split; else a toast or denial that says
  why and gives the `((id))` to copy. `door_open` no longer runs its own
  `ep0ch` command (#264).
- **Behaviour change:** `draft.patch` defaults to the `edit` policy, the same
  guard as `outline_edit`: only a dropped `[page::]` or a dropped `^anchor`
  another note links to is refused, as an error with nothing written, unless
  `allowStructural`. Before, every patch got the strict prose check, and a
  dropped `[[link]]` turned the whole patch into a proposal. The prose check is
  opt-in (`policy: "prose"`); its refusals still become proposals. A patch
  stays atomic, and a proposal reads as one edit of N changes. The mod's
  `outline_patch` takes `policy` and `allowStructural` (#263).
- A store opened at `:memory:` takes no ownership lock, so tests no longer leave
  a `:memory:.owner.sqlite` file in the working directory (PIE-510).

### Merged without an entry, Sep 22–30 (added in the PIE-502 catch-up)

These shipped with README or PR notes but no changelog line. Newest first.

- macOS parity: a leftover file at a socket path (`ENOTSOCK` on macOS) reads as
  a stopped outline rather than a busy one, and the artifact cache is resolved
  to its real path before a build, so pinned packages load under `/tmp` and
  `/var` links (#257).
- Claude mod: the `whereAmI` context names the ep0ch skill and its `peek`,
  `actions` and `act` commands, so a door agent knows how to drive the door
  (#256). The first door-tile `show` routing is #249; #251's entry below
  describes the current behavior.
- Detail links survive an embedded note whose title has parentheses: resolved
  text is no longer re-parsed, and `((uuid|Label (with parens)))` keeps its
  whole label (#247).
- Recent Mentions from a folder bound to a hosted outline is accepted, and the
  mod expands `~` in `PI_OUTLINER_MENTIONS_WORKSPACES` entries (#246).
- Opening from Herdr never creates an outline by itself: in a folder with no
  outline, **Choose outline** lists the known outlines (running or stopped) and
  offers **New outline here**; Esc creates nothing. `service-only` refuses in
  such a folder (PIE-458, #241).
- The client and service survive Bun 1.4's repeated socket errors (`EPIPE`);
  the suite passes on Bun 1.3.14 and 1.4.2 (PIE-454, #240).
- CLI `create` and `update` take `--author user|agent|system`, `--actor` and
  `--session`, and the new `activity` command reads `activity.recent`
  (`--limit`, `--since`, `--after`, `--author`) (#238).
- A Preview that already shows a note narrows to one checklist step when that
  note reloads with a step anchor (PIE-446, #235).
- A `jira::` line shows the ticket's stored details beneath it in Detail
  (accepted forms include floatty's `- jira:: --comments`), and a ticket page
  shows its ticket at the top. Reads never contact Jira. Capability
  `resources.projection` (PIE-445 slice 1, #234).
- Backlinks carry service facets (kind, stage, placement, comment
  resolution; capability `references.backlinks.facets`). Detail and Backlink
  Peek group them by kind with stage counts, hide the note itself, its
  descendants and resolved comments by default, and filter with `k`, `t`, `h`,
  `n` and `/` (PIE-442, #233).
- Checklist requests report missing `query`, `target.start` and
  `expectedRevision` as caller errors, and generated step anchors are short
  (`^t-daca0f`); existing `^task-<uuid>` anchors still work (PIE-443, #232).
- `properties.preview { text }` returns the block properties and every token a
  save would parse, from the save-time parser; CLI `properties-preview`
  (PIE-401, #222).
- `blocks.read { ids, fields? }` reads up to 1000 blocks in one request with
  field projection, and `blocks.query` accepts `fields`; CLI `read <id>…
  --fields` and `list … --fields` (PIE-400, #221).
- Virtual branches take `[expand-when::…]` to reveal collapsed paths to
  matching blocks, such as open high-priority comments, inside the view's budget
  (PIE-379, #197), and `[child-depth::0..8]` and `[expanded::false]` to bound
  descendants and start roots collapsed; **Reset view expansion** restores the
  view's policy (PIE-378, #196).
- Claude mod: Work IDs, `[[page]]` and `((uuid))` in Claude replies are links.
  A click opens the target in a Detail that Claude owns, split below its pane
  and reused, never taking focus; the `show` tool opens a reference there on
  purpose. The CLI gains read-only `resolve <pi-outliner-uri>` and `link …
  --detail-client <id> [--no-focus]` (PIE-359, #192, #193, #195).
- `install.sh --capture-key` binds a global Quick Capture shortcut (default
  `prefix+shift+c`; the comment-on-selection default moves to
  `prefix+shift+a`) (PIE-206, #146).

### Recorded with their PRs

- `draft.patch` has two policies. `edit`, the default, is the guard every agent
  edit has (`droppedLinkedStructure`, shared with `outline_edit`): only a
  dropped `[page::…]` or a dropped `^anchor` another note links to is refused,
  as an error with nothing written, unless `allowStructural`. A dropped
  `[[link]]` or `((ref))` applies, as an ordinary attributed edit when no door
  holds a draft of the note, or into the draft when one does. `prose` (opt-in,
  for tidying the person's words; `outliner patch-demo` uses it) keeps every
  structural token, and what it refuses becomes a proposal as before. Only a
  compare that fails or a prose refusal parks a proposal, and a proposal reads
  as one: `1 proposed edit (6 changes) from @agent: not applied, because change
  1 would … · A applies all`. `outline_patch` takes `policy` (default `edit`) and
  `allowStructural`.
- Outline tools for agents in the Claude mod (PIE-504): `outline_read` (full
  text, properties, revision, bounded children, completeness), `outline_find`,
  `outline_resolve`, `outline_edit` (revision-checked; refuses an empty write
  and dropping a `[page::…]` or a linked anchor), `outline_create`,
  `outline_comment`, `outline_reply`, `outline_resolve_thread`,
  `outline_changes` and `outline_patch` (`draft.patch`), each attributed to the
  agent; and in a door tile `door_where`, `door_peek`, `door_act` and
  `door_open`. They run the new CLI `agent` command. CLI `comment` takes
  `--author agent --actor`, and `activity` takes `--actor` (service capability
  `activity.actor`, which also gives `activity.recent` a `beforeCursor` so
  `outline_changes` pages back through a cut answer instead of skipping it). An
  agent's `note_section` and `work_body` refuse dropping a `[page::…]` or a
  linked anchor too.

- Fresh workspaces get seed 6 of the Documentation hub (PIE-502). The agent
  guide describes the boolean saved-view grammar, `[child-depth::…]`,
  `[expanded::…]`, `[expand-when::…]` and `views.planWrite`, page rename by
  editing `[page::…]`, literal regions, nested transclusion through the service,
  write attribution and `activity`, and that `outliner_publish` is not web
  publishing. The tour adds working selections, Preview comments, folding,
  grouped Backlinks, **New Tree**, and a section on outline names, publishing,
  the Claude Code mod and ep0ch-door; its example view uses an `OR` query.
  Existing workspaces are never reseeded.

- Published blocks run claude.ai artifacts: attach a downloaded `.html`,
  `.jsx`/`.tsx` (React, compiled on the server with `Bun.build`, never run
  there; claude.ai's packages fetched pinned into `<state root>/publish/artifacts`;
  shadcn/ui and Tailwind included), `.svg`, `.mermaid`/`.mmd`, `.md` or code file
  and it works at its URL, sandboxed with an opaque origin. Embeds on published
  pages (and in rendered markdown attachments) now show the embedded note's text,
  published or not, within the service's transclusion limits; `[[page]]` and
  `((block))` links in rendered markdown attachments link published targets; and
  `[publish::never]` locks a note and everything under it from every page, embed
  and link. See README "Artifacts".
- Claude mod: a session started in an ep0ch-door tile (or the door's Herdr agent
  pane) is told where it runs. At session start the mod runs `ep0ch where --json`
  (read-only) and gives its one-line summary to Claude as the `whereAmI` context
  block of the first prompt: the stack of layers from `EP0CH_NEST`
  (`ssh:pts/5 › door:<pid>/desk/t1:claude`), what is live, and where the person's
  keys are. Without an `ep0ch` that knows `where`, it gives the variables alone,
  marked unchecked. Outside a door it does nothing.

- Outline as server: `outliner publish serve` gives every block carrying
  `[publish::…]` a URL on 127.0.0.1 (`/p/<page address|block id|slug>`), serving
  an attached `.html`/`.md` file or the block and its subtree as markdown (with
  `?view=html`), and `/index` lists them all. Read-only; attachments are served
  only from allowed roots, never through `..`, escaping symlinks, hidden paths
  or non-regular files, never from `/` or the home folder, and not at all when the
  service runs on another machine. Attached HTML runs sandboxed, with an opaque
  origin. Embeds, titles and links never show an unpublished block's text or id.
  Any `[publish::false]` on a block wins, and a request naming a foreign Host is
  refused.
  Expose it with `tailscale serve --set-path /pub`. See README "Publishing blocks".

- In an ep0ch-door tile, `show` and a click on a reference open the note from
  Claude's own tile (`door-open --from $EP0CH_TILE`): the door puts it where
  that tile's opens land and says which reader, instead of the mod assuming a
  tile called `middle` (ep0ch-door PIE-491). A door without that tile, or older
  than `open from=`, is asked for its `middle` reader as before, then for none.

- The service plans writes into saved views (PIE-490). `views.planWrite` says
  what moving a block into each view would patch (with token ordinals, at the
  block's revision), or what a new block there is born with, and why not when a
  patch can't satisfy the view's query; `query.matches` says which of given
  blocks a query holds for. The property token grammar moved into
  `src/property-grammar.ts`, one definition the parser, the query language and
  context resolution share, and `ping` reports its version for clients that
  copy it. ep0ch-door uses all three instead of its own copies. Additive
  capabilities `views.planWrite`, `query.matches`, `ping.propertyGrammar`.

- Rename or remove a page by editing its text. Changing `[page::x]` to
  `[page::y]` in Detail, Tree, `outliner update` or any client renames the page
  (`[[x]]` stays an alias, so links keep resolving; renaming back promotes it);
  deleting the token frees the address. Saves were refused before with "requires
  pages.rename" / "requires pages.remove". An address another note owns is
  refused as `[[y]] is already the page of block <id>; pick another name`, and
  nothing is saved; an owner in Trash is named as such. Work IDs stay immutable.
  Quick Capture's idle draft saves are provisional: a page name corrected
  before Save to Inbox leaves no alias behind.

- Fragment completion searches every note (PIE-424; fixes PIE-295's
  "Searched only 500 blocks"). `fragments.candidates` finds `((note#heading` /
  `((note^anchor` targets across all active notes by the service's fragment
  rules, the draft's note first; an unanchored heading comes with the anchor it
  would get, and `fragments.ensure` writes it with a revision check. Detail,
  Tree and Quick Capture use them (with the old bounded search against an older
  service). `transclusions.read` now sends each note and its steps once, parses
  a note once per revision, stops scanning a document past its 17th embed, and
  caps a read at 512 KB (`EMBED TOO LARGE`). Additive capabilities
  `fragments.candidates`, `fragments.ensure`.

- Workspace and connection: Copy on **Client protocol** copies the number
  alone; "needs service ≥ N" is the field's note, shown as before (PIE-355).
  After leaving an edit with retained writing, the status names Alt+R and the
  actions menu; compact chrome has no header cue for Writing history.

- The service owns fragment slices and nested transclusion (PIE-424).
  `fragments.read { blockId, fragmentId }` returns what `((id^fragment))`
  covers: its kind, label, note lines, offsets and the text a reader shows (a
  step with its nested content, a heading's section, a paragraph), or
  `missing` / `duplicate`. `transclusions.read { targets, hostBlockId?,
  maxDepth? }` projects `!((id))` and `!((id^fragment))` nested to a bounded
  depth (default 3, ceiling 6), stops at a cycle (`CYCLE · this embed is
  already open above it`) and past the depth (`DEPTH LIMIT · embeds nest N
  deep`), keeps Detail's 16-per-document limit, and caps a read at 64 embeds;
  each ready projection carries the checklist steps inside what it shows.
  Both are additive capabilities; no protocol bump. A heading's section no
  longer ends at a `#` line inside a code fence, and fragment completion no
  longer offers headings inside code. Detail's embeds take their limit and
  wording from the same module (`src/transclusions.ts`), and neither Detail
  nor `transclusions.read` expands `!((…))` written inside fenced or indented
  code.

- Clients name their outline on the outline host (PIE-457 step 3).
  `OutlinerClient` sends `outline` on every request and subscription, and
  refuses a single-outline service when a name is asked for. The endpoint is
  `OUTLINER_OUTLINE` (global CLI flag `outliner --outline <name> <command>`),
  else one folder rule (`resolveFolderOutline`): the nearest bound folder
  walking up (`client.json`), else the git repository root's name, else the
  folder's name, never `$HOME`, `/` or `/tmp`-like folders (those need a name;
  Ctrl-b u shows the chooser). A guess applies once a host is set up
  (`outlines/` exists), also while it restarts: such a client waits for the host
  and never falls back to a hash database. `outlines.attach { name, create,
  root? }` and `outlines.create { name, root? }` record the outline's folder in
  `outlines/<name>.json`; its resources, file links and Inbox use it, and a
  guess from another same-named folder does not take it. Only the opens that
  open panes create (not `focus-existing`, not Pi's check). Panes register
  their outline; Herdr actions invoked from a pane (ensure-detail,
  focus-existing, link clicks, comment on selection) use it through the host's
  new `outlines.pane`. Herdr panes all get `OUTLINER_OUTLINE`; no service pane
  in host mode. New host requests `outlines.close` and `outlines.delete`; new
  action **choose-outline** (the switcher). `outliner outlines` lists an
  adopted database once, with `running`/`stopped`/`broken` from the host.
  `doctor` shows the host and how the outline was chosen. The host exits after
  5 contained faults within a minute, for systemd to restart it.

- One outline host per user and machine (PIE-457, steps 1 and 2). `bun run host`
  (`src/host-main.ts`) listens on `<state root>/outliner.sock` and serves every
  outline in `<state root>/outlines/`: it reads the first line of each
  connection and hands the whole connection to the outline its `outline` field
  names, or to `OUTLINER_DEFAULT_OUTLINE` when it names none, so existing
  clients reach the default unchanged. Outlines open on their first request and
  stay open; one that cannot open (corrupt, or held by another process) fails
  only its own requests. The host answers `outlines.list`, `outlines.create
  { name }` (the only way a new outline is born) and `outlines.adopt { path,
  name }` (serve an existing database where it lies, through a symlink; refused
  while another process holds it). `ping` adds `host` (capabilities
  `outlines.list`, `outlines.create`, `outlines.adopt`, `ping.host`,
  `request.outline`). `outliner outlines` lists through a running host, and
  `outliner outline create <name>` / `outline adopt <path> <name>` ask it.
  The single-outline service is unchanged and refuses `outlines.*`.

- Outlines have names (PIE-457, service side). Each database describes itself
  in `outline.json` (`name`, `root`, optional `label`, `host`, `created`,
  `updated`), written by the service on start. A new outline is named by
  `OUTLINER_OUTLINE_NAME` or its folder's basename, with a numeric suffix on
  collision; a name is unique in the state root, and a service refuses to start
  when another outline, running or stopped, has its name. While running, the
  service publishes `<state root>/by-name/<name>.sock` and `ping` reports
  `outline` (capability `ping.outline`). `outliner outlines [--json]` lists
  outlines by scanning; `outline rename` and `outline set-root` change a
  stopped outline explicitly (by name or storage key; an ambiguous name is
  refused), and `OUTLINER_OUTLINE=<name>` starts the service
  on a moved outline's existing database. Starting by folder at a root another
  outline already claims is refused instead of creating a second database.
  Writing the descriptor or the link never stops a service: failures are
  logged and it keeps serving on its hash socket, and an unreadable descriptor
  is left in place. Clients still address local outlines by hash until they
  resolve names.

- Who moved, trashed or restored a block: `move`, `delete` and `trash.restore`
  accept an optional `mutation` (capability `mutations.provenance`), recorded
  like an update's in the change feed's `actor` and in activity, as `move`,
  `delete` or `restore` entries. `activity.recent` returns them when asked with
  `kinds`; by default it still returns edits only. Without `mutation` nothing
  changes. The CLI's `move` and `delete`, the new `restore`, and Pi's
  `outliner_move` say who made the change, as do the Tree's and Detail's
  moves, trashing and restores (the person, through `tree` or `detail`) and the
  Inbox worker's (`inbox-agent`, as its edits already were). A trash entry is
  hidden once its block is out of Trash. The CLI's `--author agent` now needs
  `--actor` on every write, including `create` and `update`. The activity table
  is rebuilt once on startup to allow the new kinds, keeping every row whose
  block still exists, its ids and cursors; the rebuild checks its copy before
  replacing the table. **Downgrading:** an older build reads the new `move`,
  `delete` and `restore` rows as if they were edits (Pi's recent-edit context,
  note assistance and edit recovery would count them), and its own table
  definition keeps the widened check. PIE-451.

- Items with several deliveries: `work deliver --key <name>` records a PR as
  its own delivery (`PIE-123/<name>`); without a key, a PR in another
  repository than primary's is named after its repository instead of failing
  with "conflicting repository". `work complete` takes several `--delivery`
  values or `--all-merged`, and is refused while any other delivery is
  incomplete, naming it and how to finish it, so none is left in Validate under
  a Done item. `work set <delivery> delivery-stage complete|validate` finishes
  or reopens one merged delivery, revision-checked. `work help` prints the
  synopsis. Pi's task completion and the Claude `work_*` tools share the same
  rules. No service change. PIE-447.

- Agent workboard commands: `work create`, `work stage`, `work set`,
  `work deliver`, `work complete`, `work body` and `note section` in the CLI,
  and matching `work_*` / `note_section` tools in the Claude mod. Items are
  named by Work ID or block UUID; writes are checked against the revision read
  and read back; results name the Work ID, block reference and new revision.
  `work deliver` reads the PR through `gh` and refuses one whose branches differ
  from the delivery's; `work complete` needs the named delivery merged and
  records the proof. Pi's task completion uses the same code, and a
  multi-paragraph `outliner_publish` artifact is now typed as block metadata
  rather than as an inline property. PIE-438.

- Literal regions: text between `<!-- literal -->` and `<!-- /literal -->`
  lines shows outline syntax as plain text. Bracket, bare `key::` and hashtag
  properties inside are not stored, queried, indexed or previewed; links still
  resolve. Detail hides the marker lines and warns about an opening marker with
  no closer, which protects nothing. Titles skip marker lines. A property
  appended to a note that starts with a region goes on a line before it, where
  it is block metadata. Property parser version 4: the service
  re-indexes existing notes on startup without changing their text, and
  `properties.preview` reports `parserVersion` 4. PIE-422.

- Detail comment threads render comment and reply text like note text:
  `[[pages]]`, `((blocks))` (with resolved titles) and Work IDs are links you
  can click or reach with Tab and open with Enter, and bold, italics and code
  render. Headings, fences, tables, rules and HTML blocks in a comment show as
  plain lines so the thread box stays intact. A link that wraps is one Tab
  stop, `<https://…>` links its address and `[1]: https://…` lines stay
  visible. Block titles for every comment come from one request; if the
  service is slow, comments show linked block IDs instead of waiting. Backlink
  titles and snippets containing `[` no longer show stray backslashes, and a
  backlink title such as `Meeting [draft] notes` links as a whole. No service
  change. PIE-421.

- Tree's **Advanced property filter** accepts the query grammar: `OR`, `NOT`,
  parentheses and `created`/`updated` ranges, for example
  `status=open OR status=review` or `NOT status=done updated >= -7d`. Clause
  lists are sent exactly as before and keep their meaning, including
  `deleted=true`. Invalid queries show the character position and keep the
  previous filter. Uses the existing `query.expression` capability. PIE-192.

- Content events now say what changed: block, parent (and previous parent for
  moves), revision, change kind and declared actor. A client that reconnects
  can ask `changes.since` for exactly what it missed, in order, or get an
  explicit reset when history is gone. Tree skips index reloads the feed shows
  are already reflected and keeps its index across a reconnect with no changes.
  The service advertises the `changes.since` capability; restart the service
  to use it. PIE-399.

- Clients negotiate with the service instead of requiring the same protocol
  number. `ping` reports `capabilities` (`blocks.read`, `properties.preview`)
  and the oldest client protocol it serves; a newer service is accepted, and a
  client fails with a restart instruction only when the service is too old or
  lacks a capability it uses. `doctor` lists the service's capabilities.
  Additive features now add a capability rather than bumping the protocol.
  Protocol 82 introduces negotiation, so restart the service and clients once
  when upgrading. PIE-402.

- Saved views and block queries can use `OR`, `NOT`, parentheses and
  `created`/`updated` ranges: `work-stage=review OR work-stage=validate`,
  `NOT status=done`, `NOT priority`, `updated > 2026-09-20`, `updated >= -7d`.
  Existing clause lists keep their meaning. Invalid queries fail with the
  character position (`views.read` problems, `blocks.query` error `problem`)
  instead of returning nothing. Available in `[query::…]`, `blocks.query`
  `expression`/`where`, CLI `list --query` and `outliner_query`. Service
  capability `query.expression`; restart the service to use it. PIE-398.

- The service evaluates saved virtual-branch views. `views.read` returns a
  view's members in branch order with its authored limit, paging (`offset`,
  `nextOffset`), an exact `total`, truncation and structured errors, from one
  read transaction. Tree, the branch navigator, Detail view embeds, CLI `view`
  and `outliner_view` now read membership through it instead of evaluating the
  query themselves. Service capability `views.read`; restart the service to
  use it. PIE-397.

- Keep ticket-key autolinks outside complete Markdown URL spans. Plain and
  angle-bracket URLs, including Jira smart links, stay one destination through
  narrow wrapping; adjacent bare ticket keys still open local pages. PIE-392.

- Install the declarative status-summary renderer independently of the app.
  Detail, Tree Preview and Inbox Preview share responsive labelled counts,
  links, copying and comments. Disabled or missing installations preserve
  readable, editable source; reopen the note after configuration changes.
  Resizing and folding retain the open document’s renderer settings.
  Installation lifecycle and narrow-reader behavior now have a repeatable
  native application journey. PIE-382.

- Detail and Preview share cell-level source evidence for rendered copying and
  comments, including formatted text, tables, Unicode and repeated embeds.
  Comments retain immutable quotes and separate source fragments; ambiguous
  edits stay unpositioned. Saved Inbox versions retain their processing attempt
  and cannot assign IDs into live checklists. A developer provenance inspector
  explains source ranges and generated cells. An optional declarative status
  component uses the same responsive layout and evidence contract. Protocol 81
  adds passage observations and fragment resolutions; restart service and
  readers together when upgrading. PIE-350.

- Create a quoted block comment through `outliner_comment` or CLI `comment`
  without constructing annotation internals. Exact quotes require unique context,
  stale revisions fail atomically, and retrying a saved request does not duplicate
  comments even after checklist identity assignment. Source-aware readers share
  quote resolution. Protocol80 adds the convenience operation to the existing
  annotation batch ledger. PIE-377.

- Agents and CLI users can read saved virtual-branch matches in branch order
  without opening a pane or translating the query. Reads honor authored limits,
  report incomplete/invalid/unsupported results and reject mixed reads after a
  concurrent workspace change. Tree and agent reads share membership evaluation.
  PIE-376.

- Checklist steps keep stable fragment addresses through rewording and reordering.
  Pi/ANSI Detail and Preview offer monochrome status pickers, keyboard toggling,
  Copy step link and Undo, including embedded steps. Targeted agent updates
  preserve neighboring text; whole-note rewrites require explicit intent to
  remove task addresses. Comments follow item identity while retaining their
  original quoted evidence. Live checklist views correlate status and properties
  on the same step across canonical plans and update their originals. Protocol
  79 adds checklist operations and item-attached annotation targets. PIE-367.

- Tree groups root comment threads under one collapsed Comments row per displayed
  note. Open it by mouse, Space or Enter; replies remain under their own thread,
  ordinary children remain visible, and physical/virtual occurrences expand
  independently. Direct reveal opens the comment path without copying or moving
  discussion. Counts name projected root threads, excluding replies. PIE-383.

- Detail Comment supports a whole-note target without selecting text. General
  comments appear under Note comments, separate from lost passage anchors.
  Detail's local Preview composes and replies in place, preserving Current and
  protecting unsaved Preview drafts. Local Tree and Inbox readers share comment
  display and composition; Inbox Before comments retain their saved receipt and
  source identity. Comment typing takes precedence over Inbox shortcuts.
  Drag-selected local Preview passages retain their quoted text without guessing
  source offsets. Inbox navigation and receipt updates preserve active drafts;
  completed Escape input no longer consumes the next Tree shortcut as Alt.
  Keyboard passage selection uses v, arrows and Shift+arrows in the visible
  Preview viewport. Preview comment actions appear in the shared action menu
  and have their own configurable shortcuts, separate from Tree browsing.
  Short composers keep writing and save/cancel controls visible. Saved-version
  readers preserve proven historical ranges; unchanged plain text can retain
  exact coordinates while transformed layouts keep honest quoted evidence.
  Protocol 78 adds the whole-subject anchor and captured Preview/Inbox evidence.
  PIE-290.

- PIE-396: Tree `/` temporarily fuzzy-filters the selected occurrence's descendants,
  preserves rank and ancestry, searches collapsed content within projection limits,
  and restores the browsing context on Clear/Escape. The selected-items menu adds
  full-order before/after placement; filtered nudges explicitly include hidden items.
  Structured property queries remain under Advanced property filter.

- Collect Tree items with `x` or row checkboxes, inspect the finite set with
  `Shift+X`, copy canonical references or verified page links, and rank selected
  roots together in an unsorted virtual branch. Focus stays independent;
  selections survive restarts with explicit recovery and Clear. Protocol 77.
  PIE-240.

- Compact Tree, Detail and Preview chrome gives rows back to content. Shared
  searchable menus retain actions and shortcuts, Expanded layout remains
  available, and document titles use the Herdr frame with a standalone fallback
  and respect for custom pane labels. Density is a client preference; note text
  stays unchanged. PIE-385.

- Fold headings and nested list content locally in Pi Detail and Preview. Mouse and keyboard disclosures preserve nested choices, hidden links leave navigation, and fragments or comments reveal their enclosing sections. Copying omits generated arrows without deleting authored glyphs. Fold state never changes canonical text. PIE-386.

- Properties supports direct value copying and link following. Ordinary values copy on click; linked values expose a separate Copy control. Full canonical values survive wrapping, repeated keys stay distinct, and multiple embedded links have individual mouse/keyboard targets. Editing remains explicit. PIE-387.

- Quick Capture can dock left, right or below the Outliner and return to a popup while preserving its draft, cursor and selection. Editor launches use the existing recovery journal; History / Ctrl+R reviews conflicting writing before a revision-guarded save, and short panes keep the editor cursor visible. Prepared notes stay protected from assistance until Save to Inbox. A global `capture-editor` action opens that same note directly in a right sidebar editor; repeated entry returns to the live owner instead of opening a competing draft. Protocol 76. PIE-335.

- Workspace and connection groups diagnostic fields and supports drag-copy, per-value Copy buttons and keyboard field navigation. Long values copy in full without labels or wrap breaks; remote client paths stay distinct from service storage. PIE-355.

- Ordinary mouse selection and copying no longer protect Detail navigation. Retained quotes are retired when the document changes, including delayed capture replies; actual edit and comment drafts remain protected (PIE-384).

- Add a canonical first child directly from a virtual-branch result in Tree, retaining the exact occurrence context. Collapsed results open locally; depth and row-budget limits refuse before creation. PIE-148.

- Reordering a virtual branch works when that same branch also appears in another projection. Moves stay within the selected appearance and update the shared branch order, including hub embeds. PIE-395.

- ANSI Detail keeps the writing-recovery dialog visible when its pane is resized; redraw no longer waits for the open dialog to finish.

- Remove redundant test-only Store/Pi surfaces while retaining coverage through production APIs. PIE-369.

- Tree Enter opens the selected note without leaving Tree; repeat within one second to focus the same Detail, or use Alt+Enter to open and focus immediately. Draft protection and missing-destination recovery still apply. Protocol 75 requires updating the service and clients together. PIE-364.

- Jira is an installed read-only Resource extension with explicit Basic/Bearer authentication; built-in Jira HTTP, ADF and comment code is removed. Source credentials now belong to extension configuration. Protocol 74 fences the changed Source contract; service and clients must be updated together. PIE-380/381.

- Detail labels retained drafts as Writing history; actual recovery errors keep their needs-attention message.

- External-editor return automatically combines independent canonical edits into the current draft, including a newly added final newline. Clean merges no longer require the multi-version recovery dialog; Ctrl+S saves with the revision guard and exact original writing remains recoverable. Actual overlaps still require review. PIE-365.
- Human note edits can remove a `[page::…]` declaration when saving. The note and existing aliases remain; stale saves and Work ID changes still fail atomically.

- Claude Code Recent Mentions follows sessions into subdirectories of configured workspaces. The nearest configured ancestor supplies the destination database; similarly named siblings remain excluded.

- Bare external ticket keys such as PC-7 link to registered local page addresses alongside the workspace's own Work IDs. Tree, Detail, Preview, Backlinks and Recent Mentions share recognition; external keys never allocate tickets or fetch Jira during rendering. PIE-357.

- Quick Capture shares contextual reference completion with Tree and Detail, including pointer insertion, multiline drafts and Escape-to-dismiss (PIE-232).

- Tree’s Workspace and connection action and CLI `doctor` expose resolved config, endpoint and service storage identity without creating or moving data. Startup failure logs include connection paths. Actual laptop relocation recovery remains a separate verification step (PIE-337).

- Detail and Tree reference completion filter while typing, show target kind and selected context, and accept mouse or keyboard choices through one provider. Escape retains the draft; stale replies and deleted/reassigned targets cannot silently insert old choices. Work-ID labels omit nested reference syntax. PIE-295.

- Authored local file references open in Preview beside the daily note through keyboard or mouse, retaining Current and its draft. Rendered Markdown file links navigate to outline pages; missing files show an error without replacing the note. PIE-323.

- Cleaned and split notes link directly to Original capture; later rewrites also expose Before this rewrite. Merges preserve each source, snapshots reuse Inbox recovery evidence, and Preview follows them in place. New cleanups establish the links atomically. Protocol 73. PIE-345.

- Detail retains returned external-editor writing and ordinary save conflicts in a visible Recover writing flow. Compare original/local/latest versions, combine independent edits, request a reviewable Pi proposal, or keep a separate quoted draft. Recovery survives reopen; saved history offers Restore draft and Undo save as new reviews. Canonical saves remain revision guarded. Protocol 72. PIE-333.

- Pi Detail includes document body links in Tab/Shift+Tab traversal, with visible focus and canonical Enter activation. Property focus follows scrolling and keeps wrapped entries visible after resize in Current and Preview. PIE-346.

- PIE-331: Jev routes Inbox captures to keep, metadata, reversible archive or Pi editorial work; activity records the decision. Editable prompt and paired live comparison document costs, recovery and limitations.

- Inbox proposals can repair validation errors before finishing, within the same Pi session and budget. Attempt history explains retries and failures; prompt evidence shows active/package differences. PIE-330.

- Inbox activity reports effective metadata changes and no-ops, labels aggregate model-work time, and retains visible structured omissions for bounded retrieval, incomplete reads and skipped/failed relationship checks. Historical coverage stays explicitly unknown. PIE-328.

- Recent agent mentions in Tree/Detail menus, with canonical previews, conversation scope, message context, clear/save/bookmark controls, and a workspace-scoped Codex completion adapter. Protocol 71 requires a coordinated service/client restart for the new mention RPCs. PIE-325.

- Tree connection groups include Backlinks and support explicit nested disclosure on resolved block targets. Siblings retain independent state; cycles expand only by user action. PIE-324.

- A missing or closed linked reader offers Enter/click to Open here once, a destination choice, or Cancel. Tree and Inbox keep their list while Detail retains draft protections. PIE-332.

- Outlinks omit repeated titles and Work-ID prefixes while retaining custom labels, fragment names and occurrence counts. PIE-329.
- Tree and Inbox Preview follow links in place, with local Back/Forward history, keyboard link selection and explicit Open in Detail. Dragging links still copies text. The destination picker retains the browsed target. PIE-326.

- Inbox review shows Activity above independently scrollable Source/Output readers when space permits, with draggable dividers and a compact fallback. Inspect saved **Before this attempt** text without Undo; current source remains separate. Technical details collapse and errors remain visible. PIE-320.

- Inbox history can be searched across all retained attempts using original capture titles, summaries and current Source/Output text. Text matches remain usable offline; optional Jev reranks a bounded shortlist using the editable Goto prompt. Cancellation restores the browsing context. The new `inbox.search` RPC requires protocol **70** and a coordinated service/client restart; capability negotiation remains a separate architecture follow-up. PIE-319.
- Inbox now opens typed Source/Output content instead of incidental session logs, exposes reader linking, and shares Tree's rich Preview reader with separate Activity controls. PIE-317 / PIE-318.
- Tree Preview has mouse controls for visibility, right/bottom/automatic placement, size buttons and divider dragging. Prefix+Shift+U and **? → New Tree** open an independent Tree without a companion Detail. PIE-315 / PIE-316.

- Clicking Tree returns keyboard focus from local Preview in beside/below layouts. Delayed selection-publication echoes cannot replace a newer Preview.

- Creating a Detail from Link destination now links the original view to it, including sidebar placements. Ordinary split commands keep their existing links.

- Tree now keeps an interactive projection-aware breadcrumb and reclaims offscreen ancestor indentation (PIE-304).

### Capture and AI instructions

- Tree can focus an occurrence as its root or open independent rooted Tree splits. Shift+Left/Right fold/reveal one hierarchy layer. Nested query results survive collapse of their physical source folder. PIE-303 / PIE-292.
- Inbox deadlines fail only the current note and let other pending work continue. The total editing budget defaults to five minutes and can be configured with `OUTLINER_INBOX_TIMEOUT_MS`. PIE-310.
- Inbox editing and bounded note answers retain native Pi sessions per attempt. Select an activity result and press `t` to inspect its transcript through the service; early interruptions are explicitly labelled snapshots. Canceled attempts remain inspectable without suppressing retry or consuming new instructions. Protocol 65; restart service and clients together. PIE-311.
- New and meaningfully edited ordinary notes receive automatic type/tag assistance. Hashtags share the property index, semantic calendar tags follow authored dates, and human corrections survive restart. Direct supported requests can be answered in the original note; complete property inventories bypass autocomplete limits. Existing notes require explicit opt-in, and tickets/other managed records retain their contracts. PIE-302.
- The hashtag/property change requires protocol 64. Restart the service and all clients together, including remote clients; older editors use incompatible property positions.
- Inbox opens directly on outstanding questions or errors, including failures older than the recent-results page. The highlighted attention count and destination-labelled shortcut keep unresolved work easy to find; history remains available without automatic view switching.
- Quick Capture retains text and cursor across closing/reopening, inserts new captures at the top of Inbox, and supports generated titles for `/send-to-outline`. Payload-bound receipts and retained uncertain submissions prevent a retry from discarding newer text. [#84](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/84), [#85](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/85), [#86](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/86), [#120](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/120)
- A service-owned automatic Inbox editor uses the configured Pi model, with optional Jev relationship judgments. Tree `Shift+I` opens results, questions, Pause/Resume, guarded Undo, and directed reconsideration. Ordinary notes stay notes; concrete tasks enter Backlog without joining a committed batch. This is a single-user editorial experiment. [#141](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/141)
- Inbox and Goto instructions are editable Markdown/JSON file Resources. Saved changes apply to the next job/search; running jobs keep their captured instructions. Workspace prompt files survive upgrades, and results retain their exact text, path, and hash. Invalid files produce visible errors instead of stale fallbacks. [#142](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/142)

### Navigation and reading

- **? → Inspect received keys** in Tree/Pi Detail shows raw bytes, Unicode and decoded modifiers inside the existing pane. It distinguishes Option-produced characters from actual Alt shortcuts without executing them. Ctrl+Q closes only the inspector; no keystroke log is persisted.

- Standalone Tree keeps rich Preview beside its own rows regardless of detached Details. Tree and Detail expose persistent **Opens in / Change**, with Shift+L as an Alt+L fallback. Link settings remain available in Properties; active edits/filters receive an explanation without losing their text. New readers can be placed beside another Detail, or as left/right sidebars around the Outliner area or whole Herdr tab. Existing terminal sessions and saved links survive placement. Protocol **69** requires a coordinated service/client restart. PIE-305 / PIE-306.

- Tree/Detail destination pickers show document titles, Herdr workspace/tab locations and a rich selected-document preview; unlocated/other-host readers are opt-in. Preview uses available beside/below space, supports `Alt+P` and contextual Escape, and Tree-local Preview wraps Markdown and bounds pointer selection/copy. Each Tree can compare viewport versus selection indentation with `Alt+I` or its Indent badge. PIE-304 / PIE-305 / PIE-306.

- `Alt+L` in Tree or Detail chooses its linked destination. Explicit Open follows that source-to-Detail link or a one-off destination. Pane movement does not change links; missing destinations report recovery choices without automatic splits. Current stays in place while passive selection updates a separate local Preview (`F7` switches, `Shift+F7` closes, `Alt+Enter` keeps). Drafts and active source selections protect replacement. Runtime reader locks and spatial reader pools are removed; transient watchers register as observers. Herdr reader reuse follows the Tree’s link. PIE-223 / PIE-305 / PIE-306.
- Protocol **68** removes reader-lock wire fields and adds the observer role. Restart service and all clients together. Workspace ownership locks and retained Resource revision protection remain independent. PIE-306.

- Tree `g` opens searchable results with location context and a document preview, in a Herdr popup or inside Outliner. Optional Jev ranking scores up to 80 text-selected candidates; 30 results are shown with limits disclosed. Exact identities and ordinary search work without Jev. [#139](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/139)
- The opt-in `open-composed` action places Tree and Detail in one pane, with local navigation, independent view state, `F6` region switching, and explicitly detached readers. The separate-pane layout remains the default. [#133](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/133)
- Reorder appears in the action menu and keybinding registry. Defaults are now Option/Alt+Up/Down for Tree reorder and Option/Alt+Shift+Right/Down for independent Details. At that release, locked Detail used `🔐` and unlocked used `🔓`; PIE-306 removes both indicators. [#138](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/138), [#136](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/136)
- Nested Tree inline previews stay occurrence-local. Bookmark mouse reports no longer trigger the keyboard removal shortcut. [#134](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/134), [#135](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/135)
- Canonical bookmarks, virtual-branch navigation, explicit Detail destinations, attention marks, typed walkthroughs, and external editor handoff support longer reading sessions. Editor recovery preserves drafts and discovers the interactive-shell editor configuration. [#78](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/78), [#79](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/79), [#103](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/103), [#105](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/105)

### Resources and comments

- Durable Resource UUIDs and provider-qualified Sources cover filesystem, web, PDF, Jira, Linear, application, and computed providers. Immutable snapshots and representations retain provenance and provider revisions; host negotiation and dependency-aware retention preserve the same identity across presentations. [#90](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/90), [#97](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/97), [#98](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/98), [#99](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/99), [#100](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/100), [#101](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/101)
- Tree **Show authored links** projects Outlinks and Resources without creating targets. Detail activates authored `[file::…]`, `[web::…]`, `[jira::…]`, and `[app::…]` occurrences by exact block revision and source span; repeated references stay distinct in Properties while sharing one Resource. [#111](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/111), [#130](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/130)
- Durable block and Resource annotations retain original evidence and append-only reconciliation history. Direct selections support filesystem text, cached web Markdown, and extracted PDF text; unresolved changes can receive bounded agent-assisted proposals. [#94](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/94), [#95](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/95), [#96](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/96), [#108](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/108), [#110](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/110)
- Comments distinguish a Resource-wide thread from a particular authored reference and its passage. `[`/`]`, `Shift+C`, and `Shift+D` navigate, reply, and resolve/reopen in place. Stale or ambiguous anchors remain reachable under **Unpositioned comments** instead of marking unrelated text. [#129](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/129), [#131](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/131), [#132](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/132)
- Multiline comment composition uses the actual body geometry to keep the cursor visible. [#112](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/112)

### Persistence and recovery

- A service acquires exclusive workspace ownership before writable startup, migrations, or recovery, so a competing launch cannot interrupt the active owner's work. [#119](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/119)
- Normal text writes require the integer `Block.revision` from the original read. Stale writes fail atomically; sibling moves no longer invalidate unchanged text drafts. Filesystem revisions also include a hash of the original bytes. [#121](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/121), [#122](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/122)
- Filesystem saves retain the submitted draft and displaced original, preserve competing replacements, and recover interrupted saves. Recovery directories remain available for manual inspection and cleanup. This is recoverable replacement with a brief absent-path interval, not atomic compare-and-swap. [#128](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/128)

### Remote work and performance

- Tree, Detail, popups, CLI, and Pi clients connect through an SSH-forwarded Unix socket. Endpoint configuration is project-scoped, pane identities are host-scoped, and remote Tree/Detail startup opens both panes before awaiting registration. [#115](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/115), [#116](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/116), [#117](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/117)
- File previews and completion read from the canonical service host, including remote clients; passive reads create no Source or Resource. [#123](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/123)
- Tree loads a complete compact structural index and fetches exact bodies on demand. Detail paints primary content before optional enrichment, while its 32-target revisit cache revalidates revisions and passive preview scheduling keeps the newest target. Reused virtual projections and indexed ranked queries remove repeated work without adding a persistent search index or cursor system. [#124](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/124), [#125](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/125), [#127](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/127)

### Workflow and onboarding

- Roadmap items use `work-stage` alone, with Queued replacing Next and Superseded separate from accepted Done. Item-side `work-batch` references preserve committed scope through progress, pause, and completion. Resume and unchanged PR synchronization preserve explicit review/rework state. [#137](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/137)
- Fresh databases use workspace seed version 5. **Explore the Outliner** adds addressable feature guides and working reading/projection examples beside the existing agent documentation guide and authored-links example. Existing databases retain their customized content; package upgrades do not reinstall the seed.
- The guided installer and portable runtime discovery support source-checkout installation. Actual Herdr keyboard journeys use isolated workspaces and retain failure evidence. [#82](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/82), [#83](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/83), [#114](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/114)
- The current JSON-lines RPC protocol is **78**. Restart the service and all clients together when upgrading across incompatible versions; [`src/types.ts`](src/types.ts) owns the current version.

### Known limits

- Tree-generated Resource opens require a valid linked Detail; missing or protected destinations fail before registration. Resource references inside Detail use its shared chooser.
- SSH authored references are application deep links, not source-backed remote files. Tracked as PIE-261.
- Metadata-only Resource fields cannot yet receive direct Detail comments. Tracked as PIE-262.
- Computed and remote-entity cached Markdown cannot yet create direct Detail text annotations. Tracked as PIE-264.

## [0.1.0-dogfood.1] - 2026-08-22

- First tagged dogfood build of the workspace-scoped Outliner service, Tree, Detail, block graph, properties, references, virtual branches, and Pi/OMP integration.

[Unreleased]: https://github.com/float-ritual-stack/pi-herdr-outliner/compare/v0.1.0-dogfood.1...HEAD
[0.1.0-dogfood.1]: https://github.com/float-ritual-stack/pi-herdr-outliner/releases/tag/v0.1.0-dogfood.1
