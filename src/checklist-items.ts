import { normalizePropertyFilter } from "./block-query";
import { createHash, randomUUID } from "node:crypto";
import { fragmentAnchors } from "./fragments";
import { markdownListItems } from "./markdown-structure";
import { matchesFilters, parsePropertyRecords } from "./properties";
import type { ChecklistIdentityChange, ChecklistItem, ChecklistQuery, ChecklistStatus, ChecklistUpdateInput, PropertyRecord } from "./types";

export const CHECKLIST_MARKS: Readonly<Record<ChecklistStatus, string>> = {
  todo: "[ ]", done: "[x]", waiting: "[~]", problem: "[!]",
};

function requireStatus(value: unknown): asserts value is ChecklistStatus {
  if (typeof value !== "string" || !Object.hasOwn(CHECKLIST_MARKS, value)) {
    throw new Error("Checklist status must be todo, done, waiting or problem");
  }
}

/** Parse actual Markdown list nodes, never legends, fences or checkbox-shaped prose. */
export function checklistItems(text: string, properties = parsePropertyRecords(text)): ChecklistItem[] {
  const lists = markdownListItems(text);
  const anchors = fragmentAnchors(text);
  const anchorByLine = new Map(anchors.filter(anchor => anchor.kind === "list-item").map(anchor => [anchor.lineIndex, anchor]));
  const counts = new Map<string, number>();
  for (const anchor of anchors) counts.set(anchor.id, (counts.get(anchor.id) ?? 0) + 1);
  const items: ChecklistItem[] = [];
  for (const list of lists) {
    const source = text.slice(list.span.start, list.span.end);
    const mark = /^([ \t]*(?:[-+*]|\d+[.)])[ \t]+)\[([ xX~!])\](?=[ \t\r\n]|$)/.exec(source);
    if (!mark) continue;
    const status: ChecklistStatus = mark[2]!.toLowerCase() === "x" ? "done"
      : mark[2] === "~" ? "waiting" : mark[2] === "!" ? "problem" : "todo";
    const anchor = anchorByLine.get(list.span.startLine);
    // A nested plain list also owns its properties; do not leak them into an ancestor task.
    const children = lists.filter(child => child.parentStart === list.span.start);
    const ownProperties = properties.filter(property => property.start >= list.span.start && property.end <= list.span.end &&
      !children.some(child => property.start >= child.span.start && property.start < child.span.end));
    items.push({
      ...list,
      ...(anchor ? {itemId: anchor.id} : {}),
      identity: !anchor ? "unassigned" : counts.get(anchor.id) === 1 ? "unique" : "duplicate",
      status,
      evidence: createHash("sha256").update(source.trimEnd()).digest("hex"),
      markerStart: list.span.start + mark[1]!.length,
      text: source.trimEnd(),
      properties: ownProperties,
    });
  }
  return items;
}

export function queryChecklistItems(text: string, query: ChecklistQuery, properties: PropertyRecord[]) {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000) {
    throw new Error("Checklist query limit must be between 1 and 1000");
  }
  if (query.nested !== undefined && query.nested !== "include" && query.nested !== "top-level") {
    throw new Error("Checklist nested mode must be include or top-level");
  }
  for (const statuses of [query.statuses, query.excludeStatuses]) {
    if (statuses !== undefined && !Array.isArray(statuses)) throw new Error("Checklist statuses must be an array");
    for (const status of statuses ?? []) requireStatus(status);
  }
  if (query.filters !== undefined && !Array.isArray(query.filters)) throw new Error("Checklist filters must be an array");
  const filters = (query.filters ?? []).map(normalizePropertyFilter);
  const matches = checklistItems(text, properties).filter(item =>
    (query.nested !== "top-level" || item.depth === 0) &&
    (!query.statuses || query.statuses.includes(item.status)) &&
    !query.excludeStatuses?.includes(item.status) &&
    // The marker owns status, even if the item contains conflicting status prose/metadata.
    matchesFilters([...item.properties.filter(property => property.key !== "status"),
      {key: "status", value: item.status}], filters, "all"));
  return {
    items: matches.slice(0, query.limit),
    completeness: matches.length > query.limit
      ? {kind: "truncated" as const, limit: query.limit} : {kind: "complete" as const},
  };
}

