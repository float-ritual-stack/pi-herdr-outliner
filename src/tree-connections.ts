import type { OutlinerRequester } from "./client-target";
import { decodeAuthoredLinksSnapshot, AUTHORED_LINKS_MAX_ENTRIES_PER_GROUP } from "./authored-links";
import type { BacklinkCollection, TreeIndexBlock } from "./types";
import {
  composeAuthoredLinkRows, connectionOwner, type TreeDisplayRow,
  type OpenAuthoredLinksPanel, type AuthoredLinkHeaderRow,
} from "./tree-rows";
import type { TreeRow } from "./virtual-branches";

/** Owns occurrence-local disclosure, bounded reads, stale responses and refresh. */
export class TreeConnections {
  private panels = new Map<string, OpenAuthoredLinksPanel>();
  private dirty = new Set<string>();
  private revision = 0;
  private refreshing: Promise<void> | null = null;

  constructor(private requester: OutlinerRequester, private changed: () => void) {}

  get active(): boolean { return this.panels.size > 0; }
  get needsRefresh(): boolean { return this.dirty.size > 0; }
  isOpen(rowId: string): boolean { return this.panels.has(rowId); }

  toggle(row: TreeDisplayRow<TreeIndexBlock>): boolean {
    const owner = connectionOwner(row);
    if (!owner) return false;
    if (this.panels.delete(owner.rowId)) {
      this.dirty.delete(owner.rowId);
      return false;
    }
    this.panels.set(owner.rowId, {
      kind: "open", owner, generation: ++this.revision,
      collapsedGroups: { outlinks: false, resources: false, backlinks: false },
      load: { kind: "loading" }, backlinks: { kind: "loading" },
    });
    this.dirty.add(owner.rowId);
    return true;
  }

  toggleGroup(row: AuthoredLinkHeaderRow): void {
    const panel = this.panels.get(row.owner.rowId);
    if (!panel) return;
    this.panels.set(row.owner.rowId, {
      ...panel, collapsedGroups: { ...panel.collapsedGroups, [row.group]: !panel.collapsedGroups[row.group] },
    });
  }

  compose(rows: readonly TreeRow<TreeIndexBlock>[], collapsed: (row: TreeRow<TreeIndexBlock>) => boolean): TreeDisplayRow<TreeIndexBlock>[] {
    return composeAuthoredLinkRows(rows, this.panels, collapsed);
  }

  invalidate(): void {
    for (const [id, panel] of this.panels) {
      this.dirty.add(id);
      this.panels.set(id, {...panel, refreshing: true});
    }
    this.revision++;
  }

  reconcile(index: ReadonlyMap<string, TreeIndexBlock>): void {
    for (const [id, panel] of this.panels) {
      const owner = index.get(panel.owner.blockId);
      if (panel.load.kind === "ready" && panel.load.snapshot.kind === "ready" && owner && panel.load.snapshot.ownerTextDigest !== owner.textDigest) {
        this.panels.set(id, { ...panel, refreshing: true });
        this.dirty.add(id);
      }
    }
  }

  refresh(rows: () => readonly TreeDisplayRow<TreeIndexBlock>[], index: () => ReadonlyMap<string, TreeIndexBlock>): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.run(rows, index).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async run(rows: () => readonly TreeDisplayRow<TreeIndexBlock>[], index: () => ReadonlyMap<string, TreeIndexBlock>): Promise<void> {
    let passRevision = this.revision;
    const attempted = new Set<string>();
    while (true) {
      if (passRevision !== this.revision) {
        passRevision = this.revision;
        attempted.clear();
      }
      const visible = new Set(rows().filter(row => !("collapsed" in row && row.collapsed)).map(row => row.rowId));
      const id = [...this.dirty].find(id => visible.has(id) && this.panels.has(id) && !attempted.has(id));
      if (!id) break;
      attempted.add(id);
      {
        const panel = this.panels.get(id)!;
        this.dirty.delete(id);
        const revision = this.revision;
        const results = await Promise.allSettled([
          this.requester.request<unknown>({ action: "blocks.authored-links", ownerBlockId: panel.owner.blockId }),
          this.requester.request<BacklinkCollection>({
            action: "references.backlinks",
            query: { targetBlockId: panel.owner.blockId, limit: AUTHORED_LINKS_MAX_ENTRIES_PER_GROUP },
          }),
        ]);
        if (this.panels.get(id)?.generation !== panel.generation || this.revision !== revision) {
          if (this.panels.has(id)) this.dirty.add(id);
          continue;
        }
        let load: OpenAuthoredLinksPanel["load"], backlinks: OpenAuthoredLinksPanel["backlinks"];
        const error = (value: unknown) => value instanceof Error ? value.message : String(value);
        try {
          if (results[0].status === "rejected") throw results[0].reason;
          const snapshot = decodeAuthoredLinksSnapshot(results[0].value);
          if (snapshot.ownerId !== panel.owner.blockId) throw Error("Authored-links response owner does not match the requested block");
          const owner = index().get(panel.owner.blockId);
          if (snapshot.kind === "ready" && owner && snapshot.ownerTextDigest !== owner.textDigest) {
            load = panel.load;
            this.dirty.add(id);
          } else load = { kind: "ready", snapshot };
        } catch (reason) { load = { kind: "error", message: error(reason) }; }
        try {
          if (results[1].status === "rejected") throw results[1].reason;
          const found = results[1].value;
          if (found.targetBlockId !== panel.owner.blockId) throw Error("Backlink response target does not match the requested block");
          backlinks = {
            kind: "ready", group: {
              invalidCount: 0, diagnostics: [],
              completeness: found.completeness.kind === "truncated"
                ? { kind: "limited", reason: "entry-limit", shown: found.sources.length } : { kind: "complete" },
              entries: found.sources.map(source => ({
                kind: "outlink", key: source.blockId, label: source.title, referenceKind: "block",
                occurrenceCount: source.occurrenceCount, firstSpan: { start: 0, end: 0 },
                resolution: { kind: "ready", target: { kind: "block", blockId: source.blockId }, title: source.title },
              })),
            },
          };
        } catch (reason) { backlinks = { kind: "error", message: error(reason) }; }
        const latest = this.panels.get(id)!;
        this.panels.set(id, { ...latest, load, backlinks, refreshing: this.dirty.has(id) });
        this.changed();
      }
      // Recompute visibility after every read: loading a parent can reveal retained
      // dirty descendants. Attempt each row once per revision so digest disagreement
      // waits for a fresh Tree index instead of hammering the service.
    }
  }
}
