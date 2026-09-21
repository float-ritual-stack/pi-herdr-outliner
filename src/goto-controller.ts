import type { OutlinerRequester } from "./client-target";
import type { DetailReadPreviewDocument } from "./detail-pi-preview";
import { loadDetailReadPreview } from "./detail-read-preview";
import { TextBuffer } from "./text-buffer";
import { isPrintableInput, sanitizeDynamicText, type TerminalKey } from "./terminal";
import type { Block, GotoSearchCollection, GotoSearchMatch } from "./types";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function boundedInput(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const boundary = graphemes.segment(text).containing(limit);
  return text.slice(0, boundary?.index ?? limit);
}

interface GotoEffects extends OutlinerRequester {
  invalidate(): void;
  open(blockId: string, destination: "tree" | "detail"): Promise<void>;
  close(): void | Promise<void>;
}

export class GotoController {
  private buffer = new TextBuffer();
  private active = false;
  private generation = 0;
  private previewGeneration = 0;
  private lexicalPending = false;
  private lexicalJob: Promise<void> | null = null;
  private semanticJob: Promise<void> | null = null;
  private semanticPending: { query: string; generation: number } | null = null;
  private semanticTimer: ReturnType<typeof setTimeout> | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private touched = false;
  private pendingOpen: "tree" | "detail" | null = null;
  matches: GotoSearchMatch[] = [];
  index = 0;
  loading = false;
  ranking = false;
  previewLoading = false;
  preview: DetailReadPreviewDocument | null = null;
  previewOffset = 0;
  status = "";
  previewError = "";
  completeness: GotoSearchCollection["completeness"] = { kind: "complete" };
  semantic: GotoSearchCollection["semantic"] = { status: "lexical" };

  constructor(private readonly effects: GotoEffects, private readonly debounceMs = 350) {}
  get query(): string { return this.buffer.lines[0] ?? ""; }
  get column(): number { return this.buffer.column; }
  get selected(): GotoSearchMatch | undefined { return this.matches[this.index]; }

  start(): void {
    this.active = true;
    this.buffer = new TextBuffer();
    this.changed();
  }

  dispose(): void {
    this.active = false;
    ++this.generation; ++this.previewGeneration;
    clearTimeout(this.semanticTimer ?? undefined);
    clearTimeout(this.previewTimer ?? undefined);
    this.semanticPending = null;
    this.lexicalPending = false;
    this.pendingOpen = null;
  }

  async cancel(): Promise<void> { this.dispose(); await this.effects.close(); }

  paste(text: string): void {
    this.buffer.insert(boundedInput(sanitizeDynamicText(text.replace(/[\r\n]+/g, " ")), Math.max(0, 500 - this.query.length)));
    this.changed();
  }

  async input(str: string, key: TerminalKey): Promise<void> {
    if (key.name === "escape") return this.cancel();
    if (key.name === "return") return this.accept(key.meta ? "detail" : "tree");
    if (key.name === "up" || key.name === "down" || key.name === "tab") {
      this.move(key.name === "up" || (key.name === "tab" && key.shift) ? -1 : 1, key.name === "tab");
    } else if (key.name === "pageup" || key.name === "pagedown") {
      this.scrollPreview(key.name === "pageup" ? -8 : 8);
    } else {
      const before = this.query;
      if (key.name === "backspace") this.buffer.backspace();
      else if (key.name === "delete") this.buffer.deleteForward();
      else if (key.name === "left") this.buffer.moveLeft();
      else if (key.name === "right") this.buffer.moveRight();
      else if (key.name === "home") this.buffer.moveHome();
      else if (key.name === "end") this.buffer.moveEnd();
      else if (isPrintableInput(str, key) && this.query.length < 500) this.buffer.insert(boundedInput(sanitizeDynamicText(str), 500 - this.query.length));
      if (before !== this.query) this.changed();
    }
    this.effects.invalidate();
  }

  move(delta: number, wrap = false): void {
    if (!this.matches.length) return;
    const count = this.matches.length;
    this.select(wrap ? (this.index + delta + count) % count : Math.max(0, Math.min(count - 1, this.index + delta)));
  }

  select(index: number): void {
    if (!this.matches[index]) return;
    this.touched = true;
    if (index !== this.index) { this.index = index; this.startPreview(); }
    this.effects.invalidate();
  }

  scrollPreview(delta: number): void { this.previewOffset = Math.max(0, this.previewOffset + delta); this.effects.invalidate(); }

  async accept(destination: "tree" | "detail"): Promise<void> {
    if (!this.active) return;
    if (this.loading && !this.selected) { this.pendingOpen = destination; return; }
    const selected = this.selected;
    if (!selected) return;
    const generation = this.generation;
    this.touched = true;
    try {
      const block = await this.effects.request<Block | null>({ action: "get", blockId: selected.block.id });
      if (!this.active || generation !== this.generation) return;
      if (!block || block.deletedAt || block.effectiveDeletedRootId) throw new Error("This result is no longer available; search again");
      await this.effects.open(block.id, destination);
      this.dispose();
    } catch (error) {
      if (this.active && generation === this.generation) this.status = String(error instanceof Error ? error.message : error);
    }
    this.effects.invalidate();
  }

