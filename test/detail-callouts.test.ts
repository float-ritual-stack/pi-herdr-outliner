import {
  stripTerminalSequences,
  visibleWidth,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import {
  DetailCalloutDocument,
  parseDetailCallouts,
} from "../src/detail-callouts";
import {
  DEFAULT_DETAIL_CALLOUT_THEME,
  detailCalloutThemeFromEnvironment,
  resolveDetailCalloutTheme,
} from "../src/detail-callout-theme";
import { SourceSpannedMarkdown } from "../src/source-spanned-markdown";
import {
  movePreviewRegionFocus,
  parsePreviewRegionActionUri,
  previewRegionActionUri,
  reconcilePreviewRegions,
  togglePreviewRegionDisclosure,
  type PreviewRegionState,
} from "../src/detail-preview-regions";

const theme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

function regionState(): PreviewRegionState {
  return {
    regions: [],
    focusedRegionId: null,
    disclosureOverrides: new Map(),
  };
}

function render(source: string): string {
  const regions = parseDetailCallouts(source);
  const state = regionState();
  reconcilePreviewRegions(state, regions);
  return new DetailCalloutDocument(source, regions, theme, state, false)
    .render(80)
    .map(stripTerminalSequences)
    .join("\n");
}

describe("Detail Obsidian callouts", () => {
  test("retains exact spans and parent-child identity through three nesting levels", () => {
    const source = [
      "> [!note]+ Outer",
      "> outer body",
      "> > [!warning]- Middle",
      "> > middle body",
      "> > > [!tip]+ Inner",
      "> > > inner body",
      "after",
    ].join("\n");
    const regions = parseDetailCallouts(source);

    expect(regions).toHaveLength(3);
    expect(regions.map((region) => region.parentId)).toEqual([
      null,
      regions[0]!.id,
      regions[1]!.id,
    ]);
    expect(regions[0]!.childIds).toEqual([regions[1]!.id]);
    expect(regions[1]!.childIds).toEqual([regions[2]!.id]);
    expect(source.slice(regions[2]!.sourceSpan!.start, regions[2]!.sourceSpan!.end))
      .toBe("> > > [!tip]+ Inner\n> > > inner body\n");
  });

  test("honors fold markers while leaving unmarked callouts undisclosed", () => {
    const regions = parseDetailCallouts([
      "> [!note] Plain",
      "> body",
      "> [!tip]+ Open",
      "> body",
      "> [!warning]- Closed",
      "> hidden",
    ].join("\n"));

    expect(regions.map((region) => region.foldMarker)).toEqual([null, "+", "-"]);
    expect(regions.map((region) => region.disclosure?.defaultExpanded ?? null)).toEqual([
      null,
      true,
      false,
    ]);
  });

  test("normalizes aliases, preserves custom titles, and falls back for unknown types", () => {
    const regions = parseDetailCallouts([
      "> [!faq]+ Ask us anything",
      "> answer",
      "> [!attention]-",
      "> warning",
      "> [!ship-status] Fleet",
    ].join("\n"));

    expect(regions.map(({ canonicalType, title, icon }) => ({ canonicalType, title, icon })))
      .toEqual([
        { canonicalType: "question", title: "Ask us anything", icon: "?" },
        { canonicalType: "warning", title: "Warning", icon: "!" },
        { canonicalType: "ship-status", title: "Fleet", icon: "●" },
      ]);
  });

  test("merges canonical style overrides while rejecting unsafe colors and glyphs", () => {
    const resolved = resolveDetailCalloutTheme({
      question: { foreground: "#010203", glyph: "Q" },
      warning: {
        foreground: "#111213",
        background: "#212223",
        accent: "#313233",
        glyph: "W",
      },
      tip: { background: "mint", glyph: "!!" },
      faq: { accent: "#112233" },
    });

    expect(resolved.theme.types.question).toMatchObject({
      foreground: "#010203",
      glyph: "Q",
    });
    expect(resolved.errors).toEqual([
      "tip.background must be a #RRGGBB color",
      "tip.glyph must be printable and exactly one terminal column",
      "faq is not a canonical callout type",
    ]);
    expect(
      parseDetailCallouts("> [!faq] Alias", resolved.theme)[0]!.icon,
    ).toBe("Q");

    const warningRegions = parseDetailCallouts("> [!warning] Override", resolved.theme);
    const state = regionState();
    reconcilePreviewRegions(state, warningRegions);
    const rendered = new DetailCalloutDocument(
      "> [!warning] Override",
      warningRegions,
      theme,
      state,
      false,
      undefined,
      resolved.theme,
    ).render(24)[0]!;
    expect(stripTerminalSequences(rendered).trimEnd()).toBe("│ • W Override");
    expect(rendered).toContain("\x1b[38;2;49;50;51m");
    expect(rendered).toContain("\x1b[48;2;33;34;35m");
    expect(rendered).toContain("\x1b[38;2;17;18;19m");
  });

  test("falls back to defaults when environment configuration is malformed", () => {
    const resolved = detailCalloutThemeFromEnvironment({
      OUTLINER_CALLOUT_THEME: "{not-json",
    });

    expect(resolved.theme).toBe(DEFAULT_DETAIL_CALLOUT_THEME);
    expect(resolved.errors).toEqual([
      "OUTLINER_CALLOUT_THEME must be valid JSON",
    ]);
  });

  test("paints width-safe semantic cards with distinct type palettes and glyphs", () => {
    const source = [
      "> [!note] Note",
      "> [!info] Info",
      "> [!warning] Warning",
      "> [!tip] Tip",
      "> [!success] Success",
      "> [!question] Question",
      "> [!ship-status] Unknown",
    ].join("\n");
    const regions = parseDetailCallouts(source);
    const state = regionState();
    reconcilePreviewRegions(state, regions);
    const lines = new DetailCalloutDocument(source, regions, {
      ...theme,
      bold: (text) => `\x1b[1m${text}\x1b[0m`,
    }, state, false).render(32);

    expect(lines.every((line) => visibleWidth(line) === 32)).toBe(true);
    expect(lines.map((line) => stripTerminalSequences(line).trimEnd())).toEqual([
      "│ • ● Note",
      "│ • i Info",
      "│ • ! Warning",
      "│ • ◆ Tip",
      "│ • ✓ Success",
      "│ • ? Question",
      "│ • ● Unknown",
    ]);
    expect(lines[0]).toContain("\x1b[48;2;22;38;55m");
    expect(lines[2]).toContain("\x1b[48;2;57;46;24m");
    expect(lines[3]).toContain("\x1b[48;2;23;48;38m");
    expect(lines[5]).toContain("\x1b[48;2;40;33;57m");
    expect(lines[6]).toContain("\x1b[48;2;32;38;45m");
  });

  test("keeps body backgrounds and semantic color when Markdown and focus styles reset", () => {
    const source = "> [!warning]+ Risk\n> **Bold** then plain";
    const regions = parseDetailCallouts(source);
    const state = regionState();
    reconcilePreviewRegions(state, regions);
    state.focusedRegionId = regions[0]!.id;
    const lines = new DetailCalloutDocument(source, regions, {
      ...theme,
      bold: (text) => `\x1b[1m${text}\x1b[0m`,
    }, state, false).render(24);

    expect(lines.every((line) => visibleWidth(line) === 24)).toBe(true);
    expect(lines[0]).toContain("\x1b[48;2;57;46;24m");
    expect(lines[0]).toContain("\x1b[1;4m");
    expect(lines[1]).toContain(
      "\x1b[0m\x1b[48;2;57;46;24m\x1b[38;2;255;240;199m",
    );

    const narrow = new DetailCalloutDocument(source, regions, theme, state, false)
      .render(5);
    expect(narrow.every((line) => visibleWidth(line) === 5)).toBe(true);
  });

  test("renders title-only callouts and delegates lists, code, references, and embeds in bodies", () => {
    const document = render([
      "> [!example] Title only",
      "",
      "> [!note]+ Rich body",
      "> - list item with [reference](pi-outliner://block/target)",
      "> - embedded result ((target))",
      ">",
      ">   ```ts",
      ">   const value = 1;",
      ">   ```",
    ].join("\n"));

    expect(document).toContain("Title only");
    expect(document).toContain("Rich body");
    expect(document).toContain("list item with reference");
    expect(document).toContain("embedded result ((target))");
    expect(document).toContain("const value = 1;");
  });

  test("uses one typed action for keyboard activation and OSC8 dispatch without source edits", () => {
    const source = "> [!note]- Folded\n> canonical body";
    const regions = parseDetailCallouts(source);
    const state = regionState();
    reconcilePreviewRegions(state, regions);
    state.focusedRegionId = regions[0]!.id;
    const action = state.regions[0]!.activation!;

    expect(parsePreviewRegionActionUri(previewRegionActionUri(action))).toEqual(action);
    expect(togglePreviewRegionDisclosure(state, regions[0]!.id)).toBe(true);
    expect(source).toBe("> [!note]- Folded\n> canonical body");
  });

  test("skips nested callouts hidden by collapsed ancestors", () => {
    const regions = parseDetailCallouts([
      "> [!note]- Outer",
      "> > [!tip]+ Inner",
      "> > body",
    ].join("\n"));
    const state = regionState();
    reconcilePreviewRegions(state, regions);

    expect(movePreviewRegionFocus(state, 1)?.id).toBe(regions[0]!.id);
    expect(movePreviewRegionFocus(state, 1)?.id).toBe(regions[0]!.id);

    togglePreviewRegionDisclosure(state, regions[0]!.id);
    expect(movePreviewRegionFocus(state, 1)?.id).toBe(regions[1]!.id);

    togglePreviewRegionDisclosure(state, regions[0]!.id);
    reconcilePreviewRegions(state, regions);
    expect(state.focusedRegionId).toBeNull();
  });

  test("preserves projected embed decoration inside callout bodies", () => {
    const source = [
      "Before",
      "> [!note]+ Embedded note",
      "> Projected body",
      "After",
    ].join("\n");
    const state = regionState();
    const regions = parseDetailCallouts(source);
    reconcilePreviewRegions(state, regions);
    const markdown = new SourceSpannedMarkdown(
      theme,
      (text) => `\x1b[48;5;236m${text}\x1b[0m`,
      state,
    );

    markdown.setContent(source, [{ startLine: 2, endLine: 2 }], true, regions);
    const rendered = markdown.render(48);

    expect(rendered.find((line) => line.includes("Projected body"))).toContain(
      "\x1b[48;5;236m",
    );
    expect(rendered.find((line) => line.includes("Before"))).not.toContain(
      "\x1b[48;5;236m",
    );
    expect(rendered.find((line) => line.includes("After"))).not.toContain(
      "\x1b[48;5;236m",
    );
  });
});
