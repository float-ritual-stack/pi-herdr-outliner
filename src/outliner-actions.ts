import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { TerminalKey } from "./terminal";

export type OutlinerActionSurface = "tree" | "detail";
export type OutlinerActionMenuGroup = "Navigate" | "Edit" | "View" | "Pane" | "System";
export interface OutlinerActionContext {
  surface: OutlinerActionSurface;
  mode: string;
  state?: unknown;
}

export interface OutlinerActionDefinition {
  id: string;
  surface: OutlinerActionSurface;
  modes: readonly string[];
  label: string;
  description: string;
  defaultChords: readonly string[];
  helpPriority: number;
  menuGroup: OutlinerActionMenuGroup;
  intent: string;
  available(context: OutlinerActionContext): boolean;
}
type OutlinerActionSpec = Omit<OutlinerActionDefinition, "intent" | "available">;

export interface OutlinerActionMenuItem {
  id: string;
  label: string;
  description: string;
  binding: string;
  group: OutlinerActionMenuGroup;
}

export interface CanonicalActionInput {
  actionId: string | null;
  str: string;
  key: TerminalKey;
  suppressed: boolean;
}

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift"] as const;
const KEY_NAMES: Record<string, string> = {
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  backspace: "Backspace",
  delete: "Delete",
  down: "ArrowDown",
  end: "End",
  enter: "Enter",
  esc: "Esc",
  escape: "Esc",
  home: "Home",
  left: "ArrowLeft",
  pagedown: "PgDown",
  pageup: "PgUp",
  pgdown: "PgDown",
  pgup: "PgUp",
  return: "Enter",
  right: "ArrowRight",
  space: "Space",
  tab: "Tab",
  up: "ArrowUp",
};
const NAMED_ACTION_KEYS = new Set(Object.values(KEY_NAMES));
const ACTION_CHORD_GLYPHS: Readonly<Record<string, string>> = {
  Alt: "⌥",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  Backspace: "⌫",
  Cmd: "⌘",
  Command: "⌘",
  Ctrl: "⌃",
  Delete: "⌦",
  End: "↘",
  Enter: "↵",
  Esc: "⎋",
  Home: "↖",
  Option: "⌥",
  PgDown: "⇟",
  PgUp: "⇞",
  Shift: "⇧",
  Space: "␠",
  Tab: "⇥",
};

export function displayActionChord(chord: string): string {
  return chord
    .split("+")
    .map((part) => ACTION_CHORD_GLYPHS[part] ?? part)
    .join("");
}

export function filterActionMenuItems(
  items: readonly OutlinerActionMenuItem[],
  query: string,
): OutlinerActionMenuItem[] {
  return fuzzyFilter(
    [...items],
    query,
    (item) => `${item.label} ${item.group} ${item.binding} ${item.description} ${item.id}`,
  );
}

export function actionMenuItemText(item: OutlinerActionMenuItem): string {
  return `${item.group} · ${item.label}  ${item.binding}`;
}

export function outlinerActionLink(actionId: string, label: string): string {
  return `\x1b]8;;pi-outliner-action:${actionId}\x1b\\${label}\x1b]8;;\x1b\\`;
}

