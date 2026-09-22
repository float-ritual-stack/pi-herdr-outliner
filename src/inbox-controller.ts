import type { RequestInput } from "./client";
import type { OutlinerRequester } from "./client-target";
import type { InboxResultSummary, InboxStatus } from "./inbox-types";
import { TextBuffer } from "./text-buffer";
import { isPrintableInput, sanitizeDynamicText, type TerminalKey } from "./terminal";
import type { Block } from "./types";

interface InboxEffects extends OutlinerRequester {
  invalidate(): void;
  open(blockId: string, destination: "tree" | "detail"): Promise<void>;
  close(): void | Promise<void>;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function boundedInstructions(text: string, capacity: number): string {
  const clean = sanitizeDynamicText(text.replace(/[\r\n]+/g, " "));
  if (clean.length <= capacity) return clean;
  return clean.slice(0, graphemes.segment(clean).containing(capacity)?.index ?? capacity);
}

export class InboxController {
  private active = false;
  private session = 0;
  private epoch = 0;
  private refreshNeeded = false;
  private refreshJob: Promise<void> | null = null;
  private buffer = new TextBuffer();
  private reconsiderSourceId: string | null = null;
  snapshot: InboxStatus | null = null;
  attentionOnly = false;
  resultsOffset = 0;
  index = 0;
  targetIndex = 0;
  detailOffset = 0;
  loading = false;
  busy = false;
  error = "";
  notice = "";

  constructor(private readonly effects: InboxEffects) {}

  get results(): InboxResultSummary[] {
    return this.snapshot?.attentionOnly === this.attentionOnly && this.snapshot.resultsOffset === this.resultsOffset ? this.snapshot.results : [];
  }
  get selected(): InboxResultSummary | undefined { return this.results[this.index]; }
  get steering(): boolean { return this.reconsiderSourceId !== null; }
  get instructions(): string { return this.buffer.text; }
  get column(): number { return this.buffer.column; }
  get targets(): Array<{ id: string; label: string }> {
    const result = this.selected;
    if (!result) return [];
    return [
      ...result.outputIds.map((id, index) => ({ id, label: `Output ${index + 1}` })),
      { id: result.sourceId, label: "Source" },
    ];
  }

  async start(): Promise<void> {
    this.active = true;
    const session = ++this.session;
    this.reconsiderSourceId = null;
    this.attentionOnly = true;
    this.resultsOffset = 0;
    const epoch = this.epoch + 1;
    await this.changedCollection();
    // Pick the opening view once. Refreshes must preserve an explicit history choice.
    if (this.active && session === this.session && epoch === this.epoch && !this.error
      && this.snapshot?.attentionOnly && this.snapshot.attentionCount === 0) {
      this.attentionOnly = false;
      await this.changedCollection();
    }
  }

  async close(): Promise<void> {
    this.active = false;
    this.session++;
    this.reconsiderSourceId = null;
    await this.effects.close();
  }

  /** Events and reconnects refresh the retained status even while its view is closed. */
  refresh(): Promise<void> {
    this.refreshNeeded = true;
    if (this.refreshJob) return this.refreshJob;
    this.loading = true;
    this.effects.invalidate();
    this.refreshJob = this.refreshLoop().finally(() => {
      this.refreshJob = null;
      this.loading = false;
      this.effects.invalidate();
    });
    return this.refreshJob;
  }

  disconnected(): void {
    this.epoch++;
    this.error = "Workspace service disconnected; reconnecting…";
  }

  private async refreshLoop(): Promise<void> {
    while (this.refreshNeeded) {
      this.refreshNeeded = false;
      const epoch = this.epoch;
      try {
        const snapshot = await this.effects.request<InboxStatus>({
          action: "inbox.status",
          ...(this.attentionOnly ? { attentionOnly: true } : {}),
          ...(this.resultsOffset ? { resultsOffset: this.resultsOffset } : {}),
        });
        if (epoch === this.epoch) this.receive(snapshot);
      } catch (error) {
        if (epoch === this.epoch) this.error = message(error);
      }
    }
  }

  private receive(snapshot: InboxStatus): void {
    const selectedId = this.selected?.id;
    const targetId = this.targets[this.targetIndex]?.id;
    this.snapshot = snapshot;
    this.error = "";
    const nextIndex = selectedId ? snapshot.results.findIndex(result => result.id === selectedId) : -1;
    this.index = nextIndex >= 0 ? nextIndex : Math.min(this.index, Math.max(0, snapshot.results.length - 1));
    this.targetIndex = Math.max(0, this.targets.findIndex(target => target.id === targetId));
    if (selectedId !== this.selected?.id) this.detailOffset = 0;
  }

  move(delta: number): void {
    this.index = Math.max(0, Math.min(this.results.length - 1, this.index + delta));
    this.targetIndex = 0;
    this.detailOffset = 0;
    this.notice = "";
    this.effects.invalidate();
  }

