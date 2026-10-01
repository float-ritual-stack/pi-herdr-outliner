# Tarot (a whole tile)

The example for **kind 4, a whole tile**: a terminal program in a tile of its own kind,
`tarot.reading`, registered in the door's open tile-kind registry from `extensions.list`
(`tileKinds`). The cards are made up.

```text
┌──────────────────────────────────┐
│ The Star                         │
│                                  │
│ repair, slowly                   │
└──────────────────────────────────┘
d draws again · k keeps it · q closes
```

- **The tile** is `tile.ts`. The door runs it with the `command`, `cwd` and `env` the service lists,
  adds its own `EP0CH_CONTROL`, and passes the tile's saved args as `--block=<id>`.
- **Its actions are the extension's** (`draw`, `keep` in `extension.json`), run by the service
  (`tarot.ts`). The tile calls them over the outline socket (`extensions.act`); the door binds them as
  `ext.tarot.draw` and `ext.tarot.keep` (keys `d`, `k`); an agent calls the same actions with no tile
  open: `outliner ext act tarot keep --block <id>`. A kept reading is a block attributed `ext:tarot`.
- **Where it runs.** The command is a path on the service's host (`host` in the listing). A door on
  another machine shows the tile kind as unavailable rather than running something else.

Install: `outliner ext add tarot`. See [the four kinds](../../docs/extensions/README.md).
