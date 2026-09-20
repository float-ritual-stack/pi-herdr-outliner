# Data safety, remote performance, and Herdr/Pi implementation plan

Contracts and acceptance criteria, reconciled 2026-09-20 against the implemented
seven-story batch and its retained verification. The Outliner workboard owns
ownership, Work IDs, branches, PRs, and task status. This document does not certify
that every batch change is on main or deployed to the shared session; those need
their own integration and application proof.

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
- S3 / PIE-277, [PR #121](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/121):
  required atomic block edit revisions, migrated writers, and actual stale-save
  and sibling-reorder proof. Position changes do not invalidate text drafts.
- S4 / PIE-278, [PR #122](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/122):
  content-qualified filesystem revisions, PDF refresh/history checks, and actual
  stale-file-save proof. PIE-280 adds the separate recoverable replacement contract below.
- S5 / PIE-279, [PR #123](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/123):
  service-owned file previews and completion, passive catalog reads, and actual
  Pi/ANSI proof with separate client/service roots. Controller regressions cover
  obsolete file-read results and cached-file repainting separately.
- PIE-269, [PR #124](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/124):
  complete compact Tree index, service-side full-text goto, and exact on-demand
  bodies. The 1,000-block fixture transfers 737,800 bytes instead of 8,263,314
  (91.1% smaller). Direct and forwarded private journeys pass on merged main
  `e728c35`; hyperlink source spans have separate renderer regression evidence.
- PIE-271, [PR #125](https://github.com/float-ritual-stack/pi-herdr-outliner/pull/125):
  primary Detail paint and input-lane release before optional enrichment, guarded
  deferred presentation, and actual direct/forwarded application proof. Retain
  the block/file annotation identity guards; PIE-281 repairs the older placement defects.

Preserve these behaviors. PIE-270 does not establish progressive cold loading,
Tree body caching, Resource caching, or structural conflict protection for all
mutations. Its old `tree.index` prerequisite and blanket structural-revision
claim are removed from the completed scope. S3 owns the mutation-contract audit;
PIE-269 and PIE-271 deliver the Tree read cutover and progressive cold Detail reads.

## Implemented seven-story batch

These are retained contracts, not a duplicate task queue. Preserve their focused
regressions and application journeys when integrating or changing them.

| Story | Implemented boundary | Application evidence to retain |
| --- | --- | --- |
| PIE-235 | One invocation-local virtual-child lookup; ranked filters compute matching block IDs once using existing indexes. | `tree-scale.ts` at 1k/5k plus the separate 24k `profile:tree --check-budget` fixture. |
| PIE-280 | Durable draft/original recovery and publication only into an absent pathname. | `file-commit.ts`, process-interruption regressions, and the existing file-revision journey. |
| PIE-281 | Position annotations only against the displayed source representation; captured/stale evidence remains reachable and unpositioned. | `annotation-identity.ts`, including changed files and metadata-only presentation. |
| PIE-263 | Authored Resource references activate by exact host block/revision/span; repeated uses share one Resource. | Pi and ANSI `resource-occurrences.ts` journeys. |
| PIE-282 | Immutable per-occurrence evidence in the existing annotation target; Resource passages retain their separate passage/revision anchor. | `reference-annotations.ts`, native-pointer scope checks, and public service/restart regressions. |
| PIE-265 | In-Detail navigation, reply, resolve/reopen and complete evidence access, preserving target and viewport. | `annotation-threads.ts`: native Pi control activation, Pi/ANSI readers, narrow views and lifecycle refresh. |
| PIE-283 / A1-A2 | Opt-in fixed Tree/Detail surface with local ordinary navigation and explicit detached views. | `composed-surface.ts`, `composed-boundaries.ts`, and occurrence comments through the composed launch. |

The application retains the existing document editor, annotation repository and
service operations. PIE-282 introduced protocol 60; the composed role/region
contract requires the final batch cutover to protocol 61. Deploy the service and
all clients together.
See [execution and completion requirements](#execution-and-completion-requirements)
before treating branch proof as merged delivery or deployment.

## Delivery order and dependencies

S/I/A labels identify packages in this plan; PIE identifiers name canonical
workboard records. Use a focused branch per invariant; groups describe priority,
not one large PR.

| Order | Package | Impact | Dependency |
| --- | --- | --- | --- |
| Shipped foundation | S1 / PIE-275: own the workspace before writable startup | BLOCKER addressed: a second launch could invalidate live work. | Preserve the ownership and recovery regressions. |
| Shipped foundation | S2 / PIE-276: bind capture receipts to submissions | BLOCKER addressed: a retry could discard newly typed text. | S1 before deploying any required receipt migration; attached-client support for popup proof. |
| Shipped foundation | S3 / PIE-277: enforce block edit revisions | BAD DESIGN addressed: silent stale writes and common false conflicts. | Preserve migration, required-token, stale-write, and sibling-reorder regressions. |
| Shipped foundation | S4 / PIE-278: identify file contents in revisions | BUG addressed: equal size/time concealed changed bytes. | Preserve byte identity, legacy PDF history, and stale-file-save proof; PIE-280 remains separate. |
| Implemented safety extension | PIE-280: preserve external edits during file replacement | BUG addressed with recoverable replacement, not atomic compare-and-swap. | Preserve retained versions, confinement and interruption recovery; observe the documented filesystem limits. |
| Implemented identity foundation | PIE-281: annotation representation and coordinate identity | BUG addressed: screen offsets and old file resolutions cannot position against unrelated bytes. | Preserve representation/mapping checks and reachable original evidence for reference comments and composed selection. |
| Shipped foundation | S5 / PIE-279: make file reads service-owned | BAD DESIGN addressed: preview routes read different hosts' bytes. | Preserve passive-read semantics, exact file evidence, and explicit resource creation. |
| Remaining interaction fix | I1: observers are not destinations | BUG: navigator subscriptions advertise a false Detail identity. | Narrow subscription change; attached-client popup proof. |
| Remaining interaction fix | I2: chooser destination outcomes | BUG: missing eligible readers do not consistently trigger the offered split action. | Typed routing result and all chooser callers updated. |
| Remaining interaction fix | I3: Pi focus-loss handling | BUG: consumed focus loss can leave selection autoscroll active. | Focused terminal test plus attached-client input proof. |
| Before host cleanup | I4: authoritative host projection | FRAGILE: event ordering can leave stale pane state. | Verify supported-version event behavior; fix refresh before deleting subscriptions. |
| Remaining cross-client work | I5: explicit agent source view | FRAGILE: shared focus history cannot identify a particular attached client's intent. | Composed region identity is implemented; two-attached-client intent still needs its own reproduction and contract. |
| Shipped read foundation | PIE-269: compact Tree index | Duplicate full-body Tree transfer removed. | Preserve exact body revisions, reference spans, complete projections, and live journey proof. |
| Shipped read foundation | PIE-271: progressive Detail loading | Primary content and input no longer wait for optional enrichment. | Preserve S3-S5 contracts, cache/draft behavior, readiness, and source identity. |
| Measured gate | PIE-272: assess backlink indexing | No reverse-reference index justified in the measured envelope. | Reopen against the recorded workload/budgets when disclosure cost becomes material. |
| Measured gate | PIE-273: assess server windows | No cursor system justified; PIE-235 now passes the retained 5k growth budgets. | Reopen against new measured workload/budget failures. |
| Implemented performance fix | PIE-235: virtual-branch loading at scale | Repeated projection construction and ranked-query scans removed. | Preserve both 24k client and 1k/5k service/application acceptance tracks. |
| Implemented opt-in experiment | A1-A2 / PIE-283: local primary reader in one surface | Ordinary selection/open/focus no longer needs pane discovery or service navigation dispatch. | Preserve separate view state, editor contracts, region identity, retained Resource revision and detached routing. |
| After opt-in evaluation | A3: remove replaced coordination | Delete demonstrated redundancy while preserving detached behavior. | Default-cutover decision, A2 acceptance evidence and affected callers migrated. |

I1-I5 can proceed independently of a default layout change. A2 reuses the safety
and annotation foundations; its opt-in boundary does not retire standalone or
detached callers.

S1-S5 are the shipped safety foundation. Reuse their regression and application
proof; their former queue order does not create technical dependencies between
the remaining packages. PIE-269's compact Tree delivery is the baseline for the
scale gate; PIE-271 delivers the cold Detail package. Their implementations are
independent: connectivity from PIE-268 and cached revisits from PIE-270 did not
implement either behavior.
Consult the workboard for current execution status.

PIE-272/273 justify no backlink index or cursor subsystem. PIE-235 fixes the
measured growth bottleneck without either. Its performance work and PIE-280's
file replacement contract remain independent of layout. PIE-281 supplies the
identity boundary for PIE-282/265 and composed comments. I1-I5 remain separate
interaction work; A3 owns any default cutover and deletion of shared machinery.

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
- One additional remote-mode Tree/Detail context in a separate owned workspace
  root, using either supported Detail renderer. Record its endpoint, process
  environment, and registrations; capture its panes alongside the original views.
- Bounded private forwarding sockets for that context's Tree and Detail, recording
  request bytes/counts and timings. Detail can hold or fail a specifically matched
  reference-resolution or annotation-reconciliation response; unrelated replies
  and subscription events continue. The compact-index
  journey also records parse/projection cost and the first observed Tree frame.
- One owned PTY-attached Herdr client with actual keyboard/SGR mouse input,
  resize, raw ANSI and current-screen checkpoints decoded by test-only
  `@xterm/headless`; `paneSnapshot` retains exact capture text and revision.
- A bounded composed launch with one host pane and one logical registration,
  plus adoption, movement and closure of explicitly owned detached views.
- Private registry failure/restoration and specifically held composed publication
  and edit-lock replies, so ordinary local routing and draft ownership are tested
  while host discovery or an asynchronous boundary is unavailable.
- A read-only SQLite connection and consistent checkpoint copies.
- Terminal text/ANSI, topology, registrations, invocation logs, process evidence,
  and cleanup of owned processes on success, failure, and interruption.

Its limits remain one canonical service, a bounded startup contender, one extra
Tree/Detail context, and one attached Herdr client. Native mouse and resize are
now exercised for the recorded thread/composed paths; this does not prove I3's
focus-loss/autoscroll path or I5's two-client behavior. Server-wide pane focus
does not select the attached client's active tab: select that tab through actual
input before claiming attached interaction. Optional-response and registry faults
run on one host and do not establish two-host SSH or installed-server event-order
semantics. A held goto reply has a separate Tree controller regression.
Recorded batch application runs use Linux; macOS behavior remains unverified.

`startup-interruption.ts` deliberately expects its inner fixture to fail after
SIGINT and then verifies cleanup. Its outer test reports success. Distinguish
expected injected failure from failed scenario verification when reading artifacts.

### Add capabilities only when a scenario requires them

| First consumer | Small extension | Required proof |
| --- | --- | --- |
| S1 (implemented) | Launch and track one additional service process against the private workspace; hold a real async operation at a deterministic barrier. | Rejected second startup changes no live operation state; cleanup leaves no owned survivor. |
| S2 (implemented; reusable by I1) | Attach a real Herdr client through an owned PTY; send modal input through that client and retain its output. | Open, operate, and close the actual popup. A popup has no pane ID: sending keys to the underlying pane is not popup proof. |
| A2 (implemented; reusable by I4) | Adopt, move and close an explicitly owned detached view; retain returned identities. | Track the terminal/current pane ID inside the private server. This does not replace I4's event-order/reconnect check. |
| S5 (implemented) | Give client and service different fixture roots with the same relative filename. | Both UI routes display service-owned bytes; describe this as simulated remote ownership unless SSH is also exercised. |
| PIE-265 / A2 (implemented; reusable by I3) | Drive SGR mouse input and PTY resize through the attached client. | Native Reply activation and composed Resource source coordinates survive resize. I3 still needs its specific focus-loss journey. |
| I5 | Attach two controlled clients to the private Herdr server. | Record both client actions and the context selected for each explicit source. |
| A2 (implemented) | One composed launch, bounded registry fault, and publication/edit-lock response barriers. | Internal navigation works without discovery; delayed publication cannot change a draft's owner. One host pane contains distinct logical Tree and Detail views. |
| PIE-269 / PIE-271 | Reuse bounded request-byte/timing capture and narrowly matched optional Detail response barriers. | Keyboard-driven cold/revisit navigation, exact final targets, and bounded reads; hold/reorder optional Detail replies for PIE-271. Report actual two-host evidence separately from a local forwarding fixture. |

Keep process ownership, timeouts, transport, and artifact capture in the runner.
Keep domain actions and SQL assertions in each scenario. This is not a new test
framework, universal view registry, or unrestricted shell-command interface.

Final provenance should identify the tested revision and source state. Existing
artifacts record HEAD and dirty filenames. Prefer a stable clean commit for final
proof; if a dirty tree is tested, retain its diff and relevant untracked-file
hashes as evidence. Do not edit the tested checkout while its application runs.
Record tool/dependency versions where the behavior depends on them.

## Safety packages

S1-S5 and the implemented batch have runnable scenarios identified below.
The I1-I5 filenames are still proposed journeys, not existing commands.
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

### S4 — file revision identity (F6; PIE-278)

Change `src/resources.ts` revision normalization/comparison and
`src/resource-catalog.ts` filesystem read/write handling. Include the existing
content hash consistently in authoritative revisions, including pinned reads.

Scenario: `bun run test:e2e:file-revisions` (`test/e2e/file-revisions.ts`). Open a real Detail edit, replace
the file externally with same-sized bytes and restored modification time, then
save. Reject the stale save, retain the draft, and preserve the external bytes.

### PIE-280 — recoverable filesystem replacement

`src/filesystem-commit.ts` and `src/resource-catalog.ts` now retain the submitted
draft and displaced original in a private `.outliner-save-<UUID>/` directory.
Validate the displaced bytes against the opened revision; publish only into an
absent pathname. A competing replacement remains in place, the save reports a
conflict, and Detail keeps its draft. Startup or the next Resource read recovers
a pending original only into an absent pathname. Recovery rejects non-regular
originals and rechecks Source confinement.

This closes the silent-loss path with recoverable replacement, not atomic
compare-and-swap. The normal pathname is briefly absent. Recovery copies remain
for explicit cleanup because an external editor can keep writing through an old
descriptor. Local hard links, rename and directory fsync are required; unsupported
primitives fail the save. Preserve the exact recovery instructions and limitations
in [filesystem editing](../README.md#detail-edit-and-comment-modes).

`test:e2e:file-commit` drives actual save/conflict/cancel/refresh behavior. Focused
tests cover conflicting bytes, late descriptor writes, permissions, symlink
confinement and process death at commit boundaries. Linux process interruption
is verified; power loss, network filesystems, hostile source-directory replacement
and concurrent deletion of recovery evidence remain outside the verified contract.

### S5 — one file-reading authority (F4; PIE-279)

Remove service-owned reference reads from client-local filesystem paths in
`src/outliner.ts` and `src/detail-pi.ts` (and any remaining supported renderer).
Use service reads for both embedded and detached presentation; keep line ranges
and rendering local. Passive previews must remain passive, without silently
interning a Resource or refreshing its provider.

Scenario: `bun run test:e2e:file-authority` (`test/e2e/file-authority.ts`) runs
both Pi and ANSI Detail with a remote-mode client context and a separate fixture
root. Give client and service different bytes at the same relative path. Follow each supported preview/open route and
verify service-owned content; verify passive reads leave catalog identities and
counts unchanged. Exercise service-owned completion. Retain the existing
resource-authoring journey. Split roots on one host establish file ownership,
not actual two-host SSH behavior. Stale-file-read protection and cached-revisit
repainting are covered by controller regressions, not this E2E scenario.

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

## Remote-read contracts and remaining work

### PIE-269 — compact Tree index

Delivered by PR #124. The following are retained contracts and acceptance checks,
not a second implementation queue. PIE-273 records the scale decision and reopening
criteria; PIE-235 supplies the measured projection/ranked-query fix.

At baseline `53be3c0`, `src/tree-controller.ts:reload()` consumes complete `visible` and
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

Account for the current full-body consumers when deleting this path. Tree's fuzzy
goto must still match full canonical text; perform that matching at the service.
Collapsed rows need service-derived block/fragment link metadata and authored-link
identity, not copies of referenced documents. Expanded rows fetch exact text when
needed. Quick edits must use both the text and edit revision from the same exact
read, even if the compact row describes an older revision. Preserve the existing
row rendering, link targets, source identity, and selection/scroll behavior.

Resolve references from authored source before transforming the preview. Carry
their spans through hidden-property removal, properties inside labels, newline
display, and service/terminal clipping. Fully hidden references disappear;
surviving unresolved or clipped text stays nonactionable and cannot acquire a
different target through generic UUID detection. Check emitted hyperlink columns
in renderer regressions: Herdr's captured ANSI frames omit OSC 8 metadata and
cannot prove those links or host click behavior.

Scenario: `bun run test:e2e:tree-index` (`test/e2e/tree-index.ts`). Compare direct and private
forwarded-socket cold loads on one representative fixture, recording bytes,
transfer/parse/projection time, first visible frame, and on-demand body requests.
Use real keys to expand/edit a long row and navigate physical and virtual rows;
then mutate/reorder through another client and revalidate. Verify exact bodies,
stable selection, equivalent ordering, and complete projections. Define the
performance budget against the recorded baseline before claiming improvement.

Full-text goto must keep the input lane responsive while waiting for the service.
Keep at most one search in flight, skip superseded intermediate queries, and
accept only the latest query's result. Enter waits for that result. Prove this
with a held read, and inspect actual Tree request counts in the forwarded journey.

The first delivery budget is a complete 1,000-block response below 1 MB and at
least 75% smaller than `workspace.snapshot` for the same fixture. Shape its
document-size bands from aggregate workspace measurements; retain a separate
long-document stress case. Record the distribution, property/reference mix, and
exact tested source, and remeasure the final response with all required metadata.
A prototype service response meeting this budget does not prove that Tree uses
it or that first-frame latency improved.

Delete the obsolete full-snapshot Tree path after migrating every Tree caller.
Retain any full-snapshot operation still required by a different consumer.

### PIE-271 — primary Detail content before optional enrichment

Delivered by PR #125. Preserve these contracts and the application journey;
this section is not an unfinished implementation queue.

At baseline `e728c35`, `src/detail-controller.ts:applyReadyDocument()` awaits projection and
reference resolution before applying an uncached block, then awaits optional
work in the same load path. Split that concrete path using its existing target
generation checks and the existing `src/detail.ts` / `src/detail-pi.ts` effects.
Paint the exact primary document first; apply each enrichment only to its
matching target and revision. Enrichment failure must not erase readable primary
content or pretend its actions are ready.

Primary paint must also release Detail's ordered input/event lane. Emitting a
frame and then awaiting enrichment in that lane still stalls navigation and
editing. Keep optional completion guarded by the existing target generation and
document revision; it must not reset scroll, record navigation twice, or replace
an active draft/selection. Reuse the existing event scheduler rather than adding
another coordinator.

Keep navigation derived from displayed references disabled until those references
are resolved. Explicit canonical targets, such as property targets, remain usable
without that enrichment. Annotations require the exact representation identity/hash; source
coordinates must continue to name the displayed text. Keep backlinks lazy and
preserve cached revisits, dirty drafts, explicit-open ordering, and stale-result
suppression. Resources keep provider-specific revisions and passive reads.

Scenario: `bun run test:e2e:detail-progressive` (`test/e2e/detail-progressive.ts`). Delay and fail reference or
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

The gates have recorded decisions on the canonical work items. Both private
1,000/5,000-block journeys ran on merged `b367586`, with budgets declared before
measurement, actual direct/forwarded keyboard actions, and retained source/provenance.
Backlinks met the disclosure budgets, so PIE-272 adds no reverse-reference index.
Complete Tree responses remained about 91% smaller and met their byte budgets.
The initial 5,000-block projection and mutation-revalidation budgets failed;
ranked `tree.query` calls dominated. PIE-235 now removes those repeated scans and
the repeated client projection work, passing both retained budgets. Neither gate
adds a window/cursor/replay system. These results bound the measured workload;
they are not a claim about arbitrary workspace growth.

Keep the following reopening criteria:

- PIE-272 measures backlink disclosure after PIE-271. If full-graph reads exceed
  the recorded service/UI budgets, evaluate a rebuildable reverse-reference index
  maintained transactionally from canonical block text and addresses. Verify page rename, Work-ID allocation,
  property references, delete/restore, and bounded result completeness against
  current resolution behavior. Remove the repeated scan when all affected callers
  migrate. The service index does not depend on the Detail cache.
- PIE-273 measures complete-index bytes, parse/projection time, mutation
  revalidation, and representative workspace growth after PIE-269. It is a
  decision gate, not a commitment to cursors, replay, or leased views. Close it
  if the complete index meets the stated budget; otherwise propose the smallest
  bounded change at the measured bottleneck. A protocol change needs hierarchy,
  occurrence, concurrency, and reconnect evidence; a slow SQL access path does
  not justify cursor state.

Keep measurements with the canonical task proof. Local latency injection and
this agent's host-socket access check do not establish two-host SSH behavior.

### PIE-235 — remove repeated work from virtual-branch loading

The implementation fixes two independent costs. `projectVirtualBranches()` in
`src/virtual-branches.ts` builds virtual-child adjacency once per invocation and
composes only rows with virtual children. `queryRankedBlocksFromCurrentRead()` in
`src/store.ts` replaces repeated correlated property scans with matching-block-ID
membership queries through existing indexes. No persistent cache, schema change,
optimizer hint or cursor protocol is added.

Preserve case-insensitive filters, property scope, deletion/subtree rules,
authored ranks, canonical fallback order, exact bodies/revisions and explicit
completeness. Baseline comparisons cover complete, truncated, filtered, ranked
and collapsed projections, including serialized output and selected occurrences.

The separate 24,000-block client profile records projection p95 **9.92 ms** and
initialization p95 **17.83 ms**, down from about 2.14/2.21 seconds. Its existing
projection/initialization budget remains p50 <25 ms and p95 <50 ms. The private
5,000-block two-context application fixture records parse/projection p95
**68.12 ms** (<250 ms) and mutation-to-converged-Tree-and-Detail p95 **669.28 ms**
(<1 second). The mutation check requires both physical and projected copies to
converge; it does not hide a briefly mixed-revision frame.

Retain `profile:tree --check-budget` and `test/e2e/tree-scale.ts` at 1k/5k as
distinct acceptance tracks. The 24k profile is client-only; larger service
workloads, two-host SSH and atomic snapshot/query coherence remain unproven.
Detailed samples and reopening criteria stay on PIE-235 and PIE-272/273 proof.

### PIE-281 — annotation representation and coordinate identity

The conversion of captured-screen offsets to document positions and the
annotation-mode ancestor-file preview are deleted. The existing representation,
immutable quote and resolution history own the evidence. Shared placement in
`src/detail-annotations.ts` requires the actual displayed representation and an
exact source mapping; merely having UTF-8 bytes available behind a metadata view
does not establish either.

Rendered captures, stale file resolutions and unmatched representations remain
unpositioned and reachable. Source selection and reveal use the same displayed
source guard. Preserve `test:e2e:annotation-identity`: captured wrapped/projected
text, reopen/reflow, changed files, metadata-only views and original evidence.
Its pane-capture handoff is explicit; native pointer paths have additional
PIE-282/265/283 journeys. PIE-265 supplies full thread/evidence reachability.

### Reference occurrences and thread controls — PIE-263, PIE-282, PIE-265

PIE-263 uses one explicit activation path for authored file/web/Jira/application
references, carrying source block/revision/span and preserving metadata versus
inline scope. Repeated uses remain separate Properties choices and resolve to one
Resource. Reading and rendering are passive; stale activation is rejected.
Legacy file line-range previews remain separate from explicit full Resource opens.
Generated occurrences without known authored coordinates remain nonactionable
until their source is opened.

PIE-282 adds occurrence comments through the existing AnnotationRepository and
target JSON. Properties `c` can annotate one use without opening or interning its
target. A contextual Resource passage retains both the immutable host occurrence
and its Resource revision/passage anchor; a Resource-wide comment has no host
context. Navigation/history and pointer captures preserve this distinction.
No competing occurrence store or cloned Resource is introduced.

Reconciliation must never transfer a deleted or ambiguous reference's annotation
to a surviving identical mention. Exact unchanged source or a containing line
unique in both original/current text is the bounded automatic contract. Other
changes remain recoverable and require explicit reattachment. Test creation,
navigation history, movement, duplication/deletion, reply/lifecycle, service
restart and unchanged authored text through public contracts and real input.

PIE-265 exposes `[`/`]` navigation, multiline `Shift+C` replies and `Shift+D`
resolve/reopen with the same root operations as pointer controls. Resource-wide,
current-reference, other-reference and unpositioned threads remain distinct and
reachable. Navigation order derives from the validated displayed anchors,
including historical Resource representations. Replies and lifecycle refreshes
preserve the current target, selected root and viewport.

Pi uses existing preview regions. ANSI uses its ordinary reader and one scroll
offset for complete wrapped threads, quotes and replies, with source rows separate
from generated evidence. Preserve the actual `resource-occurrences`,
`reference-annotations` and `annotation-threads` journeys and focused restart,
stale-pointer, ambiguity/deletion, lifecycle-refresh and historical-order tests.
The combined surface reuses these operations and identity rules.

## Application surface experiment and deletion

### A1-A2 / PIE-283 — opt-in primary reader and fixed surface

The `open-composed` action now uses `src/composed-main.ts` and
`src/composed-surface.ts` with the existing Tree/Detail controllers, document
editor and one Pi terminal lifecycle. The application owns a fixed horizontal
split, allocated dimensions and input/source-coordinate translation. `F6`
switches regions; `q` returns to Tree. Ordinary selection/open/focus uses local
controller operations and one designated primary reader, including generated
Outlinks and Resources while Herdr discovery is unavailable.

Tree selection/history/scroll and Detail target/history/scroll/draft remain
independent. A locked primary stays locked. One `role: "composed"` registration
publishes `treeSelection`, `currentTarget` and `focusedRegion`; explicit commands
and attention reveal/focus name `targetRegion`. Retention uses Detail's exact
Resource revision regardless of keyboard focus. Existing service operations own
all reads, saves and validation. Detached readers keep explicit service/Herdr
routing, independent placement and their own state.

Preserve `test:e2e:composed` and its component journeys: real editing, selection,
undo/redo, save/cancel, dirty keyboard close, Tree scroll, narrow/wide resize,
registry outage, detached move/close and native Resource pointer coordinates.
`composed-boundaries.ts` holds publication and edit-lock replies to prove that
background Tree publication cannot change a draft's owner; generated links still
open locally during discovery failure. The occurrence journey also runs through
this launch. Public-protocol tests retain explicit region targeting and Resource
revision retention as separate invariants.

The separate-pane launch remains available. A1's broader standalone destination
policy is not silently changed by this experiment. `Ctrl+Q` guards active drafts;
force-closing a host pane or killing its process does not promise draft recovery.
External Herdr copy-mode selection is refused in composed panes because its pane
identity cannot prove the internal region. Detail-native pointer selection plus
`c` is supported. These boundaries and I1-I5 remain explicit follow-ups.

The opt-in ordinary path removes pane discovery, cross-process navigation
dispatch and host focus restoration. A3 owns the later default-cutover decision
and deletion of shared adapters still required by standalone/detached callers.

### A3 — deletion after proof

These are conditional deletion candidates, not missing PIE-283 implementation.
Choose a default cutover and migrate remaining callers before removing shared code.

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

Merged delivery and deployment to an existing user session are separate claims.
Record the running service/client protocol alongside the tested revision. Follow
the [service connection diagnostics](../CONTRIBUTING.md#connecting-to-the-running-service)
for access failures or a version mismatch; a successful host probe is not evidence
of a broken remote transport. Updating the shared session requires its own
coordinated service/client cutover and live acceptance evidence.

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
