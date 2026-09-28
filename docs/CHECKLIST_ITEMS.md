# Checklist items

Keep a plan in one Markdown note while making its steps individually
addressable. Service operations, agent tools and the editor share the same
identity guard. Pi and ANSI Detail and local Preview provide status controls,
item-attached comments and live item-query views. These operations require
service protocol 79.

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
item. The `query` object and its limit (1–1000) are required; the service does
not default them. Results retain canonical source order and
report completeness, the observed block revision and the parent plan's title.
The block ID provides the route back to the complete plan and its instructions.

Filters use the existing property index and matching rules, restricted to each
item's own source extent. Descendant items, siblings and plan metadata never
supply another item's properties. A `status` filter uses the checkbox mark.
A filter without a value tests property presence. Results contain source spans,
the item evidence hash and identity state: unassigned, unique or duplicate.
Reading and querying never assign IDs or mutate the note.

### Live views across plans

Author a note like this, then open it in Detail or Preview:

```markdown
# My remaining steps
[type::checklist-view]
[plans::project=demo]
[query::owner=alex]
[exclude-status::done]
[nested::include]
[limit::100]
```

`plans` selects canonical notes using the existing property-filter grammar;
omit it to consider the workspace. Optional `subtree` bounds those notes to one
canonical block and its descendants. `query` applies the same filter grammar
to each task's own properties and checkbox status, for example
`status=waiting owner=alex` or just `owner` for property presence. It is required;
`query::status` selects all marked tasks. `exclude-status` is a comma-separated
list from the shared status vocabulary. `nested` and `limit` follow the query
rules above. Unsupported syntax and unavailable reads display an error, not an
empty result.

The view links each result to its parent plan and, when addressed, directly to
the step. An unaddressed result can still be changed against its observed source
revision; Copy step link explicitly creates its ID. Nested text stays with its
matching parent as context, but only matched steps get controls in the result.
Results use canonical note order and then source order, independently of Tree
collapse. Embedding the view elsewhere does not create extra tasks. Changing a
status updates the original; results that no longer match leave the view, and
reader Undo can bring them back. The view's own text is not rewritten.

`checklist.search` exposes the same read through the service:

```json
{
  "scope": {"filters": [{"key": "project", "value": "demo"}]},
  "items": {"filters": [{"key": "owner", "value": "alex"}], "excludeStatuses": ["done"], "limit": 100}
}
```

The optional scope also accepts `subtreeRootId`, `text`, `propertyScope` and
the existing created/updated sort. The service searches active canonical notes,
without a preliminary first-N-note cutoff. Results contain `matches` with the
observed full `block` and `item`, plus explicit completeness for the item limit.
Reads never assign IDs. For Pi, omit `blockId` from `outliner_checklist_query`
and optionally supply `scope` with filters, subtreeRootId or text. Supplying
both a blockId and scope is rejected.

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
query. This location is valid only against that exact block revision: a missing
`start` or `expectedRevision` is rejected as required, while a different revision
reports that the checklist location changed. A status change or
`change: {kind: "ensure-id"}` assigns a short ID explicitly, `t-` plus six random
hex digits (for example `^t-daca0f`). If that ID is already used by any anchor in
the note, the same digits are extended one at a time until it is unique. Items
already addressed by older generated `task-<uuid>` IDs, or by hand-written IDs,
keep them. Repeating `ensure-id` for an already addressed item is a no-op.

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

All normal block-text writers preserve existing list-item IDs. Dropping one, or moving its ID onto a heading or paragraph,
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
unique list-item destination ID. They are not blanket permission for later rewrites and
do not silently retarget links or comments elsewhere. The agent's
`outliner_update` accepts these same declarations.

In Detail, saving a draft that removes addresses offers **Keep editing** first,
or **Save and remove item addresses**. Escape keeps the draft. The removal
choice names the affected IDs and warns that links, embeds and comments may
become unresolved. Confirmation applies only to that draft and revision; a
changed draft must be reviewed again. The same guard and explicit declaration
apply when committing retained writing. Writing history can restore the saved
before-image, including its original addresses.

## Reader controls

Pi and ANSI Detail and the shared Tree/Inbox Preview render canonical checklist marks as
controls. Click a mark, or Tab to it and press Enter, to choose a status. Mark
done comes first; Escape cancels. Space on a focused mark toggles to do/done.
Ctrl+Z reverses the reader's last status change for that note, retaining an
assigned item address. Undo checks item evidence too: a subsequently rewritten
step needs a fresh decision, rather than restoring old words.

Copy step link explicitly assigns an address if needed and copies the fragment
reference. Ordinary rendering, including hidden/folded content, never writes.
Code examples and legends have no task controls. List disclosures remain
separate controls; folding children leaves the parent checkbox usable. Status
changes preserve that local fold, including the first change that assigns an
item address. Repeated embeds keep independent folds. Saved Inbox before-images
remain read-only.

Whole-note embeds, item-fragment embeds and fragment-only Preview use the same
controls. Changing an embedded step updates its canonical plan; the embedding
note remains unchanged. Repeated copies retain distinct keyboard focus while
sharing the same item identity and evidence. Copy link points to the original
step, and Undo from the embedding note reverses that reader's latest change
made there. A focused embedded checkbox also directs a comment to its source
step. Live task-query projections reuse these controls and their source evidence.

A background refresh of the same Preview keeps an open status picker and its
current choice. The pending command retains its originally observed evidence,
so a concurrent change to that step is still detected by the service. Escape
cancels the picker; navigating elsewhere replaces it normally.

All readers use `ChecklistSession` and the same service update. The rendered
control carries canonical block/item identity and observed evidence; a wrapped
screen row is never an edit target. A late response cannot replace a newer
Preview destination. Menus and notices are local reader state, not authored text.

ANSI Detail uses the shared document layout for checklist controls, folding and
links, with keyboard focus revealing off-screen controls. Pointer coordinates
come from the rendered frame. Fragment navigation maps canonical lines to
rendered rows, including wrapped content. Its full comment evidence remains in the existing
scrollable comments section. Mouse reporting is suspended around external editors.


## Comments on steps

Focus a checkbox and press `c` to comment on that step. A passage selection
still takes precedence. Opening or cancelling the composer does not change the
note; saving a canonical passage comment establishes the innermost containing
checklist item's identity. Multiple comments saved together assign each needed
ID once, in the same transaction as the comments. Failed creation rolls back
both comments and addresses; request retries reuse the original receipt.

The immutable original target retains its quote and representation. Its
`listItemId` records the owning step. Reconciliation searches only that step’s own text, excluding descendant items:
unchanged words retain exact passage placement; rewording produces a
`list-item` resolved anchor and the visible label **Item attachment · original
passage changed**, alongside the old quote. Restoring the old wording can
restore exact passage placement. Another step containing the same words cannot
take ownership. Missing IDs remain orphaned; duplicate IDs remain ambiguous.
Revealing the source of a reworded comment opens the addressed step without
pretending its original quote is still selected. Cancelling a comment preserves
the focused checkbox, so another comment attempt still targets that step.

This uses the existing annotation targets, resolution history and block history,
not a separate comment store. Explicit human resolution preserves the owning
item. Historical Inbox sources, rendered-only captures, ordinary prose and
whole-note comments do not acquire task addresses. Detail and Preview reload
canonical text after comment-created IDs so their next reconciliation uses the
saved version. Saved before-images remain unchanged.
