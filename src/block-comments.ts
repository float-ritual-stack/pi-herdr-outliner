import type { OutlinerClient } from "./client";
import { blockAnnotationRepresentation } from "./annotation-representations";
import { createTextQuoteAnchor } from "./annotations";
import { checklistItems } from "./checklist-items";
import type { AnnotationBatchReceipt, AnnotationTarget, Block, BlockAuthor, BlockCommentInput,
  BlockCommentPassage, BlockProvenance } from "./types";

/** Shared by source-aware readers and the service's simplified comment operation. */
export function blockCommentTarget(
  block: Pick<Block, "id" | "text" | "updatedAt">,
  passage?: BlockCommentPassage,
): AnnotationTarget {
  return { representation: blockAnnotationRepresentation(block), ...blockCommentSelection(block.text, passage) };
}

/** Preserve the reader's captured representation while resolving its canonical source selection. */
export function blockCommentSelection(text: string, passage?: BlockCommentPassage): Pick<AnnotationTarget, "anchor" | "listItemId"> {
  if (passage === undefined) return { anchor: { kind: "whole-subject" } };
  if (!passage || typeof passage.quote !== "string" || passage.quote.length === 0) {
    throw new Error("Comment quote must be non-empty exact source text; omit passage for a whole-block comment");
  }
  if (passage.start !== undefined && (!Number.isSafeInteger(passage.start) || passage.start < 0)) {
    throw new Error("Comment start must be a non-negative UTF-16 source offset");
  }
  for (const key of ["prefix", "suffix", "itemId"] as const) {
    if (passage[key] !== undefined && typeof passage[key] !== "string") throw new Error(`Comment ${key} must be text`);
  }
  let lower = 0, upper = text.length;
  if (passage.itemId !== undefined) {
    const items = checklistItems(text).filter(item => item.itemId === passage.itemId);
    if (items.length !== 1 || items[0]!.identity !== "unique") throw new Error("Comment checklist item is missing or ambiguous");
    lower = items[0]!.span.start; upper = items[0]!.span.end;
  }
  const matches: number[] = [];
  for (let start = text.indexOf(passage.quote, lower); start >= 0 && start + passage.quote.length <= upper;
    start = text.indexOf(passage.quote, start + 1)) {
    const end = start + passage.quote.length;
    if (passage.start !== undefined && start !== passage.start) continue;
    if (passage.prefix !== undefined && !text.slice(0, start).endsWith(passage.prefix)) continue;
    if (passage.suffix !== undefined && !text.slice(end).startsWith(passage.suffix)) continue;
    matches.push(start);
    if (matches.length > 1) break;
  }
  if (matches.length === 0) throw new Error("Comment quote or context was not found; read the current source and select it again");
  if (matches.length > 1) throw new Error("Comment quote is ambiguous; supply start, prefix/suffix or a unique checklist itemId");
  return { anchor: createTextQuoteAnchor(text, matches[0]!, matches[0]! + passage.quote.length),
    ...(passage.itemId === undefined ? {} : { listItemId: passage.itemId }) };
}

export interface BlockCommentRequest {
  requestId: string;
  input: BlockCommentInput;
  author?: BlockAuthor;
  provenance?: BlockProvenance;
}

/** The service resolves the quote and validates its revision inside the request ledger transaction. */
export function createBlockComment(client: Pick<OutlinerClient, "request">, request: BlockCommentRequest): Promise<AnnotationBatchReceipt> {
  return client.request({ action: "annotations.batch", requestId: request.requestId,
    operations: [{ operationId: "comment", type: "block-comment", input: request.input }],
    author: request.author, provenance: request.provenance });
}
