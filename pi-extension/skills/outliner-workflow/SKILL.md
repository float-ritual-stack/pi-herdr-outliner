---
name: outliner-workflow
description: This skill should be used when the user asks to "review the roadmap", "what should we work on next", "walk me through these blocks", "capture this finding", "write this into the outline", "focus that item", or when producing a durable plan, decision, synthesis, handoff, progress record, or implementation proof in the Pi Outliner workspace.
---

# Outliner Workflow

Treat the Outliner as the durable working environment and chat as the conversational surface. Preserve useful workspace knowledge without turning every response into a block.

## Establish the task

1. Call `outliner_task` with `operation: "status"` before task-oriented work.
2. Start an explicitly named roadmap item with `operation: "start"` and its Work ID, full block ID, or unambiguous title when no task is active.
3. Refuse to silently switch away from an active task. Complete, pause, or explicitly clear it first.
4. Treat the injected active-task context as bounded orientation, not the entire record. Query or focus blocks when more context is required.

Use `pause` to return unfinished work to Next. Use `clear` only to repair session binding without changing roadmap metadata.

## Navigate before narrating

Call `outliner_focus` before explaining a roadmap item, decision chain, investigation, or durable result that the user should inspect.

- Prefer a full Work ID or block ID.
- Pass `clientId` when several Tree clients are live.
- Follow semantic order: governing task or decision first, supporting findings next, implementation proof last.
- Use the returned bounded ancestors, properties, dependencies, and children to narrate structure.
- Never invent a parallel comment or walkthrough data model.

## Decide whether to publish

Publish when the output will remain useful after the current exchange or should participate in links, backlinks, queries, metadata, or handoff. Typical durable outputs:

- plans and roadmap reviews;
- findings and runtime observations;
- decisions and rejected alternatives;
- progress records at meaningful boundaries;
- syntheses and handoffs;
- implementation or acceptance proof.

Keep transient explanation, acknowledgements, status chatter, speculative fragments, and repeated summaries in chat. Avoid transcript landfill.

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

Write one coherent artifact rather than many turn-log fragments. Include exact Work IDs and block references where they improve navigation. Leave query results and other generated projections out of authored text.

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
