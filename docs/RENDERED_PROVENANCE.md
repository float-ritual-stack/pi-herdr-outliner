# Rendered document provenance

A reader must be able to answer two different questions about a selection:
what did the reader see, and which authored passages produced it? Rendered copy
answers the first. Exact comment anchors require evidence for the second.
Matching a displayed quote against the whole source is not that evidence.

This is the implementation contract for PIE-350 and its feature-branch readers.
Merge, deployment and application acceptance are tracked on the live workboard.

## Existing contracts and migration points

| Module | Existing responsibility | Required change |
| --- | --- | --- |
| `detail-embeds` | Resolve embeds and saved views; retain observed blocks with projected line bounds | Emit projected offsets with canonical source slices and distinct host occurrences before replacement loses them |
| `detail-read-preview` | Load a block, expand references and clip long documents | Compose mappings through expansion and clipping; truncation is generated |
| `markdown-structure` | Source-spanned block tokens and list ownership | Preserve inline transform boundaries and table-cell slices |
| `SourceSpannedMarkdown` | Render shared Markdown, folding and source-line navigation | Return cell provenance with layout; line estimates cannot own selection |
| `detail-pi-preview` | Compose metadata, document content and comment panels | Carry the same map through all inserted rows, gutters and disclosures |
| `rendered-links` | Measure links across wrapping using internal markers | Keep links and provenance in the same render generation; strip internal markers before terminal output |
| `PreviewSelection` | Capture reading-order rendered text within a reader rectangle | Reduce the render map for copy and exact source fragments |
| Detail/Preview comment capture | Retain immutable rendered evidence or a proven source anchor | Consume the shared selection result; preserve explicit fallback when exact source identity is unavailable |

`PreviewSourceSpan` currently describes source offsets and line bounds, not a
cell map. `DetailEmbedRange` retains useful canonical observations but does not
fully distinguish repeated occurrences. `RenderedLink` describes visible-column
geometry; it is not an annotation source range. Keep those meanings distinct
while migrating their consumers.

## One render result

Projection retains source ownership. Rendering transforms that projection into
lines, cell provenance and interaction regions together. The result has one
identity for source/data revision, style and width. Readers may add viewport
coordinates, but must not reconstruct hit targets or provenance from painted text.

Each visible grapheme is associated with one of:

- **Source:** canonical subject, observed revision/hash and exact UTF-16 slices.
- **Reference:** an atomic authored token whose visible label can differ from its
  syntax, plus resolved destination and occurrence identity.
- **Derived:** a result identity and dependencies, with useful rendered text but
  no invented exact source range.
- **Generated:** decoration, padding, controls or truncation with an explicit
  reason and no canonical source range.

Screen coordinates are visible columns. Canonical coordinates are UTF-16.
Escapes, entities, combined graphemes and wide glyphs require explicit boundaries;
proportional division of a source span is invalid. Hidden syntax emits no cells.
A source fragment can contain discontiguous slices, as with a wrapped table cell.

An occurrence identifies the host, authored token and composition path. Two
embeds can share a canonical subject and still be different occurrences. Missing
or bounded-out embeds refer atomically to their host token where known; they
must not borrow another occurrence's source range.

## Selection and annotation

Linear and rectangular selection are separate reducers over the same render
result. Copy follows rendered reading order with useful labelled content;
layout borders and controls do not become authored text. Source fragments are
coalesced only when both subject and occurrence match and their slices are
contiguous. Mixed subjects produce multiple fragments, never one broad host range.

A captured comment retains the rendered quote and the observed source identities.
Exact ranges are admissible only against matching source evidence. Later edits
use the existing quote/identity reconciliation contract; ambiguity stays visible.
Generated-only and derived selections remain honest rendered/result evidence.
The inspector reads the same map and reports why a cell lacks a source range.

## Migration and verification

First preserve projection origins, then emit cells through Markdown transforms
and wrapping. Move copy and comment consumers together, retaining existing
immutable evidence during the transition. Delete obsolete selection-specific
line reconstruction once its consumers migrate; source-line scrolling can retain
its separate navigation purpose.

