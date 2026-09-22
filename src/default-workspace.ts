export const DEFAULT_WORKSPACE_SEED_VERSION = 5;
export const AGENT_DOCUMENTATION_SYSTEM_DOC = "agent-documentation-guide";
export const AUTHORED_LINKS_EXAMPLE_SYSTEM_DOC = "authored-links-example";
export const FEATURE_TOUR_SYSTEM_DOC = "feature-tour";

interface SeedBlock {
  readonly id: string;
  readonly revision: number;
}
interface DefaultWorkspaceSeedWriter {
  create(text: string, parentId: string | null): SeedBlock;
  update(block: SeedBlock, text: string): SeedBlock;
  select(blockId: string): void;
}

const DOCUMENTATION_SECTIONS = [
  {
    key: "core-model",
    title: "Core model",
    lines: [
      "A canonical block is the durable source of one thought unit.",
      "",
      "- Physical parentage answers where material is owned and maintained.",
      "- An exact reference connects canonical blocks without copying content.",
      "- A transclusion composes canonical material into a reader document.",
      "- Block-scoped properties classify independently queryable roots.",
      "- A virtual branch projects matching canonical blocks; it is a view, not another home.",
      "",
      "Complete when every claim has one canonical owner and every other appearance is a reference, transclusion, or projection.",
    ],
  },
  {
    key: "operating-flow",
    title: "Operating flow",
    lines: [
      "1. Inspect `outliner_property_catalog`, then query by project, type, topic, and title before creating anything.",
      "2. Read complete candidate blocks and their subtrees. Narrow structured queries until `completeness.kind` is `complete`.",
      "3. Update the existing canonical block when the claim is the same. Create a child or sibling when the material needs independent ownership or reuse.",
      "4. Put each new block under its physical owner, then connect it to other contexts with references or transclusions.",
      "5. Put routing metadata in the subject-line trailing property run or the first contiguous property-only run after the subject.",
      "6. Re-query the exact block and containing subtree after mutation. Read omitted presentation results before judging the set.",
      "",
      "Complete when no duplicate source exists, the physical path names the owner, and every collection used for the decision is complete.",
    ],
  },
  {
    key: "splitting-documents",
    title: "How to split documents",
    lines: [
      "Keep a block intact when its paragraphs form one claim, procedure, decision, example, or short list.",
      "",
      "Split when a section needs its own stable reference, independent revision history, metadata, reuse, movement, or collapse boundary. Use the physical tree as the document outline: a reader parent, section children, and grandchildren only for real drill-down.",
      "",
      "Use a stable fragment when the passage must remain locally coherent but needs a precise target: `## Failure recovery ^failure-recovery`.",
      "",
      "Complete when each block can be named in one sentence and independently updated without rewriting unrelated material.",
    ],
  },
  {
    key: "references",
    title: "References, fragments, and transclusions",
    lines: [
      "- Reference a canonical block with its full UUID: `((block-id))` or `((block-id|label))`. The label changes presentation, not identity.",
      "- Address a stable passage with `((block-id^fragment-id|label))`. Fragment IDs must be unique inside the block.",
      "- Compose a reader document with `!((block-id))` or `!((block-id^fragment-id))`. Generated content is read-only and refreshes after source changes.",
      "- Register a human-facing symbolic address with `[page::address]` and reference it as `[[address]]`.",
      "",
      "Generated embeds are non-recursive, report failures or truncation explicitly, and are bounded to 16 per document.",
      "",
      "Complete when changing the source updates every composed reading surface without copied prose.",
    ],
  },
  {
    key: "resources",
    title: "Resources",
    lines: [
      "A Resource gives file-backed or external material a stable UUID without creating a wrapper block.",
      "",
      "- `[file::docs/plan.md]` addresses a local file.",
      "- `[file::user@example-host/path/to/file.md]` addresses an SSH application deep link.",
      "- `[web::https://example.com/guide]` addresses a website.",
      "- `[jira::EXAMPLE-1]` addresses an issue through a configured Jira Source.",
      "- `[app::scheme://authority/namespace/item]` addresses a generic application deep link.",
      "",
      "Showing authored Resource rows and moving selection are read-only. Press Enter to resolve or intern an unregistered Resource only when navigating.",
      "",
      "Filesystem text and cached web/PDF text support source-backed comments. Direct Detail comments on metadata fields or computed/remote-entity Markdown are not available yet. Application Resources expose metadata and external-open behavior but do not fabricate local content.",
      "",
      "Authored Resource properties are actionable in Detail. Each reference occurrence has its own context and annotations, even when several references share the same Resource. Removing a reference leaves its annotations recoverable instead of assigning them to another mention.",
    ],
  },
  {
    key: "virtual-branches",
    title: "Virtual branches",
    lines: [
      "A virtual branch is one ordinary canonical definition block with exactly one `[type::virtual-branch]` and one `[query::…]`. Its matched rows are disposable occurrences of canonical blocks.",
      "",
      "```text",
      "Active project documents",
      "[type::virtual-branch]",
      "[query::type=project-doc doc-status=active]",
      "[sort::updated]",
      "[direction::desc]",
      "[limit::50]",
      "```",
      "",
      "Queries are positive AND clauses using property presence or case-insensitive exact equality. Context projects through relative depth 2, roots and context share a 1000-row budget, and nested branches stop at four boundaries.",
      "",
      "Add `[create::key=value]` and `[create-parent::<canonical-parent-id>]` only when branch creation has one clear canonical destination. Rank only unsorted branches with `outliner_branch_rank`.",
      "",
      "Complete when every projected row traces to one physical canonical block and no view owns unique prose.",
    ],
  },
  {
    key: "mutation-discipline",
    title: "Agent mutation discipline",
    lines: [
      "Use `outliner_capture` for raw intake, `outliner_publish` for durable typed artifacts, and `outliner_create` for ordinary canonical sections.",
      "",
      "Read before writing. Use `outliner_update` with the version read and `outliner_property_patch` for metadata-only changes. Use `outliner_move` when canonical physical organization changes; categorization belongs in properties and virtual branches.",
      "",
      "Use `outliner_work_id` and `outliner_roadmap_create` for actual work records rather than imitating their metadata in documentation. Preserve source notes and connect promoted documentation back to them.",
      "",
      "Complete when the mutation is optimistic, provenance remains visible, and unrelated text, selection, and presentation state are unchanged.",
    ],
  },
  {
    key: "completion",
    title: "Completion checklist",
    lines: [
      "- Existing owners were searched before creation.",
      "- Each authoritative claim exists once under the physical parent responsible for maintaining it.",
      "- Reader documents transclude section blocks instead of copying prose.",
      "- Exact references resolve to the intended UUID and fragments are unique.",
      "- Properties use existing vocabulary and sit on the roots intended to match.",
      "- Every virtual branch is bounded, reports complete or explicit truncation, and contains no unique source content.",
      "- Post-write queries are complete and the published subtree has the intended order without duplicate siblings.",
      "",
      "Only then report the documentation update complete.",
    ],
  },
] as const;

