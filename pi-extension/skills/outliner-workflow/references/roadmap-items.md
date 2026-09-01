# Roadmap items

## Canonical model

A roadmap item is one canonical block beneath the project's single active `[type::work-queue]` block. Lanes and tracks are virtual branches; they are views, not alternate parents.

Required metadata:

- one `[type::roadmap-item]`;
- one `[status::planned]` while open;
- one `[priority::high|medium|low]`;
- one `[work-stage::unprioritized|next|doing|review|validate|later]`;
- one `[project::<project>]`;
- one `[arc::<arc>]`;
- at least one `[track::<track>]`;
- one allocator-issued immutable `[work-id::<PREFIX-NNN>]`.

`[depends-on]`, `[related-to]`, and `[source-block]` values are canonical block UUIDs. Never put a Work ID, title, or symbolic page name in relationship properties.

## Create

1. Use `outliner_query` to search the proposed title, governing arc, source block, and likely related items. Resolve duplicates before allocation.
2. Call `outliner_roadmap_create` with a title that contains neither a Work ID nor property tokens. Include the complete contract and acceptance criteria in `body`.
3. Supply explicit `project`, `priority`, `arc`, and at least one `track`. Supply UUID relationships when known.
4. Omit `workStage` unless placement was explicitly decided. The atomic default is `unprioritized`.
5. Treat the returned `workId`, `workQueueId`, block, and branch memberships as the creation receipt. The tool fails without creating a partial block if queue discovery, relationship validation, or Work-ID allocation fails.
6. Query the new Work ID and verify the required metadata and parent before reporting success.

Never create a placeholder roadmap block and allocate its Work ID afterward. `outliner_create` remains appropriate for notes and artifacts, not roadmap work.

## Update

1. Resolve the item by Work ID and read the latest block, including `updatedAt` and property ordinals.
2. Use `outliner_property_patch` for metadata. Replace the exact property ordinal rather than appending a second scalar property.
3. Use `outliner_update` with `expectedUpdatedAt` for title, contract, or acceptance-criteria changes. Preserve the immutable Work ID and all unrelated metadata.
4. Re-read after each optimistic mutation before issuing another.
5. Verify scalar uniqueness and required metadata after the update.

## Promote and rank

Lane membership is derived from `work-stage`:

- promotion to Next: replace `work-stage` with `next`;
- active work: use `outliner_task start`, which sets `doing`;
- pause: use `outliner_task pause`, which returns the item to `next`;
- completion: use linked proof and `outliner_task complete`.

Ordering is independent of membership. Call `outliner_branch_rank` with the virtual branch UUID and canonical item UUIDs in desired relative order. Existing ranked items omitted from the call retain their relative slots. Ranking may be recorded before an item matches the branch, allowing a later stage transition to reveal it in the intended position.

Never use `outliner_move` to prioritize a lane or track. Never change `work-stage` merely to alter ordering.

## Track projections

A roadmap item may have multiple `[track]` properties. Each matching track branch projects the same canonical block. Exactly one branch may be the creation destination because the block has exactly one physical parent; additional track branches must remain query-only views.
