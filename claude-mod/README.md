# Claude Code mod: Recent Mentions, outline, workboard and door tools

A [Claude Mod](https://github.com/anthropics/claude-code/issues/91870) (a plugin
with a function-hooks module) that forwards each completed Claude Code answer to
the Outliner's `mentions.ingest` contract. It works the same way as the Codex Stop hook
(`src/mentions-codex.ts`). `[[page]]`, `((block-id))`, Work IDs and existing
UUIDs in the answer then show up in Tree/Detail `?` → **Recent mentions**.

- Only main-loop answers are sent. Subagent runs, interruptions, refusals and errors are skipped.
- A session in a configured workspace or its subdirectories feeds that workspace.
  The nearest configured ancestor wins, so a separately configured nested project
  retains its own database. Similar path prefixes do not match. Paths are normalized
  lexically; symlink aliases and sibling Git worktrees need explicit configuration.
- Each entry is an absolute folder. The outline it feeds is resolved by the
  Outliner CLI from that folder's `client.json`, as for every other client (bind
  a folder with the **choose-outline** action). Any other entry, such as a
  relative path or `folder=name`, is an error shown as a toast, never skipped.
- Herdr discovers the Outliner (`herdr plugin list --plugin float.pi-outliner`),
  and the mod calls the installed CLI's `mentions ingest`. It never starts a service.
  Failures show as one toast and leave the answer untouched.

## Clickable references and Claude's Outliner pane

