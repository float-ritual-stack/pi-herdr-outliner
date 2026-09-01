import type { DetailEditorLayout } from "./detail-editor-layout";
import type { TreeMouseClick } from "./tree-mouse";

export type DetailMouseRegion = "editor" | "preview" | "chrome";

export interface DetailMouseLayout {
  width: number;
  height: number;
  editorWidth: number;
  split: boolean;
}

export interface DetailEditorMousePoint {
  visualRow: number;
  contentColumn: number;
}

const DETAIL_HEADER_ROWS = 3;
const DETAIL_FOOTER_ROWS = 2;

export function detailMouseRegionAt(
  click: TreeMouseClick,
  layout: DetailMouseLayout,
): DetailMouseRegion {
  if (
    click.row < DETAIL_HEADER_ROWS ||
    click.row >= layout.height - DETAIL_FOOTER_ROWS ||
    click.column < 0 ||
    click.column >= layout.width
  ) return "chrome";
  if (!layout.split) return "editor";
  if (click.column < layout.editorWidth) return "editor";
  if (click.column === layout.editorWidth) return "chrome";
  return "preview";
}

export function detailEditorPointAtClick(
  click: TreeMouseClick,
  layout: Readonly<DetailEditorLayout>,
  editorVisualOffset: number,
): DetailEditorMousePoint {
  return {
    visualRow: Math.max(0, editorVisualOffset + click.row - DETAIL_HEADER_ROWS),
    contentColumn: Math.max(0, click.column - layout.lineNumberWidth - 1),
  };
}
