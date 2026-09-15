---
name: outliner-documentation
description: Manage project documentation in Pi Outliner. Use before the first documentation write in a fresh workspace, and when creating, reorganizing, splitting, referencing, transcluding, or indexing project documentation with properties or virtual branches.
---

# Outliner Documentation

The workspace database owns the current documentation operating guide. This skill is its context pointer, not a duplicate manual.

## Load the canonical guide

1. Call `outliner_query` with block-scoped filter `system-doc=agent-documentation-guide` and `limit: 2`.
2. Require `completeness.kind = complete` and exactly one matching canonical block. A second match is an identity conflict; no match means this is a legacy or intentionally customized workspace.
3. Query the returned guide UUID as `subtreeRootId` with `limit: 100`. Read every section. When `presentation.omitted > 0`, use the guide's rendered section titles to query the omitted children individually under the same subtree.
4. Follow that database guide as the workspace-local authority. Current user instructions and established workspace vocabulary override seeded examples.

Completion: the full guide and every section relevant to the requested documentation mutation have been read before writing.

## Legacy workspace fallback

When the unique system guide is absent, preserve this invariant: physical hierarchy owns canonical prose; exact references connect it; transclusions compose it; block-scoped properties classify it; virtual branches only project it.

Search for existing owners and property vocabulary before creating. Keep each authoritative claim in one canonical block. Use optimistic updates, never mutate a projected occurrence as if it were another copy, and verify query completeness after writing. Do not install or recreate the seed unless the user explicitly requests it.
