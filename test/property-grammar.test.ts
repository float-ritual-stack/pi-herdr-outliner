// src/property-grammar.ts is the one definition of the property token (PIE-490). The parser uses it, and
// clients copy the file whole, so it must stay free of imports and agree with the parser.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePropertyRecords } from "../src/properties";
import {
  isPropertyKey,
  isPropertyTokenLine,
  propertyTokensInLine,
  withoutPropertyTokens,
} from "../src/property-grammar";

test("the key rule: a letter first, then letters, digits, _ . -", () => {
  for (const key of ["plot.row", "bed_2", "work-stage", "A"]) expect(isPropertyKey(key)).toBe(true);
  for (const key of ["2nd-pass", "-x", "_x", "", "a b", "é"]) expect(isPropertyKey(key)).toBe(false);
});

test("a line's tokens are exactly the ones the parser reads, outside code and literal regions", () => {
  const lines = [
    "Plan [2nd-pass::yes] beans",
    "Plan [plot.row::3] beans",
    "Plan [empty::] beans",
    "Water the [bed_2::east] rows [kind::herb]",
    "Escaped \\[kind::herb] stays, \\\\[kind::tree] doesn't",
    "[type::task]   [work-stage::doing]",
    "Nested [a::[b::c]] tokens",
  ];
  for (const line of lines) {
    const theirs = parsePropertyRecords(line).filter(t => t.syntax === "bracket").map(t => ({ key: t.key, value: t.value, start: t.start }));
    expect({ line, tokens: propertyTokensInLine(line).map(({ key, value, start }) => ({ key, value, start })) }).toEqual({ line, tokens: theirs });
  }
  expect(withoutPropertyTokens("Plan [plot.row::3] beans [2nd-pass::yes]")).toBe("Plan  beans [2nd-pass::yes]");
  expect(isPropertyTokenLine("  [type::task] [stage::doing] ")).toBe(true);
  expect(isPropertyTokenLine("[type::task] and prose")).toBe(false);
  expect(isPropertyTokenLine("[2nd-pass::yes]")).toBe(false);
});

test("the module imports nothing, so a client can copy it whole", () => {
  const source = readFileSync(join(import.meta.dir, "../src/property-grammar.ts"), "utf8");
  expect(source).not.toMatch(/^\s*import\s/m);
  expect(source).not.toMatch(/\brequire\(/);
});
