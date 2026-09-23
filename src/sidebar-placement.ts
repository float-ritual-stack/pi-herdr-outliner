import { execFile } from "node:child_process";
import { writeFile, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";

const RectSchema = Type.Object({x: Type.Integer({minimum: 0}), y: Type.Integer({minimum: 0}), width: Type.Integer({minimum: 1}), height: Type.Integer({minimum: 1})});
const LayoutSchema = Type.Object({
  workspace_id: Type.String({minLength: 1}), tab_id: Type.String({minLength: 1}), zoomed: Type.Boolean(), area: RectSchema,
  panes: Type.Array(Type.Object({pane_id: Type.String({minLength: 1}), rect: RectSchema}), {minItems: 1}),
  splits: Type.Array(Type.Object({id: Type.String(), direction: Type.Union([Type.Literal("right"), Type.Literal("down")]), ratio: Type.Number({minimum: 0.1, maximum: 0.9}), rect: RectSchema})),
});
type Layout = Static<typeof LayoutSchema>;
type Rect = Static<typeof RectSchema>;
type Direction = "right" | "down";
type Branch = {rect: Rect; panes: string[]; split?: {direction: Direction; ratio: number; first: Branch; second: Branch}};
type Move = {pane: string; target: string; direction: Direction; ratio: number};
export type SidebarRunner = (args: string[]) => Promise<unknown>;
export interface OpenDetailSidebarOptions {
  sourcePaneId: string;
  outlinerPaneIds: string[];
  scope: "outliner" | "tab";
  side: "left" | "right";
  /** Create a right split at this anchor. On rejection, clean up any unreported pane. */
  createDetail(anchorPaneId: string): Promise<string>;
}
export class SidebarPlacementError extends Error {
  constructor(message: string, readonly journalPath?: string) {super(message); this.name = "SidebarPlacementError";}
}
const execute = promisify(execFile);
const runHerdr: SidebarRunner = async args => {
  const {stdout} = await execute(process.env.HERDR_BIN_PATH ?? "herdr", args, {encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024});
  return stdout.trim() ? JSON.parse(stdout) : undefined;
};
const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

function treeFromLayout(layout: Layout): Branch {
  if (layout.zoomed) throw new Error("Unzoom the Herdr tab before placing a sidebar");
  const splits = new Map<string, Layout["splits"][number]>();
  for (const split of layout.splits) {
    const match = /^split_\d+_(root|[01]+)$/.exec(split.id);
    if (!match) throw new Error(`Unsupported native split path: ${split.id}`);
    const path = match[1] === "root" ? "" : match[1]!;
    if (splits.has(path)) throw new Error("Herdr returned duplicate split paths");
    splits.set(path, split);
  }
  const used = new Set<string>();
  const visit = (path: string, rect: Rect): Branch => {
    const split = splits.get(path);
    if (!split) {
      const panes = layout.panes.filter(pane => contains(rect, pane.rect));
      if (panes.length !== 1 || used.has(panes[0]!.pane_id)) throw new Error("Herdr pane geometry does not match its split tree");
      used.add(panes[0]!.pane_id);
      return {rect, panes: [panes[0]!.pane_id]};
    }
    if (!sameRect(rect, split.rect)) throw new Error("Herdr split geometry changed; retry sidebar placement");
    splits.delete(path);
    const firstRect = {...rect}, secondRect = {...rect};
    // Herdr's native BSP uses rounded f32 split extents; pane chrome sits inside these rectangles.
    if (split.direction === "right") {
      firstRect.width = Math.round(Math.fround(Math.fround(rect.width) * Math.fround(split.ratio)));
      secondRect.x += firstRect.width; secondRect.width -= firstRect.width;
    } else {
      firstRect.height = Math.round(Math.fround(Math.fround(rect.height) * Math.fround(split.ratio)));
      secondRect.y += firstRect.height; secondRect.height -= firstRect.height;
    }
    const first = visit(`${path}0`, firstRect), second = visit(`${path}1`, secondRect);
    return {rect, panes: [...first.panes, ...second.panes], split: {direction: split.direction, ratio: split.ratio, first, second}};
  };
  const tree = visit("", layout.area);
  if (used.size !== layout.panes.length || splits.size) throw new Error("Herdr returned an incomplete split tree");
  return tree;
}
function selectedBranch(tree: Branch, paneIds: Set<string>): Branch {
  if (!tree.split) return tree;
  for (const child of [tree.split.first, tree.split.second]) {
    if ([...paneIds].every(id => child.panes.includes(id))) return selectedBranch(child, paneIds);
  }
  return tree;
}
function rebuildMoves(tree: Branch): Move[] {
  if (!tree.split) return [];
  const {first, second, direction, ratio} = tree.split;
  return [{pane: second.panes[0]!, target: first.panes[0]!, direction, ratio}, ...rebuildMoves(first), ...rebuildMoves(second)];
}
function treeShape(tree: Branch, replacement?: {branch: Branch; pane: string; side: "left" | "right"}): unknown {
  if (tree === replacement?.branch) {
    const original = treeShape(tree);
    return replacement.side === "left" ? ["right", 0.5, replacement.pane, original] : ["right", 0.5, original, replacement.pane];
  }
  if (!tree.split) return tree.panes[0];
  return [tree.split.direction, tree.split.ratio, treeShape(tree.split.first, replacement), treeShape(tree.split.second, replacement)];
}
const layoutFingerprint = (layout: Layout) => JSON.stringify({tab: layout.tab_id, workspace: layout.workspace_id, area: layout.area, zoomed: layout.zoomed,
  panes: layout.panes.map(({pane_id, rect}) => ({pane_id, rect})).sort((a, b) => a.pane_id.localeCompare(b.pane_id)),
  splits: layout.splits.map(({id, direction, ratio, rect}) => ({id, direction, ratio, rect})).sort((a, b) => a.id.localeCompare(b.id))});

/** Uses Herdr's native park/rebuild maneuver, also used by chmarax/herdr-nvim's sidebar.
 * Planning uses the host snapshot, not a second pane registry; existing processes are only moved.
 */
export async function openDetailSidebar(options: OpenDetailSidebarOptions, run: SidebarRunner = runHerdr): Promise<string> {
  const readLayout = async (pane: string) => Parse(Type.Object({result: Type.Object({layout: LayoutSchema})}), await run(["pane", "layout", "--pane", pane])).result.layout;
  const originalLayout = await readLayout(options.sourcePaneId);
  const tree = treeFromLayout(originalLayout);
  if (!tree.panes.includes(options.sourcePaneId)) throw new Error("Sidebar source pane is no longer in this tab");
  const requested = new Set(options.outlinerPaneIds.filter(id => tree.panes.includes(id)));
  if (options.scope === "outliner" && !requested.has(options.sourcePaneId)) throw new Error("Sidebar source must be an explicit Outliner pane");
  const branch = options.scope === "tab" ? tree : selectedBranch(tree, requested);
  if (options.scope === "outliner" && branch.panes.some(id => !requested.has(id))) throw new Error("Outliner area includes unrelated panes; choose the whole-tab sidebar explicitly");
  if (branch.rect.width < 4) throw new Error("Outliner area is too narrow for a sidebar");
  const anchor = branch.panes[0]!;
  const rebuild = rebuildMoves(branch);
  if (layoutFingerprint(originalLayout) !== layoutFingerprint(await readLayout(options.sourcePaneId))) throw new Error("Herdr layout changed during planning; retry sidebar placement");
  const journalPath = join(tmpdir(), `outliner-sidebar-${crypto.randomUUID()}.json`);
  const journal: {originalLayout: Layout; anchor: string; rebuild: Move[]; scope: string; side: string; parkingTab?: string; placeholder?: string; sidebar?: string; operation?: string[]; recoveryError?: string; placementVerified?: boolean; cleanupError?: string} = {
    originalLayout, anchor, rebuild, scope: options.scope, side: options.side,
  };
  const save = async () => {
    await writeFile(`${journalPath}.tmp`, `${JSON.stringify(journal, null, 2)}\n`, {mode: 0o600});
    await rename(`${journalPath}.tmp`, journalPath);
  };
  const command = async (args: string[]) => {journal.operation = args; await save(); return run(args);};
  const move = (pane: string, tab: string, step?: Omit<Move, "pane">) => command(["pane", "move", pane, "--tab", tab, "--split", step?.direction ?? "right",
    ...(step ? ["--target-pane", step.target, "--ratio", String(step.ratio)] : []), "--no-focus"]);
  const close = (pane: string) => command(["pane", "close", pane]);
  const paneTab = async (pane: string) => Parse(Type.Object({result: Type.Object({pane: Type.Object({tab_id: Type.String()})})}), await run(["pane", "get", pane])).result.pane.tab_id;
  const ensureParking = async () => {
    if (journal.parkingTab) return journal.parkingTab;
    const created = Parse(Type.Object({result: Type.Object({tab: Type.Object({tab_id: Type.String()}), root_pane: Type.Object({pane_id: Type.String()})})}),
      await command(["tab", "create", "--workspace", originalLayout.workspace_id, "--label", "Outliner sidebar placement", "--no-focus"])).result;
    journal.parkingTab = created.tab.tab_id; journal.placeholder = created.root_pane.pane_id; await save();
    return journal.parkingTab;
  };
  const cleanup = async () => {await unlink(journalPath);};
  await save();
  try {
    if (rebuild.length || options.side === "left") await ensureParking();
    for (const pane of branch.panes.slice(1)) await move(pane, journal.parkingTab!);
    journal.operation = ["create-detail-right", anchor]; await save();
    journal.sidebar = await options.createDetail(anchor);
    if (!journal.sidebar || tree.panes.includes(journal.sidebar)) throw new Error("Detail creation did not return a new pane identity");
    await save();
    if (options.side === "left") {
      await move(anchor, journal.parkingTab!);
      await move(anchor, originalLayout.tab_id, {target: journal.sidebar, direction: "right", ratio: 0.5});
    }
    for (const step of rebuild) await move(step.pane, originalLayout.tab_id, step);
    const placed = await readLayout(anchor);
    const expectedShape = treeShape(tree, {branch, pane: journal.sidebar, side: options.side});
    if (placed.tab_id !== originalLayout.tab_id || JSON.stringify(treeShape(treeFromLayout(placed))) !== JSON.stringify(expectedShape)) {
      throw new Error("Herdr did not preserve the requested sidebar subtree");
    }
  } catch (failure) {
    try {
      // Normalize a partial rebuild by parking the old leaves again, then replay
      // the complete original subtree. The sidebar holds its outside boundary.
      if (rebuild.length) await ensureParking();
      for (const pane of branch.panes.slice(1)) {
        if (await paneTab(pane) !== journal.parkingTab) await move(pane, journal.parkingTab!);
      }
      if (await paneTab(anchor) !== originalLayout.tab_id) {
        if (!journal.sidebar) throw new Error("Original anchor is parked without a known sidebar boundary");
        await move(anchor, originalLayout.tab_id, {target: journal.sidebar, direction: "right", ratio: 0.5});
      }
      if (journal.sidebar && !tree.panes.includes(journal.sidebar)) await close(journal.sidebar);
      for (const step of rebuild) await move(step.pane, originalLayout.tab_id, step);
      if (journal.placeholder) await close(journal.placeholder);
      if (layoutFingerprint(await readLayout(anchor)) !== layoutFingerprint(originalLayout)) throw new Error("Restored layout differs from the snapshot; inspect for concurrent or unreported pane changes");
      await cleanup();
    } catch (recoveryFailure) {
      journal.recoveryError = String(recoveryFailure);
      await save();
      throw new SidebarPlacementError(`Sidebar placement failed (${String(failure)}); recovery incomplete. Original layout and recovery moves: ${journalPath}`, journalPath);
    }
    throw new SidebarPlacementError(`Sidebar placement failed; original layout restored: ${String(failure)}`);
  }
  // The verified reader is now usable. Housekeeping failure must not close it
  // or move the original panes again; retain the journal for manual cleanup.
  journal.placementVerified = true;
  try {
    await save();
    if (journal.placeholder) await close(journal.placeholder);
    await cleanup();
  } catch (cleanupFailure) {
    journal.cleanupError = String(cleanupFailure);
    await save().catch(() => {}); // The last durable journal still describes the placement.
    console.warn(`Sidebar placed successfully; cleanup incomplete. Inspect retained journal: ${journalPath}`);
  }
  return journal.sidebar!;
}
