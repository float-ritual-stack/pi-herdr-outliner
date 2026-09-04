import { hyperlink } from "@earendil-works/pi-tui";
import {
  focusBlockByQuery,
  formatBlockFocusMatch,
  type BlockFocusRequester,
} from "./block-focus";
import { requireUniqueClientId, sendClientCommand } from "./client-target";
import { isFragmentId, resolveFragment } from "./fragments";
import {
  blockDisplayTitle,
  blockReferenceEnvelopeRanges,
  blockReferenceOccurrences,
} from "./references";
import {
  outlinerReferenceOccurrences,
  protectedMarkdownRanges,
  rangesOverlap,
  type TextRange,
} from "./reference-occurrences";
import {
  dispatchNavigation,
  resolveNavigationDestination,
} from "./navigation-routes";
import { isWorkIdAddress } from "./page-addresses";
import type {
  Block,
  OutlinerNavigationIntent,
  PageAddressFollowResult,
  PageAddressResolution,
} from "./types";

const OUTLINER_SCHEME = "pi-outliner:";
const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{8,}$/;
const BLOCK_ID_TOKEN_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export type OutlinerLinkKind = "block" | "goto" | "page" | "work";

export interface OutlinerLinkTarget {
  kind: OutlinerLinkKind;
  value: string;
  fragmentId?: string;
  preserveSource?: boolean;
  intent?: "reveal";
}

export interface OutlinerLinkNavigation {
  kind: OutlinerLinkKind;
  id: string;
  title: string;
  deleted?: boolean;
  created?: boolean;
  targetClientId?: string;
  intent?: OutlinerNavigationIntent;
  resolution?: "unlocked" | "self" | "context" | "same-tab";
}

interface LinkSpan {
  start: number;
  end: number;
  uri: string;
}


export function outlinerLinkUri(
  kind: OutlinerLinkKind,
  value: string,
  options: {
    preserveSource?: boolean;
    intent?: "reveal";
    fragmentId?: string;
  } = {},
): string {
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
  if (options.fragmentId && (kind !== "block" || !isFragmentId(options.fragmentId))) {
    throw new Error(`Invalid outliner fragment target: ${options.fragmentId}`);
  }
  const query = new URLSearchParams();
  if (options.preserveSource) query.set("preserveSource", "1");
  if (options.intent) query.set("intent", options.intent);
  if (options.fragmentId) query.set("fragment", options.fragmentId);
  const suffix = query.size > 0 ? `?${query}` : "";
  return `${OUTLINER_SCHEME}//${kind}/${encodeURIComponent(normalized)}${suffix}`;
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
  const preserveSourceValues = parsed.searchParams.getAll("preserveSource");
  const intentValues = parsed.searchParams.getAll("intent");
  const fragmentValues = parsed.searchParams.getAll("fragment");
  if (
    [...parsed.searchParams.keys()].some((key) =>
      key !== "preserveSource" && key !== "intent" && key !== "fragment"
    ) ||
    preserveSourceValues.length > 1 ||
    (preserveSourceValues.length === 1 && preserveSourceValues[0] !== "1") ||
    intentValues.length > 1 ||
    (intentValues.length === 1 && intentValues[0] !== "reveal") ||
    fragmentValues.length > 1 ||
    (fragmentValues.length === 1 &&
      (kind !== "block" || !isFragmentId(fragmentValues[0]!)))
  ) {
    throw new Error("Invalid outliner link navigation constraints");
  }
  if (
    !value ||
    TERMINAL_CONTROL_PATTERN.test(value) ||
    (kind === "block" && !BLOCK_ID_PATTERN.test(value)) ||
    (kind === "work" && !isWorkIdAddress(value))
  ) {
    throw new Error(`Invalid outliner ${kind} target`);
  }
  return {
    kind,
    value,
    ...(fragmentValues.length === 1 ? { fragmentId: fragmentValues[0] } : {}),
    ...(preserveSourceValues.length === 1 ? { preserveSource: true } : {}),
    ...(intentValues.length === 1 ? { intent: "reveal" as const } : {}),
  };
}

export interface ResolvedOutlinerLinkTarget {
  block: Block;
  fragmentId?: string;
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
    const block = await requester.request<Block>({ action: "get", blockId: target.value });
    if (!target.fragmentId) return { block };
    const fragment = resolveFragment(block.text, target.fragmentId);
    if (fragment.status === "missing") {
      throw new Error(`Fragment not found: ${target.value}^${target.fragmentId}`);
    }
    if (fragment.status === "duplicate") {
      throw new Error(`Fragment is duplicated: ${target.value}^${target.fragmentId}`);
    }
    return { block, fragmentId: target.fragmentId };
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
  targets: {
    treeClientId?: string;
    detailClientId?: string;
    sourceClientId?: string;
    intent?: OutlinerNavigationIntent;
  } = {},
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