The shared fixture corpus must include Unicode, escapes/entities, links, lists,
callouts, tables, nested/repeated/fragment embeds, saved views, failed embeds and
truncation. Assert independent expected source slices and copied text, across
widths and selection modes. Exercise actual Detail and Preview selection,
commenting, links and resize with private fixtures. Responsive table and status
component slices use this interface; neither introduces a separate task store,
annotation model or focus system.

### Current migration boundary

Read projections now require a map. Ordinary/fragment embeds, virtual branch
titles and checklist bodies preserve their observed canonical owners. The
Preview loader composes reference expansion and clipping against these maps;
fragment presentation and bounded excerpts retain the full source observation,
including its hash and revision. Reference expansion replays the resolver's
explicit token records and verifies the resulting text. Missing or inconsistent
records produce generated evidence rather than guessed exact anchors.

Relation projections retain both the outer embed and the inner relation-token
occurrence. Detail invalidation includes observed hashes/revisions even when a
hidden-source edit leaves the displayed text unchanged.

Metadata removal, terminal sanitizing, link-label expansion and heading
presentation now operate on mapped documents in both reader paths. The terminal
scanner supplies explicit consumed ranges; tab expansion is atomic. Authored
page aliases retain their whole reference token, generated links retain separate
syntax/destinations, and canonical view-title ownership survives link rendering.
The text-only helpers delegate to these same transformations.

The owned renderer now consumes mapped presentation for paragraphs, headings,
lists, blockquotes, fenced/indented code and supported inline syntax. `DocumentFrame` emits immutable painted
lines, grapheme cells and link geometry from one layout, and provides both linear
and rectangular selection reducers. Source evidence is snapshotted at capture;
wide glyphs remain indivisible, and generated padding is not copied. Code-span
newline normalization and backslash escapes retain their exact consumed slices.

`SourceSpannedMarkdown` exposes `renderedFrame` for these migrated documents.
Folding carries the map through visibility changes and generated disclosures;
checklist controls retain the canonical mark while adding their action link.
Link labels are parsed from authored text in link context, preserving escaped
brackets without recursively autolinking URL labels. Contiguous label cells
serialize as one activation, including labels with several inline styles.
Previously captured frames survive folding and resize unchanged.

Ordinary GFM tables now compile into a shared `TableNode` with mapped cells,
logical cell identities and alignment. Delimiter parsing consumes original
positions; escaped pipes keep their full consumed source slice, including inside
code spans. Column widths are allocated once across the whole table. Viable
widths use a grid; narrow widths use labelled record cards. Empty-first-cell rows
remain independent records. Borders, alignment padding and record labels are
generated. Rendered copy keeps a column separator without copying borders.
Reference-link definitions remain available in table cells and nested prose.

For mapped documents, source-line navigation now asks the same frame for an
intersecting canonical origin; it no longer estimates table rows with the old
renderer after card conversion. The legacy source-line navigation remains only
for readers still lacking observed source evidence during this migration.

Callouts now compose the same attributed rows, including nested panels,
semantic colours, local disclosure and focus. Authored titles retain source
ranges; default labels, rails, icons, truncation and disclosure marks are
explicit generated content. Width-preserving paint layers retain evidence
through callout and embedded-note tinting, including padding. Repeated embedded
occurrences remain distinct. Paragraph separators survive decoration boundaries.
Callout links come from frame cells rather than remeasurement of painted text,
so wrapping does not create extra focus targets.

