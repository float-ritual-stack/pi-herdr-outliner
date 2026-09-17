import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPdfPageRegionAnchor } from "../src/annotations";
import {
  PDFJS_TEXT_ADAPTER,
  PdfJsTextExtractor,
  type PdfTextExtraction,
  type PdfTextExtractor,
} from "../src/pdf-text";
import {
  negotiateResourcePresentation,
  TUI_RESOURCE_PRESENTATION_CONTEXT,
} from "../src/resource-presentation";
import { OutlinerStore } from "../src/store";
import type {
  AnnotationRepresentation,
  PdfResourceDocument,
  ResourceDescription,
} from "../src/types";
import { createPdfFixture } from "./pdf-fixture";

function fixturePdf(revision: number): Uint8Array {
  return createPdfFixture([
    {
      width: 300,
      height: 400,
      lines: [
        { text: `Durable claim revision ${revision}`, x: 36, y: 350 },
        { text: "Page one context", x: 36, y: 326 },
      ],
    },
    {
      width: 500,
      height: 200,
      lines: [{ text: "Second page evidence", x: 48, y: 120, size: 18 }],
    },
  ]);
}

function annotationRepresentation(
  description: ResourceDescription,
): AnnotationRepresentation {
  const pdf = description.pdf;
  if (!pdf) throw new Error("PDF fixture representation is unavailable");
  return {
    id: pdf.representation.id,
    subject: { kind: "resource", resourceId: description.resource.id },
    sourceSnapshot: {
      kind: "resource",
      resourceId: description.resource.id,
      sourceSnapshotId: pdf.sourceSnapshot.id,
      revision: pdf.sourceSnapshot.revision,
    },
    adapter: pdf.representation.adapter,
    mediaType: pdf.representation.mediaType,
    contentHash: pdf.representation.contentHash,
    capturedAt: pdf.representation.derivedAt,
  };
}

function anchorForQuote(pdf: PdfResourceDocument, quote: string) {
  const start = pdf.markdown.indexOf(quote);
  if (start < 0) throw new Error(`Missing PDF fixture quote: ${quote}`);
  const end = start + quote.length;
  const page = pdf.pages.find((candidate) => start >= candidate.start && end <= candidate.end);
  if (!page) throw new Error("PDF fixture quote crosses a page boundary");
  const regions = page.spans
    .filter((span) => span.end > start && span.start < end)
    .map(({ region }) => region);
  return createPdfPageRegionAnchor(pdf.markdown, start, end, page.page, regions);
}

class PrefixedPdfExtractor implements PdfTextExtractor {
  readonly adapter = { id: "fixture.prefixed-pdf-text", version: 2 } as const;
  private readonly base = new PdfJsTextExtractor();

  async extract(bytes: Uint8Array): Promise<PdfTextExtraction> {
    const extraction = await this.base.extract(bytes);
    const prefix = "# Alternate extraction\n\n";
    return {
      markdown: prefix + extraction.markdown,
      pages: extraction.pages.map((page) => ({
        ...page,
        start: page.start + prefix.length,
        end: page.end + prefix.length,
        spans: page.spans.map((span) => ({
          ...span,
          start: span.start + prefix.length,
          end: span.end + prefix.length,
        })),
      })),
    };
  }
}

