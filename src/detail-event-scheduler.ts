import type { OutlinerEvent } from "./types";

export interface DetailEventSchedulerOptions {
  readonly clientId: string;
  readonly enqueue: (task: () => void | Promise<void>) => void;
  readonly handle: (event: OutlinerEvent) => Promise<void>;
  readonly supersedePreview: () => void;
}

interface ScheduledDetailEvent {
  readonly event: OutlinerEvent;
  readonly passivePreview: boolean;
  obsolete: boolean;
  sealed: boolean;
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
  private active: ScheduledDetailEvent | null = null;
  private pendingPreview: ScheduledDetailEvent | null = null;

  constructor(private readonly options: DetailEventSchedulerOptions) {}

  schedule(event: OutlinerEvent): void {
    const scheduled: ScheduledDetailEvent = {
      event,
      passivePreview: isPassivePreview(event, this.options.clientId),
      obsolete: false,
      sealed: false,
    };
    if (scheduled.passivePreview) {
      if (this.active?.passivePreview && !this.active.sealed) {
        this.active.obsolete = true;
        this.options.supersedePreview();
      }
      if (this.pendingPreview) this.pendingPreview.obsolete = true;
      this.pendingPreview = scheduled;
    } else if (!isPassivePreviewContext(event)) {
      this.sealPreviewBatch();
    }
    this.options.enqueue(async () => {
      if (this.pendingPreview === scheduled) this.pendingPreview = null;
      if (scheduled.obsolete) return;
      this.active = scheduled;
      try {
        await this.options.handle(scheduled.event);
      } finally {
        if (this.active === scheduled) this.active = null;
      }
    });
  }

  scheduleWork(task: () => void | Promise<void>): void {
    this.sealPreviewBatch();
    this.options.enqueue(task);
  }

  private sealPreviewBatch(): void {
    if (this.active?.passivePreview) this.active.sealed = true;
    if (this.pendingPreview) this.pendingPreview.sealed = true;
    this.pendingPreview = null;
  }
}
