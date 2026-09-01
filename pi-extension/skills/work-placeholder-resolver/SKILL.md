---
name: work-placeholder-resolver
description: This skill should be used when a prompt, focused Outliner block, or outliner tool result contains a configured work marker such as "[work-id::PIE-XXX]", "[[PIE-XXX]]", or "[issue::PIE-XXX]", or when the user asks to "resolve PIE-XXX", "turn this placeholder into work", "reuse or create a roadmap item", or "replace a work placeholder".
---

# Work Placeholder Resolver

Resolve configured `<PREFIX>-XXX` markers into canonical Outliner work without guessing an identifier, duplicating existing intent, or rewriting unrelated prose. Treat detection as a reminder only. Perform every search, allocation, relationship change, and rewrite explicitly through Outliner tools.

## Preserve the invariants

- Call `outliner_work_id` with `operation: "status"` first. Resolve only the exact configured prefix and uppercase `XXX`; leave other prefixes and ordinary prose untouched.
- Search existing work before creating or allocating anything.
- Let semantic judgment choose a candidate; let Outliner tools enforce query, identity, allocation, and optimistic concurrency.
- Reuse exactly one confident existing candidate. Leave the marker unchanged when candidates are ambiguous or inadequate evidence prevents a decision.
- Replace only the intended marker in the latest full source text. Preserve every unrelated byte.
- Keep `XXX` intact after query, allocation, or update failure. Re-read before retrying.
- Never allocate an identifier by scanning, incrementing a visible number, or writing `[work-id::<PREFIX>-NNN]` manually.
- Never create, allocate, relate, or rewrite merely because a marker was detected.

## Interpret marker intent

Use the surrounding canonical block—not the marker alone—to determine the intended work.

| Marker | Meaning | Existing-work rewrite | New-work path |
| --- | --- | --- | --- |
| `[work-id::PIE-XXX]` | Decide whether this source block itself owns new work or expresses intent already owned elsewhere. | Replace the marker with `[related-to::<target-uuid>]`; do not assign a second Work ID. | Allocate on the source block. The allocator atomically replaces the configured placeholder property with the assigned Work ID. |
| `[[PIE-XXX]]` | Reference related work from prose. | Replace with `((target-uuid))`. | Create and allocate a target, then replace with `((target-uuid))`. |
| `[issue::PIE-XXX]` | Preserve a typed issue relationship. | Replace with `[issue::<target-uuid>]`. | Create and allocate a target, then replace with `[issue::<target-uuid>]`. |

Use the actual configured prefix in place of `PIE`.

## Resolve a marker

### 1. Establish the canonical source

1. Read the focused block with `outliner_selection` when the marker came from focus or a tool result.
2. Locate an explicit source block before mutating when the marker appeared only in a prompt. Ask for the source only when no tool-visible block can establish it.
3. Capture the source UUID, complete `text`, `updatedAt`, marker form, and exact intended occurrence.
4. Stop if multiple identical occurrences make the requested occurrence ambiguous.

### 2. Search bounded candidates

1. Remove the marker and property boilerplate from the intent phrase.
2. Call `outliner_query` with a small limit and the strongest meaningful text fragment. Prefer `[type::roadmap-item]` filtering when the intent is durable work.
3. Search a second distinctive phrase only when the first bounded search is empty or clearly too broad.
4. Inspect candidate title, body, properties, status, dependencies, and source links returned by the query. Resolve a known Work ID with `outliner_page` when necessary.
5. Do not dump an unbounded workspace or treat token overlap as semantic equivalence.

### 3. Make one explicit decision

Classify the result:

- **One confident match:** reuse it.
- **Several plausible matches:** present the bounded candidates and stop. Preserve `XXX`.
- **No adequate match:** create or promote canonical work.

Treat confidence as shared intent, not merely similar vocabulary. Prefer an existing task whose scope would make the proposed work redundant. Do not merge merely related tasks.

### 4. Reuse existing work

1. Re-read the source if any intervening tool call may have changed it.
2. Replace only the selected marker according to the marker table.
3. Call `outliner_update` with the complete updated text and the source's current `updatedAt`.
4. On optimistic conflict, preserve the marker, re-read, and reconsider the exact occurrence.
5. Use `outliner_focus` on the reused target when presenting the decision to the user.

For `[work-id::<PREFIX>-XXX]`, never assign the source another Work ID when existing work already owns the intent. The replacement relationship must point to the target UUID.

### 5. Create or promote work

For self-assignment through `[work-id::<PREFIX>-XXX]`:

1. Confirm the source is the intended durable work item and contains exactly one configured placeholder property.
2. Add missing roadmap metadata with `outliner_property_patch` only when required, preserving the placeholder.
3. Call `outliner_work_id` with `operation: "allocate"`, the source UUID, and its latest `updatedAt`.
4. Rely on the allocator's transaction to replace the placeholder atomically. Do not perform a preliminary marker removal.

For `[[<PREFIX>-XXX]]` or `[issue::<PREFIX>-XXX]`:

1. Create one canonical target with `outliner_create`. Include concise intent, `[type::roadmap-item]`, appropriate planned metadata, and `[source-block::<source-uuid>]`.
2. Allocate its Work ID with `outliner_work_id` using the returned `updatedAt`.
3. Re-read the source if necessary.
4. Replace only the source marker with the target UUID form from the marker table through `outliner_update`.
5. If source update conflicts after target creation, leave `XXX` intact. On retry, search first and reuse the newly created target rather than creating another.

## Report the result

State which outcome occurred:

- reused `<WORK-ID>` and connected the source;
- allocated `<WORK-ID>` on the source;
- created `<WORK-ID>` and replaced the relation marker;
- left the marker unchanged because candidates were ambiguous;
- left the marker unchanged because an operation failed.

Include source and target UUIDs when they aid inspection. Never claim a rewrite without the successful optimistic update result.
