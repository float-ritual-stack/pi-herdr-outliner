import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  actionChordForInput,
  displayActionChord,
  filterActionMenuItems,
  normalizeActionChord,
  OutlinerActionKeymap,
  resolveOutlinerKeymapPath,
} from "../src/outliner-actions";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryKeymap(contents: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "outliner-keymap-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "keybindings.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe("Outliner action keymap", () => {
  test("normalizes terminal inputs and configurable chords", () => {
    expect(normalizeActionChord("control+shift+r")).toBe("Ctrl+Shift+R");
    expect(actionChordForInput("R", { name: "r", shift: true })).toBe("Shift+R");
    expect(actionChordForInput(undefined, { name: "down", sequence: "\x1b[B" })).toBe("ArrowDown");
    expect(actionChordForInput(undefined, {})).toBeNull();
    expect(actionChordForInput(undefined, { name: "undefined" })).toBeNull();
    expect(actionChordForInput("", { name: "return" })).toBe("Enter");
    expect(() => normalizeActionChord("Ctrl+Banana")).toThrow("Unsupported key name: Banana");
  });
  test("renders compact terminal glyphs without changing canonical chords", () => {
    expect(displayActionChord("Ctrl+Shift+ArrowDown")).toBe("⌃⇧↓");
    expect(displayActionChord("Command+Option+ArrowUp")).toBe("⌘⌥↑");
    expect(displayActionChord("Enter")).toBe("↵");
    expect(new OutlinerActionKeymap("<test>").helpText(
      "tree",
      "browse",
      ["tree.close", "tree.move.down", "tree.read"],
    )).toBe("⌃Q close  ↓ down  ↵ read");
    expect(new OutlinerActionKeymap("<test>", {
      "tree.detail.right": ["Alt+D"],
    }).menuItems("tree", "browse")).toContainEqual(
      expect.objectContaining({
        id: "tree.detail.right",
        binding: "⌥D",
      }),
    );
  });
  test("fuzzy-ranks action menu labels, descriptions, and IDs", () => {
    const keymap = new OutlinerActionKeymap("<test>");
    const matches = filterActionMenuItems(keymap.menuItems("tree", "browse"), "dtrt");
    expect(matches[0]?.id).toBe("tree.detail.right");
    expect(filterActionMenuItems(keymap.menuItems("tree", "browse"), "no-such-action")).toEqual([]);
  });
  test("exposes stable intents and mode-aware availability", () => {
    const keymap = new OutlinerActionKeymap("<test>");
    const action = keymap.action("detail.edit.begin");
    expect(action.intent).toBe("detail.edit.begin");
    expect(action.available({ surface: "detail", mode: "preview" })).toBe(true);
    expect(action.available({ surface: "detail", mode: "edit" })).toBe(false);
  });


  test("remaps registered actions and suppresses stale defaults", () => {
    const keymap = new OutlinerActionKeymap("<test>", { "tree.edit": ["x"] });
    expect(keymap.canonicalize("tree", "browse", "x", { name: "x" })).toMatchObject({
      actionId: "tree.edit",
      str: "e",
      suppressed: false,
    });
    expect(keymap.canonicalize("tree", "browse", "e", { name: "e" })).toMatchObject({
      actionId: null,
      suppressed: true,
    });
  });
  test("uses rebound chords for actions without defaults", () => {
    const keymap = new OutlinerActionKeymap("<test>", { "tree.detail.right": ["Alt+D"] });
    expect(keymap.canonicalize("tree", "browse", "", { name: "d", meta: true })).toMatchObject({
      actionId: "tree.detail.right",
      str: "",
      key: { name: "d", meta: true },
      suppressed: false,
    });
    expect(keymap.canonicalInput("tree.detail.right")).toEqual({
      str: "",
      key: { name: "d", meta: true },
    });
    expect(new OutlinerActionKeymap("<test>").canonicalInput("tree.detail.right")).toBeNull();
  });

  test("rejects active-scope collisions and missing cancel routes", () => {
    expect(() => new OutlinerActionKeymap("<test>", {
      "tree.edit": ["g"],
    })).toThrow("tree.edit and tree.goto both use g");
    expect(() => new OutlinerActionKeymap("<test>", {
      "detail.cancel": [],
    })).toThrow("Detail editor modes require a keyboard-accessible cancel action");
  });
  test("reports unbound actions accurately in helpers and menus", () => {
    const keymap = new OutlinerActionKeymap("<test>", { "tree.edit": [] });
    expect(keymap.helpText("tree", "browse", ["tree.edit"])).toBe("unbound edit");
    expect(keymap.menuItems("tree", "browse")).toContainEqual(expect.objectContaining({
      id: "tree.edit",
      binding: "unbound",
    }));
  });


  test("reloads atomically and reports effective bindings in help and menus", () => {
    const path = temporaryKeymap({ "detail.edit.begin": ["x"] });
    const keymap = new OutlinerActionKeymap(path);
    expect(keymap.reload()).toEqual({ ok: true });
    expect(keymap.helpText("detail", "preview", ["detail.edit.begin"])).toBe("x edit");
    expect(keymap.menuItems("detail", "preview")).toContainEqual(expect.objectContaining({
      id: "detail.edit.begin",
      binding: "x",
    }));

    writeFileSync(path, JSON.stringify({ "unknown.action": ["z"] }));
    expect(keymap.reload()).toEqual({
      ok: false,
      error: "Unknown Outliner action ID: unknown.action",
    });
    expect(keymap.primaryBinding("detail.edit.begin")).toBe("x");
  });

  test("resolves XDG and explicit keymap paths", () => {
    expect(resolveOutlinerKeymapPath({
      XDG_CONFIG_HOME: "/config",
    })).toBe("/config/pi-herdr-outliner/keybindings.json");
    expect(resolveOutlinerKeymapPath({
      OUTLINER_KEYBINDINGS_PATH: "/workspace/keys.json",
    })).toBe("/workspace/keys.json");
  });
});
