import { getProperty } from './properties';
import { isBlockTreeRow, type CommentGroupRow, type TreeDisplayRow } from './tree-rows';
import type { ProjectionBlock } from './virtual-branches';

interface Node<T extends ProjectionBlock> {
  row: TreeDisplayRow<T>;
  children: Node<T>[];
}

/** Disclosure belongs to a displayed owner, never to the canonical discussion. */
export class TreeComments {
  private readonly expanded = new Set<string>();
  private readonly parents = new Map<string,string>();

  toggle(group: CommentGroupRow): void {
    if (group.collapsed) this.expanded.add(group.rowId);
    else this.expanded.delete(group.rowId);
  }

  parentGroup(rowId:string): string | undefined { return this.parents.get(rowId); }

  compose<T extends ProjectionBlock>(rows: readonly TreeDisplayRow<T>[], options: {
    revealRowId?: string;
    revealAll?: boolean;
  } = {}): TreeDisplayRow<T>[] {
    this.parents.clear();
    const roots: Node<T>[] = [], stack: Node<T>[] = [];
    for (const row of rows) {
      while (stack.length && stack.at(-1)!.row.depth >= row.depth) stack.pop();
      const node = {row,children:[]};
      (stack.at(-1)?.children ?? roots).push(node);
      stack.push(node);
    }
    // Mark the explicit reveal path once. Background refresh never reveals threads.
    const revealPath = new Set<Node<T>>();
    function mark(node:Node<T>): boolean {
      const descendants = node.children.map(mark);
      if (node.row.rowId !== options.revealRowId && !descendants.some(Boolean)) return false;
      revealPath.add(node); return true;
    }
    if (options.revealRowId) roots.forEach(mark);
    const result: TreeDisplayRow<T>[] = [];
    const emit = (node:Node<T>, offset=0): void => {
      const owner=node.row, depth=owner.depth+offset;
      result.push({...owner,depth});
      const threads: Node<T>[] = [], ordinary: Node<T>[] = [];
      for (const child of node.children) {
        const row=child.row;
        const isThread = isBlockTreeRow(owner) && isBlockTreeRow(row)
          && row.block.parentId===owner.canonicalId
          && getProperty(row.block.properties,'type')==='annotation'
          && !getProperty(row.block.properties,'parent-annotation');
        (isThread ? threads : ordinary).push(child);
      }
      ordinary.forEach(child=>emit(child,offset));
      if (!threads.length || !isBlockTreeRow(owner)) return;
      const rowId=`comments:${owner.rowId}`;
      if (!options.revealAll && threads.some(thread=>revealPath.has(thread))) this.expanded.add(rowId);
      const collapsed=!options.revealAll && !this.expanded.has(rowId);
      result.push({kind:'comment-group',rowId,parentRowId:owner.rowId,
        owner:{rowId:owner.rowId,blockId:owner.canonicalId},depth:depth+1,
        collapsed,threadCount:threads.length});
      for (const thread of threads) {
        this.parents.set(thread.row.rowId,rowId);
        if (!collapsed) emit(thread,offset+1);
      }
    };
    roots.forEach(node=>emit(node));
    return result;
  }
}
