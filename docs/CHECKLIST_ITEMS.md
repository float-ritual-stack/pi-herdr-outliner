# Checklist items

PIE-367 keeps a plan in one Markdown note while making its steps individually
addressable. This document describes the service foundation on the feature
branch, including agent tools and the editor's intentional-ID-removal flow.
Reader controls are being integrated; ANSI Detail, item projections and
item-attached comments remain in progress. The feature has not been delivered.

## Canonical content

```markdown
# Release plan

Run the experiment once, then restore the flag.

1. [x] Prepare ^prepare
2. [~] Wait for deployment [owner::alex] ^deploy
   Keep the deployment receipt here.
3. [ ] Verify

Then:
- Ask about ownership
```

The shared status vocabulary is `todo` (`[ ]`), `done` (`[x]`, also read as
`[X]`), `waiting` (`[~]`) and `problem` (`[!]`). Only actual Markdown list
items with these leading marks are tasks. Unmarked items, legends and code
examples remain ordinary content. “Next:” prose never overrides the mark.

An ID on an item's first line addresses that item plus its continuations and
nested list subtree. `((block-id^deploy))` follows it;
`!((block-id^deploy))` embeds it. Renumbering, rewording and moving the item
within the note preserve the authored ID. Source offsets are observed edit
coordinates, not durable identity.

## Reading and querying

`checklist.query` accepts `blockId` and `query`:

```json
{
  "limit": 100,
  "excludeStatuses": ["done"],
  "nested": "include",
  "filters": [{"key": "owner", "value": "alex"}]
}
```

Use `statuses` to include selected states, or `excludeStatuses` to omit them.
`nested` defaults to `include`; `top-level` excludes items inside another list
item. The required limit is 1–1000. Results retain canonical source order and
report completeness, the observed block revision and the parent plan's title.
The block ID provides the route back to the complete plan and its instructions.

Filters use the existing property index and matching rules, restricted to each
item's own source extent. Descendant items, siblings and plan metadata never
supply another item's properties. A `status` filter uses the checkbox mark.
A filter without a value tests property presence. Results contain source spans,
the item evidence hash and identity state: unassigned, unique or duplicate.
Reading and querying never assign IDs or mutate the note.

## Changing one item

`checklist.update` takes `blockId`, `input` and ordinary mutation provenance.
For an addressed item:

```json
{
  "target": {"itemId": "deploy"},
  "expectedEvidence": "hash returned by checklist.query",
  "change": {"kind": "status", "status": "done"}
}
```

For an unassigned item, use `target: {start, expectedRevision}` from the observed
query. This location is valid only against that exact block revision. A status
change or `change: {kind: "ensure-id"}` assigns a unique `task-…` ID explicitly.
Repeating `ensure-id` for an already addressed item is a no-op.

The service checks the current item's evidence and changes only the marker and,
when necessary, inserts its ID. Existing surrounding text, whitespace and line
endings survive. Addressed items tolerate unrelated edits elsewhere in the note;
changed item content, missing IDs and duplicate IDs require a fresh read and
decision. Evidence includes the item's nested subtree and ignores trailing
whitespace. Changing a nested step therefore invalidates a parent's old evidence.

The receipt contains the canonical block, updated item and `changed` flag.
Successful changes use normal block revisions, edit provenance and content
events; no separate canonical task store is introduced.

Pi agents use `outliner_checklist_query` with `blockId` and the query fields above
(default limit 100), then `outliner_checklist_update` with `blockId`, `target`,
`expectedEvidence` and `change`. The adapter records the agent/session/tool-call
provenance. These tools operate on steps, separately from the roadmap lifecycle
tool `outliner_task`. Tool results include the structured service receipt.

## Whole-note rewrites

All normal block-text writers preserve existing list-item IDs. Dropping one
returns an error naming the ID and its link/comment impact. Creating duplicate
list-item IDs is also rejected during an update. Keep IDs through formatting
and reordering; never derive them anew from the current wording.

An intentional removal or rename on the ordinary `update` request must include
`identityChanges`, alongside the current `expectedRevision`:

```json
[{"kind": "remove", "itemId": "deploy"}]
```

or:

```json
[{"kind": "rename", "itemId": "deploy", "to": "deployment"}]
```

Declarations must correspond to the submitted text. A rename requires a new,
unique destination ID. They are not blanket permission for later rewrites and
do not silently retarget links or comments elsewhere. The agent's
`outliner_update` accepts these same declarations.

In Detail, saving a draft that removes addresses offers **Keep editing** first,
or **Save and remove item addresses**. Escape keeps the draft. The removal
choice names the affected IDs and warns that links, embeds and comments may
become unresolved. Confirmation applies only to that draft and revision; a
changed draft must be reviewed again. The same guard and explicit declaration
apply when committing retained writing. Writing history can restore the saved
before-image, including its original addresses.

## Reader controls (feature branch)

Pi Detail and the shared Tree/Inbox Preview render canonical checklist marks as
controls. Click a mark, or Tab to it and press Enter, to choose a status. Mark
done comes first; Escape cancels. Space on a focused mark toggles to do/done.
Ctrl+Z reverses the reader's last status change for that note, retaining an
assigned item address. Undo checks item evidence too: a subsequently rewritten
step needs a fresh decision, rather than restoring old words.

Copy step link explicitly assigns an address if needed and copies the fragment
reference. Ordinary rendering, including hidden/folded content, never writes.
Code examples and legends have no task controls. List disclosures remain
separate controls; folding children leaves the parent checkbox usable. Saved
Inbox before-images remain read-only. Embedded/projected item controls are not
yet implemented.

Both hosts use `ChecklistSession` and the same service update. The rendered
control carries canonical block/item identity and observed evidence; a wrapped
screen row is never an edit target. A late response cannot replace a newer
Preview destination. Menus and notices are local reader state, not authored text.
