import {afterEach, expect, test} from "bun:test";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {getOsc8LinkAtColumn, stripTerminalSequences, visibleWidth} from "@earendil-works/pi-tui";
import {DEFAULT_PANE_BARS, OutlinerUiConfig, resolveOutlinerUiConfigPath} from "../src/ui-config";
import {DEFAULT_OUTLINER_ACTION_KEYMAP, OutlinerActionKeymap} from "../src/outliner-actions";
import {paneBarButtons, renderHintRow, renderPaneBar} from "../src/reader-chrome";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
function fixture(contents?: string): string {
  const root = mkdtempSync(join(tmpdir(), "ui-config-"));
  roots.push(root);
  const path = join(root, "ui.json");
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
}

test("ui.json sits beside keybindings.json and can be moved for tests", () => {
  expect(resolveOutlinerUiConfigPath({XDG_CONFIG_HOME: "/cfg"})).toBe("/cfg/pi-herdr-outliner/ui.json");
  expect(resolveOutlinerUiConfigPath({XDG_CONFIG_HOME: "/cfg", OUTLINER_UI_PATH: "/x/ui.json"})).toBe("/x/ui.json");
});

test("defaults ship in code: glyph dock buttons on Preview, compact chrome everywhere", () => {
  const config = OutlinerUiConfig.load({OUTLINER_UI_PATH: fixture()});
  expect(config.bar("preview")).toEqual(["tree.preview.right", "tree.preview.bottom", "tree.preview.auto", "tree.preview.close"]);
  expect(config.chrome("tree")).toBe("compact");
  expect(config.chrome("preview")).toBe("compact");
  expect(config.chrome("detail")).toBe("compact");
  const buttons = paneBarButtons(config.bar("preview"), DEFAULT_OUTLINER_ACTION_KEYMAP);
  expect(buttons.map(button => button.text)).toEqual(["[▐]", "[▄]", "[◙]", "[×]"]);
});

test("a pin is written on top of the file as it is now, keeping other kinds and keys", () => {
  const path = fixture(JSON.stringify({bar: {board: ["door.thing"]}, chrome: {tree: "full"}, note: "kept"}));
  const config = OutlinerUiConfig.load({OUTLINER_UI_PATH: path});
  expect(config.chrome("tree")).toBe("full");
  // Another pane pins first; this pane's write must not drop it.
  writeFileSync(path, JSON.stringify({bar: {board: ["door.thing"], tree: ["tree.goto"]}, chrome: {tree: "full"}, note: "kept"}));
  expect(config.togglePin("tree", "tree.capture")).toEqual({ok: true, pinned: true});
  const written = JSON.parse(readFileSync(path, "utf8"));
  expect(written).toEqual({bar: {board: ["door.thing"], tree: ["tree.goto", "tree.capture"]}, chrome: {tree: "full"}, note: "kept"});
  expect(config.bar("tree")).toEqual(["tree.goto", "tree.capture"]);
  expect(config.togglePin("tree", "tree.goto")).toEqual({ok: true, pinned: false});
  expect(config.bar("tree")).toEqual(["tree.capture"]);
  // A kind with no list yet starts from its defaults.
  expect(config.togglePin("preview", "tree.preview.close")).toEqual({ok: true, pinned: false});
  expect(config.bar("preview")).toEqual(DEFAULT_PANE_BARS.preview.filter(id => id !== "tree.preview.close"));
  expect(config.setChrome("preview", "full")).toEqual({ok: true});
  expect(JSON.parse(readFileSync(path, "utf8")).chrome).toEqual({tree: "full", preview: "full"});
});