In the same workspaces, Work IDs (the workspace's prefixes), `[[pages]]` and
`((block references))` in Claude's replies are drawn as links. A plain click
shows the target in **Claude's own Outliner Detail**: a pane split below the
Claude pane the first time, then reused for every later click in the session.
It never navigates your Trees or Details and never takes focus; move or resize
it as you like. References in code and existing links are left alone.

Claude can put a note there too, with the `mcp__pi-outliner__show` tool (a Work
ID, `[[page]]`, `((uuid))` or `pi-outliner://` URI).

### In an ep0ch-door tile

When Claude runs in an ep0ch-door terminal tile (`EP0CH_TILE` and `EP0CH_CONTROL`
set, as the door's daily agent is, in the tile or in its Herdr pane), a click or
`show` opens the note in that door instead: the CLI's `door-open --from
$EP0CH_TILE` sends the door an agent's `open` from Claude's own tile over
`EP0CH_CONTROL`. The door puts it where that tile's opens land (its link: the
daily layout links the claude tile to its middle detail) and says which reader
that was. A door older than `open from=`, or without that tile, is asked for
its `middle` reader instead (`--reader middle`, where the mod opened notes
before), and a door without that either puts it where its own `open` puts
notes.

- The door says who opened it (`claude-code`, or `EP0CH_AGENT`), and an agent's
  open never moves the person's focus.
- If no door answers there (the door quit and the agent kept running in Herdr),
  it splits Claude's pane in Herdr as above.
- If the door refuses (say it is on its menu, or the reader the tile links to
  holds an edit), the reason comes back as the tool's denial or a toast.
- If the door takes the request but doesn't answer within 5s, `show` says so;
  it isn't shown in Herdr too.

- The pane is recognized by its browsing context, which is the Claude session
  id, so it survives plugin reloads and resumed sessions. Close it and the next
  click splits a new one.
- If you are editing in Claude's pane, a click or `show` is refused with a toast
  (the Outliner protects active edits) rather than opening a second pane.
- Clicks reach the mod in the fullscreen terminal (`"tui": "fullscreen"`).
- Links carry `https://pi-outliner.invalid/...` stand-ins, because Claude Code only
  draws https, http and file links as links. Where it does not detect terminal
  hyperlink support (a Herdr pane), it prints each URL beside its text; set
  `FORCE_HYPERLINK=1` in the settings `env` block to draw the text alone.
- A target the Outliner cannot resolve is a toast, never a new page.

### Where this session runs

In a door tile (`EP0CH_NEST` or `EP0CH_CONTROL` set), the mod runs `ep0ch where
--json` when the session starts. The first prompt then carries its one-line
summary as a context block (`whereAmI`), not a pane: the layers the session runs
in, outermost first (`ssh:pts/5 › herdr:w1:p1 › door:<pid>/desk/t1:claude`, ep0ch-door's
`EP0CH_NEST`), which of them are live, and where the person's keys are. Claude
then doesn't have to guess from the repo name or a window title.

- `where` only reads. The mod asks `ep0ch help` first. An ep0ch older than `where`
  would take the word for a socket and open a door, so it is never run. The help
  call carries a socket path that never exists, so an ep0ch older than `help` (which
  would take `help` the same way) stops at "no carrier" instead of opening a door.
- Without a usable `ep0ch` (not on PATH, too old, an error, or no answer within
  1.5s of the first prompt), the block has the variables alone and says they are unchecked.
- It never blocks or fails the session: the work runs after the start, and any
  failure leaves the context as it was. Outside a door, nothing is added.

## Workboard tools

In the same workspaces Claude also gets `work_create`, `work_stage`, `work_set`,
`work_deliver`, `work_complete`, `work_body` and `note_section`. Each one runs the
installed CLI's `work` / `note` command (see the
[roadmap operations reference](../pi-extension/skills/outliner-workflow/references/roadmap-items.md#agent-commands))
in the session's workspace, as an agent write attributed to `claude-code` and
this session. Items are named by Work ID or block UUID, never by title. The tool
result is the command's JSON; a refusal (stale revision, unknown stage, unmerged
delivery…) comes back as the CLI's reason.

An item can have several deliveries, one per PR. `work_deliver` takes a `key`
(`door` → `PIE-123/door`); `work_complete` takes `deliveries` or `allMerged` and
is refused, naming what is left, while any other delivery is incomplete; and
`work_set` sets `delivery-stage` on a delivery named by UUID or key, such as
one left in validate on an item that is already done.

## Outline tools

In the same workspaces Claude gets typed tools for everything an agent does to
the outline, so it never writes a script around `list --subtree`, `update` or a
comment socket. Each runs the installed CLI's `agent <operation>` command
(`src/agent-tools.ts`) with the tool's input as JSON on stdin, in the session's
workspace, and returns compact JSON. The service keeps the rules; a refusal
comes back as the tool's error with the reason.

| Tool | Input | Returns |
|---|---|---|
| `outline_read` | `ref`, `depth?` (1, at most 6), `limit?` (50, at most 500) | full `text` (never the title alone), `properties`, `revision`, `author`, `actorId`, `updated`, children to `depth` with full text (60k characters of children's text at most), `complete` |
| `outline_find` | `text?`, `property?` (`key=value` or `key`), `hasKey?`, `query?`, `under?`, or `view?`; `limit?` | rows: `id`, `title`, `revision`; `complete` |
| `outline_resolve` | `ref` | `id`, `title`, `revision`, `workId`, `fragmentId` |
| `outline_edit` | `ref`, `expectedRevision`, one of `text`, `replaceSection {heading, body}`, `append`; `allowStructural?` | the new `revision`, a short `diff`, and with `allowStructural` what it `dropped` |
| `outline_create` | `parent` (a ref or `root`), `text`, `position?` | `id`, `ref`, `revision` |
| `outline_comment` | `ref`, `body`, `quote` (with `start`/`prefix`/`suffix` when it repeats) or `whole: true`, `requestId?` | the `thread` id |
| `outline_reply` | `thread`, `body` | the `reply` id |
| `outline_resolve_thread` | `thread`, `resolved` | the thread's `lifecycle` |
| `outline_changes` | `since` (an ISO time or a returned `cursor`), `author?`, `actor?`, `limit?`, `before?` | each changed block once, newest first, with who changed it; `complete`, with `before` for the older page when it is false; the next `cursor` |
| `outline_patch` | `ref`, `revision`, `patches: [{observed, replacement}]`, `mark?`, `policy?` (`edit`, the default, or `prose`), `allowStructural?` | `draft.patch`'s outcome: `applied`, or `proposed` with the reason |

A `ref` is a block id, `((id))`, `[[page]]` or a Work ID. A title is refused:
find it with `outline_find` first.

- **The safe path is read, then edit with the revision.** `outline_edit` refuses
  an empty or whitespace-only result, a revision that isn't the block's (read it
  again), and an edit that drops a `[page::…]` or an `^anchor` another note
  links to, unless `allowStructural: true` (the check is `refuseDroppedStructure`
  in `src/work-tools.ts`, over `droppedLinkedStructure` and `droppedStructure`). An
  agent's `note_section` and `work_body` get the same check, with no way past it:
  removing them is an `outline_edit` with `allowStructural`.
- Rewriting your own pages, such as a status page, is `outline_edit`. For small
  edits to a note the person may be typing in, `outline_patch` sends
  `draft.patch`: the door holding the live draft applies it in place, and with
  none it is an ordinary edit of the saved note. Its default policy, `edit`, is
  `outline_edit`'s guard (`allowStructural` likewise), refused as an error;
  `policy: "prose"` keeps every link, anchor and property. A patch whose text
  changed under it, or that `prose` refuses, becomes one proposal the person
  can apply.
- Every write is `author: agent`, with the session id as provenance, and an
  actor id: the call's `actor`, else `OUTLINER_ACTOR`, else `EP0CH_AGENT` (the
  name the door shows for the agent), else `claude-code`. The workboard tools
  use the same actor, from the environment.

## Door tools

When Claude runs in an ep0ch-door tile (`EP0CH_CONTROL` set), it also gets
`door_where`, `door_peek`, `door_act { action, args?, reader? }` and
`door_open { id }`. They run `ep0ch where --json`, `ep0ch peek`, `ep0ch act …`
and `ep0ch act open id=… from=$EP0CH_TILE` on that socket. Without
`EP0CH_CONTROL` they are not offered, and a call is refused.

- `door_act` and `door_open` are attributed with `--as` (the same actor as
  above), and the door says so on the person's screen.
- The door never lets an agent take the person's focus, keys or selection.
  Its refusal comes back as the tool's error; `block.mark` is how to ask for
  their attention.
- `ep0ch` reads an argument starting with `@` as a file, so the tool sends one
  such value through stdin (`key=@-`) and refuses a second.
- `door_open` resolves a `[[page]]` or Work ID in the session's outline first.
  `show` (above) is still the way to put a note beside Claude wherever it runs.

## Use

Function hooks are early access and need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

The installer sets up everything below: `install.sh --claude-workspace /absolute/project`,
or, from a checkout, `bun scripts/install-claude-mod.ts /absolute/project`.

```sh
PI_OUTLINER_MENTIONS_WORKSPACES=/home/evan/test \
  claude --plugin-dir /path/to/checkout/claude-mod
```

To load it in every session, set both variables and
`CLAUDE_CODE_PLUGIN_DIRS=/path/to/checkout/claude-mod` in the `env` block of
`~/.claude/settings.json`. The `workspaces` option (`pluginConfigs["pi-outliner"]`,
or `/config`) takes precedence over the environment variable when it names at
least one path. Claude Code passes an unset option as an empty string, so an
empty option always falls back to the environment variable. To turn ingestion
off, remove the path from both. Separate several paths with `:` or `,`.

## Develop

```sh
claude plugin validate claude-mod
claude plugin test claude-mod
# types: run /plugin-types claude-mod/.claude/types in a session, then
tsc -p claude-mod/tsconfig.json
```
