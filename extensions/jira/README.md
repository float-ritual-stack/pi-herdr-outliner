# Jira extension

Write a ticket key and `jira::`, and the ticket is in the outline, as if you had
copied it in and mapped its fields to properties yourself. This is the
canonical example of an extension folder (contract 2).

```text
PC-1234 Rollout [jira::PC-1234]
My own notes, my own [status::doing].
  └─ Rollout checklist for the depot switch          ← the ticket, a real block
     [jira.key::PC-1234] [jira.status::In Review] [jira.assignee::Dana Ortiz] …
     The description, as Markdown.
       └─ Lee Park · 2026-01-02 10:00                  ← with --comments
```

## Writing it

- `PC-1234 [jira::PC-1234]`: the block is the ticket's page.
- `jira:: PC-1234`, or `jira::` under a line (or in a block, or under an
  ancestor) that names the ticket: the key comes from context, nearest first
  (PIE-445, PIE-408). Two keys at one level fetch nothing and say so.
- `--comments[=N]` adds the latest N comments (default 5, of the latest 20
  fetched) as child blocks of the ticket block, oldest first; with several
  lines asking, the ticket keeps the most any of them asks for. The bullet form
  `- jira:: --comments` works too.

Saving the line registers and fetches the ticket in the background; the save
never waits. Opening a note whose copy is older than 15 minutes fetches it
again. `r` on the ticket (or a click on its age in the door) refreshes it now.
While the service runs, one JQL search every 12 minutes (`key in (…) AND
updated >= -Nm`, 50 keys a search) finds the tickets that changed, and only
those are read again. A poll that finds nothing writes nothing. A key Jira no
longer has makes it refuse the `key in` search; that batch is then answered
from one project search per poll. A search that fails keeps its window, so the
next poll looks back far enough.

If Jira refuses the credentials (401, 403, or none on this machine) or limits
requests (429), the automatic fetches (saves, opens, the poll) pause: 15
minutes for credentials, from one minute doubling to 30 for a rate limit. The
ticket says `paused, r tries now`; `r` always tries at once, and the first
answer that works ends the pause.

## What you get

- **A real block, once.** A ticket is one block, as if you had copied it in
  once: its title, its fields as block properties, its description as the
  body. It sits under the ticket's page (the block whose `[page::PC-1234]` is
  the key), else under the first block whose own `[jira::PC-1234]` names it,
  else under the first block that asks for it. Every other `jira::` line for
  that key shows the same block under the line (Enter opens it) instead of a
  copy, so a query, a backlink or a drift view sees the ticket once. When its
  home changes (you write the ticket's page later) the same block moves there,
  with its highlights and replies. Views, queries, backlinks, comments,
  highlights, embeds and the door's readers treat it like any block.
- **Trash, never lost.** When no block asks for the ticket any more, its block
  goes to Trash; a comment that leaves the newest-N window does too. Anything a
  person put on or under it (highlights, replies, their own child blocks) goes
  with it and comes back with a restore, and the change feed says why
  (`ext.jira.drop-record`, `ext.jira.drop-comment`, by `ext:jira`). Asking for
  the ticket again (or a larger `--comments=N`) restores the same block.
- **Namespaced fields: `jira.<field>`.** `jira.key`, `jira.status`,
  `jira.assignee`, `jira.type`, `jira.priority`, `jira.sprint`,
  `jira.reporter`, `jira.label` (one per label) and `jira.updated`; comments
  carry `jira.comment`, `jira.author` and `jira.created`. The property grammar
  already allows `.` in a key (`plot.row`), so no parser or client changes, and
  `jira.status="In Review"` reads like what it is. The prefix is the extension
  id, which is how the service knows who owns the field.
- **Soft links.** A key such as `PC-2` in ticket text links to PC-2's page (the
  block whose `[jira::PC-2]` names it, or the block its ticket sits under) and
  shows in that page's backlinks.
- **Jira owns the ticket block.** A person's or agent's edit to it (a field, the
  body, a kanban drag on `jira.status`) is refused: "jira.status comes from
  Jira; write your own [status::] on the parent block". Pushing edits back to
  Jira comes later. Comments and highlights on ticket text are annotations, not
  edits: they follow the text when Jira changes it, and say so when they lose
  their place.
- **Your `[status::]` stays yours.** There is no sync between `status` and
  `jira.status`, not even an alias. The gap is queryable instead (below).
- **Attribution.** Every write is `author: agent`, `actorId: ext:jira`, and only
  when the ticket changed. "What changed" views can leave these out
  (`activity.recent` with `extensions: "exclude"`).
- **Publishing is opt-in.** Ticket blocks are left off published pages unless
  the page (or a block above) has `[publish.ext::jira]`.

## Drift views

Two saved views show where your status and Jira's disagree (`child:` matches a
property on a block's direct child, here the ticket):

```text
Done here, not in Jira [type::virtual-branch] [query::status=done child:jira.status NOT child:jira.status=Done]
Done in Jira, not here [type::virtual-branch] [query::child:jira.status=Done NOT status=done]
```

## Install on the service host

```sh
outliner ext add jira        # copies this folder to ~/.config/pi-herdr-outliner/extensions/jira
```

On a machine that already reads Jira through `resource-extensions.json`, `ext
add` writes `config.json` from that entry (email and the keychain or env
reference; never a secret). Otherwise it copies `config.example.json`; edit it:

```json
{
  "config": { "authMode": "basic", "email": "you@example.com" },
  "secrets": { "token": { "keychainService": "jira-api-token" } },
  "sources": [{ "origin": "https://your-site.atlassian.net", "project": "PC" }]
}
```

- **Secrets** resolve on the service host at call time: `{"keychainService":…}`
  (macOS), `{"env":"JIRA_API_TOKEN"}`, or `{"file":"~/.config/…/jira-token"}`
  (mode 0600). They reach `jira.ts` only on stdin. A machine without them says
  "no Jira credentials on this machine" on the ticket line and keeps working.
- **Sources** are created on first use, so there is no `resource-sources.create`
  step. An existing Jira Source for the project is reused.
- `sprintField` (default `customfield_10020`) names your site's sprint field;
  `"comments": false` skips the comment request.

`bun` in `run` means the service's own Bun. Code and config are read on every
call: no restart after `ext add` or an edit. This is trusted code, not a
sandbox; it runs as the service user.

## Contract

`extension.json` (contract 2) declares the `jira` handler (`effects: read`, a
record, stale after 15 minutes, polled every 12). `jira.ts` answers three
operations, one JSON request on stdin and one response on stdout:

- `resolve`: a key to Jira's immutable issue id;
- `read`: the Resource document plus `record` (`title`, `fields`, `body`,
  `comments`), which the service keeps as blocks;
- `changed`: which of these keys changed in the last N minutes.

Errors are codes (`credentials-missing`, `unauthorized`, `forbidden`,
`not-found`, …); provider error text is never stored. See
[docs/extensions/resource-process.md](../../docs/extensions/resource-process.md).

`bun test test/jira-extension.test.ts test/extension-records.test.ts` runs this
folder against a loopback fake Jira (`test/fake-jira.ts`).
