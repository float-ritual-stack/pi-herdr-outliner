import { expect, test } from "bun:test";
import {
  resolveContextKey,
  type ContextBlock,
  type ContextKeyMatcher,
} from "../src/context-resolution";
import { parsePropertyDirectiveLines, parsePropertyRecords, previewPropertyParse } from "../src/properties";
import {
  authoredResourceReferenceOccurrences,
  mayHaveResourceProjections,
  providerKeyOccurrences,
  resourceDirectiveOccurrences,
  RESOURCE_DIRECTIVE_PROVIDERS,
} from "../src/resource-references";

// Fictional tickets: a Source claims project ACME; nothing claims PIE.
const jira = RESOURCE_DIRECTIVE_PROVIDERS[0]!;
const acme: ContextKeyMatcher = {
  propertyKey: "jira",
  keysIn: (text) => providerKeyOccurrences(jira, text).filter((key) => key.key.startsWith("ACME-")),
  keyFromProperty: (value) => jira.keyPattern.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : null,
};

function resolve(text: string, line: number, ancestors: ContextBlock[] = [], explicitKey?: string) {
  return resolveContextKey({ block: { id: "self", text }, line, ancestors, matcher: acme, ...(explicitKey ? { explicitKey } : {}) });
}

test("provider lines accept the bullet form and an empty value without loosening general properties", () => {
  const text = [
    "Call about the rollout ACME-12",
    "- jira:: --comments",
    "jira::",
    "  * jira:: ACME-7 --compact --wat",
    "- status:: done",
    "status::",
    "`jira::` in code",
  ].join("\n");
  expect(resourceDirectiveOccurrences(text).map(({ line, explicitKey, options, indent }) =>
    ({ line, explicitKey, options, indent }))).toEqual([
    { line: 1, explicitKey: undefined, options: { comments: 5, unknown: [] }, indent: "" },
    { line: 2, explicitKey: undefined, options: { unknown: [] }, indent: "" },
    { line: 3, explicitKey: "ACME-7", options: { compact: true, unknown: ["--wat"] }, indent: "  " },
  ]);
  // The general parser is unchanged: bullets and empty values stay prose.
  expect(previewPropertyParse(text).tokens.map(({ key, value }) => ({ key, value }))).toEqual([]);
  expect(previewPropertyParse("- status:: done").tokens).toEqual([]);
  expect(previewPropertyParse("status::").tokens).toEqual([]);
  expect(previewPropertyParse("jira:: --comments").tokens.map(({ key, value, scope }) => ({ key, value, scope })))
    .toEqual([{ key: "jira", value: "--comments", scope: "block" }]);
  // Only supplied provider keys are recognized as provider lines.
  expect(parsePropertyDirectiveLines(text, new Set(["status"])).map(({ line }) => line)).toEqual([4, 5]);
  expect(parsePropertyDirectiveLines(text, new Set())).toEqual([]);
});

test("an option-only provider line is not a malformed key, while other bad values still are", () => {
  const text = "Notes ACME-3\njira:: --comments\njira:: hello\n- jira:: ACME-9\njira:: ACME-4 --full";
  const occurrences = authoredResourceReferenceOccurrences(text);
  expect(occurrences.map((occurrence) => occurrence.kind === "authored-resource"
    ? occurrence.reference
    : occurrence.message)).toEqual([
    "Jira Resource key must look like PROJECT-123",
    { kind: "jira", key: "ACME-9" },
    { kind: "jira", key: "ACME-4" },
  ]);
  // A preamble `jira:: KEY` is the ticket page's property, not a provider line.
  expect(resourceDirectiveOccurrences("Ticket page\njira:: ACME-5")).toEqual([]);
  // With options it is a provider line, even in the preamble.
  expect(resourceDirectiveOccurrences("Ticket page\njira:: ACME-2 --comments"))
    .toMatchObject([{ line: 1, explicitKey: "ACME-2", options: { comments: 5 } }]);
  expect(authoredResourceReferenceOccurrences("Ticket page\njira:: ACME-2 --comments"))
    .toMatchObject([{ kind: "authored-resource", reference: { kind: "jira", key: "ACME-2" } }]);
  expect(mayHaveResourceProjections("Ticket page\njira:: ACME-5")).toBe(true);
  expect(mayHaveResourceProjections("Ticket page [status::open]")).toBe(false);
  expect(parsePropertyRecords("Ticket page\njira:: ACME-5")[0]!.scope).toBe("block");
});

