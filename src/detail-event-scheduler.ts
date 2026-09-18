import type { OutlinerEvent } from "./types";

export interface DetailEventSchedulerOptions {
  readonly clientId: string;
  readonly enqueue: (task: () => Promise<void>) => void;
  readonly handle: (event: OutlinerEvent) => Promise<void>;
  readonly supersedePreview: () => void;
}

interface ScheduledDetailEvent {
  readonly event: OutlinerEvent;
  readonly passivePreview: boolean;
  obsolete: boolean;
}

function isPassivePreview(event: OutlinerEvent, clientId: string): boolean {
  return event.domain === "ui" &&
    event.command?.targetClientId === clientId &&
    event.command.command === "preview";
}

/**
 * Keeps ordered Detail events in one lane while collapsing each contiguous burst
 * of passive previews to its newest pending target. One preview handler runs at a
 * time; a newer preview invalidates the active handler before replacing the tail.
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
    };
    if (scheduled.passivePreview) {
      if (this.active?.passivePreview) {
        this.active.obsolete = true;
        this.options.supersedePreview();
      }
      if (this.pendingPreview) this.pendingPreview.obsolete = true;
      this.pendingPreview = scheduled;
    } else {
      this.pendingPreview = null;
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
}