/** Produces a minimal source edit after checking the current item, not the whole-note hash. */
export function updateChecklistText(text: string, revision: number, input: ChecklistUpdateInput): {text: string; itemId: string} {
  const items = checklistItems(text);
  const target = input.target;
  let item: ChecklistItem | undefined;
  if ("itemId" in target) {
    const matches = items.filter(candidate => candidate.itemId === target.itemId);
    if (matches.length > 1 || matches[0]?.identity === "duplicate") throw new Error(`Duplicate checklist item ID: ${target.itemId}`);
    item = matches[0];
  } else {
    if (!Number.isSafeInteger(target.start) || target.start < 0 || target.expectedRevision !== revision) {
      throw new Error("Checklist location changed; query the current note before addressing an unassigned item");
    }
    item = items.find(candidate => candidate.span.start === target.start);
  }
  if (!item) throw new Error("Checklist item is missing; query the current note before retrying");
  if (item.identity === "duplicate") throw new Error(`Duplicate checklist item ID: ${item.itemId}`);
  if (item.evidence !== input.expectedEvidence) throw new Error("Checklist item changed; query and review the current item before retrying");
  if (input.change.kind !== "ensure-id" && input.change.kind !== "status") throw new Error("Unknown checklist change");
  if (input.change.kind === "status") requireStatus(input.change.status);
  let next = text;
  const usedIds = new Set(fragmentAnchors(text).map(anchor => anchor.id));
  let itemId = item.itemId;
  if (!itemId) {
    do {itemId = `task-${randomUUID()}`;} while (usedIds.has(itemId));
    const newline = text.indexOf("\n", item.span.start);
    const end = newline < 0 ? text.length : newline;
    const header = text.slice(item.span.start, end);
    const insertion = item.span.start + header.trimEnd().length;
    next = text.slice(0, insertion) + ` ^${itemId}` + text.slice(insertion);
  }
  if (input.change.kind === "status") {
    next = next.slice(0, item.markerStart) + CHECKLIST_MARKS[input.change.status] + next.slice(item.markerStart + 3);
  }
  return {text: next, itemId};
}

/** Whole-note writes must not silently discard list-item addresses used by links and comments. */
export function removedListItemIds(before: string, after: string): string[] {
  if (!before.includes("^")) return [];
  const next = new Set(fragmentAnchors(after).filter(anchor => anchor.kind === "list-item").map(anchor => anchor.id));
  return [...new Set(fragmentAnchors(before).filter(anchor => anchor.kind === "list-item" && !next.has(anchor.id)).map(anchor => anchor.id))];
}

export function validateChecklistIdentityChanges(before: string, after: string, changes: readonly ChecklistIdentityChange[] = []): void {
  if (!Array.isArray(changes)) throw new Error("identityChanges must be an array");
  if (!before.includes("^") && !after.includes("^") && changes.length === 0) return;
  const previous = fragmentAnchors(before);
  const next = fragmentAnchors(after);
  const nextListIds = new Set(next.filter(anchor => anchor.kind === "list-item").map(anchor => anchor.id));
  const previousIds = new Set(previous.filter(anchor => anchor.kind === "list-item").map(anchor => anchor.id));
  const nextCounts = new Map<string, number>();
  for (const anchor of next) nextCounts.set(anchor.id, (nextCounts.get(anchor.id) ?? 0) + 1);
  const listIds = new Set([...previousIds, ...next.filter(anchor => anchor.kind === "list-item").map(anchor => anchor.id)]);
  const duplicated = [...listIds].filter(id => (nextCounts.get(id) ?? 0) > 1);
  if (duplicated.length) throw new Error(`Duplicate list-item IDs: ${duplicated.join(", ")}. Give each item its own ID before saving.`);
  const declared = new Set<string>();
  const destinations = new Set<string>();
  for (const change of changes) {
    if (!change || (change.kind !== "remove" && change.kind !== "rename") ||
      !previousIds.has(change.itemId) || declared.has(change.itemId)) {
      throw new Error("Each identityChanges entry must name one existing list-item ID exactly once");
    }
    if (nextListIds.has(change.itemId)) throw new Error(`Identity change declared but ^${change.itemId} is still present`);
    if (change.kind === "rename") {
      if (!nextListIds.has(change.to) || nextCounts.get(change.to) !== 1 || previous.some(anchor => anchor.id === change.to) || destinations.has(change.to)) {
        throw new Error(`Identity rename for ^${change.itemId} must name one new, unique destination ID`);
      }
      destinations.add(change.to);
    }
    declared.add(change.itemId);
  }
  const missing = [...previousIds].filter(id => !nextListIds.has(id) && !declared.has(id));
  if (missing.length) throw new Error(
    `List-item IDs would be removed: ${missing.map(id => `^${id}`).join(", ")}. ` +
    "Links, embeds and comments using these addresses may become unresolved. Preserve the IDs, or declare each intentional remove/rename in identityChanges with the current block revision.",
  );
}
