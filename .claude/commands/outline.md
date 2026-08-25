---
description: Reopen or focus the Pi Outliner panes
allowed-tools: Bash(herdr plugin action invoke:*), Bash(herdr plugin log list:*), Bash(herdr pane read:*), Bash(herdr pane list:*)
---

Reopen or focus the Pi Outliner panes in the current Herdr workspace.

Plugin invocation:
!`herdr plugin action invoke open --plugin float.pi-outliner`

Use the invocation's `log_id` to find that exact entry in `herdr plugin log list --plugin float.pi-outliner`. If it is still running, check again. Read the service, Tree, and Detail pane IDs from the successful log's JSON `stdout`; never guess IDs or create replacement panes manually.

After the action succeeds:
- Verify the returned Tree and Detail panes with `herdr pane read`.
- Verify the returned service pane exists with `herdr pane list`.
- Report the three pane IDs and whether the action reopened or focused existing panes.

If the action fails, report its `stderr` and fix only an actionable project-local cause. Do not start a second topology.
