import {emitKeypressEvents} from "node:readline";
import {PassThrough} from "node:stream";
import {stripTerminalSequences, truncateToWidth} from "@earendil-works/pi-tui";
import {decodePiDetailInput} from "./detail-pi-input";
import {actionChordForInput, DEFAULT_OUTLINER_ACTION_KEYMAP, type OutlinerActionKeymap} from "./outliner-actions";
import type {TerminalKey} from "./terminal";

const MAX_BYTES = 512;
const MAX_RECORDS = 8;
const escaped = (text: string) => JSON.stringify(text).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
interface InputRecord {number: number; bytes: number; truncated: boolean; raw: string; hex: string; points: string; pi: string; mappings: string[]; readline: string[]}

/** In-memory input inspection. The host must offer raw input before its normal decoders. */
export class KeyInspector {
  active = false;
  private records: InputRecord[] = [];
  private serial = 0;
  private stream: PassThrough | undefined;
  private streamBytes = 0;
  private readonly keymap: OutlinerActionKeymap;
  private readonly invalidate: () => void;

  constructor(options: {actionKeymap?: OutlinerActionKeymap; invalidate?: () => void} = {}) {
    this.keymap = options.actionKeymap ?? DEFAULT_OUTLINER_ACTION_KEYMAP;
    this.invalidate = options.invalidate ?? (() => {});
  }

  open(): void {
    this.dispose();
    this.active = true;
    this.records = [];
    this.serial = 0;
    this.resetStream();
    this.invalidate();
  }

  private describe(text: string, key: TerminalKey): string {
    let chord: string;
    try { chord = actionChordForInput(text, key) ?? "unrecognized"; }
    catch (error) { chord = `parser error: ${String(error)}`; }
    return `${escaped(key.name ?? text)} ctrl=${!!key.ctrl} alt=${!!key.meta} shift=${!!key.shift} · ${escaped(chord)}`;
  }

  private mapping(surface: "tree" | "detail", mode: "browse" | "preview", text: string, key: TerminalKey): string {
    try { return this.keymap.resolve(surface, mode, text, key).actionId ?? "none"; }
    catch (error) { return `parser error: ${escaped(String(error))}`; }
  }

  private resetStream(): void {
    this.stream?.removeAllListeners();
    this.stream?.destroy();
    this.streamBytes = 0;
    const stream = new PassThrough();
    this.stream = stream;
    emitKeypressEvents(stream);
    stream.on("keypress", (text: string | undefined, key: TerminalKey) => {
      if (!this.active || this.stream !== stream) return;
      if (key.ctrl && key.name === "q") { this.dispose(); this.invalidate(); return; }
      const record = this.records.at(-1);
      if (record && record.readline.length < 8) record.readline.push(this.describe(text ?? "", key));
      this.invalidate();
    });
  }

  handle(data: string | Buffer): boolean {
    if (!this.active) return false;
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    const bounded = typeof data === "string" ? Buffer.from(data.slice(0, MAX_BYTES)).subarray(0, MAX_BYTES) : data.subarray(0, MAX_BYTES);
    const text = bounded.toString("utf8");
    let parsed: ReturnType<typeof decodePiDetailInput> | undefined;
    let parseError = "";
    try { parsed = decodePiDetailInput(text); }
    catch (error) { parseError = `parser error: ${escaped(String(error))}`; }
    if (parsed?.kind === "key" && parsed.inputAction !== "suppress" && parsed.key.ctrl && parsed.key.name === "q") {
      this.dispose(); this.invalidate(); return true;
    }
    const record: InputRecord = {
      number: ++this.serial, bytes, truncated: bytes > MAX_BYTES, raw: escaped(text),
      hex: [...bounded].map(byte => byte.toString(16).padStart(2, "0")).join(" "),
      points: [...text].map(char => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" "),
      pi: !parsed ? parseError : parsed.kind === "paste" ? `paste ${escaped(parsed.text)}` : `${this.describe(parsed.str, parsed.key)} · ${parsed.inputAction}`,
      mappings: parsed?.kind !== "key" ? [] : [
        `Pi → Tree browse: ${this.mapping("tree", "browse", parsed.str, parsed.key)}`,
        `Pi → Detail preview: ${this.mapping("detail", "preview", parsed.str, parsed.key)}`,
      ],
      readline: [],
    };
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) this.records.shift();
    if (this.streamBytes + bounded.length > MAX_BYTES) {
      this.resetStream();
      record.readline.push("Probe reset at the 512-byte stream limit");
    }
    this.streamBytes += bounded.length;
    this.stream?.write(bounded);
    if (record.truncated && this.active) this.resetStream();
    this.invalidate();
    return true;
  }

  render(width: number, height: number): string[] {
    width = Math.max(1, Math.floor(width)); height = Math.max(1, Math.floor(height));
    const lines = ["Keys seen by this pane · Ctrl+Q closes", "Raw chunk ≠ keypress. Escape is captured; mappings below are reading modes."];
    if (!this.records.length) lines.push("Press a key: try Alt+L, literal ¬, or Alt+Shift+ArrowRight.");
    for (const record of [...this.records].reverse()) {
      lines.push(`Chunk ${record.number} · ${record.bytes} bytes${record.truncated ? " · showing 512 bytes (truncated)" : ""}`,
        `Text: ${record.raw}`, `Hex: ${record.hex}`, `Codepoints: ${record.points}`, `Pi chunk: ${record.pi}`, ...record.mappings,
        ...((record.readline.length ? record.readline : ["waiting / no key event"]).map(value => `Readline: ${value}`)));
    }
    return Array.from({length: height}, (_, i) => stripTerminalSequences(truncateToWidth(lines[i] ?? "", width)));
  }

  dispose(): void {
    this.active = false;
    this.stream?.removeAllListeners();
    this.stream?.destroy();
    this.stream = undefined;
    this.streamBytes = 0;
  }
}