test("filesystem PDF keeps identity across native/text representations and auditable reanchors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-pdf-"));
  const databasePath = join(directory, "outliner.sqlite");
  const pdfPath = join(directory, "evidence.pdf");
  writeFileSync(pdfPath, fixturePdf(1));
  let store = new OutlinerStore(databasePath, { workspaceRoot: directory });
  try {
    const receipt = store.resources.internFilesystem({ path: pdfPath });
    expect(receipt.resource.mediaType).toBe("application/pdf");
    const first = await store.resources.open(receipt.resource.id, true);
    if (!first.pdf) throw new Error("Filesystem PDF did not produce a local document");
    expect(first.pdf.markdown).toContain("## Page 1");
    expect(first.pdf.markdown).toContain("## Page 2");
    expect(first.pdf.representation.adapter).toEqual(PDFJS_TEXT_ADAPTER);
    expect(first.pdf.nativeRepresentation.mediaType).toBe("application/pdf");
    expect(first.pdf.representation.id).not.toBe(first.pdf.nativeRepresentation.id);
    expect(first.pdfHistory?.sourceSnapshots).toHaveLength(1);
    expect(first.pdfHistory?.representations).toHaveLength(2);

    const tui = negotiateResourcePresentation(first, TUI_RESOURCE_PRESENTATION_CONTEXT);
    expect(tui.selected).toMatchObject({
      representation: "cached-markdown",
      renderer: "markdown",
      adapter: PDFJS_TEXT_ADAPTER,
    });
    const native = negotiateResourcePresentation(first, {
      surface: "native",
      placement: "window",
      host: {
        id: "fixture-native-pdf",
        renderers: ["native-document", "metadata"],
        placements: ["window"],
        capabilities: ["read"],
      },
      providerAccess: { credentials: "available", connectivity: "available" },
    });
    expect(native.selected).toMatchObject({
      representation: "native-document",
      renderer: "native-document",
      adapter: { id: "builtin.pdf-native", version: 1 },
    });
    const nativePayload = store.resources.nativePdfPayload(
      first.resource.id,
      first.pdf.nativeRepresentation.id,
    );
    expect(nativePayload).toMatchObject({
      representationId: first.pdf.nativeRepresentation.id,
      mediaType: "application/pdf",
      encoding: "base64",
      contentHash: first.pdf.nativeRepresentation.contentHash,
    });
    expect(Buffer.from(nativePayload.data, "base64")).toEqual(Buffer.from(fixturePdf(1)));

    const originalAnchor = anchorForQuote(first.pdf, "Durable claim revision 1");
    const annotation = store.annotations.create(
      "pdf-annotation",
      {
        target: {
          representation: annotationRepresentation(first),
          anchor: originalAnchor,
        },
        body: "Keep the page and region evidence.",
        source: "user",
      },
      "user",
    ).annotations[0]!;
    expect(annotation.originalTarget.anchor).toMatchObject({
      kind: "pdf-page-region",
      page: 1,
      exact: "Durable claim revision 1",
    });

    const firstSnapshotId = first.pdf.sourceSnapshot.id;
    const firstRepresentationId = first.pdf.representation.id;
    store.close();
    store = new OutlinerStore(databasePath, {
      workspaceRoot: directory,
      pdfExtractor: new PrefixedPdfExtractor(),
    });
    const rederived = await store.resources.open(receipt.resource.id, true);
    if (!rederived.pdf) throw new Error("PDF extractor change did not produce a document");
    expect(rederived.pdf.sourceSnapshot.id).toBe(firstSnapshotId);
    expect(rederived.pdf.representation.id).not.toBe(firstRepresentationId);
    expect(rederived.pdfHistory?.representations).toHaveLength(3);
    const rederivedResult = store.annotations.reconcile({
      subject: { kind: "resource", resourceId: receipt.resource.id },
      newRepresentation: annotationRepresentation(rederived),
      content: rederived.pdf.markdown,
    });
    expect(rederivedResult.changed).toBe(true);
    const reanchored = rederivedResult.threads[0]!;
    expect(reanchored.originalTarget.representation.id).toBe(firstRepresentationId);
    expect(reanchored.originalTarget.anchor).toEqual(originalAnchor);
    expect(reanchored.resolvedTarget).toMatchObject({
      representation: { id: rederived.pdf.representation.id },
      anchor: {
        kind: "pdf-page-region",
        page: 1,
        exact: "Durable claim revision 1",
      },
    });
    expect(reanchored.currentResolution.method).toMatchObject({
      kind: "codec",
      codecId: "pdf-page-region",
      method: "unique-exact-quote",
    });

    writeFileSync(pdfPath, fixturePdf(2));
    const refreshed = await store.resources.open(receipt.resource.id, true);
    if (!refreshed.pdf) throw new Error("Changed PDF did not produce a document");
    expect(refreshed.resource.id).toBe(receipt.resource.id);
    expect(refreshed.pdf.sourceSnapshot.id).not.toBe(firstSnapshotId);
    const refreshedResult = store.annotations.reconcile({
      subject: { kind: "resource", resourceId: receipt.resource.id },
      newRepresentation: annotationRepresentation(refreshed),
      content: refreshed.pdf.markdown,
    });
    expect(refreshedResult.changed).toBe(true);
    expect(refreshedResult.threads[0]!.originalTarget.representation.id).toBe(
      firstRepresentationId,
    );
    expect(refreshedResult.threads[0]!.currentResolution).toMatchObject({
      status: "resolved",
      method: { kind: "codec", codecId: "pdf-page-region", method: "local-fuzzy" },
      resolvedTarget: {
        anchor: { kind: "pdf-page-region", page: 1, exact: "Durable claim revision 2" },
      },
    });
    const retention = store.resources.inspectRetention(receipt.resource.id);
    expect(
      retention.artifacts.find(({ artifact }) => artifact.id === firstSnapshotId)?.states,
    ).toContain("referenced");
    expect(
      retention.artifacts.find(({ artifact }) => artifact.id === firstRepresentationId)?.states,
    ).toContain("referenced");
    expect(
      retention.artifacts.find(({ artifact }) =>
        artifact.id === refreshed.pdf!.sourceSnapshot.id
      )?.states,
    ).toEqual(expect.arrayContaining(["current", "referenced"]));
    rmSync(pdfPath);
    const unavailable = await store.resources.open(receipt.resource.id, true);
    expect(unavailable.pdf?.sourceSnapshot.id).toBe(refreshed.pdf.sourceSnapshot.id);
    expect(unavailable.pdfError).toContain("unavailable");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});


