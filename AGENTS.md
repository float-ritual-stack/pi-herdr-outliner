# Agent workflow

For AI feature design, semantic judgments, or TypeSafe/Jev integration in this
project, use the installed `typesafe-ai` skill, resolved through the agent's skill
catalog. Follow its live-documentation workflow before choosing primitives or
writing API calls. If the skill is unavailable, start with the
[TypeSafe documentation index](https://docs.typesafe.ai/llms.txt) and read the
relevant current API/SDK and cookbook pages; report unavailable sources rather
than inventing their contracts.

Before planning work, changing roadmap state, or reporting delivery, read the
live **How this workboard works** block
`d5b3e557-a166-4c50-baad-7a0ed8db8fe6` through the Outliner service (`get` RPC).
It owns the working flow; [the roadmap reference](pi-extension/skills/outliner-workflow/references/roadmap-items.md)
documents the operations and metadata. Follow the connection diagnostics below
if the block cannot be read.

Before changing runtime behavior or claiming implementation complete, follow the
[verification requirements](CONTRIBUTING.md#verification), including the
[real-application testing and evidence requirements](docs/IMPLEMENTATION_PLAN.md#execution-and-completion-requirements).

For the reviewed data-safety fixes and Herdr/Pi interaction work, read the
[implementation plan](docs/IMPLEMENTATION_PLAN.md) for dependencies and acceptance
checks. The Outliner workboard owns task status.

When a live Outliner request fails, follow the
[service connection diagnostics](CONTRIBUTING.md#connecting-to-the-running-service)
before declaring the service unavailable or leaving workboard updates pending.

## Skills for agents

ep0ch-door ships the skills agents load for this stack (`ep0ch --skill` lists them, with this repo's
`pi-extension/skills/`): `ep0ch-core` for changing this repo or the door (the architecture and reuse maps,
scratch-only testing, the real-pane recipe, review and deploy), `ep0ch-outline` for working in an outline
for someone, and `ep0ch` for driving a door.

## Two clients, one outline

The service has two clients with different jobs, and both are maintained. Tree, Detail and Preview in
Herdr are the sysop console: find any block and edit it. [ep0ch-door](https://github.com/float-ritual-stack/ep0ch-door)
is the board people use day to day. Don't treat the Herdr UI as legacy or drop its features because the
door covers a case; and when a service capability is added for one client, keep it usable by the other.
