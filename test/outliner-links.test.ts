import { getOsc8LinkAtColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import type { RequestInput } from "../src/client";
import {
  createOutlinerTextLinker,
  firstOutlinerReference,
  linkOutlinerMarkdown,
  navigateOutlinerLink,
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
    expect(parseOutlinerLinkUri(outlinerLinkUri("work", "PIE-133"))).toEqual({
      kind: "work",
      value: "PIE-133",
    });
    expect(parseOutlinerLinkUri(outlinerLinkUri("work", "ABC-001"))).toEqual({
      kind: "work",
      value: "ABC-001",
    });
    expect(parseOutlinerLinkUri(
      outlinerLinkUri("block", blockId, { preserveSource: true }),
    )).toEqual({
      kind: "block",
      value: blockId,
      preserveSource: true,
    });
    expect(parseOutlinerLinkUri(
      outlinerLinkUri("block", blockId, { intent: "reveal" }),
    )).toEqual({
      kind: "block",
      value: blockId,
      intent: "reveal",
    });
  });

  test("round-trips validated block fragments without using URL hashes", () => {
    const blockId = "550e8400-e29b-41d4-a716-446655440000";
    const uri = outlinerLinkUri("block", blockId, { fragmentId: "durable-decision" });
    expect(uri).toContain("?fragment=durable-decision");
    expect(parseOutlinerLinkUri(uri)).toEqual({
      kind: "block",
      value: blockId,
      fragmentId: "durable-decision",
    });
    expect(() => outlinerLinkUri("page", "Roadmap", { fragmentId: "decision" })).toThrow(
      "Invalid outliner fragment target",
    );
    expect(() => parseOutlinerLinkUri(
      "pi-outliner://block/550e8400-e29b-41d4-a716-446655440000?fragment=bad%20id",
    )).toThrow("Invalid outliner link navigation constraints");
  });

  test("rejects web URLs, unsupported kinds, malformed IDs, and URL decorations", () => {
    for (const uri of [
      "https://example.com",
      "pi-outliner://unknown/value",
      "pi-outliner://block/short",
      "pi-outliner://work/not-a-work-id",
      "pi-outliner://goto/value?query=yes",
      "pi-outliner://goto/value#fragment",
      "pi-outliner://goto/%1B%5B31mowned",
      "pi-outliner://goto/value%7F",
      "pi-outliner://block/550e8400-e29b-41d4-a716-446655440000?preserveSource=0",
      "pi-outliner://block/550e8400-e29b-41d4-a716-446655440000?other=1",
    ]) {
      expect(() => parseOutlinerLinkUri(uri)).toThrow();
    }
    expect(() => outlinerLinkUri("block", "short")).toThrow("Invalid outliner block target");
    expect(() => outlinerLinkUri("goto", "unsafe\nquery")).toThrow(
      "terminal control characters",
    );
  });

  test("delegates direct clicks to shared selection and Tree focus/reveal", async () => {
    const target = block(
      "550e8400-e29b-41d4-a716-446655440000",
      "Clickable target [type::decision]",
    );
    const calls: RequestInput[] = [];
    const requester = {
      async request<T>(input: RequestInput): Promise<T> {
        calls.push(input);
        if (input.action === "get") return target as T;
        if (input.action === "pages.follow") {
          return {
            address: input.address,
            normalizedAddress: "future",
            registeredAddress: "future",
            status: "resolved",
            kind: "page",
            block: target,
            created: true,
          } as T;
        }
        if (input.action === "pages.resolve" && input.address === "future") {
          return {
            address: input.address,
            normalizedAddress: "future",
            status: "missing",
          } as T;
        }
        if (input.action === "pages.resolve") {
          return {
            address: input.address,
            normalizedAddress: "pie-133",
            registeredAddress: "PIE-133",
            status: "resolved",
            kind: "work-id",
            block: target,
          } as T;
        }
        if (input.action === "clients.list") {
          return [{ clientId: "tree-client", role: "tree", contextId: "tree-client" }] as T;
        }
        return {} as T;
      },
    };

    await expect(
      navigateOutlinerLink(
        requester,
        outlinerLinkUri("block", target.id),
      ),
    ).resolves.toEqual({
      kind: "block",
      id: target.id,
      title: "Clickable target",
    });
    expect(calls).toEqual([
      { action: "get", blockId: target.id },
      { action: "clients.list", role: "tree" },
      { action: "selection.set", blockId: target.id },
      {
        action: "ui.command.send",
        command: { targetClientId: "tree-client", command: "focus", blockId: target.id },
      },
    ]);
    calls.length = 0;
    await expect(
      navigateOutlinerLink(requester, outlinerLinkUri("page", "future")),
    ).resolves.toEqual({
      kind: "page",
      id: target.id,
      title: "Clickable target",
      created: true,
    });
    expect(calls).toEqual([
      { action: "pages.resolve", address: "future" },
      { action: "clients.list", role: "tree" },
      { action: "pages.follow", address: "future" },
      { action: "selection.set", blockId: target.id },
      {
        action: "ui.command.send",
        command: { targetClientId: "tree-client", command: "focus", blockId: target.id },
      },
    ]);

    calls.length = 0;
    await expect(
      navigateOutlinerLink(requester, outlinerLinkUri("work", "PIE-133")),
    ).resolves.toEqual({
      kind: "work",
      id: target.id,
      title: "Clickable target",
    });
    expect(calls).toEqual([
      { action: "pages.resolve", address: "PIE-133" },
      { action: "clients.list", role: "tree" },
      { action: "selection.set", blockId: target.id },
      {
        action: "ui.command.send",
        command: { targetClientId: "tree-client", command: "focus", blockId: target.id },
      },
    ]);
  });

  test("dispatches typed navigation from the originating pane without global selection", async () => {
    const target = block(
      "550e8400-e29b-41d4-a716-446655440000",
      "Origin-routed target",
    );
    const calls: RequestInput[] = [];
    const requester = {
      async request<T>(input: RequestInput): Promise<T> {
        calls.push(input);
        if (input.action === "get") return target as T;
        if (input.action === "navigation.dispatch") {
          return {
            sourceClientId: input.sourceClientId,
            targetClientId: "detail-c",
            intent: input.intent,
            resolution: "unlocked",
            command: {
              targetClientId: "detail-c",
              command: input.intent,
              blockId: input.blockId,
            },
          } as T;
        }
        throw new Error(`Unexpected request: ${input.action}`);
      },
    };

    await expect(navigateOutlinerLink(
      requester,
      outlinerLinkUri("block", target.id),
      { sourceClientId: "tree-a", intent: "preview" },
    )).resolves.toEqual({
      kind: "block",
      id: target.id,
      title: "Origin-routed target",
      targetClientId: "detail-c",
      intent: "preview",
      resolution: "unlocked",
    });
    expect(calls).toEqual([
      { action: "get", blockId: target.id },
      {
        action: "navigation.dispatch",
        sourceClientId: "tree-a",
        blockId: target.id,
        intent: "preview",
      },
    ]);
  });

  test("dispatches exact fragment identity from linked references", async () => {
    const target = block(
      "550e8400-e29b-41d4-a716-446655440000",
      "Target\n\n## Decision ^durable-decision",
    );
    const calls: RequestInput[] = [];
    const requester = {
      async request<T>(input: RequestInput): Promise<T> {
        calls.push(input);
        if (input.action === "get") return target as T;
        if (input.action === "navigation.dispatch") {
          return {
            sourceClientId: input.sourceClientId,
            targetClientId: "detail-c",
            intent: input.intent,
            resolution: "unlocked",
            command: {
              targetClientId: "detail-c",
              command: input.intent,
              blockId: input.blockId,
              fragmentId: input.fragmentId,
            },
          } as T;
        }
        throw new Error(`Unexpected request: ${input.action}`);
      },
    };

    await navigateOutlinerLink(
      requester,
      outlinerLinkUri("block", target.id, { fragmentId: "durable-decision" }),
      { sourceClientId: "detail-a" },
    );

    expect(calls).toEqual([
      { action: "get", blockId: target.id },
      {
        action: "navigation.dispatch",
        sourceClientId: "detail-a",
        blockId: target.id,
        fragmentId: "durable-decision",
        intent: "open",
      },
    ]);
  });

  test("does not create a dangling page when every Detail is locked", async () => {
    const calls: RequestInput[] = [];
    const requester = {
      async request<T>(input: RequestInput): Promise<T> {
        calls.push(input);
        if (input.action === "navigation.resolve") {
          throw new Error("All Details in this tab are locked · unlock one or open another Detail");
        }
        throw new Error(`Unexpected request: ${input.action}`);
      },
    };

    await expect(navigateOutlinerLink(
      requester,
      outlinerLinkUri("page", "Future"),
      { sourceClientId: "tree-a", intent: "open" },
    )).rejects.toThrow("All Details in this tab are locked");
    expect(calls).toEqual([
      { action: "navigation.resolve", sourceClientId: "tree-a", intent: "open" },
    ]);
  });

  test("does not create a missing page before resolving Tree ambiguity", async () => {
    const calls: RequestInput[] = [];
    const requester = {
      async request<T>(input: RequestInput): Promise<T> {
        calls.push(input);
        if (input.action === "pages.resolve") {
          return {
            address: input.address,
            normalizedAddress: "future",
            status: "missing",
          } as T;
        }
        if (input.action === "clients.list") {
          return [
            { clientId: "tree-a", role: "tree", contextId: "tree-a" },
            { clientId: "tree-b", role: "tree", contextId: "tree-b" },
          ] as T;
        }
        throw new Error(`Unexpected request: ${input.action}`);
      },
    };

    await expect(
      navigateOutlinerLink(requester, outlinerLinkUri("page", "future")),
    ).rejects.toThrow(
      "Multiple live tree clients are registered; choose clientId: tree-a, tree-b",
    );
    expect(calls).toEqual([
      { action: "pages.resolve", address: "future" },
      { action: "clients.list", role: "tree" },
    ]);
  });

  test("routes exact deleted targets to read-only Detail inspection", async () => {
    const target = block(
      "550e8400-e29b-41d4-a716-446655440009",
      "Deleted target",
    );
    target.deletedAt = "deleted-at";
    target.effectiveDeletedRootId = target.id;
    const calls: RequestInput[] = [];
    const requester = {
      async request<T>(input: RequestInput): Promise<T> {
        calls.push(input);
        if (input.action === "get") return target as T;
        if (input.action === "clients.list") {
          return [{ clientId: "detail-client", role: "detail", contextId: "detail-client" }] as T;
        }
        return {} as T;
      },
    };

    await expect(
      navigateOutlinerLink(requester, outlinerLinkUri("block", target.id)),
    ).resolves.toEqual({
      kind: "block",
      id: target.id,
      title: "Deleted target",
      deleted: true,
    });
    expect(calls.slice(-3)).toEqual([
      { action: "clients.list", role: "detail" },
      { action: "selection.set", blockId: target.id },
      {
        action: "ui.command.send",
        command: {
          targetClientId: "detail-client",
          command: "focus",
          blockId: target.id,
        },
      },
    ]);
  });

  test("does not fuzzy-match a missing exact block reference", async () => {
    const missingId = "missing-reference";
    const calls: RequestInput[] = [];
    const requester = {
      async request<T>(input: RequestInput): Promise<T> {
        calls.push(input);
        throw new Error(`Block not found: ${missingId}`);
      },
    };

    await expect(
      navigateOutlinerLink(requester, outlinerLinkUri("block", missingId)),
    ).rejects.toThrow(`Block not found: ${missingId}`);
    expect(calls).toEqual([{ action: "get", blockId: missingId }]);
  });

  test("does not create an unresolved bare Work-ID link", async () => {
    const calls: RequestInput[] = [];
    const requester = {
      async request<T>(input: RequestInput): Promise<T> {
        calls.push(input);
        return {
          address: "PIE-404",
          normalizedAddress: "pie-404",
          status: "missing",
        } as T;
      },
    };

    await expect(
      navigateOutlinerLink(requester, outlinerLinkUri("work", "PIE-404")),
    ).rejects.toThrow("Work ID address is unresolved");
    expect(calls).toEqual([{ action: "pages.resolve", address: "PIE-404" }]);
  });
});