const ACTION_SPECS = [
  { id: "tree.close", surface: "tree", modes: ["*"], label: "close", description: "Close this Tree pane", defaultChords: ["Ctrl+Q"], helpPriority: 100, menuGroup: "System" },
  { id: "tree.cancel", surface: "tree", modes: ["delete", "viewer", "edit", "add-child", "add-sibling", "filter", "goto", "purge", "action-menu"], label: "cancel", description: "Cancel the current transient mode", defaultChords: ["Esc"], helpPriority: 100, menuGroup: "System" },
  { id: "tree.menu.open", surface: "tree", modes: ["browse"], label: "actions", description: "Open contextual actions and effective bindings", defaultChords: ["?"], helpPriority: 20, menuGroup: "System" },
  { id: "tree.keymap.reload", surface: "tree", modes: ["browse"], label: "reload keys", description: "Atomically reload the Outliner keymap", defaultChords: ["Ctrl+R"], helpPriority: 5, menuGroup: "System" },
  { id: "tree.move.up", surface: "tree", modes: ["browse"], label: "up", description: "Select the previous visible row", defaultChords: ["ArrowUp"], helpPriority: 100, menuGroup: "Navigate" },
  { id: "tree.move.down", surface: "tree", modes: ["browse"], label: "down", description: "Select the next visible row", defaultChords: ["ArrowDown"], helpPriority: 100, menuGroup: "Navigate" },
  { id: "tree.read", surface: "tree", modes: ["browse"], label: "read", description: "Open the selected block in Detail", defaultChords: ["Enter"], helpPriority: 95, menuGroup: "Navigate" },
  { id: "tree.edit", surface: "tree", modes: ["browse"], label: "edit", description: "Edit the selected block", defaultChords: ["e"], helpPriority: 90, menuGroup: "Edit" },
  { id: "tree.detail.below", surface: "tree", modes: ["browse"], label: "Detail below", description: "Open a new independent Detail below this pane", defaultChords: ["Shift+D"], helpPriority: 85, menuGroup: "Pane" },
  { id: "tree.detail.right", surface: "tree", modes: ["browse"], label: "Detail right", description: "Open a new independent Detail to the right", defaultChords: ["d"], helpPriority: 84, menuGroup: "Pane" },
  { id: "tree.reference.open", surface: "tree", modes: ["browse"], label: "open link", description: "Open the first authored reference", defaultChords: ["o"], helpPriority: 80, menuGroup: "Navigate" },
  { id: "tree.reference.reveal", surface: "tree", modes: ["browse"], label: "reveal", description: "Reveal the first authored reference in Tree", defaultChords: ["Shift+R"], helpPriority: 75, menuGroup: "Navigate" },
  { id: "tree.goto", surface: "tree", modes: ["browse"], label: "goto", description: "Open fuzzy goto", defaultChords: ["g"], helpPriority: 70, menuGroup: "Navigate" },
  { id: "tree.filter", surface: "tree", modes: ["browse"], label: "filter", description: "Filter the visible Tree", defaultChords: ["/"], helpPriority: 65, menuGroup: "View" },
  { id: "tree.capture", surface: "tree", modes: ["browse"], label: "capture", description: "Quick-capture beneath Inbox", defaultChords: ["c"], helpPriority: 55, menuGroup: "Edit" },
  { id: "tree.add.child", surface: "tree", modes: ["browse"], label: "add child", description: "Create a child or virtual-lane item", defaultChords: ["a"], helpPriority: 50, menuGroup: "Edit" },
  { id: "tree.add.sibling", surface: "tree", modes: ["browse"], label: "add sibling", description: "Create a sibling block", defaultChords: ["s"], helpPriority: 45, menuGroup: "Edit" },
  { id: "tree.delete", surface: "tree", modes: ["browse"], label: "Trash", description: "Enter confirm-before-Trash mode", defaultChords: ["Delete"], helpPriority: 35, menuGroup: "Edit" },
  { id: "tree.file.open", surface: "tree", modes: ["browse"], label: "open file", description: "Open the selected file reference", defaultChords: ["f"], helpPriority: 30, menuGroup: "Navigate" },
  { id: "tree.disclosure.toggle", surface: "tree", modes: ["browse"], label: "collapse/expand", description: "Toggle selected row disclosure", defaultChords: ["Space"], helpPriority: 40, menuGroup: "View" },
  { id: "tree.viewer.up", surface: "tree", modes: ["viewer"], label: "scroll up", description: "Scroll the file viewer up", defaultChords: ["ArrowUp"], helpPriority: 90, menuGroup: "Navigate" },
  { id: "tree.viewer.down", surface: "tree", modes: ["viewer"], label: "scroll down", description: "Scroll the file viewer down", defaultChords: ["ArrowDown"], helpPriority: 90, menuGroup: "Navigate" },
  { id: "tree.viewer.pageup", surface: "tree", modes: ["viewer"], label: "page up", description: "Scroll the file viewer up by one page", defaultChords: ["PgUp"], helpPriority: 60, menuGroup: "Navigate" },
  { id: "tree.viewer.pagedown", surface: "tree", modes: ["viewer"], label: "page down", description: "Scroll the file viewer down by one page", defaultChords: ["PgDown"], helpPriority: 60, menuGroup: "Navigate" },
  { id: "tree.viewer.top", surface: "tree", modes: ["viewer"], label: "top", description: "Jump to the start of the file", defaultChords: ["g"], helpPriority: 40, menuGroup: "Navigate" },
  { id: "tree.viewer.bottom", surface: "tree", modes: ["viewer"], label: "bottom", description: "Jump to the end of the file", defaultChords: ["Shift+G"], helpPriority: 40, menuGroup: "Navigate" },
  { id: "tree.viewer.close", surface: "tree", modes: ["viewer"], label: "close viewer", description: "Return to Tree browse mode", defaultChords: ["q"], helpPriority: 95, menuGroup: "View" },
  { id: "tree.input.save", surface: "tree", modes: ["edit", "add-child", "add-sibling", "filter", "goto", "purge"], label: "save", description: "Commit the current transient input", defaultChords: ["Enter"], helpPriority: 95, menuGroup: "Edit" },
  { id: "tree.input.complete", surface: "tree", modes: ["edit", "add-child", "add-sibling", "filter", "goto"], label: "complete", description: "Open or advance completion", defaultChords: ["Tab"], helpPriority: 80, menuGroup: "Edit" },
  { id: "tree.input.move.up", surface: "tree", modes: ["edit", "add-child", "add-sibling", "filter", "goto"], label: "previous", description: "Move to the previous line or completion", defaultChords: ["ArrowUp"], helpPriority: 70, menuGroup: "Navigate" },
  { id: "tree.input.move.down", surface: "tree", modes: ["edit", "add-child", "add-sibling", "filter", "goto"], label: "next", description: "Move to the next line or completion", defaultChords: ["ArrowDown"], helpPriority: 70, menuGroup: "Navigate" },
  { id: "tree.input.multiline", surface: "tree", modes: ["edit", "add-child", "add-sibling"], label: "multiline", description: "Continue this edit in multiline form", defaultChords: ["Ctrl+E", "Shift+Enter"], helpPriority: 75, menuGroup: "Edit" },
  { id: "tree.delete.confirm", surface: "tree", modes: ["delete"], label: "confirm Trash", description: "Confirm moving the selected subtree to Trash", defaultChords: ["y"], helpPriority: 95, menuGroup: "Edit" },
  { id: "detail.close", surface: "detail", modes: ["*"], label: "close", description: "Close this Detail pane", defaultChords: ["Ctrl+Q"], helpPriority: 100, menuGroup: "System" },
  { id: "detail.cancel", surface: "detail", modes: ["edit", "comment"], label: "cancel", description: "Cancel the current editor without saving", defaultChords: ["Esc"], helpPriority: 100, menuGroup: "System" },
  { id: "detail.menu.open", surface: "detail", modes: ["preview", "annotation", "file", "property"], label: "actions", description: "Open contextual actions and effective bindings", defaultChords: ["?"], helpPriority: 25, menuGroup: "System" },
  { id: "detail.keymap.reload", surface: "detail", modes: ["preview", "annotation", "file", "property"], label: "reload keys", description: "Atomically reload the Outliner keymap", defaultChords: ["Ctrl+R"], helpPriority: 5, menuGroup: "System" },
  { id: "detail.focus.tree", surface: "detail", modes: ["preview", "annotation", "file"], label: "Tree", description: "Return focus to Tree", defaultChords: ["q", "Ctrl+C"], helpPriority: 75, menuGroup: "Pane" },
  { id: "detail.property.close", surface: "detail", modes: ["property"], label: "close", description: "Close this dedicated Property Detail", defaultChords: ["q"], helpPriority: 100, menuGroup: "System" },
  { id: "detail.lock.toggle", surface: "detail", modes: ["preview", "annotation", "file", "property"], label: "lock", description: "Lock or unlock this Detail target", defaultChords: ["Shift+L", "i", "Ctrl+L"], helpPriority: 70, menuGroup: "Pane" },
  { id: "detail.property.toggle", surface: "detail", modes: ["preview", "annotation"], label: "properties", description: "Expand or collapse Property Detail", defaultChords: ["p"], helpPriority: 65, menuGroup: "View" },
  { id: "detail.property.pane", surface: "detail", modes: ["preview", "annotation", "file"], label: "property pane", description: "Open a dedicated Property Detail", defaultChords: ["Shift+P"], helpPriority: 45, menuGroup: "Pane" },
  { id: "detail.reference.open", surface: "detail", modes: ["preview", "annotation", "file"], label: "open link", description: "Open the focused or first reference", defaultChords: ["o"], helpPriority: 85, menuGroup: "Navigate" },
  { id: "detail.reference.reveal", surface: "detail", modes: ["preview", "annotation", "file"], label: "reveal", description: "Reveal the focused or first reference", defaultChords: ["Shift+R"], helpPriority: 80, menuGroup: "Navigate" },
  { id: "detail.edit.begin", surface: "detail", modes: ["preview", "annotation"], label: "edit", description: "Edit the current block", defaultChords: ["e"], helpPriority: 95, menuGroup: "Edit" },
  { id: "detail.file.view", surface: "detail", modes: ["preview", "annotation"], label: "file", description: "View the referenced file", defaultChords: ["f"], helpPriority: 50, menuGroup: "View" },
  { id: "detail.block.view", surface: "detail", modes: ["file", "annotation"], label: "block", description: "Return to block preview", defaultChords: ["b"], helpPriority: 60, menuGroup: "View" },
  { id: "detail.backlinks.toggle", surface: "detail", modes: ["preview"], label: "backlinks", description: "Expand or collapse backlinks", defaultChords: ["b"], helpPriority: 55, menuGroup: "View" },
  { id: "detail.preview.up", surface: "detail", modes: ["preview", "annotation", "file"], label: "up", description: "Scroll up", defaultChords: ["ArrowUp"], helpPriority: 90, menuGroup: "Navigate" },
  { id: "detail.preview.down", surface: "detail", modes: ["preview", "annotation", "file"], label: "down", description: "Scroll down", defaultChords: ["ArrowDown"], helpPriority: 90, menuGroup: "Navigate" },
  { id: "detail.preview.pageup", surface: "detail", modes: ["preview", "annotation", "file"], label: "page up", description: "Scroll up by one page", defaultChords: ["PgUp", "Ctrl+U"], helpPriority: 40, menuGroup: "Navigate" },
  { id: "detail.preview.pagedown", surface: "detail", modes: ["preview", "annotation", "file"], label: "page down", description: "Scroll down by one page", defaultChords: ["PgDown", "Ctrl+D"], helpPriority: 40, menuGroup: "Navigate" },
  { id: "detail.buffer.save", surface: "detail", modes: ["edit", "comment"], label: "save", description: "Save the current editor", defaultChords: ["Ctrl+S"], helpPriority: 100, menuGroup: "Edit" },
  { id: "detail.buffer.copy", surface: "detail", modes: ["edit", "comment"], label: "copy", description: "Copy selected source text", defaultChords: ["Ctrl+C"], helpPriority: 90, menuGroup: "Edit" },
  { id: "detail.completion.open", surface: "detail", modes: ["edit"], label: "complete", description: "Open reference completion", defaultChords: ["Tab", "Ctrl+Space"], helpPriority: 85, menuGroup: "Edit" },
  { id: "detail.buffer.undo", surface: "detail", modes: ["edit", "comment"], label: "undo", description: "Undo the previous source edit", defaultChords: ["Ctrl+Z"], helpPriority: 70, menuGroup: "Edit" },
  { id: "detail.pane.right", surface: "detail", modes: ["preview", "annotation", "file", "property", "destination"], label: "Detail right", description: "Open this target in a new Detail to the right", defaultChords: ["Alt+Shift+ArrowRight"], helpPriority: 44, menuGroup: "Pane" },
  { id: "detail.pane.below", surface: "detail", modes: ["preview", "annotation", "file", "property", "destination"], label: "Detail below", description: "Open this target in a new Detail below", defaultChords: ["Alt+Shift+ArrowDown"], helpPriority: 43, menuGroup: "Pane" },
  { id: "detail.buffer.redo", surface: "detail", modes: ["edit", "comment"], label: "redo", description: "Redo the previous source edit", defaultChords: ["Ctrl+Shift+Z", "Ctrl+Y"], helpPriority: 65, menuGroup: "Edit" },
  { id: "detail.split.focus", surface: "detail", modes: ["edit"], label: "focus pane", description: "Move focus between editor and draft preview", defaultChords: ["Ctrl+W"], helpPriority: 90, menuGroup: "Pane" },
  { id: "detail.split.link", surface: "detail", modes: ["edit"], label: "link scroll", description: "Link editor and draft preview scrolling by source line", defaultChords: ["Ctrl+L"], helpPriority: 80, menuGroup: "Pane" },
] as const satisfies readonly OutlinerActionSpec[];

