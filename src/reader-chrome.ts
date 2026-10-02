import {truncateToWidth, visibleWidth} from "@earendil-works/pi-tui";
import {outlinerActionLink, type OutlinerActionHint, type OutlinerActionKeymap, type OutlinerActionMenuItem} from "./outliner-actions";
import {sanitizeDynamicText} from "./terminal";
import type {ChromeLevel} from "./ui-config";

export type {ChromeLevel};
export type ReaderMenu = "note" | "view" | "links" | "props" | "all";
export const READER_MENUS: readonly ReaderMenu[] = ["note", "view", "links", "props", "all"];

/** Categories are projections of the action registry, never another action list. */
export function readerMenuItems(items: readonly OutlinerActionMenuItem[], menu: ReaderMenu): OutlinerActionMenuItem[] {
  if (menu === "all") return [...items];
  return items.filter(item => {
    if (item.id.includes(".menu.")) return false;
    if (menu === "props") return item.id.includes(".property.") || item.id.includes(".properties.");
    if (menu === "links") return item.group === "Navigate" || item.group === "Pane";
    if (menu === "view") return item.group === "View" || item.group === "System";
    return item.group === "Edit";
  });
}

export function readerMenuFromAction(action: string): ReaderMenu | null {
  const match = /^(?:tree|detail)\.menu\.(note|view|links|props|open)$/.exec(action);
  return match ? match[1] === "open" ? "all" : match[1] as ReaderMenu : null;
}

export function adjacentReaderMenu(menu: ReaderMenu, delta: number): ReaderMenu {
  return READER_MENUS[(READER_MENUS.indexOf(menu) + delta + READER_MENUS.length) % READER_MENUS.length]!;
}

export interface PaneBarButton {
  actionId: string;
  text: string;
  active?: boolean;
}

/** How a pane shows one of its pinned actions right now: a glyph that can change, and whether it is on. */
export type PaneBarState = (actionId: string) => {glyph?: string; active?: boolean} | undefined;

const MENU_LABELS: Readonly<Record<string, string>> = {note: "Note", view: "View", links: "Links", props: "Props"};

/** The pane bar's buttons for the pinned action ids, in pin order. */
export function paneBarButtons(ids: readonly string[], keymap: Pick<OutlinerActionKeymap, "action">, state?: PaneBarState): PaneBarButton[] {
  const buttons: PaneBarButton[] = [];
  for (const id of ids) {
    let action;
    try { action = keymap.action(id); } catch { continue; }
    const now = state?.(id);
    const menu = /\.menu\.(note|view|links|props)$/.exec(id)?.[1];
    const text = now?.glyph ?? action.glyph ?? (menu ? MENU_LABELS[menu]! : action.label);
    buttons.push({actionId: id, text: `[${sanitizeDynamicText(text)}]`, ...(now?.active ? {active: true} : {})});
  }
  return buttons;
}

export interface PaneBar {
  line: string;
  /** Columns of each rendered button, relative to the bar's first column. */
  controls: Array<{x: number; width: number; action: string}>;
}

function isGlyphButton(button: PaneBarButton): boolean {
  return visibleWidth(button.text) <= 3;
}

function barWidth(buttons: readonly PaneBarButton[]): number {
  return buttons.reduce((sum, button, index) => sum + visibleWidth(button.text) +
    (index > 0 && !(isGlyphButton(button) && isGlyphButton(buttons[index - 1]!)) ? 1 : 0), 0);
}

/**
 * One header row: who this pane is on the left, its pinned buttons and `[⋯]` on the right.
 * Buttons that don't fit are left off the bar, never out of the menu; `[⋯]` always stays.
 */
export function renderPaneBar(width: number, identity: string, buttons: readonly PaneBarButton[], menuAction?: string): PaneBar {
  const menu: PaneBarButton[] = menuAction ? [{actionId: menuAction, text: "[⋯]"}] : [];
  if (width <= 3) {
    return menuAction ? {line: truncateToWidth(outlinerActionLink(menuAction, "[⋯]"), Math.max(0, width)), controls: width === 3 ? [{x: 0, width: 3, action: menuAction}] : []}
      : {line: truncateToWidth(identity, Math.max(0, width)), controls: []};
  }
  // Identity is the caller's: dynamic text in it is sanitized there, so it may carry action links.
  // Who the pane is outranks extra pins: identity keeps up to half the row before buttons drop.
  const keepForIdentity = identity ? Math.min(visibleWidth(identity), Math.floor(width / 2)) + 1 : 0;
  const shown = [...buttons];
  while (shown.length && barWidth([...shown, ...menu]) + keepForIdentity > width) shown.pop();
  const all = [...shown, ...menu];
  const controlsWidth = barWidth(all);
  const identityWidth = Math.max(0, width - controlsWidth - 1);
  const left = identityWidth ? truncateToWidth(identity, identityWidth) : "";
  const start = width - controlsWidth;
  let line = left + " ".repeat(Math.max(0, start - visibleWidth(left)));
  const controls: PaneBar["controls"] = [];
  let column = start;
  all.forEach((button, index) => {
    if (index > 0 && !(isGlyphButton(button) && isGlyphButton(all[index - 1]!))) { line += " "; column += 1; }
    const text = button.active ? `\x1b[7m${button.text}\x1b[27m` : button.text;
    line += outlinerActionLink(button.actionId, text);
    controls.push({x: column, width: visibleWidth(button.text), action: button.actionId});
    column += visibleWidth(button.text);
  });
  return {line, controls};
}

/**
 * The one hint row: a status message while it is fresh, otherwise generated hints with the
 * menu key first. Every hint links to its action, so a click runs what the key runs.
 */
export function renderHintRow(
  width: number,
  hints: readonly OutlinerActionHint[],
  options: {menuKey?: string; menuAction?: string; message?: string; prefix?: string} = {},
): string {
  if (width <= 0) return "";
  if (options.message) return truncateToWidth(sanitizeDynamicText(options.message), width);
  const entries = [
    ...(options.menuKey && options.menuAction && options.menuKey !== "unbound" ? [{actionId: options.menuAction, key: options.menuKey, label: "all actions"}] : []),
    ...hints,
  ];
  let row = options.prefix ? sanitizeDynamicText(options.prefix) : "";
  for (const entry of entries) {
    const text = `${entry.key} ${entry.label}`;
    const separator = visibleWidth(row) ? " · " : "";
    if (visibleWidth(row) + separator.length + visibleWidth(text) > width) break;
    row += (separator ? `\x1b[2m${separator}\x1b[22m` : "") + outlinerActionLink(entry.actionId, `${entry.key} \x1b[2m${entry.label}\x1b[22m`);
  }
  return truncateToWidth(row, width);
}
