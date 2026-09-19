# Data safety, remote performance, and Herdr/Pi implementation plan

Sequence and acceptance criteria, reconciled 2026-09-19 against merged code and
the live workboard. The Outliner workboard is authoritative for ownership, Work
IDs, branches, PRs, and task status. This document records design dependencies and required evidence;
editing it does not implement or complete a package.

## Outcome

Protect saved text and running work first. Correct application identity and
navigation, and finish measured remote-read improvements. Test one
outliner-owned Tree/Detail surface while keeping independently useful Herdr
views. Use the existing real-application harness to prove changed behavior before
declaring a work package complete.

| Owner | Responsibilities |
| --- | --- |
| Outliner service | Canonical data, revisions, write validation, resource access, persistence, and workspace ownership. |
| Outliner interface | Navigation intent, primary reader, internal keyboard focus, layout, and each view's selection, history, scroll, and drafts. |
| Pi | Terminal input/drawing, component composition, scrolling primitives, overlays, and terminal lifecycle support. |
| Herdr | Host terminal processes, workspaces/tabs/panes, external placement and focus, plugin invocations, independently useful popups, and agent lifecycle observations. |

Closing a view releases that view's state and resources; deleting canonical data
remains a separate explicit operation. Detached references, independent editors,
views beside agents, and persistent activity displays remain valid Herdr uses.

## Reuse the shipped baseline

