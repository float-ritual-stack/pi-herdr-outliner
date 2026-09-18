import type { OutlinerEvent } from "./types";

export interface DetailEventSchedulerOptions {
  readonly clientId: string;
  readonly enqueue: (task: () => void | Promise<void>) => void;
  readonly handle: (event: OutlinerEvent) => Promise<void>;
  readonly supersedePreview: () => void;
}

function isPassivePreview(event: OutlinerEvent, clientId: string): boolean {
  return event.domain === "ui" &&
    event.command?.targetClientId === clientId &&
    event.command.command === "preview";
}

function isPassivePreviewContext(event: OutlinerEvent): boolean {
  return event.domain === "browsing-context" && event.command === undefined;
}

/**
 * Keeps Detail work in one ordered lane while collapsing passive preview bursts
 * to their newest pending target. Commandless browsing-context notifications stay
 * ordered without ending a burst. Explicit work and other events seal the burst.
 */
export class DetailEventScheduler {
  private cancelPreview: (() => void) | null = null;

  constructor(private readonly options: DetailEventSchedulerOptions) {}

  schedule(event: OutlinerEvent): void {
    if (!isPassivePreview(event, this.options.clientId)) {
      if (!isPassivePreviewContext(event)) this.cancelPreview = null;
      this.options.enqueue(() => this.options.handle(event));
      return;
    }

    this.cancelPreview?.();
    let obsolete = false;
    let active = false;
    this.cancelPreview = () => {
      obsolete = true;
      if (active) this.options.supersedePreview();
    };
    this.options.enqueue(async () => {
      if (obsolete) return;
      active = true;
      try {
        await this.options.handle(event);
      } finally {
        active = false;
      }
    });
  }

  scheduleWork(task: () => void | Promise<void>): void {
    this.cancelPreview = null;
    this.options.enqueue(task);
  }
}