Inline entities use the [entities decoder](https://github.com/fb55/entities),
with CommonMark's semicolon and numeric-length rules. Each replacement maps
atomically to its consumed UTF-16 slices; multi-codepoint entities and combining
marks remain whole graphemes. Escaped ampersands and code keep their literal
text. Decoded text is sanitized before layout so encoded controls cannot issue
terminal commands. Image alt labels retain authored ranges and reference
definitions; linked images preserve the outer destination. An empty alt label
uses an `Image` link backed by the complete image token.

Resource content now carries its observed provider revision, adapter and
representation identity where supplied. Identical text from different provider
observations cannot be merged into one source range. Fetched Markdown and
filesystem text are source-backed; diagnostic tails are generated at their
construction boundary. Computed content is explicitly derived, with its full
result observation and exact Resource dependency revisions. These do not assert
character ranges inside dependencies whose bytes were not observed.

Unsupported structures still use the existing renderer and expose no
cell frame during migration. This is an explicit unfinished boundary, not an
acceptable final fallback for the required corpus. The full corpus/fallback audit remains ahead.

Unsaved previews carry a draft observation without claiming the saved block's
revision. Async enrichment retains that observation and the separate saved
observations of embedded notes; cancelling restores saved content without
changing already captured draft frames.

The Pi reader composes cell geometry through comment gutters/panels, inline
properties and attention markers. Placements are explicit row/column maps;
text equality at a placed coordinate only checks that clipping did not replace
that glyph. Unclaimed UI cells remain generated. Mouse source-point lookup uses
the displayed frame and rejects a different subject or source observation.
The old Markdown-stripping, string-search and proportional position guesses
have been removed from this selection path. Source-backed scroll mapping also
uses the frame, so Resource metadata cannot claim an article position. The
legacy source-line helper still serves navigation for unobserved presentations.

The pinned terminal callback now supplies normalized half-open row/column ranges,
the originating ScrollView, the exact layout output identity and frozen copied
lines. Detail clipboard capture accepts only the corresponding displayed frame;
even a later identical-text render cannot replace its evidence. Mouse bounds,
linear selection and rectangular selection use the same range reducer. Table
copy retains spacing between values and excludes drawn borders. Non-reader
surfaces retain ordinary rendered copying. Generated UI text may be copied,
but remains generated evidence; it does not acquire source anchors.

Mapped Detail and Tree Preview captures now carry an `AnnotationPassage` into the existing
single-thread composer and annotation service. The passage preserves one rendered
quote, interned immutable document observations, separate source slices with quote
context, atomic references, occurrence paths and explicit generated/derived evidence.
Normalization checks hashes, bounded UTF-16 quotes, context and document references;
malformed evidence cannot silently become a broad anchor. No copied-text search is
used for this path. The outer rendered target remains unpositioned: exact positions
belong to its separate source fragments, never to a fabricated encompassing range.

The socket regression saves one comment with two repeated embedded occurrences,
replays its idempotency key, replies, edits the source and restarts the service. It
checks retained evidence and rejects corrupt observations. Each resolution event now
retains independent fragment positions, candidates and occurrence results. Matching
hashes retain exact offsets. A changed hash removes stale positions before invoking
the existing deterministic quote ladder: text coincidentally remaining at the old
offset cannot resolve an ambiguous quote. Unsaved observations remain unsupported;
unavailable sources remain unresolved. Partial failures retain other proven slices
without claiming the whole passage is resolved. Repeated unchanged reconciliation
adds no history event.

Source-subject queries can discover a passage without duplicating its comment block.
Original Resource observations and resolution evidence retain web/PDF artifacts even
when the owning comment belongs to a host block. Targeted collection filters evidence
by artifact ownership, not by the comment's root subject. The persistence migration
adds an optional passage-resolution column to append-only resolution events; legacy
events retain their previous contracts. Whole-target manual approval cannot silently
discard a passage's independent fragments.

Passage comments now place their gutter controls from matching cells at the final
reader width. Matching requires the current source hash, exact source ownership,
range overlap and the resolved host-token/path identity; a second identical embed
does not inherit the first occurrence's comment. Discontiguous passages share one
thread and panel, with a marker beside each separate visible span. Colliding
comments keep independently operable controls. Selecting a thread highlights only
its proven cells, including individual table cells after grid/card conversion.
An unresolved fragment does not discard another fragment's valid placement.

Checklist source slices retain service-admitted item IDs. The annotation transaction
uses the existing checklist identity allocator, updating a source note once even
when a selection spans several anonymous items. It preserves captured bytes and
replays its own ID insertions into the initial exact positions. Later wording changes
retain a task attachment while displaying the original quote; they do not make the
new words an exact quote match. Missing or duplicate IDs remain unresolved.

Tree Preview carries the shared reader frame through its viewport, gutter and
scroll offsets. Pointer and keyboard ranges consume that displayed frame without
re-rendering or searching copied text. Completed captures survive resizing; an
in-progress selection expires when its document or layout changes. The old
untransformed-line identity shortcut has been removed. Resource and saved-source
readers supply their observed text to the same frame, while generated diagnostics
remain generated evidence.

The private `test/e2e/rendered-passage.ts` journey exercises native terminal drag,
clipboard output, comment composition/save, canonical read-back and comment
navigation. It verifies that a comment made on the second repeated embed retains
that occurrence and appears there. Saving assigns a stable ID to the selected task;
rewording that task preserves its attachment and original quote at the second
occurrence. The host note remains unchanged. `test/e2e/local-preview-comments.ts`
also exercises wrapped pointer selection, resizing before save, keyboard selection,
reply/lifecycle actions and reopening the same discussion in Detail. Service
read-back verifies the separate source fragments and immutable rendered quote.
This is attached-terminal input proof, not physical-device shortcut validation.

Comment navigation reveals containing folds from matching source/occurrence
origins before layout, leaving identical sibling embeds collapsed. Saved-version
readers may use a matching historical resolution or the original captured source
positions; current readers still require current resolution. Resource matching
also checks the provider revision and adapter, not merely equal text.

Resource pointer comments now use terminal-normalized frame ranges, including
separate fragments across Markdown transforms. The endpoint-to-source-range path
has been removed. Tree Preview and Resource Detail share the rendered-target
builder: one outer rendered quote, with exact positions only in passage fragments.
Resource captures preserve reference context, and the reader applies occurrence
scope before placing a passage. The service accepts rendered Resource evidence
only with a normalized captured passage; older provider-backed targets retain
their original evidence checks. The socket regression covers persistence and
restart, and the native application journey copies bold/entity text, saves its
comment and displays its marker beside the Resource passage.

Contextual Resource passage reconciliation uses the existing reference-context
resolver. A unique host line can move without losing its comment; duplicate host
lines make the context ambiguous, and deleting one duplicate does not guess which
survived. The original capture stays immutable and repeated reconciliation is
idempotent. Exact Resource fragments remain independently recorded even when the
outer host occurrence becomes unpositioned.

### Developer inspector

In the Pi Detail actions menu (`?`), choose **Inspect rendered provenance**.
The inspector freezes the focused Current or local Preview body's painted frame.
Arrow keys move a cell cursor; clicking the three-line context strip chooses a
cell. Wide graphemes keep one identity across both columns. Page Up/Down or the
wheel scroll the evidence; Escape or Ctrl+Q closes only the inspector. The context
strip pans horizontally when needed without reflowing the captured frame.

The report includes the rendered glyph, copy eligibility, origin kind, observed
subject/hash/revision, UTF-16 slices, reference destination, and occurrence host
and nested token path. Derived results show their observations and dependencies;
generated cells show their reason. Source excerpts are bounded to 512 code units,
with complete range/identity metadata retained in the report. Inspecting does not
fetch current source, change a note, activate links or perform ordinary edits.
Resize changes the inspector layout, not its captured evidence. The ANSI reader
reports this Pi-specific inspection requirement rather than inventing a cell map.

The native journey checks decoded Resource entities against their authored bytes,
generated gutter cells, focused Preview ownership and returning to the reader.
This is attached-terminal input proof, not physical-device validation.

### Annotation consumer cutover

Legacy exact comments now use the same source-cell matcher as multi-source
passages. The reader admits an exact current or historical target, then matches
its subject, hash, provider identity and range against visible cells. A quote
near the end of a wrapped paragraph gets its marker beside the quote, rather
than the paragraph opening. Hidden link destinations have no matching cells;
their comments remain reachable as unpositioned comments. Comment groups no
longer carry source-line coordinates or derive layout spans from them.

Source-selection and composer highlights also consume cells, not text searches.
Decoded entities and formatted words retain their original ranges. A captured
passage matches its immutable observations and occurrence paths without creating
a saved resolution event. Stale draft hashes never borrow newer coordinates.
The selection gutter reserves width before wrapping; adding its marker does not
truncate the end of a previously full line. Resource fixtures carry the exact
rendered provider observation, including PDF Markdown.

The attention decorator remains for agent attention cues only; it is no longer
an annotation-selection consumer. Source-line helpers still support explicit
source-editor navigation and scroll restoration, not comment placement or
rendered-selection capture. ANSI retains an appended comment-evidence list and
explicit source-editor navigation; it does not place inline source gutters from
that list. Its row indexes address the appendix itself, not authored ranges.

### Saved observations and identity insertion

A saved Inbox before-image retains its attempt ID, source timestamp, hash and
revision in each captured document. The service checks that evidence against
the preserved receipt. Reading or commenting on that version never authorizes
assigning task IDs in today's note, even when their text happens to match.

Live checklist comments can assign stable IDs in the same transaction as the
comment. That transaction records its actual insertions and replays them for
every affected captured source slice and occurrence token. Repeated embeds do
not become ambiguous merely because the service inserted an ID earlier in the
host. Original observations remain immutable; later unrelated edits still use
the quote fallback, retaining ambiguity where identity cannot be established.

Protocol 81 carries passage observations and resolutions. Upgrade the service
and readers together; the database preserves older annotation representations.

### Shared table and status component example

`component:status` fences can use the installed declarative renderer in
[the status-summary package](../extensions/status-summary/README.md). Its
`label :: value` rows compile to the same attributed glyphs and immutable frame
as ordinary table cells. Wide layouts place values side by side; narrow layouts
stack and wrap them. Inline formatting and links retain source slices and link
identity across widths, including wide Unicode labels.

This first presentation contract is bounded local JSON, separate from Resource
fetching. The package chooses the host's `labelled-values` layout. Compilation
reads installation enablement and manifest version; resizing a compiled document
performs no I/O, network call, model judgment or note mutation. A missing,
disabled or invalid renderer shows a reason and the original fenced text.

Source-backed values remain exact; producer-supplied derived values keep result
identity and dependency observations. Label separators and other presentation
punctuation are generated, even when included in useful copied text. Comments
use the existing passage capture and persistence path. The native journey shows
the component beside an ordinary table in Detail and Tree Preview, resizes it,
and captures a comment whose label and value are discontiguous source slices.

The PIE-382 lifecycle journey additionally verifies a separately installed
manifest, disable/remove/re-enable without rebuilding, editing fallback source,
source export through the external editor, live note-value changes, and Inbox Preview link/copy/comment
behavior across resize. Reopening a note compiles changed installation settings;
resize does not reread them. General executable renderers, installation UI and
automatic configuration watching are outside this first slice. There is one
declarative layout, with no second task store or UI focus tree.

### Renderer ownership decision

Use an Outliner-owned attributed Markdown renderer with PiTUI's terminal width,
grapheme and style primitives. Compile the mapped presentation into attributed
nodes and emit one immutable frame containing lines, source cells and interaction
regions. Layout must wrap attributed graphemes before serializing terminal styles.
Detail and Preview share this frame; viewport and annotation gutters compose it.

Theme callbacks cannot supply exact evidence: they have no source-token identity,
and tables invoke them during both measurement and painting. Attaching counters
or matching repeated text would reintroduce the ambiguity this work removes. A
mapped PiTUI fork would also need parser, table, wrapping and cache changes. The
near-term owned tables (PIE-169) and responsive components (PIE-382) make owning
this layer useful to multiple concrete callers.

Reuse syntax recognition where it preserves explicit consumed positions. Never
recover lost inline positions by searching the rendered result. Keep folding,
checklist actions and annotation reconciliation in their existing domain owners;
this change does not introduce a general UI framework or another document store.

Checklist results retain their view query and matched source-item header (excluding status and fragment ID) in the occurrence path. A child displayed within its parent result stays distinct from the same child displayed as an independent result, including when the entire view is embedded. Edits to the matched header use the ordinary conservative quote reconciliation; result order is never an identity.


### Catalog/spec/renderer comparison

[json-render's documented separation](https://json-render.dev/docs) distinguishes
an allowed component catalog, a declarative specification, and platform-specific
implementations. The useful pattern here is the separation of data from rendering;
adopting its generated element tree is unnecessary for one authored summary.

For this slice, the installed manifest selects a supported host layout, the
readable fence supplies the specification, and the existing pi-tui document frame
is the platform binding. This is our adaptation of that separation, not a
json-render-compatible spec. A second React/Ink tree would duplicate selection,
focus and provenance ownership without improving the current acceptance path.
Keep producer execution and future action capabilities outside this presentation
contract; reconsider a richer catalog when a second layout needs one.

Installation decisions are retained per document load, including failures, and
shared with folded and callout layouts. Preview may rebuild its layout for a new
width, focus or theme, but reuses those decisions. New source content or reopening
creates a fresh catalog. Rendered frames still contain newly measured geometry
and current source data; no cache of source observations is introduced.
