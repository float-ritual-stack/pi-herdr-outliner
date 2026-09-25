# Claude Code mod: Recent Mentions

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
