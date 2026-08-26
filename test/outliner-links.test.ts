import { getOsc8LinkAtColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import {
  createOutlinerTextLinker,
  linkOutlinerMarkdown,
  outlinerLinkUri,
  parseOutlinerLinkUri,
} from "../src/outliner-links";
import type { Block } from "../src/types";

function block(id: string, text: string): Block {
  return {
    id,
    parentId: null,
    position: 0,
    text,
    author: "user",
    collapsed: false,
    createdAt: "created",
    updatedAt: "updated",
    properties: [],
  };
}

describe("outliner link URIs", () => {
  test("round-trips exact blocks and encoded shared-goto queries", () => {
    const blockId = "550e8400-e29b-41d4-a716-446655440000";
    expect(parseOutlinerLinkUri(outlinerLinkUri("block", blockId))).toEqual({
      kind: "block",
      value: blockId,
    });
    expect(parseOutlinerLinkUri(outlinerLinkUri("goto", "PIE-133 / links"))).toEqual({
      kind: "goto",
      value: "PIE-133 / links",
    });
  });

  test("rejects web URLs, unsupported kinds, malformed IDs, and URL decorations", () => {
    for (const uri of [
      "https://example.com",
      "pi-outliner://unknown/value",
      "pi-outliner://block/short",
      "pi-outliner://goto/value?query=yes",
      "pi-outliner://goto/value#fragment",
      "pi-outliner://goto/%1B%5B31mowned",
      "pi-outliner://goto/value%7F",
    ]) {
      expect(() => parseOutlinerLinkUri(uri)).toThrow();
    }
    expect(() => outlinerLinkUri("block", "short")).toThrow("Invalid outliner block target");
    expect(() => outlinerLinkUri("goto", "unsafe\nquery")).toThrow(
      "terminal control characters",
    );
  });
});

describe("outliner link rendering", () => {
  const targetId = "550e8400-e29b-41d4-a716-446655440000";
  const target = block(targetId, "Target decision [type::decision]");

  test("emits OSC 8 links for work IDs, exact metadata IDs, and resolved references", () => {
    const raw = `PIE-133 depends on [decision::${targetId}] and ((${targetId}))`;
    const resolved = `PIE-133 depends on [decision::${targetId}] and ((Target decision))`;
    const linker = createOutlinerTextLinker(raw, (id) => id === targetId ? target : null);
    const rendered = linker.link(resolved);

    expect(stripTerminalSequences(rendered)).toBe(resolved);
    expect(getOsc8LinkAtColumn(rendered, 2)).toBe(outlinerLinkUri("goto", "PIE-133"));
    expect(getOsc8LinkAtColumn(rendered, resolved.indexOf(targetId) + 2)).toBe(
      outlinerLinkUri("block", targetId),
    );
    expect(getOsc8LinkAtColumn(rendered, resolved.indexOf("Target decision") + 2)).toBe(
      outlinerLinkUri("block", targetId),
    );
  });

  test("consumes protected references before linking later rendered rows", () => {
    const firstId = "550e8400-e29b-41d4-a716-446655440001";
    const secondId = "550e8400-e29b-41d4-a716-446655440002";
    const first = block(firstId, "Shared title");
    const second = block(secondId, "Shared title");
    const linker = createOutlinerTextLinker(
      `\`((${firstId}))\`\n((${secondId}))`,
      (id) => {
        if (id === firstId) return first;
        if (id === secondId) return second;
        return null;
      },
    );

    expect(linker.link("`((Shared title))`")).toBe("`((Shared title))`");
    expect(getOsc8LinkAtColumn(linker.link("((Shared title))"), 2)).toBe(
      outlinerLinkUri("block", secondId),
    );
  });

  test("keeps unresolved references from capturing a later identical label", () => {
    const unresolvedId = "550e8400-e29b-41d4-a716-446655440003";
    const targetId = "550e8400-e29b-41d4-a716-446655440004";
    const target = block(targetId, unresolvedId);
    const linker = createOutlinerTextLinker(
      `((${unresolvedId}))\n((${targetId}))`,
      (id) => id === targetId ? target : null,
    );

    expect(linker.link(`((${unresolvedId}))`)).toBe(`((${unresolvedId}))`);
    expect(getOsc8LinkAtColumn(linker.link(`((${unresolvedId}))`), 2)).toBe(
      outlinerLinkUri("block", targetId),
    );
  });

  test("generates Markdown links after sanitization while leaving literal examples alone", () => {
    const raw = [
      `PIE-133 and ((${targetId}))`,
      `\`PIE-999 ${targetId}\``,
      "[existing](https://example.com/PIE-998)",
      `\`\`PIE-997 ${targetId}\`\``,
      `[titled](https://example.com/PIE-996 "PIE-995")`,
      "~~~text",
      `PIE-994 ${targetId}`,
      "~~~",
    ].join("\n");
    const resolved = raw.replace(`((${targetId}))`, "((Target decision))");
    const linked = linkOutlinerMarkdown(resolved, raw);

    expect(linked).toContain(`[PIE-133](${outlinerLinkUri("goto", "PIE-133")})`);
    expect(linked).toContain(
      `[((Target decision))](${outlinerLinkUri("block", targetId)})`,
    );
    expect(linked).toContain(`\`PIE-999 ${targetId}\``);
    expect(linked).toContain("[existing](https://example.com/PIE-998)");
    expect(linked).toContain(`\`\`PIE-997 ${targetId}\`\``);
    expect(linked).toContain(`[titled](https://example.com/PIE-996 "PIE-995")`);
    expect(linked).toContain(`~~~text\nPIE-994 ${targetId}\n~~~`);
  });
});
