import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {dirname, join} from "node:path";
import {outlinerActionSurface, type OutlinerActionSurface} from "./outliner-actions";

/**
 * What a person chose to keep on each pane's bar, and how much chrome each pane shows.
 *
 * `ui.json` sits beside `keybindings.json`, is edited by hand or by pinning from a
 * `[⋯]` menu, and reloads with the keymap (Ctrl+R). Its shape is shared with
 * ep0ch-door (PIE-492): `bar` and `chrome` map a pane or tile kind to a list of
 * action ids and to `compact | full`. Kinds this client doesn't know are kept and
 * ignored, so one file can carry both clients' choices.
 */
export type PaneKind = "tree" | "preview" | "detail";
export type ChromeLevel = "compact" | "full";
export const PANE_KINDS: readonly PaneKind[] = ["tree", "preview", "detail"];
const PANE_SURFACE: Readonly<Record<PaneKind, OutlinerActionSurface>> = {tree: "tree", preview: "tree", detail: "detail"};
const PANE_NAMES: Readonly<Record<PaneKind, string>> = {tree: "Tree", preview: "Preview", detail: "Detail"};

export const DEFAULT_PANE_BARS: Readonly<Record<PaneKind, readonly string[]>> = {
  tree: ["tree.menu.note", "tree.menu.view", "tree.menu.links", "tree.menu.props"],
  preview: ["tree.preview.right", "tree.preview.bottom", "tree.preview.auto", "tree.preview.close"],
  detail: ["detail.menu.note", "detail.menu.view", "detail.menu.links", "detail.menu.props"],
};

export function paneKindName(kind: PaneKind): string {
  return PANE_NAMES[kind];
}

/** One wording for every host's chrome toggle and pin results. */
export function chromeToggleLabel(kind: PaneKind, current: ChromeLevel): string {
  return `${PANE_NAMES[kind]} chrome: ${current} → ${current === "compact" ? "full" : "compact"}`;
}
export function chromeToggledText(kind: PaneKind, level: ChromeLevel): string {
  return `${PANE_NAMES[kind]} chrome: ${level}`;
}
export function pinResultText(kind: PaneKind, label: string, pinned: boolean): string {
  return `${pinned ? "Pinned" : "Unpinned"} ${label} ${pinned ? "to" : "from"} the ${PANE_NAMES[kind]} bar`;
}

export function resolveOutlinerUiConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OUTLINER_UI_PATH?.trim();
  if (override) return override;
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "pi-herdr-outliner", "ui.json");
}

interface ParsedUiConfig {
  raw: Record<string, unknown>;
  bars: Map<PaneKind, readonly string[]>;
  chrome: Map<PaneKind, ChromeLevel>;
  /** Pins that were left off: unknown or renamed actions, another surface's, repeats. */
  warnings: string[];
}

function isKind(value: string): value is PaneKind {
  return (PANE_KINDS as readonly string[]).includes(value);
}

function objectField(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = raw[key];
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`ui.json "${key}" must map pane kinds to values`);
  return value as Record<string, unknown>;
}

function parseUiConfig(input: unknown): ParsedUiConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("ui.json must be a JSON object");
  const raw = input as Record<string, unknown>;
  const bars = new Map<PaneKind, readonly string[]>();
  const warnings: string[] = [];
  for (const [kind, value] of Object.entries(objectField(raw, "bar"))) {
    if (!isKind(kind)) continue;
    if (!Array.isArray(value) || value.some(id => typeof id !== "string")) throw new Error(`ui.json bar.${kind} must be an array of action ids`);
    // One stale pin (a renamed action, a typo) drops only itself, never the whole file.
    const ids: string[] = [];
    for (const id of value as string[]) {
      const surface = outlinerActionSurface(id);
      if (!surface) warnings.push(`bar.${kind}: unknown action ${id}`);
      else if (surface !== PANE_SURFACE[kind]) warnings.push(`bar.${kind}: ${id} is a ${surface} action`);
      else if (ids.includes(id)) warnings.push(`bar.${kind}: ${id} listed twice`);
      else ids.push(id);
    }
    bars.set(kind, ids);
  }
  const chrome = new Map<PaneKind, ChromeLevel>();
  for (const [kind, value] of Object.entries(objectField(raw, "chrome"))) {
    if (!isKind(kind)) continue;
    if (value !== "compact" && value !== "full") throw new Error(`ui.json chrome.${kind} must be "compact" or "full"`);
    chrome.set(kind, value);
  }
  return {raw, bars, chrome, warnings};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type UiConfigResult = {ok: true} | {ok: false; error: string};
