---
name: outliner-workflow
description: This skill should be used when the user asks to "create a roadmap item", "add this to the roadmap", "update PIE-...", "move this to Next", "rank the Next lane", "review the roadmap", "what should we work on next", "walk me through these blocks", "step through the roadmap", "help me prioritize these items", "review this outline with me", "capture this finding", "write this into the outline", "make an Outliner-native artifact", "put this in the Outliner", "prefer the outline over chat", "focus that item", or when producing a durable plan, decision, synthesis, handoff, progress record, or implementation proof in the Pi Outliner workspace.
---

# Outliner Workflow

Treat the Outliner as the primary artifact surface and chat as the conversational control surface. Author durable or structurally useful output directly in the Outliner; do not draft a complete artifact in chat and leave promotion as an optional second pass. Preserve useful workspace knowledge without turning acknowledgements or status chatter into blocks.

## Establish the task

1. Call `outliner_task` with `operation: "status"` before task-oriented work.
2. Start an explicitly named roadmap item with `operation: "start"` and its Work ID, full block ID, or unambiguous title when no task is active. For code delivery, this records and orients the repository, base branch, and Work-ID branch before Doing.
3. Never pair task start and mutation as sibling tool calls. Start, observe the returned delivery identity, then mutate in a later turn.
4. Refuse to silently switch away from an active task. Complete, pause, or explicitly clear it first.
5. Treat the injected active-task context as bounded orientation, not the entire record. Query or focus blocks when more context is required.

Use `pause` to return unfinished work to Next. Use `clear` only to repair session binding without changing roadmap metadata.

## Keep delivery identity exact

1. Use `outliner_delivery status` before PR or merge work.
2. Treat its repository, base branch, and work branch as immutable for that delivery. Reentry must reuse them.
3. Use `outliner_delivery sync` after opening or merging the exact PR. Live Git and GitHub facts are authoritative; never fabricate PR state in Outliner properties.
4. Do not stage, stash, commit, or open a PR through lifecycle automation.
5. If a policy gate must be bypassed, use the single `override` operation with an explicit reason and owner confirmation. An override changes policy only; it does not change observed Git or GitHub facts.

## Create and update roadmap work

Read [Roadmap items](references/roadmap-items.md) before creating, editing, promoting, or ranking roadmap work.

1. Search for duplicates and related work before creating a new item.
2. Use `outliner_roadmap_create`; never assemble a roadmap block with `outliner_create` followed by separate Work-ID and metadata mutations.
3. Default new work to `work-stage=unprioritized`. Promote only when the owner explicitly requests it or a governing roadmap decision already records the promotion.
4. Update metadata with `outliner_property_patch` and prose with `outliner_update` using the latest `updatedAt`.
5. Change lane membership through `work-stage`. Change ordering within a lane or track with `outliner_branch_rank`; never physically move canonical items to rank virtual occurrences.
6. Query the item after mutation and verify its canonical parent, required properties, virtual-branch memberships, and explicit rank.

## Inspect before narrating

Use `outliner_selection` and `outliner_query` to inspect roadmap items, decision chains, investigations, and durable results without changing the user's visible Herdr tab. Call `outliner_focus` only when the user explicitly asks to switch the visible Tree context.

- Prefer a full Work ID or block ID when querying.
- Pass `clientId` when explicit focus is requested and several Tree clients are live.
- Follow semantic order: governing task or decision first, supporting findings next, implementation proof last.
- Narrate from bounded ancestors, properties, dependencies, and children.
- Use the typed `outliner_workflow` route; never invent a second comment model, copy source bodies, or persist a block per walkthrough step.

## Conduct a walkthrough or review

Use this workflow when the user wants to inspect, discuss, prioritize, or review
a connected set of blocks:

1. Start `outliner_workflow` with the explicit `walkthrough.plan` action
   surface: a block, callout, bounded structured query, or literal
   `walkthrough` command; an explicit capability allowlist; fan-out and call
   ceilings; and `callscript` unless the user specifically requests the direct
   baseline.
2. Supply a live Detail `clientId` only when the user asks for shared visual
   attention. The returned run stores its ordered source anchors and comparison
   metrics without storing source bodies or narration.