  if (targets.sourceClientId) {
    const intent = target.intent ?? targets.intent ?? "open";
    if (target.kind === "page") {
      await resolveNavigationDestination(
        requester,
        targets.sourceClientId,
        intent,
        { preserveSource: target.preserveSource },
      );
    }
    const resolved = await resolveOutlinerLinkTarget(requester, target);
    const dispatched = await dispatchNavigation(
      requester,
      targets.sourceClientId,
      resolved.block.id,
      intent,
      {
        preserveSource: target.preserveSource,
        fragmentId: resolved.fragmentId,
      },
    );
    return {
      kind: target.kind,
      id: resolved.block.id,
      title: blockDisplayTitle(resolved.block),
      targetClientId: dispatched.targetClientId,
      intent: dispatched.intent,
      resolution: dispatched.resolution,
      ...(resolved.block.effectiveDeletedRootId ? { deleted: true } : {}),
      ...(resolved.created ? { created: true } : {}),
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
    block = (await resolveOutlinerLinkTarget(requester, target)).block;
  }
  if (block.effectiveDeletedRootId) {
    const detailClientId =
      targets.detailClientId ?? await requireUniqueClientId(requester, "detail");
    await requester.request({ action: "selection.set", blockId: block.id });
    await sendClientCommand(requester, detailClientId, {
      command: "focus",
      blockId: block.id,
      ...(target.fragmentId ? { fragmentId: target.fragmentId } : {}),
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
    ...(target.fragmentId ? { fragmentId: target.fragmentId } : {}),
  });
  return {
    kind: target.kind,
    id: block.id,
    title: blockDisplayTitle(block),
    ...(pageFollow?.created ? { created: true } : {}),
  };
}


export function firstOutlinerReference(
  text: string,
  workIdPrefix: string | null = null,
): OutlinerLinkTarget | null {
  const first = outlinerReferenceOccurrences(text, workIdPrefix)[0];
  if (!first) return null;
  if (first.kind === "block") {
    return {
      kind: "block",
      value: first.blockId,
      ...(first.fragmentId ? { fragmentId: first.fragmentId } : {}),
    };
  }
  if (first.kind === "page") return { kind: "page", value: first.address };
  return { kind: "work", value: first.address };
}

function genericLinkSpans(
  text: string,
  canLinkBlock: (blockId: string) => boolean,
  workIdPrefix: string | null,
): LinkSpan[] {
  const spans: LinkSpan[] = [];
  const blockReferenceRanges = blockReferenceEnvelopeRanges(text).filter((range) =>
    text.slice(range.start, range.end).includes("|")
  );
  for (const reference of outlinerReferenceOccurrences(text, workIdPrefix)) {
    if (reference.kind === "page") {
      spans.push({
        start: reference.start,
        end: reference.end,
        uri: outlinerLinkUri("page", reference.address),
      });
    } else if (reference.kind === "work-id") {
      spans.push({
        start: reference.start,
        end: reference.end,
        uri: outlinerLinkUri("work", reference.address),
      });
    }
  }
  for (const match of text.matchAll(BLOCK_ID_TOKEN_PATTERN)) {
    const range = { start: match.index, end: match.index + match[0].length };
    if (
      blockReferenceRanges.some((reference) => rangesOverlap(reference, range)) ||
      !canLinkBlock(match[0])
    ) continue;
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
    if (protectedRanges.some((range) => rangesOverlap(span, range))) continue;
    if (selected.some((existing) => rangesOverlap(span, existing))) continue;
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
  for (const reference of blockReferenceOccurrences(rawText)) {
    resolvedCursor += reference.start - rawCursor;
    const authored = rawText.slice(reference.start, reference.end);
    if (resolvedText.startsWith(authored, resolvedCursor)) {
      rawCursor = reference.end;
      resolvedCursor += authored.length;
      continue;
    }
    if (!resolvedText.startsWith("((", resolvedCursor)) return [];
    const end = resolvedText.indexOf("))", resolvedCursor + 2);
    if (end < 0) return [];
    spans.push({
      start: resolvedCursor,
      end: end + 2,
      uri: outlinerLinkUri("block", reference.blockId, {
        fragmentId: reference.fragmentId,
      }),
    });
    rawCursor = reference.end;
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
  const references = blockReferenceOccurrences(rawText).map((reference) => {
    const target = lookup(reference.blockId);
    const fragmentSuffix = reference.fragmentId ? `^${reference.fragmentId}` : "";
    if (!target) {
      return {
        visible:
          `((${reference.blockId}${fragmentSuffix}${reference.label !== undefined ? `|${reference.label}` : ""}))`,
        uri: null,
      };
    }
    const title = blockDisplayTitle(target);
    const presentation = reference.label ?? title;
    if (target.effectiveDeletedRootId) {
      return {
        visible:
          `((${presentation}${reference.label === undefined ? fragmentSuffix : ""} · Trash))`,
        uri: outlinerLinkUri("block", reference.blockId, {
          fragmentId: reference.fragmentId,
        }),
      };
    }
    if (reference.fragmentId) {
      const fragment = resolveFragment(target.text, reference.fragmentId);
      if (fragment.status !== "resolved") {
        const state = fragment.status === "missing" ? "Missing fragment" : "Duplicate fragment";
        return {
          visible:
            `((${presentation}${reference.label === undefined ? fragmentSuffix : ""} · ${state}))`,
          uri: null,
        };
      }
    }
    return {
      visible: `((${presentation}${reference.label === undefined ? fragmentSuffix : ""}))`,
      uri: outlinerLinkUri("block", reference.blockId, {
        fragmentId: reference.fragmentId,
      }),
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
