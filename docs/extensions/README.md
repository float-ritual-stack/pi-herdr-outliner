# Extensions: the four kinds

An extension is a folder. Put one in a watched folder and the outline service loads it, with no
restart. Delete the folder and everything it added goes away. The service runs the extension's
code; clients (Detail, the door, the publisher, agents) only draw what the service returns.

There are four kinds. One extension may provide several of them.

| Kind | What it is | Written as | Where the result lives | How a client draws it |
|---|---|---|---|---|
| 1. **Data** | A record put into a block, as if you copied it in | `moon:: 2026-10-26`, `jira:: PC-12` | A real block the extension owns, with namespaced properties (`[moon.phase::Full Moon]`) | As any block. Under the line, a projection says what it is and when it was fetched |
| 2. **Inline output** | Markdown rendered inside a block | `horoscope:: virgo` | Kept by the service per line (`extension_outputs`); never written into the note unless you **keep** it | The projection's `output.markdown`, under the line |
| 3. **Rich component** | Data plus a view, with its own behaviour (actions) | `fancy-horror:: virgo` | Kept like an output: `{ data, view }` | The view's primitives (box, card, table, stat, bar, checklist, sparkline, badge, text, row, stack), or a rendered target |
| 4. **A whole tile** | A program in a tile of its own kind | opened from the door | Whatever its actions write | The door's tile-kind registry runs it in a terminal tile |

The canonical examples ship in [`extensions/`](../../extensions): [moon](../../extensions/moon) and
[jira](../../extensions/jira) (data), [horoscope](../../extensions/horoscope) (inline output),
[fancy-horror](../../extensions/fancy-horror) (rich component) and [tarot](../../extensions/tarot)
(a tile). They are forkable source: `outliner ext add <name>` copies one into your folder, where it
is yours to edit.

Extensions are **trusted code, not a sandbox**, like nvim or Claude Code plugins. They run as the
service user. What keeps the outline safe is the contract below: a call gets a bounded, read-only
view of the outline and no database handle; every write it makes goes back through the service,
which checks revisions, keeps it inside the block it acts on, and attributes it
(`author: agent`, `actorId: ext:<id>`), so every surface shows who wrote it.

## Where extensions live

| Folder | Serves |
|---|---|
| `<outline root>/extensions/<id>/` | That outline only. It travels with the outline. |
| `~/.config/pi-herdr-outliner/extensions/<id>/` (or `OUTLINER_EXTENSIONS_DIR`) | Every outline the service serves. |

- When both have the same id, the outline's copy wins; `outliner ext ls` lists the other as
  `shadowed`.
- The repo's own `extensions/` folder is never loaded in place, even when an outline's root is the
  repo.
- **Watched.** The service watches both folders (recursively, 300 ms of quiet) and rebuilds its
  registry from scratch on every change. Clients get an `extensions` event (`extensions.changed`)
  and read `extensions.list` again.
- **Code needs no reload.** Each call starts a fresh process, so an edit to `horoscope.ts` applies
  on the next call. A read handler also runs again on open when the manifest's `version` changes.
- **A broken folder keeps its last good version.** It is listed as `failed`, with the reason and
  the version it still serves. One that never loaded serves nothing and says why.

The errors name the file and the field:

```text
extension.json: handlers/0/kind must be one of resource, data, output, component; still serving version 1 loaded 2026-10-01T09:00:00Z
extension.json: handlers/0 has a field it doesn't know: efects
extension.json: id other must match the folder's name (mismatch)
config.json: config doesn't match the config schema in extension.json (email must not have fewer than 1 characters)
handler horoscope:: is already served by horoscope (/home/you/outlines/pie/extensions/horoscope)
```

### From a shell

```sh
outliner ext ls                                   # every folder, its state, its error, what it serves
outliner ext add horoscope                        # a built-in, into the user folder
outliner ext add ./my-extension                   # any folder (checked first; a broken one is refused)
outliner ext add moon --outline-folder ~/outlines/pie   # into that outline's own extensions/
outliner ext remove horoscope                     # deletes the folder; the service drops it at once
outliner ext act fancy-horror ward --block <id>   # runs an action, attributed to the extension
```