const ACTIONS: readonly OutlinerActionDefinition[] = ACTION_SPECS.map((action) => ({
  ...action,
  intent: action.id,
  available: (context) => {
    const modes = action.modes as readonly string[];
    return action.surface === context.surface &&
      (modes.includes("*") || modes.includes(context.mode));
  },
}));

const ACTIONS_BY_ID = new Map(ACTIONS.map((action) => [action.id, action]));

function canonicalKeyName(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 1) return trimmed;
  return KEY_NAMES[trimmed.toLowerCase()] ?? `${trimmed[0]?.toUpperCase() ?? ""}${trimmed.slice(1)}`;
}

export function normalizeActionChord(input: string): string {
  const parts = input.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Key chord cannot be empty");
  let key = canonicalKeyName(parts.at(-1)!);
  const modifiers = new Set<string>();
  for (const raw of parts.slice(0, -1)) {
    const modifier = raw.toLowerCase();
    if (modifier === "ctrl" || modifier === "control") modifiers.add("Ctrl");
    else if (modifier === "alt" || modifier === "meta" || modifier === "cmd") modifiers.add("Alt");
    else if (modifier === "shift") modifiers.add("Shift");
    else throw new Error(`Unknown key modifier: ${raw}`);
  }
  if (key.length !== 1 && !NAMED_ACTION_KEYS.has(key)) {
    throw new Error(`Unsupported key name: ${key}`);
  }
  if (modifiers.size > 0 && /^[a-z]$/i.test(key)) key = key.toUpperCase();
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

export function actionChordForInput(str: string | undefined, key: TerminalKey): string | null {
  const text = str ?? "";
  const uppercasePrintable = /^[A-Z]$/.test(text);
  const bareQuestionMark = text === "?";
  const bareSpace = text === " ";
  let name = key.name ? canonicalKeyName(key.name) : "";
  if (uppercasePrintable) name = text.toLowerCase();
  else if (bareQuestionMark) name = text;
  else if (bareSpace) name = "Space";
  else if (!name && text.length === 1) name = text;
  if (!name) return null;
  if (name.length !== 1 && !NAMED_ACTION_KEYS.has(name)) return null;
  const modifiers: string[] = [];
  if (key.ctrl) modifiers.push("Ctrl");
  if (key.meta) modifiers.push("Alt");
  if (uppercasePrintable || (key.shift && !bareQuestionMark)) modifiers.push("Shift");
  if (name.length === 1 && !key.ctrl && !key.meta) {
    name = uppercasePrintable ? text.toLowerCase() : text || name;
  }
  return normalizeActionChord([...modifiers, name].join("+"));
}

function actionApplies(
  action: OutlinerActionDefinition,
  surface: OutlinerActionSurface,
  mode: string,
): boolean {
  return action.available({ surface, mode });
}

function triggerForChord(chord: string): { str: string; key: TerminalKey } {
  const normalized = normalizeActionChord(chord);
  const parts = normalized.split("+");
  const name = parts.at(-1)!;
  const ctrl = parts.includes("Ctrl");
  const meta = parts.includes("Alt");
  const shift = parts.includes("Shift");
  const terminalName: Record<string, string> = {
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    Enter: "return",
    Esc: "escape",
    PgDown: "pagedown",
    PgUp: "pageup",
    Space: "space",
    Tab: "tab",
  };
  const keyName = terminalName[name] ?? name.toLowerCase();
  const printable = name.length === 1 && !ctrl && !meta ? (shift ? name.toUpperCase() : name) : "";
  return {
    str: printable,
    key: {
      name: keyName,
      ...(ctrl ? { ctrl: true } : {}),
      ...(meta ? { meta: true } : {}),
      ...(shift ? { shift: true } : {}),
    },
  };
}

export function resolveOutlinerKeymapPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OUTLINER_KEYBINDINGS_PATH?.trim();
  if (override) return override;
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "pi-herdr-outliner", "keybindings.json");
}

