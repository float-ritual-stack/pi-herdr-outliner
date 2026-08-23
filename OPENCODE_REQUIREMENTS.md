# OpenCode Port Requirements — `opencode-herdr-outliner`

Port of the pi outliner extension (`pi-extension/index.ts` + `herdr-plugin.toml`) to an
OpenCode V2 plugin. Everything below is based on the V2 docs (`opencode.ai/v2/docs`),
which note the plugin API is **beta** — pin to a specific OpenCode release and expect
breakage between betas.

## Architecture verdict

The pi version already separates concerns correctly, so the port is mostly mechanical:

| Layer | Host-coupled? | Disposition |
| --- | --- | --- |
| `src/store.ts` (SQLite blocks tree, properties, selection, sequence) | No | Reuse unchanged |
| `src/server.ts` + `server-main.ts` (unix-socket JSON-lines RPC) | No | Reuse unchanged |
| `src/types.ts`, `properties.ts`, `files.ts`, `annotations.ts`, `terminal.ts`, `text-buffer.ts`, `client.ts`, `paths.ts` | No | Reuse unchanged |
| `src/outliner.ts` (outliner TUI pane) | No (raw ANSI, standalone bun process) | Reuse unchanged |
| `src/detail.ts` (detail TUI pane) | No | Reuse unchanged |
| `src/herdr-open.ts` (pane orchestration via herdr CLI) | herdr only, not pi | Reuse unchanged |
| `herdr-plugin.toml` | herdr only, not pi | Reuse — point commands at same entrypoints |
| `pi-extension/index.ts` | **pi-only** | **Rewrite as OpenCode V2 plugin** |

OpenCode does **not** do pane management natively. Its TUI is single-terminal with
internal split views only. Keep herdr as the pane/split manager exactly as in the pi
version.

## 1. Plugin shell

- New package/file: `.opencode/plugins/outliner.ts` in the target project (auto-discovered)
  or a published npm package with `"./tui"` export if we ever want TUI-side code.
- Default export via `Plugin.define({ id: "float.opencode-outliner", setup })`.
- Dependencies: `@opencode-ai/plugin@beta` installed next to the plugin file
  (`cd .opencode && bun add @opencode-ai/plugin@beta`). OpenCode does not install deps for
  local plugins. Drop the pi/typebox dependencies entirely.
- The store/server/TUIs keep running as separate `bun run src/server-main.ts` /
  `bun run src/outliner.ts` processes, spawned by the plugin exactly as today.
  `bun:sqlite` is fine because it runs inside our own bun process, not inside OpenCode.

## 2. Tool registration

Replace each `pi.registerTool(...)` with `ctx.tool.transform((tools) => tools.add(...))`
in `setup`. JSON Schema input instead of typebox:

- `tools.add("outliner.create", { description, input, output, execute })`
  — namespace form gives dotted grouping; set `codemode: false` on all six tools so they
  are exposed directly to the provider rather than only through CodeMode (these are
  core workflow tools the model should call by name).
- Tools to register (same semantics as pi):
  1. `outliner.create` — text (+ `[prop::value]` markers), optional parentId, author.
  2. `outliner.update` — blockId, text, optional optimistic-concurrency `expectedUpdatedAt`.
  3. `outliner.query` — text / property filters / subtreeRootId / optional caller limit.
     The executor must send `blocks.query` with `limit ?? 100` and return the complete
     `VisibleBlockCollection` (`{ blocks, completeness }`), not a bare block array.
  4. `outliner.move` — blockId, parentId, position (with descendant-cycle guard from store).
  5. `outliner.annotate_file` — line-range comment under a `[file::path]` block.
  6. `outliner.selection` — read user's selected block + ancestors + children.
- Executor returns `{ output, content }`; apply the same ~12 KB truncation guard on
  `content` that the pi version uses.
- Keep `ensureService(false)` at the top of every executor (ping → spawn headless server
  → wait). This makes the `/outliner` command mostly unnecessary; see §4.

The shared socket protocol is v3. There is no `list` action: every search uses
`blocks.query`, whose `query.limit` is a required positive integer. Its
`VisibleBlockCollection.completeness` is either `{ kind: "complete" }` or
`{ kind: "truncated", limit }`. Plugin and command output must preserve that envelope so
agents and users can tell when they have only a bounded prefix.

