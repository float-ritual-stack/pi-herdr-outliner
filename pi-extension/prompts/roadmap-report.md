---
description: Explain current roadmap state, sequencing, and blockers
argument-hint: "[scope or question] [chat-only]"
---
Use the `outliner-workflow` skill's roadmap review workflow for this request.

Optional scope, question, or explicit chat-only request:

$ARGUMENTS

Produce a current, decision-useful roadmap report that helps an owner quickly remember what the project is set up to do and what should happen next.

1. Resolve the active Outliner task, current selection, project, canonical work queue, and relevant virtual branches before drawing conclusions. If the arguments name a Work ID, track, arc, stage, or question, use that as the report scope; otherwise review the current project.
2. Query canonical roadmap items with block-scoped properties. Do not count historical prose that merely mentions `status`, `priority`, `work-stage`, `track`, or a Work ID. Respect query completeness metadata and label any truncated section instead of presenting it as exhaustive.
3. Summarize the setup rather than reciting every block:
   - project goal, active initiatives, arcs, and tracks;
   - counts by work stage and priority;
   - Doing, Review, and Validate work;
   - the ordered Next lane and why its first items are next;
   - dependency chains, blockers, and dogfood or owner-decision gates;
   - high-priority unprioritized work and metadata inconsistencies worth attention;
   - recently completed capabilities only when they explain the current sequencing.
4. Give a short recommendation section: the next one to three actions, the evidence for that order, and any decision the owner must make. Distinguish repository/runtime evidence from inference.
5. Compose the report as an Outliner-native Detail artifact, not as a chat transcript pasted into a block. Use exact block references for the small set of canonical items worth opening, callouts for decisions/blockers/recommendations, and links or embeds to relevant virtual branches or canonical source when that is more useful than copying a frozen inventory. Keep native affordances semantic and bounded.
6. Never mutate priority, status, work stage, rank, dependencies, or roadmap prose while producing the report. A report is read-only unless the user explicitly asks for a separate mutation after reviewing it.
7. Publish one durable `roadmap-review` by default beneath the narrowest unambiguous existing roadmap/review parent, with focus enabled. Return only a concise chat pointer containing the decisive conclusion and created block ID. If the arguments explicitly include `chat-only`, return the same bounded report in chat without publishing. If no unambiguous project or parent can be established after querying the workspace, do not invent a container; explain the missing scope in chat.

Keep the report bounded and scannable. Put raw query inventories nowhere in authored content; reference the live native source instead.