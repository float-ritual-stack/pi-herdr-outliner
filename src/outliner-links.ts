import { hyperlink } from "@earendil-works/pi-tui";
import {
  focusBlockByQuery,
  formatBlockFocusMatch,
  type BlockFocusRequester,
} from "./block-focus";
import { requireUniqueClientId, sendClientCommand } from "./client-target";
import { blockDisplayTitle, blockReferenceIds } from "./references";
import { isWorkIdAddress, pageAddressReferences } from "./page-addresses";
import type { Block, PageAddressFollowResult, PageAddressResolution } from "./types";
import { workIdReferences } from "./work-ids";

const OUTLINER_SCHEME = "pi-outliner:";
const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{8,}$/;
const BLOCK_ID_TOKEN_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const RAW_BLOCK_REFERENCE_PATTERN = /\(\(([A-Za-z0-9_-]{8,})\)\)/g;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export type OutlinerLinkKind = "block" | "goto" | "page" | "work";

export interface OutlinerLinkTarget {
  kind: OutlinerLinkKind;
  value: string;
}

export interface OutlinerLinkNavigation {
  kind: OutlinerLinkKind;
  id: string;
  title: string;
  deleted?: boolean;
  created?: boolean;
}

interface LinkSpan {
  start: number;
  end: number;
  uri: string;
}

interface TextRange {
  start: number;
  end: number;
}

export function outlinerLinkUri(kind: OutlinerLinkKind, value: string): string {
  const normalized = value.trim();
  if (TERMINAL_CONTROL_PATTERN.test(normalized)) {
    throw new Error("Outliner link target contains terminal control characters");
  }
  if (!normalized) throw new Error("Outliner link target cannot be empty");
  if (
    (kind === "block" && !BLOCK_ID_PATTERN.test(normalized)) ||
    (kind === "work" && !isWorkIdAddress(normalized))
  ) {
    throw new Error(`Invalid outliner ${kind} target: ${normalized}`);
  }
  return `${OUTLINER_SCHEME}//${kind}/${encodeURIComponent(normalized)}`;
}

export function parseOutlinerLinkUri(uri: string): OutlinerLinkTarget {
  if (!URL.canParse(uri)) {
    throw new Error("Invalid outliner link URI");
  }
  const parsed = new URL(uri);
  if (
    parsed.protocol !== OUTLINER_SCHEME ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Invalid outliner link URI");
  }
  const kind = parsed.hostname;
  if (kind !== "block" && kind !== "goto" && kind !== "page" && kind !== "work") {
    throw new Error(`Unsupported outliner link kind: ${parsed.hostname}`);
  }
  const encoded = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname;
  let value: string;
  try {
    value = decodeURIComponent(encoded);
  } catch {
    throw new Error("Invalid outliner link encoding");
  }
  if (
    !value ||
    TERMINAL_CONTROL_PATTERN.test(value) ||
    (kind === "block" && !BLOCK_ID_PATTERN.test(value)) ||
    (kind === "work" && !isWorkIdAddress(value))
  ) {
    throw new Error(`Invalid outliner ${kind} target`);
  }
  return { kind, value };
}

export interface ResolvedOutlinerLinkTarget {
  block: Block;
  created?: boolean;
}

export async function resolveOutlinerLinkTarget(
  requester: BlockFocusRequester,
  target: OutlinerLinkTarget,
): Promise<ResolvedOutlinerLinkTarget> {
  if (target.kind === "goto") {
    throw new Error("Fuzzy goto links require a Tree destination");
  }
  if (target.kind === "block") {
    return { block: await requester.request<Block>({ action: "get", blockId: target.value }) };
  }
  const resolution = await requester.request<PageAddressResolution>({
    action: "pages.resolve",
    address: target.value,
  });
  if (resolution.block) return { block: resolution.block };
  if (target.kind === "work") {
    throw new Error(`Work ID address is unresolved: ${target.value}`);
  }
  const followed = await requester.request<PageAddressFollowResult>({
    action: "pages.follow",
    address: target.value,
  });
  if (!followed.block) throw new Error(`Page address did not resolve: ${target.value}`);
  return { block: followed.block, ...(followed.created ? { created: true } : {}) };
}

