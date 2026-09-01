import { getOsc8LinkAtColumn } from "@earendil-works/pi-tui";

const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

export interface TreeMouseClick {
  column: number;
  row: number;
}

export interface TreeMouseTarget {
  readonly rowId: string;
  readonly disclosureColumn: number;
}

export type TreeWheelDirection = "up" | "down";

export interface TreeWheelEvent extends TreeMouseClick {
  direction: TreeWheelDirection;
}

export function isTreeMouseSequence(sequence: string): boolean {
  return SGR_MOUSE_PATTERN.test(sequence);
}

export function parseTreePlainClick(sequence: string): TreeMouseClick | null {
  const match = SGR_MOUSE_PATTERN.exec(sequence);
  if (!match || match[4] !== "M") return null;
  const button = Number.parseInt(match[1], 10);
  if (button !== 0) return null;
  const column = Number.parseInt(match[2], 10) - 1;
  const row = Number.parseInt(match[3], 10) - 1;
  if (column < 0 || row < 0) return null;
  return { column, row };
}
export function parseTreeSecondaryClick(sequence: string): TreeMouseClick | null {
  const match = SGR_MOUSE_PATTERN.exec(sequence);
  if (!match || match[4] !== "M") return null;
  const button = Number.parseInt(match[1], 10);
  if (button !== 2) return null;
  const column = Number.parseInt(match[2], 10) - 1;
  const row = Number.parseInt(match[3], 10) - 1;
  return column >= 0 && row >= 0 ? { column, row } : null;
}

export function parseTreeWheelEvent(sequence: string): TreeWheelEvent | null {
  const match = SGR_MOUSE_PATTERN.exec(sequence);
  if (!match || match[4] !== "M") return null;
  const column = Number.parseInt(match[2], 10) - 1;
  const row = Number.parseInt(match[3], 10) - 1;
  if (column < 0 || row < 0) return null;
  const button = Number.parseInt(match[1], 10);
  const direction = button === 64 ? "up" : button === 65 ? "down" : null;
  return direction ? { direction, column, row } : null;
}

export function parseTreeWheel(sequence: string): TreeWheelDirection | null {
  return parseTreeWheelEvent(sequence)?.direction ?? null;
}

export function treeDisclosureAtClick(
  targets: readonly (TreeMouseTarget | null | undefined)[],
  sequence: string,
): string | null {
  const click = parseTreePlainClick(sequence);
  if (!click) return null;
  const target = targets[click.row];
  return target && click.column === target.disclosureColumn ? target.rowId : null;
}

export function treeLinkAtClick(
  renderedLines: readonly string[],
  sequence: string,
): string | null {
  const click = parseTreePlainClick(sequence);
  if (!click) return null;
  const line = renderedLines[click.row];
  if (line === undefined) return null;
  return getOsc8LinkAtColumn(line, click.column) ?? null;
}
