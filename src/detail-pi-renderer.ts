import {
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { DetailState } from "./detail-controller";
import { renderDetailLines } from "./detail-renderer";

export interface DetailPiComponentOptions {
  state: Readonly<DetailState>;
  height(): number;
  onInput(data: string): void;
}

export class DetailPiComponent implements Component {
  constructor(private readonly options: DetailPiComponentOptions) {}

  render(width: number): string[] {
    return renderDetailLines(this.options.state, {
      width,
      height: Math.max(1, this.options.height()),
    }).map((line) => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    this.options.onInput(data);
  }

  invalidate(): void {}
}
