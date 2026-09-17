import {
  type PdfPageText,
  type PdfRegion,
  type ResourceRepresentationAdapter,
} from "./resources";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextContent } from "pdfjs-dist/types/src/display/api.js";

export interface PdfTextExtraction {
  readonly markdown: string;
  readonly pages: readonly PdfPageText[];
}

export interface PdfTextExtractor {
  readonly adapter: ResourceRepresentationAdapter;
  extract(bytes: Uint8Array): Promise<PdfTextExtraction>;
}

export const PDFJS_TEXT_ADAPTER = {
  id: "builtin.pdfjs-text-markdown",
  version: 1,
} as const satisfies ResourceRepresentationAdapter;

type PdfJsContentItem = TextContent["items"][number];
type PdfJsTextItem = Extract<PdfJsContentItem, { str: string }>;

function isTextItem(item: PdfJsContentItem): item is PdfJsTextItem {
  return "str" in item;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`PDF.js returned an invalid ${label}`);
  }
  return value;
}

function regionFor(
  item: PdfJsTextItem,
  pageNumber: number,
  userUnit: number,
): PdfRegion {
  const unit = finiteNumber(userUnit, `user-unit value on page ${pageNumber}`);
  if (unit <= 0) {
    throw new Error(`PDF.js returned a non-positive user-unit value on page ${pageNumber}`);
  }

  return {
    x: finiteNumber(item.transform[4], `text x coordinate on page ${pageNumber}`) * unit,
    y: finiteNumber(item.transform[5], `text y coordinate on page ${pageNumber}`) * unit,
    width: Math.abs(finiteNumber(item.width, `text width on page ${pageNumber}`)) * unit,
    height: Math.abs(finiteNumber(item.height, `text height on page ${pageNumber}`)) * unit,
  };
}

function extractionError(cause: unknown): Error {
  const detail = cause instanceof Error && cause.message.length > 0
    ? ` PDF.js reported: ${cause.message}`
    : "";
  return new Error(
    `Cannot extract PDF text. Verify that the input is a valid, supported, password-free PDF.${detail}`,
    { cause },
  );
}

export class PdfJsTextExtractor implements PdfTextExtractor {
  readonly adapter = PDFJS_TEXT_ADAPTER;

  async extract(bytes: Uint8Array): Promise<PdfTextExtraction> {
    if (bytes.byteLength === 0) {
      throw new Error("Cannot extract PDF text from empty input. Provide a valid PDF file.");
    }

    const loadingTask = getDocument({
      data: bytes,
      stopAtErrors: true,
      useSystemFonts: true,
    });
    try {
      const document = await loadingTask.promise;
      const markdownParts: string[] = [];
      const pages: PdfPageText[] = [];
      let markdownLength = 0;

      const append = (text: string): void => {
        markdownParts.push(text);
        markdownLength += text.length;
      };

      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent();
        const spans: PdfPageText["spans"][number][] = [];

        if (pageNumber > 1) {
          append("\n\n");
        }
        append(`## Page ${pageNumber}\n\n`);
        const start = markdownLength;
        let hasText = false;
        let lineBreakBeforeNextText = false;

        for (const item of textContent.items) {
          if (!isTextItem(item)) {
            continue;
          }
          if (item.str.length === 0) {
            lineBreakBeforeNextText ||= item.hasEOL;
            continue;
          }

          if (hasText) {
            append(lineBreakBeforeNextText ? "\n" : " ");
          }
          const spanStart = markdownLength;
          append(item.str);
          spans.push({
            start: spanStart,
            end: markdownLength,
            region: regionFor(item, pageNumber, page.userUnit),
          });
          hasText = true;
          lineBreakBeforeNextText = item.hasEOL;
        }

        pages.push({
          page: pageNumber,
          width: finiteNumber(viewport.width, `width of page ${pageNumber}`),
          height: finiteNumber(viewport.height, `height of page ${pageNumber}`),
          start,
          end: markdownLength,
          spans,
        });
      }

      return { markdown: markdownParts.join(""), pages };
    } catch (cause) {
      throw extractionError(cause);
    } finally {
      await loadingTask.destroy();
    }
  }
}
