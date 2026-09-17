import { expect, test } from "bun:test";
import {
  PDFJS_TEXT_ADAPTER,
  PdfJsTextExtractor,
} from "../src/pdf-text";
import { createPdfFixture } from "./pdf-fixture";

function minimalTwoPagePdf(): Uint8Array {
  return createPdfFixture([
    {
      width: 300,
      height: 400,
      lines: [
        { text: "First page line", x: 36, y: 350 },
        { text: "Second line", x: 36, y: 326 },
      ],
    },
    {
      width: 500,
      height: 200,
      lines: [{ text: "Page two text", x: 48, y: 120, size: 18 }],
    },
  ]);
}

test("extracts deterministic page-aware Markdown and PDF-point spans", async () => {
  const extractor = new PdfJsTextExtractor();
  const extraction = await extractor.extract(minimalTwoPagePdf());

  expect(extractor.adapter).toBe(PDFJS_TEXT_ADAPTER);
  expect(extractor.adapter).toEqual({
    id: "builtin.pdfjs-text-markdown",
    version: 1,
  });
  expect(extraction.markdown).toBe(
    "## Page 1\n\nFirst page line\nSecond line\n\n## Page 2\n\nPage two text",
  );
  expect(extraction.pages).toHaveLength(2);

  const firstPage = extraction.pages[0];
  const secondPage = extraction.pages[1];
  expect({ page: firstPage.page, width: firstPage.width, height: firstPage.height }).toEqual({
    page: 1,
    width: 300,
    height: 400,
  });
  expect({ page: secondPage.page, width: secondPage.width, height: secondPage.height }).toEqual({
    page: 2,
    width: 500,
    height: 200,
  });
  expect(extraction.markdown.slice(firstPage.start, firstPage.end)).toBe(
    "First page line\nSecond line",
  );
  expect(extraction.markdown.slice(secondPage.start, secondPage.end)).toBe("Page two text");

  for (const page of extraction.pages) {
    expect(page.spans.length).toBeGreaterThan(0);
    for (const span of page.spans) {
      expect(extraction.markdown.slice(span.start, span.end).length).toBeGreaterThan(0);
      expect(span.start).toBeGreaterThanOrEqual(page.start);
      expect(span.end).toBeLessThanOrEqual(page.end);
      expect(span.region.x).toBeGreaterThan(0);
      expect(span.region.y).toBeGreaterThan(0);
      expect(span.region.width).toBeGreaterThan(0);
      expect(span.region.height).toBeGreaterThan(0);
    }
  }
});

test("rejects empty PDF input with an actionable error", async () => {
  await expect(new PdfJsTextExtractor().extract(new Uint8Array())).rejects.toThrow(
    "Cannot extract PDF text from empty input. Provide a valid PDF file.",
  );
});

test("rejects invalid PDF input with an actionable error", async () => {
  await expect(
    new PdfJsTextExtractor().extract(new TextEncoder().encode("not a PDF")),
  ).rejects.toThrow(
    "Cannot extract PDF text. Verify that the input is a valid, supported, password-free PDF.",
  );
});
