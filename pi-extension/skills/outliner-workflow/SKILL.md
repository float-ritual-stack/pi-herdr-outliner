---
name: outliner-workflow
description: This skill should be used when the user asks to "create a roadmap item", "add this to the roadmap", "update PIE-...", "move this to Next", "rank the Next lane", "review the roadmap", "what should we work on next", "walk me through these blocks", "step through the roadmap", "help me prioritize these items", "review this outline with me", "capture this finding", "write this into the outline", "make an Outliner-native artifact", "put this in the Outliner", "prefer the outline over chat", "focus that item", or when producing a durable plan, decision, synthesis, handoff, progress record, or implementation proof in the Pi Outliner workspace.
---

# Outliner Workflow

Treat the Outliner as the primary artifact surface and chat as the conversational control surface. Author durable or structurally useful output directly in the Outliner; do not draft a complete artifact in chat and leave promotion as an optional second pass. Preserve useful workspace knowledge without turning acknowledgements or status chatter into blocks.

## Establish the task

1. Call `outliner_task` with `operation: "status"` before task-oriented work.
2. Start an explicitly named roadmap item with `operation: "start"` and its Work ID, full block ID, or unambiguous title when no task is active.
3. Refuse to silently switch away from an active task. Complete, pause, or explicitly clear it first.
4. Treat the injected active-task context as bounded orientation, not the entire record. Query or focus blocks when more context is required.

Use `pause` to return unfinished work to Next. Use `clear` only to repair session binding without changing roadmap metadata.

## Create and update roadmap work

Read [Roadmap items](references/roadmap-items.md) before creating, editing, promoting, or ranking roadmap work.

1. Search for duplicates and related work before creating a new item.
2. Use `outliner_roadmap_create`; never assemble a roadmap block with `outliner_create` followed by separate Work-ID and metadata mutations.
3. Default new work to `work-stage=unprioritized`. Promote only when the owner explicitly requests it or a governing roadmap decision already records the promotion.
4. Update metadata with `outliner_property_patch` and prose with `outliner_update` using the latest `updatedAt`.
5. Change lane membership through `work-stage`. Change ordering within a lane or track with `outliner_branch_rank`; never physically move canonical items to rank virtual occurrences.
6. Query the item after mutation and verify its canonical parent, required properties, virtual-branch memberships, and explicit rank.

## Navigate before narrating

Call `outliner_focus` before explaining a roadmap item, decision chain, investigation, or durable result that the user should inspect.

- Prefer a full Work ID or block ID.
- Pass `clientId` when several Tree clients are live.
- Follow semantic order: governing task or decision first, supporting findings next, implementation proof last.
- Use the returned bounded ancestors, properties, dependencies, and children to narrate structure.
- Never invent a parallel comment or walkthrough data model.

## Conduct a walkthrough or review

Use this workflow when the user wants to inspect, discuss, prioritize, or review a connected set of blocks:

1. Read the current selection and query only enough bounded structure to identify the relevant arc.
2. Choose a narrative order based on decisions and dependencies rather than storage or query order.
3. State the scope briefly: which blocks are included, why they belong together, and what judgment the walkthrough should produce.
4. Focus the first block before discussing it. Read the full body only for the block currently under discussion.
5. Explain its role, current state, and connection to the preceding and following items. Avoid reciting every property or child.
6. Continue through a small coherent group when no owner decision is required.
7. Stop at an actual judgment boundary with one bounded question. Do not publish a decision or change priority before the owner answers.
8. Resume from the next unresolved block. Re-read selection or query results after any mutation that may have changed the arc.
9. End with the agreed ordering, unresolved questions, and next action. Publish only the durable conclusion, not each walkthrough stop.

Treat Tree focus as the ephemeral shared attention marker. Use durable child blocks only for conclusions, corrections, decisions, follow-ups, or proof. Preserve the existing Now/Next work-in-progress limit and never promote an item silently.

## Choose artifact or chat

Default to an Outliner-native artifact when the output has durable structure or remains useful after the current exchange. This includes plans, roadmap reports and reviews, findings, runtime observations, decisions, rejected alternatives, meaningful progress records, syntheses, handoffs, and implementation or acceptance proof.

Compose the artifact for the Detail surface rather than as pasted chat prose. Use native affordances when they improve comprehension or navigation:

- exact block references and page links for canonical targets;
- callouts for decisions, blockers, warnings, and recommendations;
- transclusion or embeds when showing canonical source is better than copying it;
- virtual-branch references or filters for live collections instead of frozen inventories;
- typed properties for durable query, routing, and lifecycle metadata.

Keep each affordance semantic. Do not add callouts, embeds, or properties as decoration, and do not duplicate large canonical bodies merely to make a report self-contained.

Return only a concise chat pointer after publication: what was created, the decisive conclusion, and the focused block ID or Work ID. Keep transient explanations, acknowledgements, bounded owner questions, live status, speculative fragments, and repeated summaries in chat. Use chat-only output when the user explicitly requests it or when no durable artifact would remain useful.

## Publish durable work

Call `outliner_publish` with the narrowest existing type:

- `field-note` for bounded working observations;
- `finding` for established discoveries;
- `decision` for a chosen direction and its reason;
- `progress` for a meaningful work-state boundary;
- `synthesis` for integrated architecture or investigation results;
- `roadmap-review` for prioritization and sequencing;
- `implementation-proof` for exercised behavior and verification evidence.

Omit `parentId` to publish beneath the active task. Supply an explicit parent when the artifact belongs elsewhere. Keep `focus` enabled when the published block is the useful user-facing result. The tool reports focus failure separately from successful creation; never claim focus when `focused` is false.

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
2. Publish an `implementation-proof` block beneath the active roadmap item.
3. Call `outliner_task` with `operation: "complete"` and the proof block ID.
4. Let the task tool move canonical metadata to complete/done and clear session presence.
5. Leave a concise chat response pointing to the focused durable artifact.

Never infer semantic completion from `agent_end`, `agent_settled`, idle state, or the absence of further tool calls. Completion requires an explicit tool action and linked proof.