describe("outliner link rendering", () => {
  const targetId = "550e8400-e29b-41d4-a716-446655440000";
  const target = block(targetId, "Target decision [type::decision]");

  test("emits OSC 8 links for pages, work IDs, exact metadata IDs, and resolved references", () => {
    const raw = `[[Future Page]] PIE-133 depends on [decision::${targetId}] and ((${targetId}))`;
    const resolved = `[[Future Page]] PIE-133 depends on [decision::${targetId}] and ((Target decision))`;
    const linker = createOutlinerTextLinker(
      raw,
      (id) => id === targetId ? target : null,
      "PIE",
    );
    const rendered = linker.link(resolved);

    expect(stripTerminalSequences(rendered)).toBe(resolved);
    expect(getOsc8LinkAtColumn(rendered, 2)).toBe(outlinerLinkUri("page", "Future Page"));
    expect(getOsc8LinkAtColumn(rendered, resolved.indexOf("PIE-133") + 2)).toBe(
      outlinerLinkUri("work", "PIE-133"),
    );
    expect(getOsc8LinkAtColumn(rendered, resolved.indexOf(targetId) + 2)).toBe(
      outlinerLinkUri("block", targetId),
    );
    expect(getOsc8LinkAtColumn(rendered, resolved.indexOf("Target decision") + 2)).toBe(
      outlinerLinkUri("block", targetId),
    );
  });
  test("gives titled page links precedence over nested Work-ID styling", () => {
    const raw =
      `[[PIE-123|some title · PIE-123]] and PIE-123 and ((${targetId}))`;
    const titledTarget = block(targetId, "Target decision · PIE-123 [type::decision]");
    const resolved = raw.replace(`((${targetId}))`, "((Target decision · PIE-123))");
    const linker = createOutlinerTextLinker(
      raw,
      (id) => id === targetId ? titledTarget : null,
      "PIE",
    );
    const rendered = linker.link(resolved);

    expect(stripTerminalSequences(rendered)).toBe(resolved);
    expect(getOsc8LinkAtColumn(rendered, 3)).toBe(outlinerLinkUri("page", "PIE-123"));
    expect(getOsc8LinkAtColumn(rendered, resolved.indexOf("some title") + 2)).toBe(
      outlinerLinkUri("page", "PIE-123"),
    );
    expect(getOsc8LinkAtColumn(rendered, resolved.indexOf("and PIE-123") + 6)).toBe(
      outlinerLinkUri("work", "PIE-123"),
    );
    expect(getOsc8LinkAtColumn(rendered, resolved.indexOf("Target decision") + 2)).toBe(
      outlinerLinkUri("block", targetId),
    );
    expect(firstOutlinerReference(raw, "PIE")).toEqual({
      kind: "page",
      value: "PIE-123",
    });
  });

  test("preserves heading and callout structure around titled links", () => {
    const raw = [
      "# [[PIE-123|Heading label]]",
      "> [!note]",
      "> [[PIE-123|Callout label]]",
    ].join("\n");
    const linked = linkOutlinerMarkdown(raw, raw, "PIE");

    expect(linked).toContain(
      `# [[[PIE-123|Heading label\\]\\]](${outlinerLinkUri("page", "PIE-123")})`,
    );
    expect(linked).toContain(
      `> [[[PIE-123|Callout label\\]\\]](${outlinerLinkUri("page", "PIE-123")})`,
    );
    expect(linked.match(/pi-outliner:\/\/page\//g)).toHaveLength(2);
    expect(linked).not.toContain(outlinerLinkUri("work", "PIE-123"));
  });


  test("links resolved durable fragments to fragment-aware block URIs", () => {
    const anchored = block(targetId, "Target decision\n\n## Durable ^durable");
    const raw = `((${targetId}^durable))`;
    const resolved = "((Target decision^durable))";
    const linker = createOutlinerTextLinker(raw, () => anchored);
    const rendered = linker.link(resolved);

    expect(stripTerminalSequences(rendered)).toBe(resolved);
    expect(getOsc8LinkAtColumn(rendered, 3)).toBe(
      outlinerLinkUri("block", targetId, { fragmentId: "durable" }),
    );
    expect(linkOutlinerMarkdown(resolved, raw)).toContain(
      outlinerLinkUri("block", targetId, { fragmentId: "durable" }),
    );
  });
  test("links titled references by canonical block and fragment identity", () => {
    const secondId = "550e8400-e29b-41d4-a716-446655440001";
    const raw = [
      `((${targetId}^durable|same **label** PIE-123))`,
      `((${secondId}|same **label** PIE-123))`,
    ].join(" ");
    const resolved = [
      "((same **label** PIE-123))",
      "((same **label** PIE-123))",
    ].join(" ");
    const linker = createOutlinerTextLinker(
      raw,
      (id) => id === targetId
        ? block(targetId, "Target\n\n## Durable ^durable")
        : id === secondId
          ? block(secondId, "Other")
          : null,
      "PIE",
    );
    const rendered = linker.link(resolved);
    const firstLabel = resolved.indexOf("same");
    const secondLabel = resolved.lastIndexOf("same");

    expect(stripTerminalSequences(rendered)).toBe(resolved);
    expect(getOsc8LinkAtColumn(rendered, firstLabel + 2)).toBe(
      outlinerLinkUri("block", targetId, { fragmentId: "durable" }),
    );
    expect(getOsc8LinkAtColumn(rendered, secondLabel + 2)).toBe(
      outlinerLinkUri("block", secondId),
    );
    expect(getOsc8LinkAtColumn(rendered, resolved.indexOf("PIE-123") + 2)).toBe(
      outlinerLinkUri("block", targetId, { fragmentId: "durable" }),
    );
    expect(firstOutlinerReference(raw, "PIE")).toEqual({
      kind: "block",
      value: targetId,
      fragmentId: "durable",
    });
  });

  test("leaves missing and invalid titled references visible but nonactionable", () => {
    const raw = `((${targetId}|missing label))`;
    const missing = linkOutlinerMarkdown(raw, raw, "PIE");
    const invalid = `((${targetId}|))`;

    expect(stripTerminalSequences(missing)).toBe(raw);
    expect(getOsc8LinkAtColumn(missing, raw.indexOf(targetId) + 2)).toBeUndefined();
    expect(firstOutlinerReference(invalid, "PIE")).toBeNull();
    expect(createOutlinerTextLinker(invalid, () => target).link(invalid)).toBe(invalid);
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
    const linked = linkOutlinerMarkdown(resolved, raw, "PIE");

    expect(linked).toContain(`[PIE-133](${outlinerLinkUri("work", "PIE-133")})`);
    expect(linked).toContain(
      `[((Target decision))](${outlinerLinkUri("block", targetId)})`,
    );
    expect(linked).toContain(`\`PIE-999 ${targetId}\``);
    expect(linked).toContain("[existing](https://example.com/PIE-998)");
    expect(linked).toContain(`\`\`PIE-997 ${targetId}\`\``);
    expect(linked).toContain(`[titled](https://example.com/PIE-996 "PIE-995")`);
    expect(linked).toContain(`~~~text\nPIE-994 ${targetId}\n~~~`);
    expect(linked).not.toContain(outlinerLinkUri("work", "PIE-994"));
  });

  test("links dangling pages in Markdown while protecting literal examples", () => {
    const raw = "[[Future Page]] and `[[Literal Page]]`";
    const linked = linkOutlinerMarkdown(raw, raw);

    expect(linked).toContain(`[[[Future Page\\]\\]](${outlinerLinkUri("page", "Future Page")})`);
    expect(linked).toContain("`[[Literal Page]]`");
    expect(linked).not.toContain(outlinerLinkUri("page", "Literal Page"));
  });

  test("finds the first actionable exact or symbolic reference", () => {
    expect(firstOutlinerReference("`[[literal]]` then [[Page]] and ((target01))")).toEqual({
      kind: "page",
      value: "Page",
    });
    expect(firstOutlinerReference("((target01)) then [[Page]]")).toEqual({
      kind: "block",
      value: "target01",
    });
    expect(firstOutlinerReference("PIE-132 without brackets", "PIE")).toEqual({
      kind: "work",
      value: "PIE-132",
    });
    expect(firstOutlinerReference("((target01^decision))")).toEqual({
      kind: "block",
      value: "target01",
      fragmentId: "decision",
    });
  });

  test("finds bare Work IDs as symbolic references", () => {
    expect(firstOutlinerReference("PIE-133", "PIE")).toEqual({ kind: "work", value: "PIE-133" });
    expect(firstOutlinerReference("`PIE-133` then PIE-134", "PIE")).toEqual({
      kind: "work",
      value: "PIE-134",
    });
    expect(firstOutlinerReference("[[Page]] before PIE-133")).toEqual({
      kind: "page",
      value: "Page",
    });
    expect(firstOutlinerReference("[[PIE-135]")).toBeNull();
    const malformed = createOutlinerTextLinker("[[PIE-135]", () => null).link("[[PIE-135]");
    expect(getOsc8LinkAtColumn(malformed, 3)).toBeUndefined();
    expect(firstOutlinerReference("pie-136")).toBeNull();
    const lowercase = createOutlinerTextLinker("pie-136", () => null).link("pie-136");
    expect(getOsc8LinkAtColumn(lowercase, 2)).toBeUndefined();
    expect(firstOutlinerReference("ABC-001", "ABC")).toEqual({
      kind: "work",
      value: "ABC-001",
    });
    const customPrefix = createOutlinerTextLinker(
      "ABC-001",
      () => null,
      "ABC",
    ).link("ABC-001");
    expect(getOsc8LinkAtColumn(customPrefix, 2)).toBe(
      outlinerLinkUri("work", "ABC-001"),
    );
    expect(firstOutlinerReference("ABC-001_foo")).toBeNull();
    expect(firstOutlinerReference("foo_ABC-001")).toBeNull();
    const embedded = createOutlinerTextLinker("ABC-001_foo", () => null).link(
      "ABC-001_foo",
    );
    expect(getOsc8LinkAtColumn(embedded, 2)).toBeUndefined();
  });

  test("keeps tilde fences protected until a complete matching close", () => {
    const literal = [
      "~~~text",
      `PIE-994 ${targetId}`,
      "```not the matching marker",
      "    ~~~",
      "~~~not a closing fence",
      `PIE-993 ${targetId}`,
      "~~~",
    ].join("\n");

    expect(linkOutlinerMarkdown(literal, literal)).toBe(literal);
  });
});
