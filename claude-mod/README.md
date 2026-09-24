# Claude Code mod: Recent Mentions

A [Claude Mod](https://github.com/anthropics/claude-code/issues/91870) (a plugin
with a function-hooks module) that forwards each completed Claude Code answer to
the Outliner's `mentions.ingest` contract. It works the same way as the Codex Stop hook
(`src/mentions-codex.ts`). `[[page]]`, `((block-id))`, Work IDs and existing
UUIDs in the answer then show up in Tree/Detail `?` → **Recent mentions**.

- Only main-loop answers are sent. Subagent runs, interruptions, refusals and errors are skipped.
- A session is ingested only when its cwd is exactly one of the configured workspaces.
- Herdr discovers the Outliner (`herdr plugin list --plugin float.pi-outliner`),
  and the mod calls the installed CLI's `mentions ingest`. It never starts a service.
  Failures show as one toast and leave the answer untouched.

## Use

Function hooks are early access and need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

```sh
PI_OUTLINER_MENTIONS_WORKSPACES=/home/evan/test \
  claude --plugin-dir /path/to/checkout/claude-mod
```

To load it in every session, set both variables and
`CLAUDE_CODE_PLUGIN_DIRS=/path/to/checkout/claude-mod` in the `env` block of
`~/.claude/settings.json`. The `workspaces` option (`pluginConfigs["pi-outliner"]`,
or `/config`) takes precedence over the environment variable. Separate
several paths with `:` or `,`.

## Develop

```sh
claude plugin validate claude-mod
claude plugin test claude-mod
# types: run /plugin-types claude-mod/.claude/types in a session, then
tsc -p claude-mod/tsconfig.json
```
