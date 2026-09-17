import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTHORED_LINKS_MAX_ENTRIES_PER_GROUP,
  AUTHORED_LINKS_MAX_TEXT_UNITS,
  readAuthoredLinks,
} from "../src/authored-links";
import { OutlinerStore } from "../src/store";

function withStore(run: (store: OutlinerStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-authored-links-"));
  const store = new OutlinerStore(join(directory, "outliner.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("enumerates existing Outlink forms and exact Resource links without passive loading", () => {
  withStore((store) => {
    store.configureWorkIdPrefix("PIE");
    const blockTarget = store.create("Block target");
    const pageTarget = store.followPageAddress("Release checklist").block;
    if (!pageTarget) throw new Error("Expected page fixture");
    const workTarget = store.create("Work target [work-id::PIE-001]");
    const source = store.resources.createSource({
      name: "Protocol docs",
      provider: "web",
      boundary: { baseUrl: "https://example.test/" },
    });
    const resource = store.resources.intern({
      sourceId: source.id,
      address: { kind: "web", url: "https://example.test/guide" },
    }).resource;
    const exactResourceLink = `pi-outliner://resource/${resource.id}`;
    const missingResourceId = "33333333-3333-4333-8333-333333333333";
    const owner = store.create([
      `((${blockTarget.id}))`,
      "[[Release checklist]]",
      "PIE-001",
      `[Guide](${exactResourceLink})`,
      `[Later label](${exactResourceLink})`,
      `\`[Inline code](${exactResourceLink})\``,
      "```md",
      `[Fenced code](${exactResourceLink})`,
      "```",
      "",
      `    [Indented code](${exactResourceLink})`,
      `![Image](${exactResourceLink})`,
      `[resource::${resource.id}]`,
      exactResourceLink,
      `[Missing](pi-outliner://resource/${missingResourceId})`,
      `[Unsupported](pi-outliner://resource/${resource.id}?revision=2)`,
    ].join("\n"));
    const sequenceBefore = store.sequence;

    const result = readAuthoredLinks(store, owner.id);

    expect(store.sequence).toBe(sequenceBefore);
    if (result.kind !== "ready") throw new Error(`Expected ready result, got ${result.kind}`);
    expect(result.outlinks.entries.map((entry) => entry.referenceKind)).toEqual([
      "block",
      "page",
      "work-id",
    ]);
    expect(result.outlinks.entries.map((entry) =>
      entry.resolution.kind === "ready" ? entry.resolution.target.blockId : null
    )).toEqual([blockTarget.id, pageTarget.id, workTarget.id]);
    expect(result.resources.entries).toHaveLength(2);
    expect(result.resources.entries[0]).toMatchObject({
      label: "Guide",
      occurrenceCount: 2,
      resolution: {
        kind: "ready",
        target: { kind: "resource", resourceId: resource.id },
        sourceName: "Protocol docs",
        provider: "web",
      },
    });
    expect(result.resources.entries[1]).toMatchObject({
      resourceId: missingResourceId,
      resolution: { kind: "missing" },
    });
    expect(result.resources.invalidCount).toBe(1);
    expect(result.resources.diagnostics[0]?.message).toContain("canonical UUID");
  });
});

test("preserves unresolved page addresses without registering them during enumeration", () => {
  withStore((store) => {
    store.configureWorkIdPrefix("PIE");
    const owner = store.create("[[Future Page]]\nPIE-999");
    const sequenceBefore = store.sequence;

    const result = readAuthoredLinks(store, owner.id);

    expect(store.sequence).toBe(sequenceBefore);
    if (result.kind !== "ready") throw new Error(`Expected ready result, got ${result.kind}`);
    expect(result.outlinks.entries).toEqual([
      expect.objectContaining({
        referenceKind: "page",
        resolution: {
          kind: "unregistered-page",
          address: "Future Page",
          reason: "Page is not registered: Future Page",
        },
      }),
      expect.objectContaining({
        referenceKind: "work-id",
        resolution: {
          kind: "missing",
          reason: "Work ID is not registered: PIE-999",
        },
      }),
    ]);
  });
});

test("caps each authored-link group and reports incomplete results", () => {
  withStore((store) => {
    const targets = Array.from(
      { length: AUTHORED_LINKS_MAX_ENTRIES_PER_GROUP + 1 },
      (_, index) => store.create(`Target ${index + 1}`),
    );
    const owner = store.create(targets.map((target) => `((${target.id}))`).join("\n"));

    const result = readAuthoredLinks(store, owner.id);

    if (result.kind !== "ready") throw new Error(`Expected ready result, got ${result.kind}`);
    expect(result.outlinks.entries).toHaveLength(AUTHORED_LINKS_MAX_ENTRIES_PER_GROUP);
    expect(result.outlinks.completeness).toEqual({
      kind: "limited",
      reason: "entry-limit",
      shown: AUTHORED_LINKS_MAX_ENTRIES_PER_GROUP,
    });
  });
});

test("rejects oversized owner text before parsing a valid-looking prefix", () => {
  withStore((store) => {
    const target = store.create("Target");
    const owner = store.create(
      `((${target.id}))${"x".repeat(AUTHORED_LINKS_MAX_TEXT_UNITS)}`,
    );

    expect(readAuthoredLinks(store, owner.id)).toEqual({
      kind: "source-too-large",
      ownerId: owner.id,
      maximumUtf16Units: AUTHORED_LINKS_MAX_TEXT_UNITS,
    });
  });
});