  private changed(): void {
    ++this.generation; ++this.previewGeneration;
    clearTimeout(this.semanticTimer ?? undefined); clearTimeout(this.previewTimer ?? undefined);
    this.semanticPending = null; this.pendingOpen = null;
    this.matches = []; this.index = 0; this.touched = false; this.preview = null; this.previewOffset = 0;
    this.status = ""; this.previewError = ""; this.previewLoading = false; this.ranking = false;
    this.semantic = { status: "lexical" }; this.loading = true; this.lexicalPending = true;
    this.pumpLexical();
    const query = this.query.trim(), generation = this.generation;
    if (query.length >= 3) this.semanticTimer = setTimeout(() => {
      if (!this.active || generation !== this.generation || this.selected?.exact) return;
      this.semanticPending = { query, generation }; this.pumpSemantic();
    }, this.debounceMs);
    this.effects.invalidate();
  }

  private pumpLexical(): void {
    if (this.lexicalJob) return;
    this.lexicalJob = (async () => {
      while (this.active && this.lexicalPending) {
        this.lexicalPending = false;
        const generation = this.generation, query = this.query.trim();
        try {
          const result = await this.effects.request<GotoSearchCollection>({ action: "tree.search", query });
          if (!this.active || generation !== this.generation) continue;
          // The semantic response may win the race; a late lexical reply cannot undo it.
          if (this.semantic.status !== "ranked") this.apply(result);
          this.loading = false;
          const destination = this.pendingOpen; this.pendingOpen = null;
          if (destination) void this.accept(destination);
        } catch (error) {
          if (this.active && generation === this.generation) {
            this.loading = false;
            this.status = `Search failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        this.effects.invalidate();
      }
    })().finally(() => { this.lexicalJob = null; if (this.active && this.lexicalPending) this.pumpLexical(); });
  }

  private pumpSemantic(): void {
    if (this.semanticJob || !this.semanticPending || !this.active) return;
    const { query, generation } = this.semanticPending;
    this.semanticPending = null; this.ranking = true; this.effects.invalidate();
    this.semanticJob = (async () => {
      try {
        const result = await this.effects.request<GotoSearchCollection>({ action: "tree.search", query, semantic: true });
        if (!this.active || generation !== this.generation) return;
        this.apply(result);
      } catch {
        if (this.active && generation === this.generation) this.semantic = { status: "unavailable", message: "Jev unavailable; showing text matches" };
      } finally {
        if (this.active && generation === this.generation) { this.ranking = false; this.effects.invalidate(); }
      }
    })().finally(() => { this.semanticJob = null; this.pumpSemantic(); });
  }

  private apply(result: GotoSearchCollection): void {
    const selected = this.selected;
    if (this.touched) {
      const incoming = new Map(result.matches.map(match => [match.block.id, match]));
      // A bounded ranking omitting an ID says nothing about its existence.
      // Once the user navigates, retain their list; accept() verifies the target.
      this.matches = this.matches.map(match => incoming.get(match.block.id) ?? match);
    } else this.matches = result.matches;
    this.index = this.touched && selected ? Math.max(0, this.matches.findIndex(match => match.block.id === selected.block.id)) : 0;
    this.completeness = result.completeness; this.semantic = result.semantic;
    if (this.touched && result.semantic.status === "ranked") this.semantic = { ...result.semantic, message: "Jev ready · keeping your selection" };
    if (selected?.block.id !== this.selected?.block.id || selected?.block.revision !== this.selected?.block.revision) this.startPreview();
  }

  private startPreview(): void {
    const generation = ++this.previewGeneration;
    clearTimeout(this.previewTimer ?? undefined);
    this.preview = null; this.previewOffset = 0; this.previewError = "";
    const selected = this.selected;
    this.previewLoading = !!selected;
    if (!selected) return;
    this.previewTimer = setTimeout(() => {
      void (async () => {
        try {
          const block = await this.effects.request<Block | null>({ action: "get", blockId: selected.block.id });
          if (!this.active || generation !== this.previewGeneration) return;
          if (!block || block.deletedAt || block.effectiveDeletedRootId) throw new Error("Block is no longer available");
          const preview = await loadDetailReadPreview(this.effects, block, 12_000);
          if (!this.active || generation !== this.previewGeneration) return;
          this.preview = preview;
        } catch (error) {
          if (!this.active || generation !== this.previewGeneration) return;
          this.previewError = error instanceof Error ? error.message : String(error);
        } finally {
          if (this.active && generation === this.previewGeneration) { this.previewLoading = false; this.effects.invalidate(); }
        }
      })();
    }, 60);
  }
}