const FEATURE_TOUR_SECTIONS = [
  {
    key: "navigation", title: "Find and keep your place",
    lines: [
      "These are default keys. Press `?` for the actions and configured bindings available in the current mode.",
      "",
      "- In Tree, `g` opens searchable Goto with a selected-result preview. Try `outliner-tour` or words from a note; a UUID is not required.",
      "- Goto: arrows choose a result, Enter reveals it in Tree, Alt+Enter opens Detail, and Esc cancels without changing your place. Jev optionally ranks a bounded set of text candidates; text search still works without it.",
      "- Tree cursor movement previews in an unlocked Detail. `L` in Detail toggles the distinct 🔓 / 🔐 lock states; a locked reader keeps its target.",
      "- `.` expands the selected Tree occurrence's inline preview. Other appearances of the same block keep their own expansion state.",
      "- `m` bookmarks a block and `Shift+M` opens the bookmark navigator. A pointer click selects; deletion is an explicit action.",
      "- Option/Alt+Up and Down reorder eligible siblings or unsorted virtual-branch roots. Option/Alt+Shift+Right and Down open independent Details.",
    ],
  },
  {
    key: "capture-inbox", title: "Capture first, organize in the background",
    lines: [
      "Quick Capture saves an ordinary note into Inbox. In its popup, Enter inserts a newline, Ctrl+S saves, and Esc retains the draft. Pi/OMP also provides `/capture` and `/send-to-outline`; the latter saves the last completed response as canonical Markdown.",
      "",
      "When the service's Pi model is configured, the automatic Inbox editor processes eligible captures. It can clean prose, split mixed ideas, consolidate duplicates and link context. Lists, meetings and personal thoughts remain notes. Actual Outliner work uses the allocator and starts in Backlog; cleanup does not commit it to a batch.",
      "",
      "Press Shift+I in Tree. It opens on Needs attention when questions or errors remain, otherwise on Recent results. `a` switches those views; the footer shows the destination and your configured key. `p` pauses/resumes, Left/Right pages history, `u` undoes an eligible result, and `r` gives direction for reconsideration. Closing the view leaves processing running. Undo refuses to overwrite later edits or references.",
      "",
      "This is an exploratory editorial agent, not a guarantee of correct classification. Results, source/output links, errors and model usage remain inspectable. Without model configuration, capture, history and recovery remain available.",
    ],
  },
  {
    key: "prompts", title: "Tune the AI instructions",
    lines: [
      "The service seeds editable `prompts/inbox-editor.md`, `prompts/inbox-relationships.json` and `prompts/goto-ranking.json` beneath this workspace's state directory. `OUTLINER_PROMPT_DIR` can select a different complete directory.",
      "",
      "Create ordinary file Resource references to those runtime files, open in Detail, press e, and save with Ctrl+S. Use the service host's paths, including when the client is remote. Packaged defaults in a source checkout are not the live workspace configuration.",
      "",
      "Saving changes the next Inbox job or eligible Goto search without rebuilding or restarting. A running job retains its captured prompts. New Inbox results show prompt hashes and keep the full instructions used; agents retrieve a full receipt with `inbox.result`.",
      "",
      "Edit the wording, keeping the JSON keys and four Goto score levels. Invalid files show their name and cause instead of using stale instructions. Fix the file, then Resume Inbox or run another search. App upgrades preserve existing prompt files.",
    ],
  },
  {
    key: "reading-comments", title: "Read, edit and annotate canonical content",
    lines: [
      "References `((UUID|label))` and `[[address]]` point to existing canonical content; `!((UUID))` embeds a read-only presentation. A label changes display, not identity. An exact reference can also address a stable `^fragment`.",
      "",
      "In Detail, e edits the current document. Ctrl+S saves with the revision originally read; Esc cancels the editing session. Ctrl+E hands off to your configured external editor. A stale draft is rejected instead of replacing someone else's edit.",
      "",
      "Drag a rendered passage and press c to comment on that source range. The keyboard v path begins source-line selection. A comment without a positioned range remains inspectable as an unpositioned comment; these entry points have not been unified. Existing threads support replies, resolution/reopening and source navigation.",
      "",
      "Several mentions of the same file share a Resource target but can retain distinct occurrence annotations. Removed or ambiguous occurrences stay recoverable rather than silently moving a comment to the next mention.",
    ],
  },
  {
    key: "resources", title: "Follow files and external Resources",
    lines: [
      "From Tree's ? menu, Show authored links reveals Outlinks and Resources for the selected occurrence. It has no default key; configure one if useful. Enumeration is read-only; Enter on an unresolved authored target follows or registers it.",
      "",
      "Filesystem Resources support preview, edit/save, refresh, external editing and source-backed comments through the service's files. Cached web/PDF text also supports comments. Computed and remote-entity views expose retained representations and revision information, but direct Detail comments on their text or metadata fields are not available yet.",
      "",
      "Opening cached Web content does not fetch the network; refresh is explicit. Provider credentials, Source configuration and capabilities determine available actions. SSH-style file references are application links, not an SSH file provider.",
      "",
      "A locked Detail is an anchor. Detail's authored Resource links can use its destination chooser. Tree-generated Resource activation does not yet offer that chooser. Closing a view does not delete its Resource or annotations.",
    ],
  },
  {
    key: "workboard", title: "Separate possible work, commitment and delivery",
    lines: [
      "Backlog contains candidates; Later is an explicit deferral. The next agreed block of work is batch membership, not a promise to execute the visible list in order.",
      "",
      "A roadmap item's work-stage records queued → doing → review → validate → done, with superseded for retired work. Review means an implementation awaits review; Validate means it is merged and awaits acceptance. Roadmap items do not also carry a competing lifecycle status.",
      "",
      "One work-batch reference retains commitment while stages change. Rank guides order; dependencies constrain it. Newly discovered work stays outside the commitment until chosen. Small standalone fixes need no batch ceremony.",
      "",
      "Agents use the roadmap allocator and delivery operations rather than guessing Work IDs. Establish the project's work queue and read its live workboard contract first; this tour does not create a project backlog or reserve a prefix for you.",
    ],
  },
  {
    key: "surfaces", title: "Use linked panes or the combined-surface experiment",
    lines: [
      "Normal Tree and Detail are separate Herdr panes. A project-scoped SSH socket configuration lets them use a remote service while other projects stay local; start the tunnel before opening that remote workspace.",
      "",
      "The opt-in Herdr action `open-composed` places Tree and Detail in one application-owned surface. F6 switches regions; q returns from Detail to Tree. Selection, history, scroll, drafts and lock state remain distinct for each region.",
      "",
      "Independent references and editors can still open in Herdr panes. The combined layout is a fixed split experiment: orientation switching, interactive resizing and multiple embedded Details are not shipped. Browser pane prototypes are separate experiments, not an installed web UI.",
      "",
      "Closing a pane closes a view. It never means deleting the underlying block, file, Resource or annotation. Save or cancel active drafts before closing.",
    ],
  },
] as const;

