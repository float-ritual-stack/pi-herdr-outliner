# Roadmap operations

Read the live **How this workboard works** block
`d5b3e557-a166-4c50-baad-7a0ed8db8fe6` for the owner's operating flow. Retrieve it
through the configured service with `get`; do not change Tree focus to read it.
This reference documents the metadata and tool contract.

## Agent commands

Agents without Pi's session tools (Claude, Codex, scripts) use the CLI, which
shares one implementation (`src/work-tools.ts`) with Pi's task completion. Every
command names its item explicitly by Work ID or block UUID, checks the revision
it read, reads the result back and prints JSON with the Work ID, `((block ref))`
and new revision. Refusals print one `error: …` line and exit 1.

```sh
bun src/cli.ts work create --title … --project … --arc … --track … --priority … [--stage queued] [--stdin|--body-file f]
bun src/cli.ts work stage PIE-123 doing [--expected N]
bun src/cli.ts work set PIE-123 priority high [--expected N]
bun src/cli.ts work set PIE-123/door delivery-stage complete [--expected N]
bun src/cli.ts work deliver PIE-123 --repo owner/name --pr 42 [--key door] [--base main] [--branch feature/x]
bun src/cli.ts work complete PIE-123 [--delivery <uuid|key|name>]… [--all-merged] --proof-file proof.md|--stdin|--proof-block <uuid>
bun src/cli.ts work body PIE-123 --file body.md|--stdin [--expected N]
bun src/cli.ts note section <uuid> "Heading" --file section.md|--stdin [--expected N]
bun src/cli.ts work help
```

Add `--author agent --actor <id>` for agent writes. `work stage … done` is
refused: Done goes through `work complete`, which creates or links the proof.
`work deliver` reads the PR through `gh` and refuses a PR whose branches differ
from the delivery's.

### Items with several deliveries

An item can ship through more than one PR, one delivery each: say the Outliner
change and a door change in another repository. Each delivery has a key
`PIE-123/<name>`.

- **Recording.** `work deliver --key door` records the PR as `PIE-123/door`
  (`--key PIE-123/door` is the same). Without `--key`, a PR whose repository and
  branch a delivery already records syncs that delivery; otherwise the first
  delivery is `primary`, and once primary records another repository the new one
  is named after its repository (`owner/ep0ch-door` → `PIE-123/ep0ch-door`). A
  second branch in primary's own repository, or a key that already records other
  branches, is refused with a request for `--key <name>`.
- **Completing.** `work complete` covers deliveries named with `--delivery`
  (repeat it or separate with commas; block UUID, key or name) or, with
  `--all-merged`, every delivery whose PR is merged and synced. Each one covered
  must be merged. While any other delivery is not Complete the command is
  refused, naming each one with its next step (include it, or merge the PR and
  sync it with `work deliver … --key <name>`). No delivery is left behind in
  Validate under a Done item.
- **Finishing one by hand.** `work set <delivery> delivery-stage complete`
  completes one merged delivery, for example one left in Validate on an item
  that is already done; `validate` reopens a complete one. The delivery is named
  by block UUID or key and the write is revision-checked (`--expected N`). Work
  and Review come from the PR through `work deliver`, so they cannot be set.

