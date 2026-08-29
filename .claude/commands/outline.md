---
description: Reopen or focus the Pi Outliner panes
allowed-tools: Bash(herdr plugin action invoke:*), Bash(herdr plugin log list:*), Bash(herdr pane read:*), Bash(herdr pane list:*)
---

Reopen or focus the Pi Outliner panes in the current Herdr workspace.

Plugin invocation:
!`herdr plugin action invoke open --plugin float.pi-outliner`

Use the invocation's `log_id` to find that exact entry in `herdr plugin log list --plugin float.pi-outliner`. If it is still running, check again. Read the successful log's JSON `stdout`; never guess pane or client IDs.

After the action succeeds:
- If `stdout` contains `outlinerPane` and `detailPane`, verify both with `herdr pane read` and verify `servicePane` with `herdr pane list`.
- If `stdout` contains `focusedClientId`, verify the focused **Outliner** pane with `herdr pane list`.
- Report whether the action opened a new pair or focused one live Tree.

Multiple live Trees are intentionally ambiguous. If the action fails with their client IDs, report the ambiguity instead of choosing one or starting another topology.