test.each([null, "4"])("HTTP PDF enforces the streaming limit with content-length %s", async (declaredLength) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-pdf-limit-"));
  let receivedChunks = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      receivedChunks += 1;
      controller.enqueue(new Uint8Array(4));
      if (receivedChunks === 10) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  const headers = new Headers({ "content-type": "application/pdf" });
  if (declaredLength !== null) headers.set("content-length", declaredLength);
  const store = new OutlinerStore(join(directory, "outliner.sqlite"), {
    maximumPdfBytes: 8,
    fetch: (async () => new Response(body, { headers })) as unknown as typeof fetch,
  });
  try {
    const source = store.resources.createSource({
      name: "PDF limit fixture",
      provider: "web",
      boundary: { baseUrl: "https://example.com/" },
    });
    const resource = store.resources.intern({
      sourceId: source.id,
      address: { kind: "web", url: "https://example.com/evidence.pdf" },
      mediaType: "application/pdf",
    }).resource;
    const result = await store.resources.refreshWeb(resource.id, true);
    expect(result.pdf).toBeNull();
    expect(result.pdfError).toBe("PDF response exceeds 8 bytes");
    expect(receivedChunks).toBe(3);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
    expect(store.resources.describe(resource.id, true).pdf).toBeNull();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PDF retention evicts and purges unreachable binary and text payloads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-pdf-retention-"));
  const databasePath = join(directory, "outliner.sqlite");
  const pdfPath = join(directory, "history.pdf");
  let store = new OutlinerStore(databasePath, { workspaceRoot: directory });
  try {
    writeFileSync(pdfPath, fixturePdf(1));
    const resource = store.resources.internFilesystem({ path: pdfPath }).resource;
    const first = await store.resources.open(resource.id, true);
    writeFileSync(pdfPath, fixturePdf(22));
    const second = await store.resources.open(resource.id, true);
    writeFileSync(pdfPath, fixturePdf(333));
    const current = await store.resources.open(resource.id, true);
    if (!first.pdf || !second.pdf || !current.pdf) {
      throw new Error("PDF retention fixture did not create three revisions");
    }
    const nativePin = store.resources.pinRetention({
      artifact: { kind: "representation", id: second.pdf.nativeRepresentation.id },
      label: "Native PDF delivery",
    }).pin;
    const pinned = store.resources.inspectRetention(resource.id);
    expect(
      pinned.artifacts.find(({ artifact }) =>
        artifact.id === second.pdf!.nativeRepresentation.id
      )?.states,
    ).toContain("pinned");
    expect(
      pinned.artifacts.find(({ artifact }) =>
        artifact.id === second.pdf!.sourceSnapshot.id
      )?.states,
    ).toContain("pinned");
    expect(store.resources.unpinRetention(nativePin.id).removed).toBe(true);
    store.resources.configureRetention({
      retainNewestSourceSnapshots: 1,
      retainNewestRepresentationsPerAdapter: 1,
      minimumAgeMs: 0,
      purgeGraceMs: 0,
    });
    const before = store.resources.inspectRetention(resource.id);
    expect(
      before.artifacts.find(({ artifact }) =>
        artifact.id === second.pdf!.sourceSnapshot.id
      )?.states,
    ).toEqual(["evictable"]);
    expect(
      before.artifacts.find(({ artifact }) =>
        artifact.id === second.pdf!.representation.id
      )?.states,
    ).toEqual(["evictable"]);

    const eviction = store.resources.collectRetention("evict", resource.id);
    expect(eviction.evicted).toEqual(expect.arrayContaining([
      { kind: "source-snapshot", id: second.pdf.sourceSnapshot.id },
      { kind: "representation", id: second.pdf.representation.id },
      { kind: "representation", id: second.pdf.nativeRepresentation.id },
    ]));
    const evicted = store.resources.describe(
      resource.id,
      true,
      second.pdf.sourceSnapshot.revision,
    );
    expect(evicted.pdf).toBeNull();
    expect(
      evicted.pdfHistory?.sourceSnapshots.find(({ id }) =>
        id === second.pdf!.sourceSnapshot.id
      ),
    ).toMatchObject({ bytesAvailable: false });
    expect(
      evicted.pdfHistory?.representations.find(({ id }) =>
        id === second.pdf!.representation.id
      ),
    ).toMatchObject({ contentAvailable: false });

    const purge = store.resources.collectRetention("purge", resource.id);
    expect(purge.purged.map(({ artifact }) => artifact)).toEqual(expect.arrayContaining([
      { kind: "source-snapshot", id: second.pdf.sourceSnapshot.id },
      { kind: "representation", id: second.pdf.representation.id },
      { kind: "representation", id: second.pdf.nativeRepresentation.id },
    ]));
    const opened = await store.resources.open(resource.id, true);
    expect(opened.pdf?.sourceSnapshot.id).toBe(current.pdf.sourceSnapshot.id);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP PDF refresh caches page-aware text and opens without refetching", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-http-pdf-"));
  const databasePath = join(directory, "outliner.sqlite");
  let fetchCount = 0;
  const bytes = fixturePdf(1);
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    fetchCount += 1;
    if (new Headers(init?.headers).get("if-none-match") === '"pdf-v1"') {
      return new Response(null, { status: 304, headers: { etag: '"pdf-v1"' } });
    }
    return new Response(bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer, {
      headers: { "content-type": "application/pdf", etag: '"pdf-v1"' },
    });
  }) as typeof fetch;
  let store = new OutlinerStore(databasePath, { fetch: fetcher });
  try {
    const source = store.resources.createSource({
      name: "PDF HTTP fixture",
      provider: "web",
      boundary: { baseUrl: "https://example.com/" },
    });
    const resource = store.resources.intern({
      sourceId: source.id,
      address: { kind: "web", url: "https://example.com/evidence.pdf" },
      mediaType: "application/pdf",
    }).resource;
    const refreshed = await store.resources.refreshWeb(resource.id, true);
    expect(refreshed.pdf?.markdown).toContain("Durable claim revision 1");
    expect(refreshed.pdf?.sourceSnapshot.locator).toBe("https://example.com/evidence.pdf");
    expect(fetchCount).toBe(1);
    const opened = await store.resources.open(resource.id, true);
    expect(opened.pdf?.representation.id).toBe(refreshed.pdf?.representation.id);
    expect(fetchCount).toBe(1);

    store.close();
    store = new OutlinerStore(databasePath, {
      fetch: (async () => {
        throw new Error("Provider must not be contacted for retained rederivation");
      }) as unknown as typeof fetch,
      pdfExtractor: new PrefixedPdfExtractor(),
    });
    const rederived = await store.resources.open(resource.id, true);
    expect(rederived.pdf?.sourceSnapshot.id).toBe(refreshed.pdf?.sourceSnapshot.id);
    expect(rederived.pdf?.representation.id).not.toBe(refreshed.pdf?.representation.id);
    expect(rederived.pdf?.representation.adapter).toEqual({
      id: "fixture.prefixed-pdf-text",
      version: 2,
    });
    expect(fetchCount).toBe(1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy PDF page-region evidence survives repository startup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-pdf-legacy-anchor-"));
  const databasePath = join(directory, "outliner.sqlite");
  const pdfPath = join(directory, "legacy.pdf");
  writeFileSync(pdfPath, fixturePdf(1));
  let store = new OutlinerStore(databasePath, { workspaceRoot: directory });
  try {
    const resource = store.resources.internFilesystem({ path: pdfPath }).resource;
    const description = await store.resources.open(resource.id, true);
    if (!description.pdf) throw new Error("Legacy PDF fixture is unavailable");
    const annotation = store.annotations.create("legacy-pdf-anchor", {
      target: {
        representation: annotationRepresentation(description),
        anchor: anchorForQuote(description.pdf, "Durable claim revision 1"),
      },
      body: "Preserve legacy PDF evidence.",
      source: "user",
    }, "user").annotations[0]!;
    if (annotation.originalTarget.anchor.kind !== "pdf-page-region") {
      throw new Error("Legacy PDF fixture has the wrong anchor kind");
    }
    const legacyTarget = {
      ...annotation.originalTarget,
      anchor: {
        kind: "pdf-page-region",
        page: annotation.originalTarget.anchor.page,
        regions: annotation.originalTarget.anchor.regions,
        exact: annotation.originalTarget.anchor.exact,
      },
    };
    store.database.exec("DROP TRIGGER annotation_targets_immutable");
    store.database.query(`
      UPDATE annotation_targets SET original_target_json = ?
      WHERE annotation_block_id = ?
    `).run(JSON.stringify(legacyTarget), annotation.block.id);
    store.close();

    store = new OutlinerStore(databasePath, { workspaceRoot: directory });
    expect(store.annotations.get(annotation.block.id).originalTarget.anchor).toMatchObject({
      kind: "pdf-page-region",
      page: 1,
      start: null,
      end: null,
      prefix: null,
      suffix: null,
      exact: "Durable claim revision 1",
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PDF refresh enforces policy before provider access", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-outliner-pdf-policy-"));
  let fetchCount = 0;
  const store = new OutlinerStore(join(directory, "outliner.sqlite"), {
    fetch: (async () => {
      fetchCount += 1;
      const bytes = fixturePdf(1);
      return new Response(bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer, {
        headers: { "content-type": "application/pdf" },
      });
    }) as unknown as typeof fetch,
  });
  try {
    const source = store.resources.createSource({
      name: "Denied PDF refresh",
      provider: "web",
      boundary: { baseUrl: "https://example.com/" },
      policy: { deniedCapabilities: ["refresh"] },
    });
    const resource = store.resources.intern({
      sourceId: source.id,
      address: { kind: "web", url: "https://example.com/denied.pdf" },
      mediaType: "application/pdf",
    }).resource;
    await expect(async () => {
      await store.resources.refreshWeb(resource.id, true);
    }).toThrow("denies reading or refreshing");
    expect(fetchCount).toBe(0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