`note section` replaces what Detail folds under the heading, up to the next
heading of its level (a trailing callout included) and returns it as `previous`.
The Claude mod exposes the same commands as `work_*` and `note_section` tools,
and every other outline operation an agent needs (read with full text, find,
resolve, revision-checked edit, create, comment, changes, `draft.patch`) as its
[`outline_*` tools](../../../../claude-mod/README.md#outline-tools), which run
the CLI's `agent` command. Use them instead of a script around `list` or `update`.

## Canonical records

A roadmap item is one block beneath its project's active `type=work-queue`.
Views project that item; physical position does not express commitment or priority.

Required properties:

- one `type=roadmap-item`, immutable allocator-issued `work-id`, and `project`;
- one `work-stage=unprioritized|later|queued|doing|review|validate|done|superseded`;
- one `priority=high|medium|low`, one `arc`, and at least one `track`.

Roadmap items have no `status` property. `done` means accepted delivery with
linked proof. `superseded` means retired into a linked `superseded-by` item; it
does not count as shipped. Other block types retain their own status meanings.

An optional single `work-batch` property references a `type=work-batch` block
in the same project. This item-side reference alone owns membership. Batch
blocks contain the agreed objective, stopping point and scope decisions; their
member views query `work-batch=<batch UUID>`. Membership survives stage changes,
pause, review, completion and session restart. Batch progress comes from members,
not another mutable status or completion counter.

A referenced batch retains its type and project. Reassign members before
removing it; Trash members still retain their commitment. Deleting a batch and
all its members together is allowed, as is restoring that subtree. Deleting a
query view alone never deletes its members.

Relationships (`work-batch`, `depends-on`, `related-to`, `source-block`, `proof`,
`superseded-by`) contain canonical block UUIDs, not Work IDs or titles.

## Create and schedule

1. Inspect the source and search for an existing outcome before allocating work.
   Rough ideas may remain notes until they have a concrete outcome and observable
   acceptance criteria.
2. Use `outliner_roadmap_create` with title, body, priority, project, arc and tracks.
   Source and relationship fields take UUIDs. New work defaults to `unprioritized`.
3. After the owner commits scope, create an ordinary `work-batch` block with its
   project and objective. Assign members through optimistic `work-batch` property
   patches; use `queued` for selected items waiting to start. `workBatchId` on
   roadmap creation validates the batch and defaults the new member to `queued`.
4. Read back canonical metadata and query the batch with block-scoped properties.
   Confirm complete results, exact membership, stage and branch-local rank.

Near-term candidates can be refined and ranked without joining a batch. A small
standalone fix can be explicitly queued without a batch. Related discoveries
stay outside committed scope until the owner or an existing scope allowance
authorizes their inclusion. Record additions, removals and deferral reasons on
the batch before changing membership; keep these decisions as history.

## Execute and return

- `outliner_task start` binds a session and orients its delivery branch. Queued,
  unprioritized or later work enters Doing. Attaching to Doing, Review or Validate
  preserves its stage. Rework is an explicit stage edit, not a side effect of
  resuming a session. Terminal items need an explicit reopen first.
- `outliner_task pause` clears the session binding. Doing returns to Queued;
  Review and Validate retain their next action. Membership remains unchanged.
- `outliner_delivery sync` uses the exact PR's live facts: open delivery reaches
  Review, merge reaches Validate. Those delivery transitions advance the item;
  repeated sync of unchanged facts preserves explicit rework in Doing.
  Delivery identity records Git facts; it does not own batch scope.
- `outliner_task complete` requires linked proof and, for recorded code delivery,
  a merged PR. It completes the session's delivery; like `work complete`, it is
  refused while another delivery of the item is incomplete. It sets Done and
  clears the session binding.
- `outliner_task clear` repairs binding without changing the item's progress.

Execution order follows dependencies and practical sequencing. A batch remains
inspectable after its Queued view empties. Report the agreed scope, actual next
actions, evidence, deviations and deferred discoveries when handing back.
Record the run's authorized stopping point; review-ready is not accepted delivery.

## Edit, rank and query

Read the latest revision and property ordinals before every mutation. Use
`outliner_property_patch` for metadata and `outliner_update` for prose. Replace
scalar values instead of appending duplicates. Read back after each mutation.

Use `outliner_branch_rank` for ordering. Preserve canonical IDs, source parents,
proofs and unrelated metadata. Capability maps still group the same items by
arc or track; they do not schedule work.

Current filters support property equality/presence, not OR/NOT. Use explicit
stage views or a batch-wide view with stage summaries. Stage views and their
creation defaults must agree; create roadmap work through the allocator tool,
not by copying a projected item. Do not create records directly in Done or Review.

## Existing workspace cutover

`bun run scripts/migrate-roadmap.ts --project <project>` reports proposed item
edits. Add `--apply --backup <new-file>` to retain before-images and apply through
the service with revision checks. Conflicting legacy values stop planning;
supersession is preserved, and rerunning makes no changes. Trash is left intact;
restoring legacy roadmap items applies the same metadata conversion.

Migrate saved-view queries, creation defaults and current hub instructions as
part of the workspace cutover. Preserve historical notes as history. Verify
Tree/Detail and agent lifecycle operations in a private fixture before applying
live changes. The application guide and current batch remain the authority for
task status; repository documents contain no second task queue.