const KEYMAP_STARTUP_DIAGNOSTIC_LIMIT = 512;

function reportKeymapStartupFailure(path: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  const diagnostic = `Pi Outliner keymap ${path} could not be loaded; using defaults: ${reason}`;
  const bounded = diagnostic.length <= KEYMAP_STARTUP_DIAGNOSTIC_LIMIT
    ? diagnostic
    : `${diagnostic.slice(0, KEYMAP_STARTUP_DIAGNOSTIC_LIMIT - 1)}…`;
  console.error(bounded);
}

export class OutlinerActionKeymap {
  #bindings = new Map<string, readonly string[]>();

  constructor(readonly path = resolveOutlinerKeymapPath(), overrides: unknown = {}) {
    this.#bindings = this.validate(overrides);
  }

  static load(env: NodeJS.ProcessEnv = process.env): OutlinerActionKeymap {
    const path = resolveOutlinerKeymapPath(env);
    try {
      return new OutlinerActionKeymap(path, JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new OutlinerActionKeymap(path);
      reportKeymapStartupFailure(path, error);
      return new OutlinerActionKeymap(path);
    }
  }

  reload(): { ok: true } | { ok: false; error: string } {
    try {
      let input: unknown = {};
      try {
        input = JSON.parse(readFileSync(this.path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const next = this.validate(input);
      this.#bindings = next;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  bindings(actionId: string): readonly string[] {
    const action = ACTIONS_BY_ID.get(actionId);
    if (!action) throw new Error(`Unknown Outliner action: ${actionId}`);
    return this.#bindings.get(actionId) ?? action.defaultChords.map(normalizeActionChord);
  }

  primaryBinding(actionId: string): string {
    return this.bindings(actionId)[0] ?? "unbound";
  }

  canonicalize(
    surface: OutlinerActionSurface,
    mode: string,
    str: string | undefined,
    key: TerminalKey,
  ): CanonicalActionInput {
    const text = str ?? "";
    const chord = actionChordForInput(text, key);
    if (!chord) return { actionId: null, str: text, key, suppressed: false };
    const applicable = ACTIONS.filter((action) => actionApplies(action, surface, mode));
    const matched = applicable.find((action) => this.bindings(action.id).includes(chord));
    if (matched) {
      const canonical = triggerForChord(matched.defaultChords[0] ?? chord);
      return { actionId: matched.id, ...canonical, suppressed: false };
    }
    const ownedDefault = applicable.some((action) =>
      action.defaultChords.map(normalizeActionChord).includes(chord)
    );
    return ownedDefault
      ? { actionId: null, str: "", key: {}, suppressed: true }
      : { actionId: null, str: text, key, suppressed: false };
  }

  helpText(surface: OutlinerActionSurface, mode: string, actionIds?: readonly string[]): string {
    const selected = this.actions(surface, mode)
      .filter((action) => !actionIds || actionIds.includes(action.id))
      .sort((left, right) => right.helpPriority - left.helpPriority || left.id.localeCompare(right.id));
    return selected
      .map((action) => `${displayActionChord(this.primaryBinding(action.id))} ${action.label}`)
      .join("  ");
  }

  menuItems(surface: OutlinerActionSurface, mode: string): OutlinerActionMenuItem[] {
    return this.actions(surface, mode)
      .sort((left, right) => left.menuGroup.localeCompare(right.menuGroup) || right.helpPriority - left.helpPriority)
      .map((action) => ({
        id: action.id,
        label: action.label,
        description: action.description,
        binding: this.bindings(action.id).map(displayActionChord).join(", ") || "unbound",
        group: action.menuGroup,
      }));
  }

  action(actionId: string): OutlinerActionDefinition {
    const action = ACTIONS_BY_ID.get(actionId);
    if (!action) throw new Error(`Unknown Outliner action: ${actionId}`);
    return action;
  }

  canonicalInput(actionId: string): { str: string; key: TerminalKey } | null {
    const chord = this.action(actionId).defaultChords[0] ?? this.bindings(actionId)[0];
    return chord ? triggerForChord(chord) : null;
  }
  boundInput(actionId: string): { str: string; key: TerminalKey } | null {
    const chord = this.bindings(actionId)[0];
    return chord ? triggerForChord(chord) : null;
  }

  private actions(surface: OutlinerActionSurface, mode: string): OutlinerActionDefinition[] {
    return ACTIONS.filter((action) => actionApplies(action, surface, mode));
  }
  defaultInput(actionId: string): { str: string; key: TerminalKey } | null {
    const chord = this.action(actionId).defaultChords[0];
    return chord ? triggerForChord(chord) : null;
  }

  private validate(input: unknown): Map<string, readonly string[]> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Outliner keymap must be a JSON object mapping action IDs to chord arrays");
    }
    const overrides = new Map<string, readonly string[]>();
    for (const [actionId, raw] of Object.entries(input)) {
      if (!ACTIONS_BY_ID.has(actionId)) throw new Error(`Unknown Outliner action ID: ${actionId}`);
      if (!Array.isArray(raw) || raw.some((chord) => typeof chord !== "string")) {
        throw new Error(`Outliner action ${actionId} must map to an array of key chords`);
      }
      const chords = raw.map(normalizeActionChord);
      if (new Set(chords).size !== chords.length) {
        throw new Error(`Outliner action ${actionId} contains duplicate key chords`);
      }
      overrides.set(actionId, chords);
    }

    for (const action of ACTIONS) {
      const chords = overrides.get(action.id) ?? action.defaultChords.map(normalizeActionChord);
      for (const other of ACTIONS) {
        if (other.id <= action.id || other.surface !== action.surface) continue;
        if (!action.modes.some((mode) => other.modes.includes(mode) || mode === "*" || other.modes.includes("*"))) continue;
        const otherChords = overrides.get(other.id) ?? other.defaultChords.map(normalizeActionChord);
        const collision = chords.find((chord) => otherChords.includes(chord));
        if (collision) {
          throw new Error(`Outliner key collision in active scopes: ${action.id} and ${other.id} both use ${collision}`);
        }
      }
    }
    if ((overrides.get("tree.cancel") ?? ACTIONS_BY_ID.get("tree.cancel")!.defaultChords).length === 0) {
      throw new Error("Tree transient modes require a keyboard-accessible cancel action");
    }
    if ((overrides.get("detail.cancel") ?? ACTIONS_BY_ID.get("detail.cancel")!.defaultChords).length === 0) {
      throw new Error("Detail editor modes require a keyboard-accessible cancel action");
    }
    return overrides;
  }
}

export const DEFAULT_OUTLINER_ACTION_KEYMAP = new OutlinerActionKeymap("<defaults>");