test("context resolution walks nearest first and stops at the first level with a key", () => {
  // 1. An explicit key wins over everything.
  expect(resolve("ACME-1\njira::", 1, [], "ACME-9")).toMatchObject({ kind: "resolved", key: "ACME-9", site: { step: "explicit" } });
  // 2. A key on the line itself.
  expect(resolve("ACME-1\nsee ACME-2 jira::", 1)).toMatchObject({ key: "ACME-2", site: { step: "line" } });
  // 3. The nearest earlier line at the same or a shallower indent; deeper lines are skipped.
  expect(resolve("Subject ACME-1\n- ACME-2 vendor call\n  - aside ACME-3\n- jira:: --comments", 3))
    .toMatchObject({ key: "ACME-2", site: { step: "preceding-line", line: 1 } });
  // 4. The block's own property beats its subject line.
  expect(resolve("Subject ACME-1 [jira::ACME-5]\nnotes\njira::", 2))
    .toMatchObject({ key: "ACME-5", site: { step: "block-property" } });
  // 5. The subject line.
  expect(resolve("Subject ACME-1\nnotes\njira::", 2)).toMatchObject({ key: "ACME-1", site: { step: "subject-line", line: 0 } });
  // 6. Ancestors, nearest first: property, then subject.
  const parent = { id: "parent", text: "Parent ACME-20\nnotes ACME-21" };
  const grandparent = { id: "grandparent", text: "Page [jira::ACME-30]" };
  expect(resolve("Child\njira::", 1, [parent, grandparent]))
    .toMatchObject({ key: "ACME-20", site: { step: "ancestor-subject", blockId: "parent" } });
  expect(resolve("Child\njira::", 1, [{ id: "plain", text: "No key" }, grandparent]))
    .toMatchObject({ key: "ACME-30", site: { step: "ancestor-property", blockId: "grandparent" } });
  expect(resolve("Child\njira::", 1, [{ id: "plain", text: "No key" }])).toEqual({ kind: "none" });
});

test("two different keys at the nearest level are ambiguous; the walk does not skip past them", () => {
  expect(resolve("Subject ACME-1\ncompare ACME-2 with ACME-3\njira::", 2)).toEqual({
    kind: "ambiguous",
    keys: ["ACME-2", "ACME-3"],
    site: { step: "preceding-line", blockId: "self", line: 1 },
  });
  // The same key twice is one ticket.
  expect(resolve("Subject\nACME-2 then ACME-2 again\njira::", 2)).toMatchObject({ kind: "resolved", key: "ACME-2" });
  expect(resolve("Page [jira::ACME-1] [jira::ACME-2]\njira::", 1)).toMatchObject({ kind: "ambiguous", keys: ["ACME-1", "ACME-2"] });
});

test("keys count only when claimed and outside code", () => {
  // The workboard prefix and dates never resolve as tickets for this Source.
  expect(resolve("PIE-445 on 2026-09-28\njira::", 1)).toEqual({ kind: "none" });
  expect(resolve("Subject\n`ACME-4` in code\njira::", 2)).toEqual({ kind: "none" });
});

test("the resolver is provider-agnostic: a matcher supplies the key grammar", () => {
  const issues: ContextKeyMatcher = {
    propertyKey: "gh",
    keysIn: (text) => [...text.matchAll(/#(\d+)\b/g)].map((match) => ({ key: match[0], start: match.index, end: match.index + match[0].length })),
    keyFromProperty: (value) => /^#\d+$/.test(value) ? value : null,
  };
  expect(resolveContextKey({ block: { id: "b", text: "Fix the crash #482\ngh::" }, line: 1, ancestors: [], matcher: issues }))
    .toMatchObject({ kind: "resolved", key: "#482", site: { step: "subject-line" } });
});

test("the walk leaves a section through its heading rather than entering an earlier section", () => {
  const sections = ["Subject", "Section A", "  item ACME-2", "Section B", "  jira::"].join("\n");
  expect(resolve(sections, 4)).toEqual({ kind: "none" });
  // Siblings at the same indent, and items in the same section, still resolve.
  expect(resolve(["Subject", "Section B", "  item ACME-3", "  jira::"].join("\n"), 3))
    .toMatchObject({ key: "ACME-3", site: { step: "preceding-line", line: 2 } });
  expect(resolve(["Subject", "Section ACME-4", "  notes", "  jira::"].join("\n"), 3))
    .toMatchObject({ key: "ACME-4", site: { step: "preceding-line", line: 1 } });
});

test("literal regions hide keys, while indented lines are prose", () => {
  expect(resolve(["Subject", "<!-- literal -->", "ACME-9 pasted", "<!-- /literal -->", "jira::"].join("\n"), 4)).toEqual({ kind: "none" });
  expect(resolve(["Subject", "```", "ACME-9", "```", "jira::"].join("\n"), 4)).toEqual({ kind: "none" });
  expect(resolve(["Subject", "", "    ACME-7 indented thought", "    jira::"].join("\n"), 3))
    .toMatchObject({ key: "ACME-7", site: { step: "preceding-line" } });
  expect(resourceDirectiveOccurrences(["S", "<!-- literal -->", "jira::", "<!-- /literal -->"].join("\n"))).toEqual([]);
});

test("ancestors are read through their preamble only", () => {
  const preamble = { id: "page", text: "Parent page\n[jira::ACME-8] [owner::me]\n\nbody mentions ACME-99" };
  expect(resolve("Child\njira::", 1, [preamble])).toMatchObject({ key: "ACME-8", site: { step: "ancestor-property" } });
  expect(resolve("Child\njira::", 1, [{ id: "body", text: "Parent\n\nbody mentions ACME-99 [jira::ACME-98]" }])).toEqual({ kind: "none" });
});
