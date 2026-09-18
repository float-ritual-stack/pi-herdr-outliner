import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAuthoredLinks } from "../src/authored-links";
import {
  AGENT_DOCUMENTATION_SYSTEM_DOC,
  AUTHORED_LINKS_EXAMPLE_SYSTEM_DOC,
  DEFAULT_WORKSPACE_SEED_VERSION,
} from "../src/default-workspace";
import { getProperty } from "../src/properties";
import { OutlinerStore } from "../src/store";
import {
  isVirtualBranchOccurrence,
  projectVirtualBranches,
} from "../src/virtual-branches";

const EXPECTED_GUIDE_SECTIONS = [
  "core-model",
  "operating-flow",
  "splitting-documents",
  "references",
  "virtual-branches",
  "mutation-discipline",
  "completion",
];

test("seeds and preserves an agent-readable documentation workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-default-workspace-"));
  const path = join(directory, "outliner.sqlite");
  let store: OutlinerStore | null = new OutlinerStore(path);

  try {
    const guideCollection = store.queryBlocks({
      filters: [{ key: "system-doc", value: AGENT_DOCUMENTATION_SYSTEM_DOC }],
      limit: 2,
    });
    expect(guideCollection.completeness).toEqual({ kind: "complete" });
    expect(guideCollection.blocks).toHaveLength(1);

    const guide = guideCollection.blocks[0]!;
    expect(guide.author).toBe("system");
    expect(getProperty(guide.properties, "type")).toBe("project-doc");
    expect(getProperty(guide.properties, "seed-version")).toBe(
      String(DEFAULT_WORKSPACE_SEED_VERSION),
    );
    expect(getProperty(guide.properties, "page")).toBe("outliner-documentation-guide");
    expect(store.resolvePageAddress("outliner-documentation-guide")).toMatchObject({
      status: "resolved",
      kind: "page",
      block: { id: guide.id },
    });
    const authoredLinksExamples = store.queryBlocks({
      filters: [{ key: "system-doc", value: AUTHORED_LINKS_EXAMPLE_SYSTEM_DOC }],
      limit: 2,
    }).blocks;
    expect(authoredLinksExamples).toHaveLength(1);
    const authoredLinksExample = authoredLinksExamples[0]!;
    expect(store.resolvePageAddress("outliner-authored-links-example")).toMatchObject({
      status: "resolved",
      kind: "page",
      block: { id: authoredLinksExample.id },
    });
    const authoredLinks = readAuthoredLinks(store, authoredLinksExample.id);
    if (authoredLinks.kind !== "ready") {
      throw new Error(`Expected ready authored links, got ${authoredLinks.kind}`);
    }
    expect(authoredLinks.outlinks.entries.map((entry) => entry.resolution.kind)).toEqual([
      "ready",
      "unregistered-page",
    ]);
    expect(authoredLinks.resources.entries).toEqual([
      expect.objectContaining({
        label: "https://github.com/float-ritual-stack/pi-herdr-outliner/blob/main/README.md",
        resolution: {
          kind: "unregistered",
          reference: {
            kind: "web",
            url: "https://github.com/float-ritual-stack/pi-herdr-outliner/blob/main/README.md",
          },
          reason: "Web Resource is not registered: https://github.com/float-ritual-stack/pi-herdr-outliner/blob/main/README.md",
        },
      }),
    ]);

    const documentation = store.get(guide.parentId!);
    expect(documentation).not.toBeNull();
    expect(getProperty(documentation!.properties, "type")).toBe("documentation");

    const sections = store.children(guide.id);
    expect(sections.map((block) => getProperty(block.properties, "guide-section"))).toEqual(
      EXPECTED_GUIDE_SECTIONS,
    );
    const embeddedSectionIds = [...guide.text.matchAll(/!\(\(([0-9a-f-]+)\)\)/g)]
      .map((match) => match[1]);
    expect(embeddedSectionIds).toEqual(sections.map((block) => block.id));

    const virtualBranchReference = guide.text.match(
      /Read \(\(([0-9a-f-]+)\|Virtual branches\)\)/,
    );
    expect(virtualBranchReference?.[1]).toBe(
      sections.find((block) => getProperty(block.properties, "guide-section") === "virtual-branches")
        ?.id,
    );

    const documentationChildren = store.children(documentation!.id);
    const branch = documentationChildren.find((block) =>
      getProperty(block.properties, "type") === "virtual-branch"
    );
    expect(branch).toBeDefined();
    expect(getProperty(branch!.properties, "query")).toBe("type=project-doc");
    expect(getProperty(branch!.properties, "create-parent")).toBe(documentation!.id);

    const snapshot = store.readWorkspaceSnapshot();
    const projection = await projectVirtualBranches(
      snapshot.visible.blocks,
      snapshot.physical.blocks,
      async (query) => store!.queryBlocks(query),
      snapshot.virtualOccurrenceRanks,
    );
    expect(projection.branchStates.get(branch!.id)).toMatchObject({
      completeness: { kind: "complete" },
      count: 1,
      queryError: null,
      truncation: { rootQuery: false, depth: false, budget: false },
    });
    expect(
      projection.rows
        .filter(isVirtualBranchOccurrence)
        .filter((row) => row.viewId === branch!.id && row.relativeDepth === 0)
        .map((row) => row.canonicalId),
    ).toEqual([guide.id]);

    const beforeRestartIds = store.traversePreorder({}).map((block) => block.id);
    const locallyEdited = store.update(
      guide.id,
      `${guide.text}\n\nLocal documentation convention.`,
      guide.updatedAt,
      { author: "user" },
    );
    store.close();
    store = new OutlinerStore(path);

    expect(store.traversePreorder({}).map((block) => block.id)).toEqual(beforeRestartIds);
    expect(store.get(guide.id)).toMatchObject({
      id: guide.id,
      text: locallyEdited.text,
      updatedAt: locallyEdited.updatedAt,
    });
    expect(store.queryBlocks({
      filters: [{ key: "system-doc", value: AGENT_DOCUMENTATION_SYSTEM_DOC }],
      limit: 2,
    }).blocks).toHaveLength(1);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
