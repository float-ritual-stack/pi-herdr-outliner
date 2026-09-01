import { expect, test } from "bun:test";
import {
  classifyPropertyInspectorTarget,
  createPropertyInspectorModel,
  filterPropertyInspectorEntries,
  groupPropertyInspectorEntries,
  propertyInspectorAuthoredText,
} from "../src/property-inspector";

const BLOCK_ID = "1176c501-63ed-4e57-ae04-c110ad591dc2";
const DEPENDENCY_IDS = [
  "a655c62d-4a19-4435-8a4b-9e063517e8d2",
  "92b957ce-d70f-471b-ac58-df4a5bda4068",
] as const;
const RELATED_IDS = [
  "32283d0d-869b-483f-a521-4377989a4f38",
  "a9298643-894c-462a-b2eb-8ce8eada66ac",
] as const;

const PROPERTY_HEAVY_TEXT = [
  "PIE-154 — Expose fire-and-forget capture dispatch [type::roadmap-item] [status::complete] [priority::high] [work-stage::done] [arc::polish-adapters] [depends-on::a655c62d-4a19-4435-8a4b-9e063517e8d2] [depends-on::92b957ce-d70f-471b-ac58-df4a5bda4068] [related-to::32283d0d-869b-483f-a521-4377989a4f38] [related-to::a9298643-894c-462a-b2eb-8ce8eada66ac] [work-id::PIE-154] [multiplicity::independent] [branch::main] [commit::e301fea10cf08fa2c32dbf01a784ec4baae968e9] [proof::4f21c818-8a48-446b-955a-99dddde98f23]",
  "",
  "Capture adapters share one service primitive.",
].join("\n");

test("projects every property-heavy occurrence with stable identity and exact source data", () => {
  const model = createPropertyInspectorModel(BLOCK_ID, PROPERTY_HEAVY_TEXT);
  const rebuilt = createPropertyInspectorModel(BLOCK_ID, PROPERTY_HEAVY_TEXT);

  expect(model.blockId).toBe(BLOCK_ID);
  expect(model.canonicalText).toBe(PROPERTY_HEAVY_TEXT);
  expect(model.entries).toHaveLength(14);
  expect(model.entries.map((entry) => entry.key)).toEqual([
    "type",
    "status",
    "priority",
    "work-stage",
    "arc",
    "depends-on",
    "depends-on",
    "related-to",
    "related-to",
    "work-id",
    "multiplicity",
    "branch",
    "commit",
    "proof",
  ]);
  expect(model.entries.map((entry) => entry.occurrenceId)).toEqual(
    rebuilt.entries.map((entry) => entry.occurrenceId),
  );
  expect(new Set(model.entries.map((entry) => entry.occurrenceId)).size).toBe(14);

  for (const entry of model.entries) {
    expect(PROPERTY_HEAVY_TEXT.slice(entry.start, entry.end)).toBe(entry.raw);
    expect(entry.ordinal).toBe(model.entries.indexOf(entry));
    expect(entry.line).toBe(0);
    expect(entry.scope).toBe("block");
    expect(entry.syntax).toBe("bracket");
  }

  expect(
    model.entries.filter((entry) => entry.key === "depends-on").map((entry) => entry.value),
  ).toEqual([...DEPENDENCY_IDS]);
  expect(
    model.entries.filter((entry) => entry.key === "related-to").map((entry) => entry.value),
  ).toEqual([...RELATED_IDS]);
  expect(model.entries.find((entry) => entry.key === "proof")).toMatchObject({
    value: "4f21c818-8a48-446b-955a-99dddde98f23",
    target: { kind: "block", source: "value" },
  });
});

