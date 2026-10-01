# Moon (data)

The small example for **kind 1, data put into a block**: `read` returns a record, and the service
keeps it as one real block the extension owns, with namespaced properties. Computed from the date,
so it needs no network and no account.

```text
moon:: 2026-10-01
  └─ Moon on 2026-10-01: Waxing Gibbous        ← a real block, owned by ext:moon
     [moon.key::2026-10-01] [moon.phase::Waxing Gibbous] [moon.illumination::73%] …
     73% lit, 9.4 days since the new moon.
```

- **As if copied in.** `moon.phase=Full Moon` in a saved view finds every full-moon date you
  wrote; the record shows in backlinks and embeds like any block.
- **Owned.** Only the extension writes the record: an edit to it is refused with a reason. Your
  own notes and `[phase::]` go on the block that asks.
- **One per key, Trash when unused.** Two lines for one date share one record. Delete the last
  line and it goes to Trash (restorable).
- **Refresh.** `effects: read` fetches when the line is saved and the record is missing; `r`
  fetches again. A handler can set `staleAfter` to refetch older copies on open.

Jira (`extensions/jira`) is the full data extension: a remote record with comments, a poll and a
Resource snapshot. Install: `outliner ext add moon`. See [the four kinds](../../docs/extensions/README.md).