  paste(text: string): void {
    if (!this.steering || this.busy) return;
    this.buffer.insert(boundedInstructions(text, Math.max(0, 500 - this.instructions.length)));
    this.effects.invalidate();
  }

  async input(str: string, key: TerminalKey): Promise<void> {
    if (!this.active) return;
    if (key.name === "escape") {
      if (this.steering) { this.reconsiderSourceId = null; this.notice = ""; this.effects.invalidate(); }
      else await this.close();
      return;
    }
    if (this.busy) return;
    if (this.steering) {
      if (key.name === "return") {
        const sourceId = this.reconsiderSourceId!;
        const instructions = this.instructions.trim();
        const ok = await this.mutate({ action: "inbox.retry", sourceId, ...(instructions ? { instructions } : {}) }, "Queued for reconsideration");
        if (ok) this.reconsiderSourceId = null;
      } else if (key.name === "backspace") this.buffer.backspace();
      else if (key.name === "delete") this.buffer.deleteForward();
      else if (key.name === "left") this.buffer.moveLeft();
      else if (key.name === "right") this.buffer.moveRight();
      else if (key.name === "home") this.buffer.moveHome();
      else if (key.name === "end") this.buffer.moveEnd();
      else if (isPrintableInput(str, key)) this.paste(str);
    } else if (str === "a") {
      this.attentionOnly = !this.attentionOnly;
      this.resultsOffset = 0;
      await this.changedCollection();
    } else if (key.name === "left" || key.name === "right") {
      if (this.attentionOnly) this.notice = "Resolve these questions to reveal the remaining items";
      else if (key.name === "left" && this.resultsOffset > 0) {
        this.resultsOffset = Math.max(0, this.resultsOffset - 30);
        await this.changedCollection();
      } else if (key.name === "right" && this.snapshot?.resultsTruncated) {
        this.resultsOffset += 30;
        await this.changedCollection();
      } else this.notice = key.name === "left" ? "First page of recent results" : "No older results";
    } else if (key.name === "up" || key.name === "down") this.move(key.name === "up" ? -1 : 1);
    else if (key.name === "tab") {
      const count = this.targets.length;
      if (count) this.targetIndex = (this.targetIndex + (key.shift ? -1 : 1) + count) % count;
    } else if (key.name === "pageup" || key.name === "pagedown") {
      this.detailOffset = Math.max(0, this.detailOffset + (key.name === "pageup" ? -5 : 5));
    } else if (key.name === "return") await this.open(this.targets[this.targetIndex]?.id, key.meta ? "detail" : "tree");
    else if (str === "s") await this.open(this.selected?.sourceId, "tree");
    else if (str === "p") {
      if (!this.snapshot) this.notice = "Wait for Inbox status before changing it";
      else await this.mutate({ action: this.snapshot.paused ? "inbox.resume" : "inbox.pause" }, this.snapshot.paused ? "Inbox agent resumed" : "Inbox agent paused");
    } else if (str === "u") {
      if (this.selected?.state === "applied") await this.mutate({ action: "inbox.undo", resultId: this.selected.id }, "Result undone");
      else this.notice = "Only an applied result can be undone";
    } else if (str === "r") {
      if (!this.selected) this.notice = "Select a result to reconsider";
      else if (this.selected.state === "applied") this.notice = "Undo this result before reconsidering it";
      else {
        this.reconsiderSourceId = this.selected.sourceId;
        this.buffer = new TextBuffer();
        this.notice = "Add optional instructions for this capture.";
      }
    }
    this.effects.invalidate();
  }

  private async changedCollection(): Promise<void> {
    this.epoch++;
    this.index = 0;
    this.targetIndex = 0;
    this.detailOffset = 0;
    this.notice = "";
    await this.refresh();
  }

  private async mutate(input: RequestInput, notice: string): Promise<boolean> {
    this.busy = true;
    this.notice = "Saving…";
    this.epoch++;
    this.effects.invalidate();
    try {
      const snapshot = await this.effects.request<InboxStatus>(input);
      this.epoch++;
      if (this.attentionOnly || this.resultsOffset) await this.refresh();
      else this.receive(snapshot);
      this.notice = notice;
      return true;
    } catch (error) {
      this.notice = message(error);
      return false;
    } finally {
      this.busy = false;
      this.effects.invalidate();
    }
  }

  private async open(blockId: string | undefined, destination: "tree" | "detail"): Promise<void> {
    if (!blockId) return;
    const session = this.session;
    try {
      const block = await this.effects.request<Block | null>({ action: "get", blockId });
      if (!this.active || session !== this.session) return;
      if (!block || block.deletedAt || block.effectiveDeletedRootId) throw new Error("This block is no longer available");
      await this.effects.open(block.id, destination);
      this.active = false;
      this.session++;
    } catch (error) {
      if (this.active && session === this.session) this.notice = message(error);
    }
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