3. Use one `transition` at a time. `next`, `previous`, `resume`, and `skip`
   reveal the exact current source anchor through ephemeral PIE-180 attention;
   `pause` suspends in place; `branch` records one bounded question; `end`
   clears current attention.
4. Discuss the current passage in chat. Read the full body only when the
   current judgment needs it. Do not recite every property or child.
5. Put source-situated owner questions and replies in existing PIE-210
   annotations. Preserve owner comments and lifecycle; never convert silence,
   model narration, or a branch question into a decision.
6. Promote an agreed outcome only with `promotion_preview`, show or otherwise
   obtain approval for that exact text and provenance, then call
   `promotion_commit` with its unchanged approval token. A changed approver,
   target, kind, or text requires a new preview.
7. End with the agreed ordering, unresolved questions, and next action.
   Publish only durable conclusions; the run and result properties provide
   query/embed links without copying canonical sources.

Treat Tree focus as an explicit foreground action: it switches the user's active
Herdr pane. Background agent work must query, publish, reveal, read, or send to
explicit panes without focusing them. Preserve the existing Now/Next
work-in-progress limit and never promote an item silently.

## Choose artifact or chat

Default to an Outliner-native artifact when the output has durable structure or remains useful after the current exchange. This includes plans, roadmap reports and reviews, findings, runtime observations, decisions, rejected alternatives, meaningful progress records, syntheses, handoffs, and implementation or acceptance proof.

Compose the artifact for the Detail surface rather than as pasted chat prose. Use native affordances when they improve comprehension or navigation:

- exact block references and page links for canonical targets;
- callouts for decisions, blockers, warnings, and recommendations;
- transclusion or embeds when showing canonical source is better than copying it;
- virtual-branch references or filters for live collections instead of frozen inventories;
- typed properties for durable query, routing, and lifecycle metadata.

Keep each affordance semantic. Do not add callouts, embeds, or properties as decoration, and do not duplicate large canonical bodies merely to make a report self-contained.

Return only a concise chat pointer after publication: what was created, the decisive conclusion, and the block ID or Work ID. Keep transient explanations, acknowledgements, bounded owner questions, live status, speculative fragments, and repeated summaries in chat. Use chat-only output when the user explicitly requests it or when no durable artifact would remain useful.

## Publish durable work

Call `outliner_publish` with the narrowest existing type:

- `field-note` for bounded working observations;
- `finding` for established discoveries;
- `decision` for a chosen direction and its reason;
- `progress` for a meaningful work-state boundary;
- `synthesis` for integrated architecture or investigation results;
- `roadmap-review` for prioritization and sequencing;
- `implementation-proof` for exercised behavior and verification evidence.

Omit `parentId` to publish beneath the active task. Supply an explicit parent when the artifact belongs elsewhere. Publication does not focus by default; pass `focus: true` only when the user explicitly asks to switch the visible Tree context. The tool reports focus failure separately from successful creation; never claim focus when `focused` is false.

Write one coherent artifact rather than many turn-log fragments. Include exact Work IDs and block references where they improve navigation. Leave raw query results and other generated projections out of authored text; link or embed the live native source instead.

## Record work while proceeding

Publish only at durable boundaries:

1. Record a finding after evidence changes the implementation direction.
2. Record a decision after selecting among materially different options.
3. Record progress when handing off, pausing, or crossing a meaningful phase boundary.
4. Record implementation proof only after exercising the changed behavior.

Do not publish raw chain-of-thought, tentative guesses, repetitive tool output, or every file edit.

## Complete safely

1. Exercise the changed behavior.
2. Synchronize an active delivery through Review to Validate after its exact PR merges.
3. Publish an `implementation-proof` block beneath the active roadmap item.
4. Call `outliner_task` with `operation: "complete"` and the proof block ID.
5. Let the task tool require merged delivery facts when present, move canonical metadata to complete/done, and clear session presence.
6. Leave a concise chat response pointing to the focused durable artifact.

Never infer semantic completion from `agent_end`, `agent_settled`, idle state, or the absence of further tool calls. Completion requires an explicit tool action and linked proof.
