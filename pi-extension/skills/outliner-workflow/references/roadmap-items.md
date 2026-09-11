# Roadmap items

## Canonical model

A roadmap item is one canonical block beneath the project's single active `[type::work-queue]` block. Lanes, capability maps, arcs, and tracks are virtual branches. They project canonical items and never own copies.

Every roadmap item has these properties:

- one `[type::roadmap-item]`;
- one `[status::planned|complete]`;
- one `[priority::high|medium|low]`;
- one `[work-stage::unprioritized|later|next|doing|review|validate|done]`;
- one `[project::<project>]`;
- one `[arc::<arc>]`;
- at least one `[track::<track>]`;
- one allocator-issued immutable `[work-id::<PREFIX-NNN>]`.

`[depends-on]`, `[related-to]`, and `[source-block]` values are canonical block UUIDs. Never put a Work ID, a title, or a page name in a relationship property.

## Status and work stage answer different questions

`status` records the roadmap item's outcome.

| Value | Meaning |
| --- | --- |
| `planned` | The work remains open. This value does not mean that the item is scheduled. |
| `complete` | The work met its acceptance criteria and has linked proof. |

`work-stage` records scheduling and delivery position.

| Value | Meaning |
| --- | --- |
| `unprioritized` | The item belongs to the planned backlog but has no execution commitment or lane rank. |
| `later` | The owner deliberately deferred the item. |
| `next` | The owner selected and ranked the item for near-term execution. Keep this lane small. |
| `doing` | One agent session owns active implementation. |
| `review` | The deliverable or pull request awaits review. |
| `validate` | The change merged and awaits acceptance proof or field validation. |
| `done` | The item is complete and links to proof. |

An open item keeps `[status::planned]` while its work stage changes. Completion changes both axes to `[status::complete] [work-stage::done]`.

`accepted` is not a roadmap-item status. Findings, decisions, reviews, and feedback can use `[status::accepted]` to record a judgment. If an accepted source requires work, link it to an existing roadmap item or create a planned roadmap item with `[source-block::<source UUID>]`.

## Intake and backlog review

Process candidate work in this order:

1. Read the source artifact and identify one concrete user outcome.
2. Search roadmap titles, contracts, source links, dependencies, and related work for duplicates.
3. If an existing item owns the outcome, link the source to that item and record the duplicate or routed disposition on the source.
4. If no item owns the outcome, call `outliner_roadmap_create` with the complete contract and acceptance criteria. New items default to `unprioritized`.
5. Query the item after creation. Verify its Work ID, canonical parent, required properties, source link, and capability-map memberships.

Do not convert every idea into work. A candidate needs a concrete user outcome, an observable acceptance condition, and enough evidence to distinguish it from existing work.

## Create

1. Use `outliner_query` to search the proposed title, governing arc, source block, and likely related items.
2. Call `outliner_roadmap_create` with a title that contains neither a Work ID nor property tokens. Include the complete contract and acceptance criteria in `body`.
3. Supply explicit `project`, `priority`, `arc`, and at least one `track`. Supply UUID relationships when known.
4. Omit `workStage` unless the owner has explicitly chosen placement. The atomic default is `unprioritized`.
5. Treat the returned `workId`, `workQueueId`, block, and branch memberships as the creation receipt.
6. Query the new Work ID and verify the required metadata and parent.

Never create a placeholder roadmap block and allocate its Work ID afterward. `outliner_create` remains appropriate for notes and artifacts, not roadmap work.

## Update

1. Resolve the item by Work ID and read its latest `updatedAt` and property ordinals.
2. Use `outliner_property_patch` for metadata. Replace the exact scalar property ordinal instead of appending a second value.
3. Use `outliner_update` with `expectedUpdatedAt` for title, contract, or acceptance changes.
4. Re-read after each optimistic mutation before another mutation.
5. Verify scalar uniqueness and required metadata after the update.

Preserve the immutable Work ID and unrelated metadata.

## Schedule and deliver

Use this normal transition sequence:

1. `unprioritized` or `later` to `next` after an explicit owner choice or a governing roadmap decision.
2. `next` to `doing` through `outliner_task start`.
3. `doing` to `review` through `outliner_delivery sync` after the pull request opens.
4. `review` to `validate` through `outliner_delivery sync` after merge.
5. `validate` to `done`, paired with `planned` to `complete`, through `outliner_task complete` with linked proof.

`outliner_task pause` returns active work to `next`. `outliner_task clear` only repairs session binding and does not change roadmap metadata.

Do not use invented work stages such as `accepted`, `now`, `proof`, or `dogfood-gated`. Record dependencies with `[depends-on]`, deferred work with `later`, and validation requirements in the item contract.

## Capability maps and ranking

Capability maps group the same canonical roadmap items by `[arc]` or `[track]`. They answer where the capability belongs. They do not answer when the team will execute it.

Lane membership comes only from `work-stage`. Ordering is independent of membership. Call `outliner_branch_rank` with the virtual branch UUID and canonical item UUIDs to rank a lane or track. Existing ranked items omitted from the call retain their relative slots.

Never use `outliner_move` to prioritize a lane or track. Never change `work-stage` only to alter ordering.

A roadmap item can have several `[track]` properties. Each matching track branch projects the same canonical block. Exactly one block under the work queue remains authoritative.
