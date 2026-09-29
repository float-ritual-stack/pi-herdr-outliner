import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import type { KnownOutline } from "./known-outlines";
import { type OutlinerClientConfig, slugifyOutlineName } from "./paths";
import type { HostedOutlineSummary } from "./types";
import { sanitizeDynamicText, type TerminalKey } from "./terminal";
import { parseTreePrimaryClick, parseTreeWheelEvent } from "./tree-mouse";

/** What the launcher tells the chooser popup about the open it interrupted. */
export interface OutlineChooserContext {
  mode: string;
  workspaceRoot: string;
  rootSource: string;
  paneId?: string;
  clientId?: string;
  /** The switcher: the folder may already have an outline, and a choice replaces it. */
  switch?: boolean;
}

export function parseOutlineChooserContext(value: string | undefined): OutlineChooserContext {
  if (!value) throw new Error("OUTLINER_CHOOSER_CONTEXT is required");
  const parsed = JSON.parse(value) as Partial<OutlineChooserContext>;
  if (typeof parsed.mode !== "string" || typeof parsed.workspaceRoot !== "string" || typeof parsed.rootSource !== "string") {
    throw new Error("OUTLINER_CHOOSER_CONTEXT must name mode, workspaceRoot and rootSource");
  }
  return {
    mode: parsed.mode,
    workspaceRoot: parsed.workspaceRoot,
    rootSource: parsed.rootSource,
    ...(typeof parsed.paneId === "string" ? { paneId: parsed.paneId } : {}),
    ...(typeof parsed.clientId === "string" ? { clientId: parsed.clientId } : {}),
    ...(parsed.switch === true ? { switch: true } : {}),
  };
}

export type OutlineChooserRow =
  | { kind: "outline"; outline: KnownOutline }
  | { kind: "hosted"; outline: HostedOutlineSummary }
  | { kind: "new" };

export class OutlineChooser {
  rows: OutlineChooserRow[] = [{ kind: "new" }];
  index = 0;
  loading = true;
  busy = false;
  status = "";

  constructor(readonly context: OutlineChooserContext) {}

  get selected(): OutlineChooserRow | undefined { return this.rows[this.index]; }

  /** Set when an outline host answers: rows are its outlines, and "new" creates one there. */
  host: { socket: string; names: Set<string> } | undefined;

  setOutlines(outlines: readonly KnownOutline[]): void {
    this.rows = [...outlines.map(outline => ({ kind: "outline", outline }) as const), { kind: "new" }];
    this.index = Math.min(this.index, this.rows.length - 1);
    this.loading = false;
  }

  setHostedOutlines(socket: string, outlines: readonly HostedOutlineSummary[]): void {
    this.host = { socket, names: new Set(outlines.map(outline => outline.name)) };
    this.rows = [...outlines.map(outline => ({ kind: "hosted", outline }) as const), { kind: "new" }];
    this.index = Math.min(this.index, this.rows.length - 1);
    this.loading = false;
  }

  move(delta: number): void {
    this.index = Math.max(0, Math.min(this.rows.length - 1, this.index + delta));
    this.status = "";
  }

  select(index: number): void {
    if (index < 0 || index >= this.rows.length) return;
    this.index = index;
    this.status = "";
  }
}

export type ChooserIntent = "choose" | "close" | "changed" | null;

export function chooserKey(chooser: OutlineChooser, key: TerminalKey): ChooserIntent {
  // Once a choice is being saved, closing would record it without opening anything.
  if (chooser.busy) return null;
  if (key.name === "escape" || (key.ctrl && key.name === "c")) return "close";
  if (key.name === "return") return "choose";
  if (key.name === "up" || key.name === "k") { chooser.move(-1); return "changed"; }
  if (key.name === "down" || key.name === "j") { chooser.move(1); return "changed"; }
  return null;
}

// Frame rows: blank, top border, two context lines, a heading, the list, status, help, bottom border.
const LIST_TOP = 5;
function chooserLayout(width: number, height: number, index: number) {
  const inner = Math.max(1, width - 4);
  const listHeight = Math.max(2, height - LIST_TOP - 3);
  const slots = Math.max(1, Math.floor(listHeight / 2));
  const start = Math.max(0, index - slots + 1);
  return { inner, listHeight, slots, start };
}

/** Wheel moves the selection; a click on a row chooses it, as Enter does on the selected row. */
export function chooserMouse(chooser: OutlineChooser, sequence: string, width: number, height: number): ChooserIntent {
  if (chooser.busy || width < 20 || height < 10) return null;
  const layout = chooserLayout(width, height, chooser.index);
  const wheel = parseTreeWheelEvent(sequence);
  if (wheel) { chooser.move(wheel.direction === "up" ? -1 : 1); return "changed"; }
  const click = parseTreePrimaryClick(sequence);
  if (!click || click.row < LIST_TOP || click.row >= LIST_TOP + layout.slots * 2 || click.column < 2 || click.column >= layout.inner + 2) return null;
  const index = layout.start + Math.floor((click.row - LIST_TOP) / 2);
  if (!chooser.rows[index]) return null;
  chooser.select(index);
  return "choose";
}