test("retains block, line, and inline scopes without suppressing unknown keys", () => {
  const text = [
    "# Subject [type::roadmap-item]",
    "",
    "[status::planned]",
    "owner:: evan",
    "",
    "Body [unknown-widget::kept]",
    "ctx:: later [related-to::32283d0d-869b-483f-a521-4377989a4f38]",
  ].join("\n");
  const entries = createPropertyInspectorModel(BLOCK_ID, text).entries;

  expect(entries.map(({ key, scope, syntax, placement }) => ({ key, scope, syntax, placement }))).toEqual([
    { key: "type", scope: "block", syntax: "bracket", placement: "trailing-metadata" },
    { key: "status", scope: "block", syntax: "bracket", placement: "metadata-line" },
    { key: "owner", scope: "block", syntax: "bare", placement: "metadata-line" },
    { key: "unknown-widget", scope: "inline", syntax: "bracket", placement: "trailing-metadata" },
    { key: "ctx", scope: "line", syntax: "bare", placement: "metadata-line" },
    { key: "related-to", scope: "inline", syntax: "bracket", placement: "trailing-metadata" },
  ]);
  expect(filterPropertyInspectorEntries(entries)).toEqual([...entries]);
  expect(filterPropertyInspectorEntries(entries, { scopes: ["line", "inline"] }).map((entry) => entry.key)).toEqual([
    "unknown-widget",
    "ctx",
    "related-to",
  ]);
  expect(filterPropertyInspectorEntries(entries, { query: "UNKNOWN" }).map((entry) => entry.value)).toEqual([
    "kept",
  ]);
});

test("replaces block metadata in preview while preserving authored body properties", () => {
  const text = [
    "# Subject [type::roadmap-item]",
    "",
    "[status::planned]",
    "owner:: evan",
    "",
    "Body [unknown-widget::kept]",
    "ctx:: later [tag::body]",
  ].join("\n");

  expect(propertyInspectorAuthoredText(text)).toBe([
    "# Subject",
    "",
    "Body [unknown-widget::kept]",
    "ctx:: later [tag::body]",
  ].join("\n"));
  expect(text).toContain("[status::planned]");
});

test("filters and groups occurrences while preserving repeated-key order and identity", () => {
  const entries = createPropertyInspectorModel(BLOCK_ID, PROPERTY_HEAVY_TEXT).entries;
  const relationshipEntries = filterPropertyInspectorEntries(entries, {
    keys: ["RELATED-TO", "depends-on"],
    targetKinds: ["block"],
  });
  const groups = groupPropertyInspectorEntries(relationshipEntries, "key");

  expect(groups.map((group) => ({ id: group.id, label: group.label }))).toEqual([
    { id: "key:depends-on", label: "depends-on" },
    { id: "key:related-to", label: "related-to" },
  ]);
  expect(groups[0]?.entries.map((entry) => entry.value)).toEqual([...DEPENDENCY_IDS]);
  expect(groups[1]?.entries.map((entry) => entry.value)).toEqual([...RELATED_IDS]);
  expect(groups.flatMap((group) => group.entries.map((entry) => entry.occurrenceId))).toEqual(
    relationshipEntries.map((entry) => entry.occurrenceId),
  );

  const targetGroups = groupPropertyInspectorEntries(entries, "target");
  expect(targetGroups.map((group) => group.label)).toEqual(["plain", "block", "work-id"]);
  expect(targetGroups.find((group) => group.label === "plain")?.entries.some((entry) => entry.key === "branch")).toBe(true);
});

test("classifies canonical values and authored references without treating prose as a target", () => {
  const uuid = "32283d0d-869b-483f-a521-4377989a4f38";

  expect(classifyPropertyInspectorTarget("related-to", uuid)).toEqual({
    kind: "block",
    blockId: uuid,
    source: "value",
  });
  expect(classifyPropertyInspectorTarget("work-id", "PIE-171")).toEqual({
    kind: "work-id",
    workId: "PIE-171",
    source: "value",
  });
  expect(classifyPropertyInspectorTarget("page", "Planning / Inbox")).toEqual({
    kind: "page",
    address: "Planning / Inbox",
    normalizedAddress: "planning / inbox",
    source: "value",
  });
  expect(classifyPropertyInspectorTarget("source", `See ((${uuid}^contract))`)).toEqual({
    kind: "block",
    blockId: uuid,
    fragmentId: "contract",
    source: "authored-reference",
  });
  expect(classifyPropertyInspectorTarget("destination", "Open [[Planning / Inbox]]")).toEqual({
    kind: "page",
    address: "Planning / Inbox",
    normalizedAddress: "planning / inbox",
    source: "authored-reference",
  });
  expect(classifyPropertyInspectorTarget("branch", "main")).toBeNull();
  expect(classifyPropertyInspectorTarget("note", "PIE-171 is discussed here")).toBeNull();
});