They are conveniences: copying a folder in or deleting it does the same.

## The folder

```text
extensions/horoscope/
  extension.json   the manifest (contract 2)
  horoscope.ts     code; `bun` in run means the service's own Bun
  config.json      optional: this install's settings and secret references. Never a secret value.
  README.md
```

### `extension.json` (contract 2)

```json
{
  "contract": 2,
  "id": "horoscope",
  "version": 1,
  "name": "Horoscope",
  "description": "Inline output: a made-up horoscope for a sign.",
  "run": ["bun", "horoscope.ts"],
  "deadline": "15s",
  "handlers": [{
    "key": "horoscope", "kind": "output", "effects": "read",
    "argument": { "name": "sign", "required": true, "pattern": "^(aries|…|pisces)$", "description": "a zodiac sign" },
    "options": {
      "day":   { "type": "string", "pattern": "^(today|tomorrow)$", "default": "today" },
      "short": { "type": "boolean", "scope": "display" }
    },
    "staleAfter": "1h"
  }],
  "actions": [],
  "tiles": []
}
```

| Field | Meaning |
|---|---|
| `id` | Lowercase name; must match the folder's name. Its properties are `<id>.<field>`. |
| `version` | An integer. Raise it when output changes meaning: read handlers run again on open. |
| `run` | The program each call starts. Needed by handlers and actions; a tile-only extension can leave it out. |
| `deadline` | How long one call may take (`30s`, `2m`); default 15 s, at most 5 m. A handler may set its own. |
| `configSchema`, `secrets` | A JSON schema for `config.json`'s `config`, and the secrets it needs by name. |
| `handlers[]` | The `key::` lines it serves (kinds 1–3). |
| `actions[]` | What it can do: one action is a key, a click and an agent call alike. |
| `tiles[]` | Tile kinds (kind 4). |

### `config.json`

```json
{
  "config": { "authMode": "basic", "email": "you@example.com" },
  "secrets": { "token": { "keychainService": "jira-api-token" } },
  "sources": [{ "origin": "https://your-site.atlassian.net", "project": "PC" }],
  "enabled": true
}
```

Secrets are references, resolved on the service host at call time: `{"env": "NAME"}`,
`{"keychainService": "…"}` (macOS) or `{"file": "~/.config/…/token"}` (mode 0600). The values reach
the program only on stdin, and are scrubbed from what it returns. `"enabled": false` keeps the folder
but serves nothing.

## The wire

One process per call. The service writes one JSON request to stdin and reads one JSON response
from stdout, then the process exits (its whole process group is killed at the deadline). The
environment is only `PATH` and `LANG`; the working directory is the extension's folder.

```json
{ "contract": 2, "operation": "run", "input": { … }, "config": { … }, "credentials": { … } }
```

The answer is `{"ok": true, "value": …}` or `{"ok": false, "code": "not-found"}` (codes:
`credentials-missing`, `unauthorized`, `forbidden`, `not-found`, `invalid-config`, `network`,
`timeout`, `rate-limited`). A provider's own error text is never stored.

| Operation | Called for | `input` | `value` |
|---|---|---|---|
| `read` | a data handler | `{ handler, key, options, context }` | `{ record: { title, fields: [{ key, value }], body } }` |
| `run` | an output or component handler | `{ handler, argument, options, context }` | output: `{ markdown, title? }`; component: `{ data, view, targets?, title? }` |
| `act` | an action | `{ action, args?, target?: { blockId, revision, line?, argument?, options? }, context?, output? }` | `{ message?, writes?: [...] }` |
| `resolve`, `read`, `changed` | Jira's Resource path | see [resource-process.md](resource-process.md) | |

`context` is what the call sees of the outline, bounded and read-only:

```json
{
  "block": { "id": "…", "text": "…(16 000 characters at most)", "revision": 4, "properties": [{ "key": "status", "value": "doing" }] },
  "line": { "index": 1, "text": "horoscope:: virgo" },
  "children": [{ "id": "…", "text": "…" }],
  "ancestors": [{ "id": "…", "title": "…" }],
  "now": "2026-10-01T09:00:00.000Z"
}
```

## Handler lines

Every handler is written the same way, and the service parses it, not the extension:

```text
key:: [argument] [--option[=value]]…
```

- The **argument** is the words that aren't options: a sign, a date, a ticket key. `argument.pattern`
  (or `keyPattern` for data) checks it. A bad one shows its reason on the line and nothing runs.
- **Options** are typed by the manifest: `boolean` (`--short`), `integer` (`--days=3`, with `min`
  and `max`) or `string` (`--day=tomorrow`, with `pattern`). Defaults fill in.
  - `fetch` (the default scope): part of the call. Two lines that differ by one are two calls.
  - `display`: never reaches the extension. Lines that differ only by one share a result.
  - An unknown `--flag` is a warning on the line, not a failure.
- The bullet form works: `- horoscope:: virgo`. A line in a code span or fence is text.
- Keys the outline already uses (`status`, `type`, `page`, `query`, `file`, `web`, …) can't be
  handler keys.

### When a handler runs on its own: `effects`

| `effects` | Runs by itself | Otherwise |
|---|---|---|
| `read` | When the line is saved or the note is opened, if it has no result, the result is older than `staleAfter`, or the extension's `version` changed | `r` |
| `spend` (costs money or model time) | Once, when a person writes the line. A line an agent wrote waits. | `r` |
| `write` | Never | `r` |

`r` is `resources.projection.refresh` (the door's `projection.refresh`; Detail's `r` on a note).
Lines written by an extension never trigger anything, so extensions can't loop.

### What readers get

`resources.projection.read` returns handler lines in the same slot as Jira's tickets, one
projection per line, ordered by line:

```json
{
  "anchor": { "kind": "directive", "line": 1, "start": 6, "end": 23 },
  "provider": "horoscope", "label": "Horoscope", "propertyKey": "horoscope",
  "kind": "output",
  "extension": { "id": "horoscope", "handler": "horoscope", "effects": "read", "display": {}, "version": 1 },
  "key": "virgo",
  "status": "ready",
  "summary": "Virgo · 2026-10-01",
  "fetchedAt": "2026-10-01T09:00:00.000Z",
  "output": { "markdown": "**Virgo, 2026-10-01.** …", "ranAt": "2026-10-01T09:00:00.000Z", "title": "Virgo · 2026-10-01" },
  "fields": [], "options": { "unknown": [] }
}
```

- `status`: `ready`; `stale` (the last run failed, the last good result is shown, `reason` says
  why); `not-run` (with `reason`: when it will run); `not-fetched` (data not fetched yet);
  `unavailable` (a bad line, or a failure with nothing to show). `fetching: true` while it runs.
- `output.markdown` is inert BlockDown: it never adds properties or provider lines to a note.
- `output.inputsChanged` / `versionChanged`: the block or the extension changed since it ran.
- A component adds `output.component: { data, view }`; `output.markdown` is its markdown rendering.
- A data line adds `record: { blockId, pageBlockId, syncedAt }` and the `fields` the handler lists.
- A `resource-catalog` event (`extensions.output`, with `blockId`) says a line's result changed.

`extensions.render { blockId, line?, target, fallback? }` returns a line's result in one target:
`terminal`, `markdown`, `blockdown`, `html`, `json` or `csv`.

## Kind 1: data

**What it is.** A record from somewhere else put into a block, as if you had copied it in and
mapped its fields to properties yourself. Its properties are queryable (`moon.phase="Full Moon"`),
it shows in backlinks and embeds, and it is refreshed.

**The contract.** A handler with `"kind": "data"` and a `keyPattern`; the argument is the key.
`read` returns `{ record: { title, fields, body } }`. The service writes one block per key:

```text
Moon on 2026-10-26: Full Moon
[moon.key::2026-10-26] [moon.phase::Full Moon] [moon.illumination::100%] [moon.age::14.9 days]

100% lit, 14.9 days since the new moon.
```

- It sits under the key's home: the block whose `[page::KEY]` is the key, else the first block whose
  own `[moon::KEY]` names it, else the first block that asks. Every other line for that key shows
  that block. It moves when its home changes and goes to Trash (restorable) when nothing asks.
- Only the extension writes it. A person's or agent's edit is refused with the reason
  (`moon.phase comes from Moon; write your own [phase::] on the parent block`).
- Writes are diff-only (an unchanged record isn't written), attributed `ext:moon`,
  `ext.moon.sync` in the change feed. `activity.recent` with `extensions: "exclude"` leaves them out.
- `fields` in the handler lists what the projection shows beside the title.
- Jira is the full version: a Resource snapshot, comments as child blocks, a poll, drift views
  ([extensions/jira](../../extensions/jira)). Its `kind: "resource"` path is Jira's alone for now;
  a new provider uses `data`.

**Worked example: "make me an extension that puts a book's details into a block".**

1. `mkdir ~/.config/pi-herdr-outliner/extensions/book`
2. `extension.json`:

   ```json
   {
     "contract": 2, "id": "book", "version": 1, "name": "Book",
     "run": ["bun", "book.ts"],
     "handlers": [{ "key": "book", "kind": "data", "effects": "read",
       "keyPattern": "^[0-9]{10}([0-9]{3})?$", "argument": { "name": "ISBN" },
       "fields": ["author", "year"], "staleAfter": "24h" }]
   }
   ```

3. `book.ts` reads the request, looks the ISBN up (a local catalogue file, or an API with a
   secret declared in `secrets`), and answers:

   ```ts
   const { input } = await Bun.stdin.json();
   const book = lookUp(input.key);   // yours
   process.stdout.write(JSON.stringify(book
     ? { ok: true, value: { record: { title: book.title,
         fields: [{ key: "author", value: book.author }, { key: "year", value: String(book.year) }],
         body: book.summary } } }
     : { ok: false, code: "not-found" }));
   ```

4. `outliner ext ls` shows `book active`. Write `book:: 9780000000000` in a note: the record appears
   under it. A view `book.author="Ann Example"` lists your books.

## Kind 2: inline output

**What it is.** Markdown the service computes and shows under the line that asks. It isn't the
note's text: the note keeps exactly what you wrote. **keep** turns it into real blocks when you want
it to stay.

**The contract.** A handler with `"kind": "output"`. `run` returns `{ markdown, title? }` (64 KiB at
most). The service keeps the last good result per line, so a reader shows it at once and a restart
keeps it.

- **keep** is built in for every output and component handler (`ext.<id>.keep`): it writes the
  result under the block as one block, attributed to the extension.
- A failed run keeps the last good result and says why (`stale`).

**Worked example: "make me an extension that shows today's weather under a line".**

1. `extensions/weather/extension.json`:

   ```json
   {
     "contract": 2, "id": "weather", "version": 1, "name": "Weather",
     "run": ["bun", "weather.ts"],
     "secrets": { "apiKey": "Weather API key" },
     "handlers": [{ "key": "weather", "kind": "output", "effects": "read",
       "argument": { "name": "city", "required": true }, "staleAfter": "30m" }]
   }
   ```

2. `config.json`: `{ "secrets": { "apiKey": { "env": "WEATHER_API_KEY" } } }`.
3. `weather.ts`:

   ```ts
   const { input, credentials } = await Bun.stdin.json();
   const now = await fetchWeather(input.argument, credentials.apiKey);   // yours
   process.stdout.write(JSON.stringify({ ok: true, value: {
     title: `${input.argument} · ${now.summary}`,
     markdown: `**${now.temperature}°C**, ${now.summary}\n\n- Wind: ${now.wind} km/h`,
   } }));
   ```

4. `weather:: Lisbon` shows the weather under the line and refreshes after 30 minutes on open.
   `r` fetches now. For a call that costs money or model time (an LLM summary, say), use
   `"effects": "spend"` and a `"deadline"` up to `"5m"`.

[horoscope](../../extensions/horoscope) is the smallest complete one.

## Kind 3: rich component

**What it is.** Something inside a block with its own look and its own behaviour: a little board, a
gauge, a checklist you act on. It is **headless**: its data is the truth, and its view is composed
from a shared catalogue of primitives every client already draws. A new component needs no client
code.

**The contract.** A handler with `"kind": "component"`. `run` returns:

```json
{
  "title": "Virgo · week of 2026-09-28",
  "data": { "sign": "virgo", "dread": 5, "omens": [{ "omen": "…", "warded": false }] },
  "view": { "type": "card", "title": "Virgo", "badge": { "label": "uneasy", "tone": "warn" }, "children": [
    { "type": "stat", "label": "Dread", "value": 5, "unit": "/ 10", "tone": "warn" },
    { "type": "checklist", "items": [{ "label": "…", "done": false }] }
  ] },
  "targets": { "html": "<optional: its own rendering for a target>" }
}
```

Its behaviour is **actions** (below): `ward` writes a block, and the next run reads it back from
`context.children`. The component's state lives in the outline, as blocks.

### The primitives

| Primitive | Fields |
|---|---|
| `text` | `text`, `tone?`, `strong?` |
| `badge` | `label`, `tone?` |
| `stat` | `label`, `value` (number or text), `unit?`, `tone?` |
| `bar` | `label`, `value`, `max`, `tone?` |
| `table` | `columns`, `rows` (cells: text or numbers), `links?` (a block id per row, or null: Enter or a click opens it) |
| `checklist` | `items: [{ label, done }]` |
| `sparkline` | `label?`, `values` |
| `card` | `title`, `subtitle?`, `badge?`, `link?` (a block id), `children?` |
| `box` | `title?`, `children` |
| `stack`, `row` | `children` (top to bottom; side by side) |

`tone` is `default`, `good`, `warn`, `bad`, `dim` or `accent`. Limits: depth 8, 400 primitives, 200
rows, 12 columns, 2 000 characters of text each, 256 KiB of data. A view that breaks one is refused
with a path to the problem (`view.children[0].max must be more than 0`), and the line shows it.

### Targets and fallbacks

Data first, rendered to the target the reader names (`extensions.render`, or the publisher by
`Accept` header later):

| Target | From the primitives |
|---|---|
| `terminal` | Plain text with box drawing; a client that draws primitives (the door) takes `view` instead |
| `markdown` | Lists, a GFM table, `- [x]` items |
| `blockdown` | The markdown, made inert: it can't add properties to a note |
| `html` | Semantic HTML with `ext-*` classes |
| `json` | The data |
| `csv` | The view's first table, else data that is a list of flat objects |

For one target the chain is: (1) the component's own `targets[target]`; (2) the version composed from
its primitives; (3) the fallback the requester names (`fallback`, default `json`). An unknown
component never breaks a reader: it degrades to its data.

**Worked example: "make me an extension that shows my open bugs as a little board in a note".**

1. A `kind: "component"` handler `bugs` with `"effects": "read"` and `"staleAfter": "10m"`.
2. `run` fetches the bugs (or reads them from `context`) and returns
   `data: [{ key, title, state }]` with a view:
   `{ type: "box", title: "Open bugs", children: [{ type: "stat", label: "Open", value: n },
   { type: "table", columns: ["Key", "Title", "State"], rows: [...] }] }`.
3. Add an action `"close"` (`"on": "handler:bugs"`, `"effects": "write"`) whose `act` returns a
   write (a child block "Closed PC-12"), or calls the tracker with a secret and returns a message.
4. `bugs:: mine` draws in Detail and the door; `extensions.render … target: "csv"` gives a sheet.

[fancy-horror](../../extensions/fancy-horror) is the canonical one.

## Actions

An action is one thing an extension can do, declared once and reachable every way: a key and a
click in the door (its `ActionDef` is `ext.<id>.<action>`), `outliner ext act`, and
`extensions.act` for agents.

```json
{ "id": "ward", "label": "Ward off the next omen", "on": "handler:fancy-horror", "key": "w", "effects": "write" }
```

- `on`: `block` (any block; the default), `handler:<key>` (a line of that handler: the request
  names the block, and the line when there are several), or `tile:<kind>` (needs no block).
- `effects`: `read` (the default) answers only; `write` may return writes.
- `act` returns `{ message?, writes? }`. Writes are
  `{ "op": "create", "parentId", "text" }` or `{ "op": "update", "blockId", "expectedRevision", "text" }`,
  at most 20. They must stay inside the block the action acts on; they apply together or not at
  all; an update is revision-checked; each is `author: agent`, `actorId: ext:<id>`, under
  `ext.<id>.<action>` in the change feed. After an action on a handler's line writes, that line runs
  again before the answer comes back.
- `keep` is built in for every output and component handler.

```json
{ "action": "extensions.act", "extension": "fancy-horror", "extensionAction": "ward", "blockId": "…", "line": 1 }
```

## Kind 4: a whole tile

**What it is.** A program that is a tile: like nvim or the daily agent in a pane, but registered as a
tile kind of its own (`tarot.reading`). The door's open tile-kind registry (PIE-505) makes, binds and
saves it like any built-in kind; the engine never switches on its name.

**The contract.** A `tiles[]` entry:

```json
{
  "kind": "reading", "name": "Tarot",
  "run": ["bun", "tile.ts"],
  "actions": ["draw", "keep"],
  "policy": { "resizable": true, "collapsible": true, "droppable": false },
  "accepts": [],
  "args": { "block": { "type": "block", "description": "Where k keeps a reading" } }
}
```

### What the door's registry consumes

`extensions.list` returns every active tile kind in `tileKinds`, ready to register:

```json
{
  "kind": "tarot.reading",
  "extension": "tarot",
  "name": "Tarot",
  "description": "Today's card; d draws again, k keeps it under the tile's block, q closes",
  "command": ["/home/you/.bun/bin/bun", "tile.ts"],
  "cwd": "/home/you/.config/pi-herdr-outliner/extensions/tarot",
  "host": "float-2",
  "env": { "OUTLINER_EXTENSION": "tarot", "OUTLINER_OUTLINE": "pie", "OUTLINER_SOCKET_PATH": "/run/…/outliner.sock" },
  "actions": [
    { "id": "draw", "name": "ext.tarot.draw", "label": "Draw a card", "on": "tile:reading", "key": "d", "effects": "read" },
    { "id": "keep", "name": "ext.tarot.keep", "label": "Keep the reading", "on": "block", "key": "k", "effects": "write" }
  ],
  "policy": { "resizable": true, "collapsible": true, "droppable": false },
  "accepts": [],
  "args": { "block": { "type": "block" } },
  "save": "args"
}
```

| Registry entry | From |
|---|---|
| name | `kind` (`<extension>.<kind>`, unique) and `name` |
| how to make it | a pty tile running `command` in `cwd` with `env`, plus the door's own `EP0CH_CONTROL`, and the tile's args appended as `--name=value` |
| its actions | `actions`: bind each as an `ActionDef` named `name` with its `key`; it runs `extensions.act` (`extension`, `extensionAction: id`, and the tile's `block` arg as `blockId` when `on` is `block`) |
| default policy | `policy` (the layout design's per-container settings) |
| what it accepts | `accepts` (tile kinds it takes as drops; empty: none) |
| how it saves | `save: "args"`: a screen stores the kind and its args, nothing else |
| where it can run | `host`: the command is a path on the service's host. A door on another machine shows the kind as unavailable. |

When `extensions.changed` arrives the door reads `tileKinds` again: a removed extension's tiles say
their kind is gone instead of running something else.

**The program** draws itself in the tile's terminal and reaches the outline only through the service
(`extensions.act` on `OUTLINER_SOCKET_PATH`, naming `OUTLINER_OUTLINE`), or through `EP0CH_CONTROL`
for door actions. So what it writes is attributed to the extension, exactly as when an agent runs the
same action with no tile open.

**Worked example: "make me a pomodoro tile that logs each session in my journal".**

1. `extension.json` with `"run": ["bun", "pomodoro.ts"]`, an action
   `{ "id": "log", "label": "Log a session", "on": "block", "effects": "write" }`, and a tile
   `{ "kind": "timer", "name": "Pomodoro", "run": ["bun", "tile.ts"], "actions": ["log"],
   "args": { "block": { "type": "block" } } }`.
2. `pomodoro.ts` answers `act` for `log` with
   `{ writes: [{ op: "create", parentId: target.blockId, text: "Pomodoro: 25 min, " + args.task }] }`.
3. `tile.ts` draws the countdown; when it ends it sends one line to the outline socket:
   `{"id":"…","outline":"pie","action":"extensions.act","extension":"pomodoro","extensionAction":"log","blockId":"<--block>","args":{"task":"…"}}`.
4. The door lists `pomodoro.timer` as a tile kind. An agent can log a session with no tile:
   `outliner ext act pomodoro log --block <journal id> --arg task=review`.

[tarot](../../extensions/tarot) is the canonical one; its README shows the program's key loop and
socket call.

## `extensions.list`

```json
{
  "generation": 3,
  "roots": [{ "path": "/home/you/outlines/pie/extensions", "origin": "outline", "exists": true }, { "path": "…/extensions", "origin": "user", "exists": true }],
  "extensions": [{
    "id": "horoscope", "name": "Horoscope", "version": 1, "origin": "user", "directory": "…", "state": "active",
    "loadedAt": "…", "runsCode": true,
    "handlers": [{ "key": "horoscope", "kind": "output", "effects": "read", "argument": { … }, "options": { … }, "staleAfter": "1h" }],
    "actions": [{ "id": "keep", "name": "ext.horoscope.keep", "builtIn": true, … }],
    "tiles": []
  }],
  "tileKinds": [ … ],
  "primitives": ["text", "badge", "stat", "bar", "table", "checklist", "sparkline", "card", "box", "stack", "row"],
  "targets": ["terminal", "markdown", "blockdown", "html", "json", "csv"],
  "trust": "Extensions are trusted code, not a sandbox: they run as the service user."
}
```

`state` is `active`, `failed` (with `error`; it may still serve its last good version), `disabled`
or `shadowed`. `extensions.list { reload: true }` reads the folders now instead of waiting for the
watcher.

## Testing an extension

Never against a real outline. Start a scratch service whose outline root is a temp folder, copy the
extension into its `extensions/`, and drive it over the socket, as
[`test/extensions-wave-b.test.ts`](../../test/extensions-wave-b.test.ts) does for the four examples.
Use made-up data. The runtime is the same one the live service uses.

## Not yet

- **The door's `::graph-*` figures** (`graph-check`, `graph-stat`, `graph-table`, `graph-rank`) stay
  in ep0ch-door for now. They are a rich component in shape, but they live in the door's core and
  read the outline through queries on every paint; moving them needs the door to draw components
  from the service (with the tile-kind registry, PIE-505) and a query input in the `run` contract
  (a handler that declares the query it reads, evaluated by the service). The primitives here are
  the target they move to.
- **Renderers for `component:` fences** (status-summary, `document-renderers.json`) still use the
  reader host's registry; they move to `extensions.list` with the door's renderer work.
- **The door** draws handler lines generically until it reads `kind` and `output` (its projection
  filter knows only `jira` today). Detail draws them now.
- **The publisher** shows data records (they are blocks) but not yet handler outputs; it will ask
  `extensions.render` for `html`.
- **Generic Resource providers.** `kind: "resource"` is Jira's path; others use `data`.