export async function navigateOutlinerLink(
  requester: BlockFocusRequester,
  uri: string,
  targets: { treeClientId?: string; detailClientId?: string } = {},
): Promise<OutlinerLinkNavigation> {
  const target = parseOutlinerLinkUri(uri);
  if (target.kind === "goto") {
    const focused = await focusBlockByQuery(requester, target.value, 20, targets.treeClientId);
    if (focused.resolution.kind === "none") {
      throw new Error(`No outliner block matches clicked link: ${target.value}`);
    }
    if (focused.resolution.kind === "ambiguous") {
      const candidates = focused.resolution.matches
        .map((match) => formatBlockFocusMatch(match, match.block.id))
        .join("\n");
      throw new Error(`Clicked outliner link is ambiguous:\n${candidates}`);
    }
    return {
      kind: "goto",
      id: focused.resolution.match.block.id,
      title: focused.resolution.match.title,
    };
  }

  let pageFollow: PageAddressFollowResult | null = null;
  let treeClientId = targets.treeClientId;
  let block: Block;
  if (target.kind === "page") {
    const resolution = await requester.request<PageAddressResolution>({
      action: "pages.resolve",
      address: target.value,
    });
    if (resolution.block) {
      block = resolution.block;
    } else {
      treeClientId ??= await requireUniqueClientId(requester, "tree");
      pageFollow = await requester.request<PageAddressFollowResult>({
        action: "pages.follow",
        address: target.value,
      });
      if (!pageFollow.block) throw new Error(`Page address did not resolve: ${target.value}`);
      block = pageFollow.block;
    }
  } else if (target.kind === "work") {
    const resolution = await requester.request<PageAddressResolution>({
      action: "pages.resolve",
      address: target.value,
    });
    if (!resolution.block) throw new Error(`Work ID address is unresolved: ${target.value}`);
    block = resolution.block;
  } else {
    block = await requester.request<Block>({ action: "get", blockId: target.value });
  }
  if (block.effectiveDeletedRootId) {
    const detailClientId =
      targets.detailClientId ?? await requireUniqueClientId(requester, "detail");
    await requester.request({ action: "selection.set", blockId: block.id });
    await sendClientCommand(requester, detailClientId, {
      command: "focus",
      blockId: block.id,
    });
    return {
      kind: target.kind,
      id: block.id,
      title: blockDisplayTitle(block),
      deleted: true,
      ...(pageFollow?.created ? { created: true } : {}),
    };
  }

  treeClientId ??= await requireUniqueClientId(requester, "tree");
  await requester.request({ action: "selection.set", blockId: block.id });
  await sendClientCommand(requester, treeClientId, {
    command: "focus",
    blockId: block.id,
  });
  return {
    kind: target.kind,
    id: block.id,
    title: blockDisplayTitle(block),
    ...(pageFollow?.created ? { created: true } : {}),
  };
}

function protectedMarkdownRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let activeFence: { marker: string; length: number } | null = null;
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const lineEnd = lineStart + line.length;
    if (activeFence) {
      ranges.push({ start: lineStart, end: lineEnd });
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (
        closing &&
        closing[0] === activeFence.marker &&
        closing.length >= activeFence.length
      ) {
        activeFence = null;
      }
    } else {
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (opening) {
        ranges.push({ start: lineStart, end: lineEnd });
        activeFence = { marker: opening[0], length: opening.length };
      } else if (/^( {4}|\t)/.test(line)) {
        ranges.push({ start: lineStart, end: lineEnd });
      }
    }
    lineStart = lineEnd + 1;
  }
  for (const pattern of [/(`+)[^\n]*?\1/g, /!?\[[^\]\n]*\]\([^)\n]*\)/g]) {
    for (const match of text.matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges;
}

function pageSyntaxRanges(text: string): TextRange[] {
  return [...text.matchAll(/\[\[[^\r\n]*?(?:\]\]|(?=\r?$))/gm)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function overlaps(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && right.start < left.end;
}

export function firstOutlinerReference(
  text: string,
  workIdPrefix: string | null = null,
): OutlinerLinkTarget | null {
  const candidates: Array<OutlinerLinkTarget & TextRange> = [];
  for (const match of text.matchAll(RAW_BLOCK_REFERENCE_PATTERN)) {
    candidates.push({
      kind: "block",
      value: match[1],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  for (const reference of pageAddressReferences(text)) {
    candidates.push({
      kind: "page",
      value: reference.displayAddress,
      start: reference.start,
      end: reference.end,
    });
  }
  const pageRanges = pageSyntaxRanges(text);
  for (const reference of workIdPrefix ? workIdReferences(text, workIdPrefix) : []) {
    const range = { start: reference.start, end: reference.end };
    if (pageRanges.some((pageRange) => overlaps(range, pageRange))) continue;
    candidates.push({
      kind: "work",
      value: reference.workId,
      ...range,
    });
  }
  const protectedRanges = protectedMarkdownRanges(text);
  const first = candidates
    .filter((candidate) => !protectedRanges.some((range) => overlaps(candidate, range)))
    .sort((left, right) => left.start - right.start)[0];
  return first ? { kind: first.kind, value: first.value } : null;
}

function genericLinkSpans(
  text: string,
  canLinkBlock: (blockId: string) => boolean,
  workIdPrefix: string | null,
): LinkSpan[] {
  const spans: LinkSpan[] = [];
  const pageRanges = pageSyntaxRanges(text);
  for (const reference of pageAddressReferences(text)) {
    spans.push({
      start: reference.start,
      end: reference.end,
      uri: outlinerLinkUri("page", reference.displayAddress),
    });
  }
  for (const reference of workIdPrefix ? workIdReferences(text, workIdPrefix) : []) {
    const range = { start: reference.start, end: reference.end };
    if (pageRanges.some((pageRange) => overlaps(range, pageRange))) continue;
    spans.push({
      ...range,
      uri: outlinerLinkUri("work", reference.workId),
    });
  }
  for (const match of text.matchAll(BLOCK_ID_TOKEN_PATTERN)) {
    if (!canLinkBlock(match[0])) continue;
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      uri: outlinerLinkUri("block", match[0]),
    });
  }
  return spans;
}

function selectLinkSpans(
  text: string,
  exactSpans: readonly LinkSpan[],
  canLinkBlock: (blockId: string) => boolean,
  workIdPrefix: string | null,
): LinkSpan[] {
  const protectedRanges = protectedMarkdownRanges(text);
  const selected: LinkSpan[] = [];
  for (const span of [
    ...exactSpans,
    ...genericLinkSpans(text, canLinkBlock, workIdPrefix),
  ]) {
    if (protectedRanges.some((range) => overlaps(span, range))) continue;
    if (selected.some((existing) => overlaps(span, existing))) continue;
    selected.push(span);
  }
  return selected.sort((left, right) => left.start - right.start);
}

function renderLinkSpans(
  text: string,
  spans: readonly LinkSpan[],
  renderLink: (visible: string, uri: string) => string,
): string {
  if (spans.length === 0) return text;
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += text.slice(cursor, span.start);
    result += renderLink(text.slice(span.start, span.end), span.uri);
    cursor = span.end;
  }
  return result + text.slice(cursor);
}

function markdownLink(visible: string, uri: string): string {
  const label = visible.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
  return `[${label}](${uri})`;
}

function resolvedReferenceSpans(rawText: string, resolvedText: string): LinkSpan[] {
  const spans: LinkSpan[] = [];
  let rawCursor = 0;
  let resolvedCursor = 0;
  for (const match of rawText.matchAll(RAW_BLOCK_REFERENCE_PATTERN)) {
    resolvedCursor += match.index - rawCursor;
    if (!resolvedText.startsWith("((", resolvedCursor)) return [];
    const end = resolvedText.indexOf("))", resolvedCursor + 2);
    if (end < 0) return [];
    spans.push({
      start: resolvedCursor,
      end: end + 2,
      uri: outlinerLinkUri("block", match[1]),
    });
    rawCursor = match.index + match[0].length;
    resolvedCursor = end + 2;
  }
  return spans;
}

export function linkOutlinerMarkdown(
  resolvedText: string,
  rawText: string,
  workIdPrefix: string | null = null,
): string {
  const spans = selectLinkSpans(
    resolvedText,
    resolvedReferenceSpans(rawText, resolvedText),
    () => true,
    workIdPrefix,
  );
  return renderLinkSpans(resolvedText, spans, markdownLink);
}

export interface OutlinerTextLinker {
  link(text: string): string;
}

export function createOutlinerTextLinker(
  rawText: string,
  lookup: (blockId: string) => Block | null,
  workIdPrefix: string | null = null,
): OutlinerTextLinker {
  const references = blockReferenceIds(rawText).map((blockId) => {
    const target = lookup(blockId);
    const title = target
      ? `${blockDisplayTitle(target)}${target.effectiveDeletedRootId ? " · Trash" : ""}`
      : blockId;
    return {
      visible: `((${title}))`,
      uri: target ? outlinerLinkUri("block", blockId) : null,
    };
  });
  const consumedReferences = new Set<number>();
  return {
    link(text: string): string {
      const exactSpans: LinkSpan[] = [];
      const referenceRanges: TextRange[] = [];
      for (let index = 0; index < references.length; index += 1) {
        if (consumedReferences.has(index)) continue;
        const reference = references[index];
        let start = text.indexOf(reference.visible);
        while (
          start >= 0 &&
          referenceRanges.some((range) =>
            range.start < start + reference.visible.length && start < range.end
          )
        ) {
          start = text.indexOf(reference.visible, start + 1);
        }
        if (start < 0) continue;
        const range = { start, end: start + reference.visible.length };
        referenceRanges.push(range);
        consumedReferences.add(index);
        if (reference.uri) exactSpans.push({ ...range, uri: reference.uri });
      }
      const spans = selectLinkSpans(
        text,
        exactSpans,
        (blockId) => lookup(blockId) !== null,
        workIdPrefix,
      );
      return renderLinkSpans(text, spans, hyperlink);
    },
  };
}
