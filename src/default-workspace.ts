export const DEFAULT_WORKSPACE_SEED_VERSION = 4;
export const AGENT_DOCUMENTATION_SYSTEM_DOC = "agent-documentation-guide";
export const AUTHORED_LINKS_EXAMPLE_SYSTEM_DOC = "authored-links-example";

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
      "Filesystem text, cached web Markdown, and extracted PDF text support source-backed comments. Application Resources expose metadata and external-open behavior but do not fabricate local content.",
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