test("hand edits reload; a broken file keeps what is shown and is never overwritten", () => {
  const path = fixture("{}");
  const config = OutlinerUiConfig.load({OUTLINER_UI_PATH: path});
  writeFileSync(path, JSON.stringify({bar: {preview: ["tree.preview.close"]}, chrome: {preview: "full"}}));
  expect(config.reload()).toEqual({ok: true});
  expect(config.bar("preview")).toEqual(["tree.preview.close"]);
  expect(config.chrome("preview")).toBe("full");
  for (const broken of ["{not json", JSON.stringify({bar: {preview: ["tree.nope"]}}), JSON.stringify({bar: {preview: ["detail.edit.begin"]}}),
    JSON.stringify({chrome: {tree: "roomy"}}), JSON.stringify({bar: {tree: ["tree.goto", "tree.goto"]}})]) {
    writeFileSync(path, broken);
    const result = config.reload();
    expect(result.ok).toBe(false);
    expect(config.bar("preview")).toEqual(["tree.preview.close"]);
    expect(config.togglePin("tree", "tree.goto").ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(broken);
  }
  expect(config.togglePin("detail", "tree.goto")).toEqual({ok: false, error: "tree.goto can't go on the Detail bar"});
});

test("a pane without a ui.json path never writes", () => {
  expect(new OutlinerUiConfig("").togglePin("tree", "tree.goto").ok).toBe(false);
});

test("Alt+Enter pins in a menu: menus own their keys, so Keep Preview's wildcard Alt+Enter doesn't reach them", () => {
  const keymap = DEFAULT_OUTLINER_ACTION_KEYMAP;
  expect(keymap.resolve("tree", "action-menu", "", {name: "return", meta: true}).actionId).toBe("tree.menu.pin");
  expect(keymap.resolve("detail", "menu", "", {name: "return", meta: true}).actionId).toBe("detail.menu.pin");
  expect(keymap.resolve("detail", "preview", "", {name: "return", meta: true}).actionId).toBe("detail.reading.keep");
  expect(keymap.resolve("tree", "browse", "", {name: "return", meta: true}).actionId).toBe("tree.read.focus");
  // Rebinding the pin key is an ordinary keymap override, checked for collisions like any other.
  const rebound = new OutlinerActionKeymap("<test>", {"detail.menu.pin": ["Ctrl+P"]});
  expect(rebound.resolve("detail", "menu", "", {name: "p", ctrl: true}).actionId).toBe("detail.menu.pin");
});

test("the bar keeps [⋯] and drops pins that don't fit; every button is a link to its action", () => {
  const buttons = paneBarButtons(DEFAULT_PANE_BARS.preview, DEFAULT_OUTLINER_ACTION_KEYMAP);
  for (const width of [8, 12, 20, 40]) {
    const bar = renderPaneBar(width, "○ Preview · A long title", buttons, "tree.preview.menu");
    expect(visibleWidth(bar.line)).toBeLessThanOrEqual(width);
    expect(bar.controls.at(-1)?.action).toBe("tree.preview.menu");
    for (const control of bar.controls) expect(getOsc8LinkAtColumn(bar.line, control.x + 1)).toBe(`pi-outliner-action:${control.action}`);
  }
  expect(renderPaneBar(40, "○ Preview", buttons, "tree.preview.menu").controls.map(c => c.action)).toEqual([...DEFAULT_PANE_BARS.preview, "tree.preview.menu"]);
});

test("the hint row is generated from bound actions, leads with the menu key and shows a status instead while it is fresh", () => {
  const hints = DEFAULT_OUTLINER_ACTION_KEYMAP.hints("tree", "browse");
  expect(hints.some(hint => hint.key === "↑" || hint.key === "↓")).toBe(false);
  expect(hints[0]?.actionId).toBe("tree.close");
  const row = renderHintRow(60, hints, {menuKey: "?", menuAction: "tree.menu.open"});
  expect(stripTerminalSequences(row)).toStartWith("? all actions · ");
  expect(visibleWidth(row)).toBeLessThanOrEqual(60);
  expect(getOsc8LinkAtColumn(row, 0)).toBe("pi-outliner-action:tree.menu.open");
  expect(stripTerminalSequences(renderHintRow(60, hints, {menuKey: "?", menuAction: "tree.menu.open", message: "Branch filter cleared"}))).toBe("Branch filter cleared");
});