export type UiReloadResult = {ok: true; warnings: readonly string[]} | {ok: false; error: string};

export class OutlinerUiConfig {
  #parsed: ParsedUiConfig;

  constructor(readonly path = resolveOutlinerUiConfigPath(), input: unknown = {}) {
    this.#parsed = parseUiConfig(input);
  }

  /** A missing file means defaults; a broken one is reported and defaults are used, like the keymap. */
  static load(env: NodeJS.ProcessEnv = process.env): OutlinerUiConfig {
    const path = resolveOutlinerUiConfigPath(env);
    try {
      return new OutlinerUiConfig(path, readUiFile(path));
    } catch (error) {
      console.error(`Pi Outliner ${path} could not be loaded; using default bars and compact chrome: ${errorText(error)}`);
      return new OutlinerUiConfig(path);
    }
  }

  /** Replaces the whole config only when the file is valid; otherwise keeps what is shown. */
  /** What was left off the bars when the file was last read. */
  get warnings(): readonly string[] {
    return this.#parsed.warnings;
  }

  reload(): UiReloadResult {
    try {
      this.#parsed = parseUiConfig(readUiFile(this.path));
      return {ok: true, warnings: this.#parsed.warnings};
    } catch (error) {
      return {ok: false, error: errorText(error)};
    }
  }

  bar(kind: PaneKind): readonly string[] {
    return this.#parsed.bars.get(kind) ?? DEFAULT_PANE_BARS[kind];
  }

  isPinned(kind: PaneKind, actionId: string): boolean {
    return this.bar(kind).includes(actionId);
  }

  chrome(kind: PaneKind): ChromeLevel {
    return this.#parsed.chrome.get(kind) ?? "compact";
  }

  /** Pins or unpins on top of the file as it is now, so another pane's pins are never lost. */
  togglePin(kind: PaneKind, actionId: string): {ok: true; pinned: boolean} | {ok: false; error: string} {
    const surface = outlinerActionSurface(actionId);
    if (surface !== PANE_SURFACE[kind]) return {ok: false, error: `${actionId} can't go on the ${PANE_NAMES[kind]} bar`};
    // The ♦ marks come from memory; take the file as it is now so a toggle matches what it changes.
    void this.reload();
    let pinned = false;
    const result = this.write(parsed => {
      const current = parsed.bars.get(kind) ?? DEFAULT_PANE_BARS[kind];
      // Stale entries the parser dropped are dropped from the file too.
      pinned = !current.includes(actionId);
      const bar = pinned ? [...current, actionId] : current.filter(id => id !== actionId);
      return {...parsed.raw, bar: {...objectField(parsed.raw, "bar"), [kind]: bar}};
    });
    return result.ok ? {ok: true, pinned} : result;
  }

  setChrome(kind: PaneKind, level: ChromeLevel): UiConfigResult {
    return this.write(parsed => ({...parsed.raw, chrome: {...objectField(parsed.raw, "chrome"), [kind]: level}}));
  }

  private write(change: (parsed: ParsedUiConfig) => Record<string, unknown>): UiConfigResult {
    if (!this.path) return {ok: false, error: "This pane has no ui.json to save to"};
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      // A hand edit that doesn't parse is the person's work in progress: refuse rather than overwrite it.
      const next = change(parseUiConfig(readUiFile(this.path)));
      const parsed = parseUiConfig(next);
      mkdirSync(dirname(this.path), {recursive: true});
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {mode: 0o644});
      renameSync(temporary, this.path);
      this.#parsed = parsed;
      return {ok: true};
    } catch (error) {
      rmSync(temporary, {force: true});
      return {ok: false, error: `${this.path} unchanged: ${errorText(error)}`};
    }
  }
}

function readUiFile(path: string): unknown {
  if (!path) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return JSON.parse(text);
}