- PIE-268, [PR #115](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/115):
  remote clients and nonblocking Tree selection publication.
- PIE-270, [PR #116](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/116):
  project-scoped endpoints, a disposable 32-target Detail block cache, and
  latest-wins passive previews. PRs #117/#118 fix remote startup and simplify
  scheduling. The cache shipped without PIE-269's proposed compact Tree index.
- S1 / PIE-275, [PR #119](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/119):
  exclusive writable-store ownership and its real-service regression.
- S2 / PIE-276, [PR #120](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/120):
  payload-bound capture receipts, uncertain-submission recovery, and real popup proof.

Preserve these behaviors. PIE-270 does not establish progressive cold loading,
Tree body caching, Resource caching, or structural conflict protection for all
mutations. Its old `tree.index` prerequisite and blanket structural-revision
claim are removed from the completed scope. S3 owns the mutation-contract audit;
PIE-269 and PIE-271 own the remaining Tree and Detail read work.

## Delivery order and dependencies

S/I/A labels identify packages in this plan; PIE identifiers name canonical
workboard records. Use a focused branch per invariant; groups describe priority,
not one large PR.

| Order | Package | Impact | Dependency |
| --- | --- | --- | --- |
| Shipped foundation | S1 / PIE-275: own the workspace before writable startup | BLOCKER addressed: a second launch could invalidate live work. | Preserve the ownership and recovery regressions. |
| Shipped foundation | S2 / PIE-276: bind capture receipts to submissions | BLOCKER addressed: a retry could discard newly typed text. | S1 before deploying any required receipt migration; attached-client support for popup proof. |
| After S2 in the queue | S3 / PIE-277: enforce block edit revisions | BAD DESIGN: silent stale writes and common false conflicts. | S1 before migration; one coordinated protocol/caller cutover. |
| After S3 in the queue | S4 / PIE-278: identify file contents in revisions | BUG: equal size/time can conceal changed bytes. | Focused file-write contract test and live Detail save path. |
| After S4 in the queue | S5 / PIE-279: make file reads service-owned | BAD DESIGN: preview routes can read different hosts' bytes. | Preserve passive-read semantics and explicit resource creation. |
| Alongside safety work | I1: observers are not destinations | BUG: navigator subscriptions advertise a false Detail identity. | Narrow subscription change; attached-client popup proof. |
| Alongside safety work | I2: chooser destination outcomes | BUG: missing eligible readers do not consistently trigger the offered split action. | Typed routing result and all chooser callers updated. |
| Alongside safety work | I3: Pi focus-loss handling | BUG: consumed focus loss can leave selection autoscroll active. | Focused terminal test plus attached-client input proof. |
| Before host cleanup | I4: authoritative host projection | FRAGILE: event ordering can leave stale pane state. | Verify supported-version event behavior; fix refresh before deleting subscriptions. |
| Before composed-view targeting | I5: explicit agent source view | FRAGILE: shared focus history cannot identify a particular attached client's intent. | Bounded two-client reproduction and source-view contract. |
| After safety work | PIE-269: compact Tree index | Remove duplicate full-body transfer on Tree loads. | Reuse S3's body revision contract; no dependency on PIE-271 or A2. |
| After safety work | PIE-271: progressive Detail loading | Paint an uncached primary document before optional enrichment. | Preserve S3-S5 contracts and the existing cache; no compact-index or backlink-index prerequisite. |
| Measurement gate after PIE-271 | PIE-272: assess backlink indexing | Remove full-graph backlink cost only if it remains material. | Profile the changed Detail path before choosing an index. |
| Measurement gate after PIE-269 | PIE-273: assess server windows | Establish whether compact complete snapshots remain too expensive. | Compact-index measurements; no cache-delivery prerequisite. |
| After routing contract is clear | A1: primary reader ownership | BAD DESIGN: host geometry decides ordinary navigation destinations. | I1; reuse I2's explicit destination outcomes. |
| Experiment | A2: one Tree/Detail surface | Test whether coordination can actually disappear. | A1; bounded rendering; explicit internal focus and resource retention. |
| After experiment passes | A3: remove replaced coordination | Delete demonstrated redundancy while preserving detached behavior. | A2 acceptance evidence and affected callers migrated. |

Safety work and small interaction fixes can proceed independently. A layout
rewrite is not a dependency of S1-S5. A2 can be prototyped before all fixes land,
but shipping its editing/capture behavior requires the relevant safety fixes.

The safety delivery sequence is S2, S3, S4, S5; consult the workboard for current
queue status. This is delivery priority, not a claim that S4 technically depends
on S3 or S3 on S2. PIE-269 and PIE-271 remain
planned after safety work; prefer PIE-269 first for cold Tree transfer cost, but
their implementations are independent. Neither performance work nor A2 blocks
the safety fixes. A2's bounded layout experiment does not require either read
optimization. PIE-272 and PIE-273 may close with evidence that no new machinery
is needed.

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
bun run test:e2e:ownership
```

On clean merged main `ae2ee326dff9610923be962de6a56e64b2a33e5e`, both commands
passed on Linux with Herdr 0.9.1/protocol 22 and locked Pi 0.84.2. Retained visible
output and read-only database assertions showed one canonical Resource on first
and repeated activation, and an unchanged live refresh after competing service
startup was rejected. PIE-275's proof owns the detailed evidence. These journeys
do not prove the outstanding fixes.

The runner already provides:

- A private named Herdr server, isolated XDG directories, project, Outliner state,
  and keymap; the private plugin registry links the tested checkout.
- Actual service, Tree, and Detail processes with verified provenance.
- `focus`, `keys`, `text`, `visible`, `waitVisible`, bounded `waitFor`,
  `registrations`, `checkpoint`, and `record` operations.
- A production client for the private service and a bounded
  `rejectCompetingService` operation against that same workspace.
- One owned PTY-attached Herdr client for popup input, with raw ANSI and current-screen checkpoints decoded by test-only `@xterm/headless`.
- A read-only SQLite connection and consistent checkpoint copies.
- Terminal text/ANSI, topology, registrations, invocation logs, process evidence,
  and cleanup of owned processes on success, failure, and interruption.

Its current limits are material: fixed launcher/service/Tree/Detail pane roles;
one project/canonical service with a bounded startup contender; one attached
Herdr client and capture-popup launch; no second attached client or real mouse/resize journey. A passing
existing scenario does not cover those paths.

`startup-interruption.ts` deliberately expects its inner fixture to fail after
SIGINT and then verifies cleanup. Its outer test reports success. Distinguish
expected injected failure from failed scenario verification when reading artifacts.

### Add capabilities only when a scenario requires them

| First consumer | Small extension | Required proof |
| --- | --- | --- |
| S1 (implemented) | Launch and track one additional service process against the private workspace; hold a real async operation at a deterministic barrier. | Rejected second startup changes no live operation state; cleanup leaves no owned survivor. |
| S2 (implemented; reusable by I1) | Attach a real Herdr client through an owned PTY; send modal input through that client and retain its output. | Open, operate, and close the actual popup. A popup has no pane ID: sending keys to the underlying pane is not popup proof. |
| S3 / A1 / I4 | Open, move, resize, and close additional owned views using supported Herdr operations; record returned identities. | Track the moved terminal and current pane ID; actions stay within the private server. |
| S5 | Give client and service different fixture roots with the same relative filename. | Both UI routes display service-owned bytes; describe this as simulated remote ownership unless SSH is also exercised. |
| I3 / A2 | Add attached-client mouse/focus input and PTY resize evidence. | Input reaches the real host/application path; capture resized frames and resulting state. |
| I5 | Attach two controlled clients to the private Herdr server. | Record both client actions and the context selected for each explicit source. |
| A2 | Support one narrowly defined composed launch alongside the existing detached launch. | One host pane may contain two logical views; fixtures no longer require distinct Tree and Detail pane IDs for that case. |
| PIE-269 / PIE-271 | Add bounded request-byte/timing capture and deterministic response barriers at the existing read seam; use a private forwarded socket for transport measurements. | Keyboard-driven cold/revisit navigation, reordered replies, exact final targets, and bounded reads. Report actual two-host evidence separately from a local forwarding fixture. |

Keep process ownership, timeouts, transport, and artifact capture in the runner.
Keep domain actions and SQL assertions in each scenario. This is not a new test
framework, universal view registry, or unrestricted shell-command interface.

Final provenance should identify the tested revision and source state. Existing
artifacts record HEAD and dirty filenames. Prefer a stable clean commit for final
proof; if a dirty tree is tested, retain its diff and relevant untracked-file
hashes as evidence. Do not edit the tested checkout while its application runs.
Record tool/dependency versions where the behavior depends on them.

## Safety packages

S1 (`test/e2e/workspace-ownership.ts`) and S2 (`test/e2e/capture-retry.ts`) have runnable scenarios. The remaining new scenario filenames below are planned files, not commands that exist today.
Each defect needs a focused regression that fails before its fix, plus evidence
from the real service or UI path appropriate to the claim.

### S1 — exclusive workspace ownership (F2; PIE-275)

The implemented boundary is `src/workspace-ownership.ts`, the `OutlinerStore`
constructor, and `src/server-main.ts` cleanup. Preserve exclusive ownership for
the canonical database identity before writable open, migrations, and recovery.
A preliminary ping does not establish ownership. Release only ownership acquired
by this process.

Implemented scenario: `test/e2e/workspace-ownership.ts`. Keep an operation in flight,
launch a second actual service against the same fixture, verify rejection without
state changes, and let the original operation finish. Cover computed, web, and
remote-entity recovery with focused variants. Also exercise legitimate recovery
after an owned process dies. Preserve an old-schema fixture for later migration checks.

Complete when the second launch cannot mutate the first service's work, and a
subsequent legitimate owner can recover interrupted work.

### S2 — exact capture acknowledgement (F1; PIE-276)

Change `src/capture-popup.ts`, capture persistence/receipts, and all capture
callers needed for the contract. Bind each request ID to its submitted payload;
an uncertain submission retains both. Acknowledgement permits clearing only the
acknowledged draft revision. Blindly assigning a fresh request ID after an
uncertain commit can duplicate a capture and is not the fix.

Implemented scenario: `test/e2e/capture-retry.ts` (`bun run test:e2e:capture`). In a real popup, commit a capture,
fail draft cleanup, type more, and retry. The added bytes remain durably
recoverable. Separately lose the committed reply and retry the original payload;
one capture exists across retry/restart. Inject faults at an existing transport
or operation seam in the private fixture, and record exactly what failed; keep
production behavior free of test-only switches.

The protocol-55 implementation retains uncertain submission text separately from later edits and never resets the draft revision counter on clear. Legacy receipts have no reconstructable payload: reject their replay, identify the saved capture for inspection, and preserve the draft. Current CLI/popup entrypoints reject incompatible services.

Complete when no retry clears unacknowledged text and same-payload retry remains
idempotent. Confirm closing/reopening preserves the recovery policy and leaves
ordinary Tree navigation unchanged.

### S3 — one block editing contract (F3/F5; PIE-277)

Change `src/store.ts`, request types, server dispatch, CLI, Tree/Detail, and agent
callers together. Introduce an authoritative edit revision with atomic
compare-and-update. Normal writes require the original revision. Define lifecycle
validation explicitly; unrelated position changes do not invalidate text drafts.
Keep display timestamps separate. Body revisions survive position changes and
unchanged delete/restore cycles; text saves still require an active block at the
time of the write. Historical annotation timestamps remain evidence metadata;
the existing content hash validates exact source bytes. Update incompatible
protocol versions and all callers in the same cutover; an optional old-token
bypass preserves the defect.

Scenario: `bun run test:e2e:edit-conflicts` (`test/e2e/edit-conflicts.ts`). Hold a
real Detail draft while a second client changes the block; a stale UI/CLI save must fail and preserve both
the newer stored content and recoverable draft. A sibling reorder must allow an
unchanged-content draft to save. Use a focused frozen/backwards-clock regression
for version reuse. Run migration twice on a copied old-schema fixture and verify
canonical text, identities, and timestamps are preserved.

Complete when every normal writer enforces the same contract and each of those
distinct stale-write/reorder invariants is covered.

Also audit the remaining hierarchy/lifecycle write preconditions that PIE-270's
old description incorrectly claimed were implemented. Identify the authoritative
checks for move, delete, and restore, and distinguish confirmed stale-write
defects from unspecified policy. The Detail cache provides no structural write
authority. Define an operation's missing precondition from a concrete failing
case; do not add a universal structural counter merely to satisfy the old wording.

### S4 — file revision identity and the separate write race (F6; PIE-278)

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

### S5 — one file-reading authority (F4; PIE-279)

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

## Remaining remote-read work

### PIE-269 — compact Tree index

`src/tree-controller.ts:reload()` still consumes complete `visible` and
`physical` collections from `workspace.snapshot`. Start at that read boundary
and the corresponding `src/store.ts`, `src/server.ts`, `src/types.ts`, and
`src/virtual-branches.ts` contracts. Preserve a complete structural graph while
removing duplicate full document bodies from the Tree response. The earlier
948-block/7.38 MB measurement is historical evidence, not a current benchmark.

Return stable identity, parent/order, child/deletion state, bounded row previews,
and the properties/ranks needed for projection. Use the service sequence for
complete-index revalidation and S3's edit revision for exact body reads. Fetch
bodies only where selected/expanded/edited presentation needs them; reuse the
existing body operations before adding another cache. Preserve filters,
transclusions, virtual occurrence identity, collapse, and selection re-anchoring.
Do not silently truncate structural data or substring-search a shortened preview.

Proposed scenario: `test/e2e/tree-index.ts`. Compare local and private
forwarded-socket cold loads on one representative fixture, recording bytes,
transfer/parse/projection time, first visible frame, and on-demand body requests.
Use real keys to expand/edit a long row and navigate physical and virtual rows;
then mutate/reorder through another client and revalidate. Verify exact bodies,
stable selection, equivalent ordering, and complete projections. Define the
performance budget against the recorded baseline before claiming improvement.

Delete the obsolete full-snapshot Tree path after migrating every Tree caller.
Retain any full-snapshot operation still required by a different consumer.

### PIE-271 — primary Detail content before optional enrichment

`src/detail-controller.ts:applyReadyDocument()` still awaits projection and
reference resolution before applying an uncached block, then awaits optional
work in the same load path. Split that concrete path using its existing target
generation checks and the existing `src/detail.ts` / `src/detail-pi.ts` effects.
Paint the exact primary document first; apply each enrichment only to its
matching target and revision. Enrichment failure must not erase readable primary
content or pretend its actions are ready.

Keep reference navigation disabled until the displayed source's references are
resolved. Annotations require the exact representation identity/hash; source
coordinates must continue to name the displayed text. Keep backlinks lazy and
preserve cached revisits, dirty drafts, explicit-open ordering, and stale-result
suppression. Resources keep provider-specific revisions and passive reads.

Proposed scenario: `test/e2e/detail-progressive.ts`. Delay and fail reference or
annotation enrichment behind deterministic barriers. Actual Detail must show
the cold primary content before release, retain it on enrichment failure, and
reject an old response after A→B navigation. Exercise link/comment readiness,
source positions, cache revisits, and a provider-backed Resource. Record
selection-to-primary latency and request counts locally and through the private
forwarded socket; repeat the affected journey on two hosts for remote UX claims.

Neighbor prefetch is removed from the required scope. Measure the simpler path
first. Any later bounded prefetch must be justified by remaining latency and
must not intern Resources, refresh providers, execute producers, or reconcile
annotations speculatively. No new enrichment scheduler or read-session framework
is required by this package.

### PIE-272 / PIE-273 — evidence before more infrastructure

- PIE-272 first measures backlink disclosure after PIE-271. If full-graph reads
  still dominate, maintain a rebuildable reverse-reference index transactionally
  from canonical block text and addresses. Verify page rename, Work-ID allocation,
  property references, delete/restore, and bounded result completeness against
  current resolution behavior. Remove the repeated scan when all affected callers
  migrate. The service index does not depend on the Detail cache.
- PIE-273 measures complete-index bytes, parse/projection time, mutation
  revalidation, and representative workspace growth after PIE-269. It is a
  decision gate, not a commitment to cursors, replay, or leased views. Close it
  if the complete index meets the stated budget; otherwise propose the smallest
  bounded protocol change with hierarchy, occurrence, concurrency, and reconnect
  evidence.

Keep measurements with the canonical task proof. Local latency injection and
this agent's host-socket access check do not establish two-host SSH behavior.

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
verification requirements. Keep completion evidence on the canonical work item;
planned acceptance criteria are not evidence that an implementation exists.
