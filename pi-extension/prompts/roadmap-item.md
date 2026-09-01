---
description: Create, update, promote, or rank canonical Outliner roadmap work
argument-hint: "<create|update|promote|rank> <details>"
---
Use the `outliner-workflow` skill's canonical roadmap-item workflow for this request:

$ARGUMENTS

Resolve current workspace state before mutating it. For creation, search for duplicates first and use `outliner_roadmap_create` so the Work ID, canonical parent, metadata, relationships, and branch memberships are committed atomically. Default new work to Unprioritized unless this request explicitly promotes it. For updates, use optimistic property/prose tools. For ordering, use `outliner_branch_rank`; do not physically move canonical blocks or conflate rank with `work-stage`. Verify the resulting item and virtual occurrence state before reporting completion.