function sectionText(section: (typeof DOCUMENTATION_SECTIONS)[number]): string {
  return [
    `${section.title} [type::project-doc-section] [guide-section::${section.key}]`,
    "",
    ...section.lines,
  ].join("\n");
}

export function seedDefaultWorkspace(writer: DefaultWorkspaceSeedWriter): void {
  const workspace = writer.create("Workspace [type::workspace]", null);
  const documentation = writer.create("Documentation [type::documentation]", workspace.id);
  const guideTitle = `Managing project documentation [type::project-doc] [system-doc::${AGENT_DOCUMENTATION_SYSTEM_DOC}] [seed-version::${DEFAULT_WORKSPACE_SEED_VERSION}] [page::outliner-documentation-guide]`;
  const guide = writer.create(guideTitle, documentation.id);
  const sections = DOCUMENTATION_SECTIONS.map((section) => ({
    definition: section,
    block: writer.create(sectionText(section), guide.id),
  }));
  const virtualBranchesSection = sections.find(({ definition }) =>
    definition.key === "virtual-branches"
  );
  const referencesSection = sections.find(({ definition }) =>
    definition.key === "references"
  );
  if (!virtualBranchesSection) throw new Error("Default documentation seed is missing virtual branches");
  if (!referencesSection) throw new Error("Default documentation seed is missing references");

  writer.update(guide, [
    guideTitle,
    "",
    "The physical tree owns documentation. References connect it. Transclusions compose it. Properties classify it. Virtual branches project it.",
    "",
    `Read ((${virtualBranchesSection.block.id}|Virtual branches)) before defining a saved documentation view.`,
    "",
    ...sections.flatMap(({ block }) => [`!((${block.id}))`, ""]),
  ].join("\n").trimEnd());
  const authoredLinksGuideUrl =
    "https://github.com/float-ritual-stack/pi-herdr-outliner/blob/main/README.md";
  writer.create([
    `Authored links example [type::example] [system-doc::${AUTHORED_LINKS_EXAMPLE_SYSTEM_DOC}] [page::outliner-authored-links-example]`,
    "",
    "Select this block in Tree, open the action menu with `?`, and invoke `Show authored links`.",
    "",
    `- Existing block: ((${referencesSection.block.id}|References guide))`,
    "- Unregistered page: [[Planning scratchpad]]",
    "- Local file Resource: [file::README.md]",
    `- Web Resource: [web::${authoredLinksGuideUrl}]`,
    "- SSH application Resource: [file::user@example-host/path/to/file.md]",
    "- Jira Resource: [jira::EXAMPLE-1]",
    "",
    "Showing the generated Outlinks and Resources branches is read-only. Press Enter on an unregistered page or Resource to create it only when navigating.",
    "",
    "The local file must exist before activation. The SSH example is an external application link, and the Jira example requires one configured Source for project `EXAMPLE`.",
  ].join("\n"), documentation.id);

  const tourTitle = `Explore the Outliner [type::project-doc] [system-doc::${FEATURE_TOUR_SYSTEM_DOC}] [seed-version::${DEFAULT_WORKSPACE_SEED_VERSION}] [page::outliner-tour]`;
  const tour = writer.create(tourTitle, documentation.id);
  const tourSections = FEATURE_TOUR_SECTIONS.map(section => writer.create([
    `${section.title} [type::project-doc-section] [tour-section::${section.key}] [page::outliner-tour-${section.key}]`,
    "", ...section.lines,
  ].join("\n"), tour.id));
  const example = writer.create([
    "A canonical source note [type::example] [demo-set::feature-tour] [demo-kind::source] [page::outliner-tour-example]",
    "", "## Shared context ^context", "",
    "This is one ordinary editable note. References, embeds and the ranked example view below point here rather than maintaining another copy.",
  ].join("\n"), tour.id);
  const reader = writer.create([
    "A reader with two references [type::example] [demo-set::feature-tour] [demo-kind::reader]",
    "", `Read ((${example.id}|the canonical note)) or just its ((${example.id}^context|shared context)).`,
    "", `!((${example.id}^context))`,
  ].join("\n"), tour.id);
  const exampleView = writer.create([
    "Ranked example notes [type::virtual-branch] [query::demo-set=feature-tour] [limit::10]",
    "[summary-properties::demo-kind]",
  ].join("\n"), tour.id);
  writer.update(tour, [
    tourTitle, "",
    "Start here for the current interaction model. Press g in Tree and search outliner-tour to return. Expand this block for individual guides and working examples; ? shows your current actions and bindings.",
    "",
    `Try ((${example.id}|a source)), ((${reader.id}|its composed reader)), and ((${exampleView.id}|the ranked projection)). Move an unsorted projected root with Option/Alt+Up or Down; the source keeps its physical parent. These example notes are not roadmap tasks or Inbox jobs.`,
    "",
    `For agent documentation ownership, read ((${guide.id}|Managing project documentation)).`,
    "", ...tourSections.flatMap(block => [`!((${block.id}))`, ""]),
  ].join("\n").trimEnd());

  writer.create([
    "Project documentation [type::virtual-branch]",
    "[query::type=project-doc]",
    "[create::type=project-doc]",
    `[create-parent::${documentation.id}]`,
    "[limit::100]",
    "[summary-properties::project,doc-status]",
  ].join("\n"), documentation.id);
  writer.create("Notes [type::notes]", workspace.id);
  writer.create("Open Questions [type::questions] [status::open]", workspace.id);
  writer.create("Decisions [type::decisions]", workspace.id);
  writer.create("Progress Log [type::progress-log]", workspace.id);
  writer.select(workspace.id);
}
