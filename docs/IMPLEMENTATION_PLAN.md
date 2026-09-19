# Data safety and Herdr/Pi implementation plan

Proposed sequence and acceptance criteria, prepared 2026-09-18. No runtime fixes
or harness extensions are implemented by this document. The Outliner workboard
remains authoritative for owners, Work IDs, branches, PRs, and task status; this
document records the design dependencies and required evidence for this work.

## Outcome

Protect saved text and running work first. Correct application identity and
navigation next. Then test one outliner-owned Tree/Detail surface while keeping
independently useful Herdr views. Use the existing real-application harness to
prove changed behavior before declaring a work package complete.

| Owner | Responsibilities |
| --- | --- |
| Outliner service | Canonical data, revisions, write validation, resource access, persistence, and workspace ownership. |
| Outliner interface | Navigation intent, primary reader, internal keyboard focus, layout, and each view's selection, history, scroll, and drafts. |
| Pi | Terminal input/drawing, component composition, scrolling primitives, overlays, and terminal lifecycle support. |
| Herdr | Host terminal processes, workspaces/tabs/panes, external placement and focus, plugin invocations, independently useful popups, and agent lifecycle observations. |

Closing a view releases that view's state and resources; deleting canonical data
remains a separate explicit operation. Detached references, independent editors,
views beside agents, and persistent activity displays remain valid Herdr uses.

## Delivery order and dependencies

Each identifier below names a work package in this plan, not a new roadmap ID.
Use a focused branch per invariant; groups describe priority, not one large PR.

| Order | Package | Impact | Dependency |
| --- | --- | --- | --- |
| Immediate | S1: own the workspace before writable startup | BLOCKER: a second launch can invalidate live work. | Existing harness plus a bounded second-process fixture. |
| Immediate | S2: bind capture receipts to submissions | BLOCKER: a retry can discard newly typed text. | S1 before deploying any required receipt migration; attached-client support for popup proof. |
| Next | S3: enforce block edit revisions | BAD DESIGN: silent stale writes and common false conflicts. | S1 before migration; one coordinated protocol/caller cutover. |
| Next | S4: identify file contents in revisions | BUG: equal size/time can conceal changed bytes. | Focused file-write contract test and live Detail save path. |
| Next | S5: make file reads service-owned | BAD DESIGN: preview routes can read different hosts' bytes. | Preserve passive-read semantics and explicit resource creation. |
| Alongside safety work | I1: observers are not destinations | BUG: navigator subscriptions advertise a false Detail identity. | Narrow subscription change; attached-client popup proof. |
| Alongside safety work | I2: chooser destination outcomes | BUG: missing eligible readers do not consistently trigger the offered split action. | Typed routing result and all chooser callers updated. |
| Alongside safety work | I3: Pi focus-loss handling | BUG: consumed focus loss can leave selection autoscroll active. | Focused terminal test plus attached-client input proof. |
| Before host cleanup | I4: authoritative host projection | FRAGILE: event ordering can leave stale pane state. | Verify supported-version event behavior; fix refresh before deleting subscriptions. |
| Before composed-view targeting | I5: explicit agent source view | FRAGILE: shared focus history cannot identify a particular attached client's intent. | Bounded two-client reproduction and source-view contract. |
| After routing contract is clear | A1: primary reader ownership | BAD DESIGN: host geometry decides ordinary navigation destinations. | I1; reuse I2's explicit destination outcomes. |
| Experiment | A2: one Tree/Detail surface | Test whether coordination can actually disappear. | A1; bounded rendering; explicit internal focus and resource retention. |
| After experiment passes | A3: remove replaced coordination | Delete demonstrated redundancy while preserving detached behavior. | A2 acceptance evidence and affected callers migrated. |

Safety work and small interaction fixes can proceed independently. A layout
rewrite is not a dependency of S1-S5. A2 can be prototyped before all fixes land,
but shipping its editing/capture behavior requires the relevant safety fixes.

Hard dependencies:

- Exclusive workspace ownership precedes writable open, recovery, and migrations.
- Host snapshot refresh must work independently before unused agent-status
  subscriptions and their extra discovery snapshot are removed.
- Primary-destination semantics precede deleting primary pane routing.
- Internal focus, displayed Detail target, and pinned-resource retention must be
  represented separately before agents use a composed surface.