## 3. Selection-context injection into every prompt

pi used `before_agent_start` returning `{ systemPrompt }`. OpenCode equivalent is a
runtime hook registered in `setup`:

```ts
await ctx.session.hook("context", async (event) => {
  const selection = await selectionContext(250) // ping-guarded, fail-open
  if (!selection.selected) return
  event.system = `${event.system}\n\n${formatSelection(selection)}`
})
```

- Must stay fast and never throw (hook failure fails the dispatch). Keep the 250 ms
  timeout and silent catch.
- Same `formatSelection` output as pi: breadcrumb path, up to 20 children, nudge to use
  the outliner tools for durable notes/questions/decisions.

## 4. Commands

OpenCode V2 commands are prompt templates, not imperative handlers — there is no direct
equivalent of pi's command handler + `ctx.ui.notify`.

- `/outliner` → replace with an `outliner.open` tool (thin wrapper around
  `ensureService(true)` returning pane ids) plus a command template like
  "Open the outliner workspace using the outliner.open tool" so the agent performs it.
  Alternatively skip the command entirely; tools self-bootstrap the service.
- `/outliner-filter type=question status=open` → becomes pure tool usage:
  `outliner.query` with parsed filters. No TUI widget needed (see §6).

## 5. Herdr integration & lifecycle

- `ensureService` keeps two modes, identical logic to pi:
  - Inside herdr (`HERDR_ENV=1`): spawn `bun run src/herdr-open.ts` with
    `HERDR_PLUGIN_ID=float.opencode-outliner` (update id or keep shared manifest),
    `OUTLINER_FOCUS`, `OUTLINER_WORKSPACE_ROOT`. Verify OpenCode inherits the herdr pane
    environment into its server process / tool executors; if not, fall back to detecting
    herdr via `HERDR_BIN_PATH` presence.
  - Outside herdr: spawn headless `server-main.ts`, track the ChildProcess.
- Cleanup: return a cleanup function from `setup` that SIGTERMs the headless server
  (replaces pi's `session_shutdown`). Hook registrations release automatically; owned
  child processes do not.
- Per-workspace state isolation via `resolvePaths()` sha256-of-root keying carries over
  unchanged — important because OpenCode's background service is shared across projects
  and sessions, so multiple sessions may hit one workspace socket concurrently. The
  socket RPC is already serialized per connection; confirm concurrent-session behavior in
  testing.

## 6. Known gaps / open questions

- **Filter widget**: pi renders live query previews below the editor via
  `ctx.ui.setWidget`. OpenCode V2 has a terminal-plugin surface (`plugins` in `cli.json`,
  `./tui` export, `plugins/tui` discovery dirs) but no documented widget API yet.
  Requirement v1: drop the widget; query results live in tool output and the detail pane.
  Revisit when TUI plugin docs land.
- **Notifications**: no server-side notify equivalent. Surface errors as tool errors
  (they render in the transcript anyway).
- **Beta churn**: plugin API shapes (`tools.add` signature, hook names) may change;
  match `@opencode-ai/plugin@beta` version to the installed `opencode2` release and retest
  on upgrades. Verify loading with `opencode2 api get /api/plugin`; debug via
  `~/.local/share/opencode/log/opencode.log` (filter `role=server`).

## 7. Testing requirements

- Reuse existing tests (`test/store.test.ts`, `protocol.test.ts`, `files.test.ts`,
  `editor.test.ts`) unchanged — they test host-free layers.
- Add: plugin loads (`/api/plugin` lists `float.opencode-outliner`); every query sends an
  explicit positive limit, returns `{ blocks, completeness }`, and preserves truncated
  completeness in agent-visible output; each tool round-trips against a live store;
  `context` hook injects selection and fails open when the service is down; cleanup kills
  the headless server; end-to-end inside herdr opens both panes and focuses the outliner.

## Suggested layout

```
opencode-herdr-outliner/
  package.json            # @opencode-ai/plugin@beta dep only
  .opencode/plugins/outliner.ts   # or package entrypoint
  src/                    # copied verbatim from pi version (minus pi imports)
  herdr-plugin.toml       # same panes/actions, ids updated
```

Effort estimate: the rewrite surface is roughly the size of `pi-extension/index.ts`
(~250 lines); everything else is a copy.
