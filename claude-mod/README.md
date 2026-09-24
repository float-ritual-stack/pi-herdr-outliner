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

## Clickable references

In the same workspaces, Work IDs (the workspace's prefixes), `[[pages]]` and
`((block references))` in Claude's replies are drawn as links. A plain click
opens the target through the Outliner Tree in the same Herdr tab (else one in
the same Herdr workspace), in that Tree's linked Detail, as a click inside the
Tree would. References in code and existing links are left alone.

- Clicks reach the mod in the fullscreen terminal (`"tui": "fullscreen"`).
- Links carry `https://pi-outliner.invalid/...` stand-ins, because Claude Code only
  draws https, http and file links as links. Where it does not detect terminal
  hyperlink support (a Herdr pane), it prints each URL beside its text; set
  `FORCE_HYPERLINK=1` in the settings `env` block to draw the text alone.
- With no Tree open, or a target the Outliner cannot resolve, a toast says so.

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