- Capture receipt correctness precedes shipping an embedded capture replacement.

## Start with the existing harness

Read [the current harness instructions](../README.md#real-herdr-keyboard-e2e),
[the runner](../test/e2e/herdr-runner.ts), and
[the resource journey](../test/e2e/resource-authoring.ts).

The existing runnable baseline is:

```sh
bun run test:e2e:herdr
```

On the reviewed clean baseline, commit
`71f01b72f6ff9a7837627ce3460c7dd0d54692f3`, this command passed on Linux with Herdr
0.9.1/protocol 22 and locked Pi 0.84.2. Retained visible output and read-only
database assertions showed one canonical Resource on first and repeated
activation. This baseline proves the existing journey, not the outstanding fixes.

The runner already provides:

- A private named Herdr server, isolated XDG directories, project, Outliner state,
  and keymap; the private plugin registry links the tested checkout.
- Actual service, Tree, and Detail processes with verified provenance.
- `focus`, `keys`, `text`, `visible`, `waitVisible`, bounded `waitFor`,
  `registrations`, `checkpoint`, and `record` operations.
- A read-only SQLite connection and consistent checkpoint copies.
- Terminal text/ANSI, topology, registrations, invocation logs, process evidence,
  and cleanup of owned processes on success, failure, and interruption.

Its current limits are material: fixed launcher/service/Tree/Detail pane roles;
one project/service; no attached Herdr client; no popup input/capture; no real
mouse or resize journey. A passing existing scenario does not cover those paths.

`startup-interruption.ts` deliberately expects its inner fixture to fail after
SIGINT and then verifies cleanup. Its outer test reports success. Distinguish
expected injected failure from failed scenario verification when reading artifacts.

### Add capabilities only when a scenario requires them

| First consumer | Small extension | Required proof |
| --- | --- | --- |
| S1 | Launch and track one additional service process against the private workspace; hold a real async operation at a deterministic barrier. | Rejected second startup changes no live operation state; cleanup leaves no owned survivor. |
| S2 / I1 | Attach a real Herdr client through an owned PTY; send modal input through that client and retain its output. | Open, operate, and close the actual popup. A popup has no pane ID: sending keys to the underlying pane is not popup proof. |
| S3 / A1 / I4 | Open, move, resize, and close additional owned views using supported Herdr operations; record returned identities. | Track the moved terminal and current pane ID; actions stay within the private server. |
| S5 | Give client and service different fixture roots with the same relative filename. | Both UI routes display service-owned bytes; describe this as simulated remote ownership unless SSH is also exercised. |
| I3 / A2 | Add attached-client mouse/focus input and PTY resize evidence. | Input reaches the real host/application path; capture resized frames and resulting state. |
| I5 | Attach two controlled clients to the private Herdr server. | Record both client actions and the context selected for each explicit source. |
| A2 | Support one narrowly defined composed launch alongside the existing detached launch. | One host pane may contain two logical views; fixtures no longer require distinct Tree and Detail pane IDs for that case. |

Keep process ownership, timeouts, transport, and artifact capture in the runner.
Keep domain actions and SQL assertions in each scenario. This is not a new test
framework, universal view registry, or unrestricted shell-command interface.

Final provenance should identify the tested revision and source state. Existing
artifacts record HEAD and dirty filenames. Prefer a stable clean commit for final
proof; if a dirty tree is tested, retain its diff and relevant untracked-file
hashes as evidence. Do not edit the tested checkout while its application runs.
Record tool/dependency versions where the behavior depends on them.

## Safety packages

The S1 scenario `test/e2e/workspace-ownership.ts` is implemented. The remaining
new scenario filenames below are planned files, not commands that exist today.
Each defect needs a focused regression that fails before its fix, plus evidence
from the real service or UI path appropriate to the claim.

### S1 — exclusive workspace ownership (F2)

Change `src/server-main.ts`, service startup, and constructor recovery ordering.
Acquire exclusive ownership for the canonical workspace/database identity before
opening writable SQLite, running migrations, or recovering work. A preliminary
ping does not establish ownership. Release only ownership acquired by this process.

Implemented scenario: `test/e2e/workspace-ownership.ts`. Keep an operation in flight,
launch a second actual service against the same fixture, verify rejection without
state changes, and let the original operation finish. Cover computed, web, and
remote-entity recovery with focused variants. Also exercise legitimate recovery
after an owned process dies. Preserve an old-schema fixture for later migration checks.

Complete when the second launch cannot mutate the first service's work, and a
subsequent legitimate owner can recover interrupted work.

### S2 — exact capture acknowledgement (F1)

Change `src/capture-popup.ts`, capture persistence/receipts, and all capture
callers needed for the contract. Bind each request ID to its submitted payload;
an uncertain submission retains both. Acknowledgement permits clearing only the
acknowledged draft revision. Blindly assigning a fresh request ID after an
uncertain commit can duplicate a capture and is not the fix.

Proposed scenario: `test/e2e/capture-retry.ts`. In a real popup, commit a capture,
fail draft cleanup, type more, and retry. The added bytes remain durably
recoverable. Separately lose the committed reply and retry the original payload;
one capture exists across retry/restart. Inject faults at an existing transport
or operation seam in the private fixture, and record exactly what failed; keep
production behavior free of test-only switches.

Complete when no retry clears unacknowledged text and same-payload retry remains
idempotent. Confirm closing/reopening preserves the recovery policy and leaves
ordinary Tree navigation unchanged.

### S3 — one block editing contract (F3/F5)

Change `src/store.ts`, request types, server dispatch, CLI, Tree/Detail, and agent
callers together. Introduce an authoritative edit revision with atomic
compare-and-update. Normal writes require the original revision. Define lifecycle
validation explicitly; unrelated position changes do not invalidate text drafts.
Keep display timestamps separate. Update incompatible protocol versions and all
callers in the same cutover; an optional old-token bypass preserves the defect.

Proposed scenario: `test/e2e/edit-conflicts.ts`. Hold a real Detail draft while a
second client changes the block; a stale UI/CLI save must fail and preserve both
the newer stored content and recoverable draft. A sibling reorder must allow an
unchanged-content draft to save. Use a focused frozen/backwards-clock regression
for version reuse. Run migration twice on a copied old-schema fixture and verify
canonical text, identities, and timestamps are preserved.

Complete when every normal writer enforces the same contract and each of those
distinct stale-write/reorder invariants is covered.

### S4 — file revision identity and the separate write race (F6)

Change `src/resources.ts` revision normalization/comparison and
`src/resource-catalog.ts` filesystem read/write handling. Include the existing
content hash consistently in authoritative revisions, including pinned reads.

Proposed scenario: `test/e2e/file-revisions.ts`. Open a real Detail edit, replace
the file externally with same-sized bytes and restored modification time, then
save. Reject the stale save, retain the draft, and preserve the external bytes.

Investigate the separate validation-to-rename gap with a controlled external
writer. A hash comparison does not close that interval; a service-local lock
does not constrain an external editor. Record the supported writer/recovery
contract and the bounded reproduction before choosing a permanent fix. Track it
separately if the revision change lands first; do not claim all file-write races
are solved by that change.

### S5 — one file-reading authority (F4)

Remove service-owned reference reads from client-local filesystem paths in
`src/outliner.ts` and `src/detail-pi.ts` (and any remaining supported renderer).
Use service reads for both embedded and detached presentation; keep line ranges
and rendering local. Passive previews must remain passive, without silently
interning a Resource or refreshing its provider.

Proposed scenario: `test/e2e/file-authority.ts`. Give client and service different
bytes at the same relative path. Follow each supported preview/open route and
verify service-owned content; verify passive reads leave catalog identities and
counts unchanged. Retain the existing resource-authoring journey.

## Interaction packages

Land these as separate focused fixes; they do not require A2.

| Package and files | Change | Focused application proof |
| --- | --- | --- |
| I1: `src/client.ts`, `src/types.ts`, `src/server.ts`, `src/virtual-branch-navigator-main.ts` | Permit event observation without registering a routable Tree/Detail. Delete the navigator's false Detail identity and pane lookup. | `navigator-observer.ts`: open the real popup; content refresh works while destination registrations and agent source context stay unchanged. |
| I2: `src/navigation-routes.ts`, `src/server.ts`, `src/detail-controller.ts`, popup chooser callers | Represent no eligible destination explicitly; preserve genuine target/topology failures. Migrate every caller that matches the old error string. | `destination-chooser.ts`: with no eligible other reader, the offered split operation opens one; invalid targets still report failure. |
| I3: `src/detail-pi.ts`, `src/detail-pi-input.ts` | Let Pi receive focus loss needed to stop selection/autoscroll. | `detail-focus-loss.ts`: start edge-drag autoscroll, move focus through an attached client, and verify scrolling stops without losing selection. Keep a focused terminal regression. |
| I4: `src/herdr-runtime.ts`, `src/herdr-registry.ts`, `src/client-runtime-sync.ts` | Make host projection authoritative across bootstrap, move/close, and reconnect. Fix refresh independently of agent-status subscriptions before removing unused subscriptions. | `host-topology.ts`: record actual event delivery, move/close a view, and compare final projection with a fresh snapshot. Disconnect/reconnect; discovery recovers without inventing a replacement destination. |
| I5: `pi-extension/index.ts`, client identity/targeting | Use explicit application source identity where precision is required; recent server-wide focus remains a heuristic. Keep application view identity separate from host pane location. | `agent-view-context.ts`: another attached client's focus change cannot redirect a prompt/action explicitly bound to the first client's view. Record unsupported ambiguous behavior honestly. |

Two evidence limitations guide these fixes. The installed Herdr 0.9.1 CLI was
observed sending `pane.current` with no caller ID when `--current` had no
`HERDR_PANE_ID`, contrary to the pasted CLI reference. The supplied upstream
dispatcher and local reducer reproduced event-order divergence, but the live
installed server's delivery still needs verification. Check contracts against
the binary/schema used by each run.

The user's nested-terminal screenshot shows "Herdr pane discovery is unavailable".
That is an observed symptom, not a diagnosis. Reproduce it in an isolated attached
session and record socket/binary identity, registry readiness, registrations,
reconnect events, and the surrounding terminal arrangement. Claim a nesting
regression only after the layer responsible is demonstrated. The current chat's
live Herdr session is not a disposable fixture.

## Application surface experiment and deletion

### A1 — ordinary navigation owns a primary reader

Change the policy around `src/server.ts`'s `detailPool` and explicit navigation
destinations. Ordinary opens target the application's designated reader rather
than whichever unlocked pane sorts first by geometry. Detached readers remain
explicit destinations with independent history, locks, and drafts. Closing a
primary reader produces an explicit outcome, not silent adoption of a neighbor.

Proposed scenario: `test/e2e/primary-detail.ts`. Create two browsing contexts and
a detached reader, move the detached pane, and verify ordinary opens stay with
their designated reader. A locked draft survives preview/open attempts. Keep this
policy change small enough to survive or disappear cleanly in A2.

### A2 — one fixed Tree/Detail surface

Use `createTreeController`, `createDetailController`, the existing document
buffer, and one Pi `ProcessTerminal`/`TuiAltScreen`. Start with one fixed split,
one local chooser, and one detach action. Available Pi composition includes
`HStack`, `VStack`, `ScrollView`, and overlays; the application chooses the layout.

Make `src/tree-renderer.ts` render allocated rows without whole-terminal clear
commands. Give Detail allocated dimensions and translate input/source coordinates.
Keep the same service operations for reads, saves, resources, and validation;
embedded navigation uses local controller calls while detached delivery uses the
existing explicit client protocol.

Extend the existing registration model narrowly for a composed surface. Internal
focus is separate from the displayed Detail target and its retained resource
revision (`src/server.ts` currently derives these roots from Detail registrations).
Two registrations claiming one pane and competing in a pane-keyed map are not a
valid substitute. Tree and Detail retain independent history, selection, and scroll.

Proposed scenario: `test/e2e/composed-surface.ts`. Select, open, edit, undo/redo,
save/cancel, and return to Tree with selection/scroll intact. Open a detached
reference, move and close it, and verify the primary target and stored data remain
intact. Verify internal agent targeting, pinned-resource retention, copy/comment
source positions, narrow/wide resize, and dirty-draft close behavior. Interrupt
host discovery while the outliner service remains healthy: ordinary internal
navigation must continue without host discovery or cross-process UI routing.

Go forward only if this removes primary coordination while preserving those
behaviors. Retain the existing document editor unless an alternative proves its
selection, undo/redo, grapheme, source-position, scrolling, and save contracts.

### A3 — deletion after proof

| Location | Delete for the ordinary composed interaction | Retain for independent views |
| --- | --- | --- |
| `src/herdr-open.ts` | Paired primary launch, dual view readiness, and the focus dance. | Service readiness, independent launch, and explicit external focus. |
| `src/outliner.ts`, `src/detail-pi.ts`, `src/client-runtime-sync.ts` callers | Duplicate primary terminal lifecycle and runtime subscriptions. | Detached entrypoints and necessary host-location updates. |
| `src/navigation-routes.ts` and server routing callers | Primary pane discovery and cross-process preview/focus delivery. | Explicit detached routing and application state publication needed by agents. |
| `src/backlink-peek-main.ts`, popup launch/return callers | Parent-bound subprocess and context plumbing after all relevant callers migrate. | Backlink queries and presentation behavior. |
| `src/detail-pi-input.ts` | Duplicate stream framing/timer only after proving Pi's actual callback contract. | Application key semantics and document editing behavior. |

Keep capture as a Herdr popup if session-wide invocation earns that separate
lifetime; otherwise embed it after S2. Preserve independent editors where handing
the terminal to `$EDITOR` would otherwise suspend the whole composed surface.
Do not expand this experiment into a docking framework or migrate every screen.

Useful upstream requests are ordered events with a defined snapshot cut,
consistent `--current` semantics/documentation, and documented Pi input-listener
priority. They may remove local workarounds; immediate safety fixes do not wait
for them. `layout.apply` replaces live terminals, and plugin startup hooks do not
supervise the outliner service; neither is a shortcut for this plan.

## Execution and completion requirements

Use the existing [contribution verification rules](../CONTRIBUTING.md#verification).
For each work package in this plan:

1. Recheck the defect on the current branch. Record what is observed, inferred,
   and still unknown; update the workboard rather than cloning task status here.
2. Define one invariant and a focused failing regression for each real defect.
   Identify the corresponding real-service/UI journey and any missing harness control.
3. Implement the smallest permanent fix, migrating all affected callers and
   removing superseded paths. Keep harness extensions bounded to the scenario.
4. Run focused regressions while iterating. Once stable, run `bun run check`,
   `bun test`, the existing Herdr baseline, and the package's application scenario.
5. Inspect the retained frames/ANSI and assertions at initial, failure, recovery,
   and final checkpoints. A pass line alone is not evidence that the correct
   checkout, pane, target, or failure path was exercised.
6. Record exact tested source state, commands, versions, artifact locations,
   changed behavior, cleanup outcome, and remaining coverage limits in the PR/proof.
   Re-run affected checks after changes or conflict resolution. Verify the integrated
   main checkout in a fresh private fixture after merge before claiming delivery.

Drive the UI through real input for UI claims. Use production CLI/RPC entrypoints
for service/CLI claims. SQLite connections are read-only oracles and backup
sources, not a way to pre-complete the operation supposedly tested through the UI.
Synchronize on visible/state conditions and explicit fault barriers, not arbitrary
sleeps. Retain failing artifacts and distinguish product, harness, and environment
failures. A retry does not erase an unexplained failure.

Until a missing host interaction is automated, an attached private-session run
with recorded actions and output can supply that portion of the evidence. If it
cannot be exercised, report "implemented; application verification pending" and
the missing capability rather than claiming the feature complete. A headless pane
read does not establish popup, host mouse, resize, or multi-client correctness.

Use private named sessions and fixture roots even when the coding agent itself
runs inside Herdr. Verify socket/session provenance before control operations.
Shared user panes and databases require a separately authorized live acceptance
run. Keep runtime databases, logs, and screenshots out of commits.

Suggested proof fields:

```text
Invariant / changed user behavior:
Tested commit and dirty-tree evidence:
Herdr / Pi / Bun versions and application protocol:
Focused regression (including observed pre-fix failure):
Static check / full suite:
Actual application scenario and actions:
Artifact directory and inspected checkpoints:
Persisted-state assertions / cleanup outcome:
Unverified behavior and blocking reason:
Merged-main verification (when claiming delivered):
```

The root [AGENTS.md](../AGENTS.md) directs implementation agents to these
verification requirements. The work packages remain proposed; adding this
instruction does not complete any runtime fixes or harness extensions.
