# Agent workflow

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
