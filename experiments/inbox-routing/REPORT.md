# PIE-331: spend editorial effort where it helps

## Recommendation

Enable the small Inbox routing policy, with editable prompts and the existing Undo/Reconsider controls. Keep SQLite, the ordinary Inbox worker and Pi editor. No second workflow engine is needed.

On eight representative synthetic captures, the trial sent **2/8 to Pi instead of 8/8**, cost **$0.1194 versus $0.2966** (about 60% lower), and preserved every useful case. These are one paired run, not calibrated accuracy or a universal saving. The mixed capture was more expensive in the trial ($0.0958 versus $0.0570); normal model variability can outweigh routing overhead on a particular job.

## What changed

The existing Jev classification request now includes two questions: the useful amount of work (keep / metadata / archive / editorial), and whether the whole capture is disposable test noise. Code decides the route. There is no extra network roundtrip for routing.

- **Keep:** file useful prose intact, adding no inferred tags/type. Existing authored and inferred metadata remain. Filing still moves the capture and marks it processed.
- **Metadata:** preserve prose while applying useful ordinary type/tag judgments.
- **Archive:** move clear noise intact into the existing reversible Processed captures folder. Never delete it.
- **Editorial:** use the existing bounded Pi cleanup for mixed work, ambiguous meaning, requests or explicit steering.

An incomplete routing window, malformed distribution, close alternatives, or explicit Reconsider goes to the editor. A note with children cannot take the cheap archive route. Request fulfillment retains its established path and cannot be bypassed by a keep/archive judgment. The route and reason appear on activity receipts, including failed Pi attempts.

## Paired comparison

Same text, isolated stores seeded identically, separate live Jev/Pi runs. Default configured Pi was used. Baseline omits only the new routing questions and follows the existing classification → Pi cleanup path. Both runs include classification and any relationship checks. Synthetic texts represent observed capture categories; no private user note dump was sent.

| Case | Expected | Trial | Baseline seconds | Trial seconds |
|---|---|---|---:|---:|
| `aaaa` | Archive | Archive, no Pi | 13.7 | 0.6 |
| `did a thing` | Keep or inspect | Pi; kept vague meaning | 13.9 | 13.6 |
| Insurance renewal reminder | Keep/metadata | Keep | 13.8 | 0.4 |
| Dated first-use marker | Keep/metadata | Keep | 25.5 | 0.4 |
| Grocery list | Keep | Keep | 13.8 | 0.6 |
| UI request + recipe | Split/task | Pi; task plus recipe note | 32.3 | 47.0 |
| Historical architecture review | Preserve history | Metadata | 23.0 | 0.4 |
| SQLite reference | Keep/metadata | Metadata | 11.2 | 0.4 |

Exact times and usage are in [results.json](results.json). Sum of observed per-note latency: **147.3s baseline / 63.4s trial**; this is not concurrent batch wall time. Input + output tokens: **120,822 / 79,655**. Polling adds up to 200ms to per-note observed time. Estimated cost uses the application's existing model accounting; it is not a billing statement.

The trial kept the shopping items, date, insurance fact, historical accepted/rejected decisions and reference URL. The mixed capture produced one task and a separate recipe note. No useful case took the archive route, and the historical request to create a scheduler was not executed.

## Threshold experiment and holdout

Initial policy used a 0.30 choice margin and 0.95 disposable probability. `aaaa` had archive margin 0.92 but disposable 0.80, so it unnecessarily reached Pi; `did a thing` had disposable 0.60 and appropriately escalated. We lowered this **local trial's** disposable threshold to 0.75 while retaining the margin gate. This is a policy choice about reversible filing, not treating probability as permission to delete.

A separate eight-case holdout then archived long repeated `a`s and an explicit capture test. It retained a dated vague marker, `buy milk`, an AAA-battery reminder, an uncertain thought, a rejected historical proposal, and a note explaining that `aaaa` names a parser fixture. **0/6 useful holdout notes archived; 2/2 declared noise notes archived.** Holdout used live Jev; editorial routes were observed without paying for Pi, so it does not measure editorial quality or end-to-end cost.

Do not generalize accuracy from sixteen deliberately selected examples. The policy may keep some noise, and Pi can still make a poor editorial decision. Review concrete outcomes and add counterexamples before changing thresholds again. Children force editorial inspection rather than assuming the short parent is the entire note.

## Recovery and operation

`prompts/inbox-routing.json` is seeded once into the editable workspace prompt directory. Changes are read per job without rebuild. Active custom files are retained; deliberate removal produces an explicit prompt error. Results retain the routing prompt hash.

Undo restores the source's text and location using the existing revision-aware recovery. Undo suppresses automatic reprocessing. Reconsider with guidance explicitly asks for another attempt; on an undone Inbox capture it goes to Pi. Filed ordinary notes retain the existing note-assistance Reconsider behavior.

To disable all cheap routing while retaining other note assistance, set `enabled` to `false` in `inbox-routing.json`. To disable note assistance entirely, the existing `OUTLINER_NOTE_ASSISTANCE=0` uses the legacy Inbox editor path; that broader switch also disables ordinary-note assistance. Prefer editing the routing policy for a focused experiment.

## Reproduce

```sh
# Uses configured Pi authentication and TYPESAFE_API_KEY; spends tokens.
bun experiments/inbox-routing/run.ts --live
bun experiments/inbox-routing/holdout.ts --live
# Actual private Herdr, keyboard Undo/Reconsider and visible live results:
bun test/e2e/inbox-routing.ts
```

Set `ROUTING_CASE=<id>` to run one paired case or `ROUTING_EVIDENCE_DIR` to choose the evidence directory. Stores and session logs stay in that directory, outside the repo. Preserve failed runs too: the initial comparison had one baseline TypeSafe availability failure; the final full paired run succeeded. The first Herdr fixture had note assistance disabled and exercised the old path; correcting that fixture is not a product fix.

## Sources and scope

Design follows TypeSafe's [Choice contract](https://docs.typesafe.ai/primitives/choice), [confidence guidance](https://docs.typesafe.ai/confidence), [routing pattern](https://docs.typesafe.ai/patterns/intent-routing), and [HTTP API](https://docs.typesafe.ai/api), read on 2026-09-23. Independent questions share one request; code owns execution and uncertainty policy. No model change, permanent deletion, semantic index or automated routine promotion is included.