function describeHosted(outline: HostedOutlineSummary): { title: string; detail: string } {
  const flags = [outline.open ? "\x1b[32mopen\x1b[0m" : "\x1b[2mclosed\x1b[0m", ...(outline.default ? ["default"] : []), ...(outline.adopted ? ["adopted"] : [])];
  return {
    title: `${sanitizeDynamicText(outline.name)}  ${flags.join("  ")}`,
    detail: sanitizeDynamicText(outline.root ?? outline.database),
  };
}

function describe(outline: KnownOutline): { title: string; detail: string } {
  const status = outline.status === "running" ? "\x1b[32mrunning\x1b[0m" : "\x1b[2mstopped\x1b[0m";
  const where = `${outline.name && outline.name !== outline.label ? `${outline.name} · ` : ""}${outline.root ?? `root unknown · ${outline.stateKey ?? outline.socket}`}`;
  const aliases = outline.aliases.length ? ` · also ${outline.aliases.map(alias => sanitizeDynamicText(alias)).join(", ")}` : "";
  return {
    title: `${sanitizeDynamicText(outline.label)}  ${status}${outline.location === "remote" ? "  \x1b[2mremote socket\x1b[0m" : ""}`,
    detail: `${sanitizeDynamicText(where)}${aliases}`,
  };
}

export function renderChooserFrame(chooser: OutlineChooser, width: number, height: number): string[] {
  if (width < 20 || height < 10) {
    return Array.from({ length: Math.max(1, height) }, (_, i) => i === 0 ? truncateToWidth("Choose outline · enlarge terminal", Math.max(1, width)) : "");
  }
  const { inner, listHeight, slots, start } = chooserLayout(width, height, chooser.index);
  const fit = (line: string) => {
    const text = truncateToWidth(line, inner);
    return text + " ".repeat(Math.max(0, inner - visibleWidth(text)));
  };
  const bordered = (line: string) => ` │${fit(line)}│ `;
  const root = sanitizeDynamicText(chooser.context.workspaceRoot);
  const list: string[] = [];
  for (const [offset, row] of chooser.rows.slice(start, start + slots).entries()) {
    const active = start + offset === chooser.index;
    const text = row.kind === "new"
      ? chooser.host
        ? { title: "+ New outline here", detail: `Creates the outline "${newHostedOutlineName(chooser.context.workspaceRoot, chooser.host.names)}" on the outline host` }
        : { title: "+ New outline here", detail: `Creates a new database for ${root}` }
      : row.kind === "hosted" ? describeHosted(row.outline) : describe(row.outline);
    const title = fit(`${active ? "›" : " "} ${text.title}`);
    list.push(active ? `\x1b[48;5;238m\x1b[1m${title}\x1b[0m` : title);
    list.push(`  \x1b[2m${text.detail}\x1b[0m`);
  }
  const count = chooser.rows.length - 1;
  const heading = chooser.loading
    ? "Looking for outlines…"
    : count ? `Use one of ${count} known outline${count === 1 ? "" : "s"}, or start a new one:` : "No other outlines found. Start a new one:";
  const output = ["", ` ┌${"─".repeat(inner)}┐ `,
    bordered(chooser.context.switch ? `\x1b[1;36mChoose the outline for\x1b[0m ${root}` : `\x1b[1;36mNo outline for\x1b[0m ${root}`),
    bordered(`\x1b[2mResolved from ${sanitizeDynamicText(chooser.context.rootSource)}. Nothing has been created.\x1b[0m`),
    bordered(heading)];
  for (let row = 0; row < listHeight; row++) output.push(bordered(list[row] ?? ""));
  output.push(bordered(chooser.status ? `\x1b[33m${sanitizeDynamicText(chooser.status)}\x1b[0m` : ""));
  output.push(bordered("\x1b[2m↑/↓ j/k move · Enter or click choose · wheel scroll · Esc close\x1b[0m"),
    ` └${"─".repeat(inner)}┘ `);
  return output.slice(0, height);
}

/** The name "New outline here" gives on a host: the folder's name, with a suffix if taken. */
export function newHostedOutlineName(workspaceRoot: string, taken: ReadonlySet<string>): string {
  const base = slugifyOutlineName(basename(workspaceRoot));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * What choosing a row does: the config to record, an outline service to start
 * first (no host), or an outline to create on the host first.
 */
export type ChooserPlan =
  | { kind: "write"; config: OutlinerClientConfig & { workspaceRoot: string }; startServiceFor?: string; createOutline?: string }
  | { kind: "refuse"; message: string };

export function planChoice(row: OutlineChooserRow, workspaceRoot: string, host?: { names: ReadonlySet<string> }): ChooserPlan {
  if (row.kind === "hosted") return { kind: "write", config: { mode: "host", workspaceRoot, outline: row.outline.name } };
  if (row.kind === "new" && host) {
    const name = newHostedOutlineName(workspaceRoot, host.names);
    return { kind: "write", config: { mode: "host", workspaceRoot, outline: name }, createOutline: name };
  }
  if (row.kind === "new") return { kind: "write", config: { mode: "local", workspaceRoot } };
  const { outline } = row;
  const config = { mode: "remote" as const, workspaceRoot, socketPath: outline.socket, label: outline.label };
  if (outline.status === "running" || outline.location === "remote") return { kind: "write", config };
  if (!outline.root) {
    return { kind: "refuse", message: `${outline.label} is stopped and its folder is unknown; open it from its own folder first.` };
  }
  return { kind: "write", config, startServiceFor: outline.root };
}
