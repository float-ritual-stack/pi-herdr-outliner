// Disposable PIE-388 spike: a ZIP Resource projected as one ANSI artwork in Detail.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync, gunzipSync } from "node:zlib";
import { Terminal } from "@xterm/headless";
import { getCapabilities } from "@earendil-works/pi-tui";
import type { ResourceDescription } from "./resources";
import { sanitizeDynamicText } from "./terminal";

const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
const VGA = ["#000000", "#0000aa", "#00aa00", "#00aaaa", "#aa0000", "#aa00aa", "#aa5500", "#aaaaaa", "#555555", "#5555ff", "#55ff55", "#55ffff", "#ff5555", "#ff55ff", "#ffff55", "#ffffff"];
const ANSI_TO_VGA = [0, 4, 2, 6, 1, 5, 3, 7, 8, 12, 10, 14, 9, 13, 11, 15];
const MAX_ENTRY_BYTES = 256_000;
const MAX_ENTRIES = 1_000;
const FONT_PATH = "/usr/share/consolefonts/Uni2-VGA16.psf.gz";

export interface ArtCell { char: string; fg: number; bg: number }
export interface ArtFrame {
  name: string;
  title: string;
  author: string;
  group: string;
  width: number;
  height: number;
  cells: ArtCell[][];
}

function cp437(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte < 128 ? String.fromCharCode(byte) : CP437_HIGH[byte - 128]!;
  return result;
}

function sauce(bytes: Buffer): { title: string; author: string; group: string; width: number; height: number; data: Buffer } {
  const tail = bytes.subarray(Math.max(0, bytes.length - 128));
  const hasSauce = tail.subarray(0, 7).toString("ascii") === "SAUCE00";
  const dataEnd = hasSauce ? bytes.length - 128 : bytes.length;
  const eof = bytes.subarray(0, dataEnd).lastIndexOf(0x1a);
  const data = bytes.subarray(0, eof >= dataEnd - 2 ? eof : dataEnd);
  const field = (start: number, end: number) => hasSauce ? cp437(tail.subarray(start, end)).trim() : "";
  return {
    title: field(7, 42), author: field(42, 62), group: field(62, 82),
    width: hasSauce ? Math.max(1, Math.min(160, tail.readUInt16LE(96) || 80)) : 80,
    height: hasSauce ? Math.max(1, Math.min(400, tail.readUInt16LE(98) || 25)) : 25,
    data,
  };
}

function command(args: string[], maxBuffer = 1_000_000): Buffer {
  const result = spawnSync("unzip", args, { maxBuffer, timeout: 5_000 });
  if (result.status !== 0) throw new Error(result.stderr.toString().trim() || "Archive read failed");
  return result.stdout;
}

export function artEntries(path: string): string[] {
  const names = command(["-Z", "-1", path]).toString("utf8").split(/\r?\n/);
  if (names.length > MAX_ENTRIES) throw new Error("Archive contains too many entries for this spike");
  return names.filter(name => /\.(ans|asc)$/i.test(name) && !/[\x00-\x1f\x7f]/.test(name));
}

export async function readArt(path: string, name: string): Promise<ArtFrame> {
  const bytes = command(["-p", path, name], MAX_ENTRY_BYTES + 1);
  if (bytes.length > MAX_ENTRY_BYTES) throw new Error("Artwork is too large for this spike");
  const metadata = sauce(bytes);
  const terminal = new Terminal({ cols: metadata.width, rows: metadata.height, scrollback: 0, allowProposedApi: true });
  const decoded = cp437(metadata.data);
  await new Promise<void>(done => terminal.write(decoded, done));
  const cells: ArtCell[][] = [];
  for (let row = 0; row < metadata.height; row++) {
    const line = terminal.buffer.active.getLine(row);
    const result: ArtCell[] = [];
    for (let col = 0; col < metadata.width; col++) {
      const cell = line?.getCell(col);
      const inverse = cell?.isInverse() ?? false;
      const fg = cell?.isFgPalette() ? ANSI_TO_VGA[cell.getFgColor() & 15]! : 7;
      const bg = cell?.isBgPalette() ? ANSI_TO_VGA[cell.getBgColor() & 15]! : 0;
      result.push({
        char: cell?.getChars() || " ",
        fg: inverse ? bg : cell?.isBold() ? fg | 8 : fg,
        bg: inverse ? fg : bg,
      });
    }
    cells.push(result);
  }
  terminal.dispose();
  return { name, title: metadata.title || name.split("/").at(-1)!, author: metadata.author, group: metadata.group, width: metadata.width, height: metadata.height, cells };
}

function textRows(frame: ArtFrame, x: number, y: number, width: number, height: number): string[] {
  const rows: string[] = [];
  for (let row = y; row < Math.min(frame.height, y + height); row++) {
    let line = "";
    let last = "";
    for (const cell of frame.cells[row]!.slice(x, x + width)) {
      const style = `\x1b[38;2;${hex(VGA[cell.fg]!)};48;2;${hex(VGA[cell.bg]!)}m`;
      if (style !== last) { line += style; last = style; }
      line += cell.char;
    }
    rows.push(`${line}\x1b[0m`);
  }
  return rows;
}

function hex(color: string): string {
  return `${parseInt(color.slice(1, 3), 16)};${parseInt(color.slice(3, 5), 16)};${parseInt(color.slice(5, 7), 16)}`;
}

interface BitmapFont { glyphs: Map<number, number>; data: Buffer; charSize: number }
let fontCache: BitmapFont | null = null;
function font(): BitmapFont {
  if (fontCache) return fontCache;
  const data = gunzipSync(readFileSync(FONT_PATH));
  if (data[0] !== 0x36 || data[1] !== 0x04) throw new Error("Expected PSF1 VGA font");
  const charSize = data[3]!;
  const count = (data[2]! & 1) !== 0 ? 512 : 256;
  const glyphs = new Map<number, number>();
  let offset = 4 + count * charSize;
  for (let glyph = 0; glyph < count && offset + 1 < data.length; glyph++) {
    while (offset + 1 < data.length) {
      const codepoint = data.readUInt16LE(offset); offset += 2;
      if (codepoint === 0xffff) break;
      if (codepoint !== 0xfffe && !glyphs.has(codepoint)) glyphs.set(codepoint, glyph);
    }
  }
  fontCache = { glyphs, data, charSize };
  return fontCache;
}

function pixelOn(character: string, x: number, y: number, bitmap: BitmapFont): boolean {
  if (character === "█") return true;
  if (character === "▄") return y >= 8;
  if (character === "▀") return y < 8;
  if (character === "▌") return x < 4;
  if (character === "▐") return x >= 4;
  if (character === "░") return ((x + y * 3) & 3) === 0;
  if (character === "▒") return ((x + y) & 1) === 0;
  if (character === "▓") return ((x + y * 3) & 3) !== 0;
  const index = bitmap.glyphs.get(character.codePointAt(0) ?? 32) ?? bitmap.glyphs.get(32) ?? 32;
  const byte = bitmap.data[4 + index * bitmap.charSize + y] ?? 0;
  return (byte & (0x80 >> x)) !== 0;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(name: string, data: Buffer): Buffer {
  const kind = Buffer.from(name, "ascii");
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const check = Buffer.alloc(4); check.writeUInt32BE(crc32(Buffer.concat([kind, data])));
  return Buffer.concat([head, kind, data, check]);
}

export function png(frame: ArtFrame, x: number, y: number, cols: number, rows: number): Buffer {
  const bitmap = font();
  const pixelWidth = cols * 8;
  const pixelHeight = rows * 16;
  const pixels = Buffer.alloc((pixelWidth * 4 + 1) * pixelHeight);
  for (let py = 0; py < pixelHeight; py++) {
    const cellRow = frame.cells[y + Math.floor(py / 16)];
    const rowOffset = py * (pixelWidth * 4 + 1);
    for (let px = 0; px < pixelWidth; px++) {
      const cell = cellRow?.[x + Math.floor(px / 8)] ?? { char: " ", fg: 7, bg: 0 };
      const color = VGA[pixelOn(cell.char, px % 8, py % 16, bitmap) ? cell.fg : cell.bg]!;
      const offset = rowOffset + 1 + px * 4;
      pixels[offset] = parseInt(color.slice(1, 3), 16);
      pixels[offset + 1] = parseInt(color.slice(3, 5), 16);
      pixels[offset + 2] = parseInt(color.slice(5, 7), 16);
      pixels[offset + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(pixelWidth, 0); ihdr.writeUInt32BE(pixelHeight, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

export class AnsiPackPrototype {
  private resourceId: string | null = null;
  private revisionKey = "";
  private path = "";
  private entries: string[] = [];
  private index = 0;
  private frame: ArtFrame | null = null;
  private error = "";
  private x = 0;
  private y = 0;
  private readonly kittyEnabled = process.env.OUTLINER_KITTY_GRAPHICS === "1" ||
    (process.env.OUTLINER_KITTY_GRAPHICS !== "0" &&
      getCapabilities().images === "kitty");
  private mode: "kitty" | "cells" = this.kittyEnabled ? "kitty" : "cells";
  private imageId = 900_000_000 + Math.floor(Math.random() * 100_000_000);
  private placed = false;
  private generation = 0;
  private graphicCache: { frame: ArtFrame; x: number; y: number; cols: number; rows: number; png: Buffer } | null = null;

  constructor(private readonly invalidate: () => void) {}

  sync(description: ResourceDescription | null): boolean {
    const resource = description?.resource;
    if (resource?.provider !== "filesystem" || resource.address.kind !== "filesystem" || !/\.zip$/i.test(resource.address.path) || description?.source.provider !== "filesystem") {
      if (this.resourceId !== null) this.close();
      return false;
    }
    const revisionKey = JSON.stringify(description.filesystem?.revision ?? resource.updatedAt);
    if (resource.id === this.resourceId && revisionKey === this.revisionKey) return true;
    this.close();
    this.resourceId = resource.id;
    this.revisionKey = revisionKey;
    this.path = resolve(description.source.boundary.root, resource.address.path);
    try {
      this.entries = artEntries(this.path);
      this.index = Math.max(0, this.entries.findIndex(name => /SHY-EPO!\.ANS$/i.test(name)));
      void this.load();
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    return true;
  }

  private async load(): Promise<void> {
    this.dispose(); this.x = 0; this.y = 0;
    if (!this.entries.length) { this.error = "No ANSI/ASCII artwork in this pack"; return; }
    const generation = ++this.generation;
    this.frame = null; this.error = "Loading artwork…";
    try {
      const frame = await readArt(this.path, this.entries[this.index]!);
      if (generation !== this.generation) return;
      this.frame = frame; this.error = "";
    } catch (error) {
      if (generation !== this.generation) return;
      this.frame = null; this.error = error instanceof Error ? error.message : String(error);
    }
    this.invalidate();
  }

  next(delta: number): void {
    if (!this.entries.length) return;
    this.index = (this.index + delta + this.entries.length) % this.entries.length;
    void this.load();
  }
  toggle(): void { if (this.kittyEnabled) { this.dispose(); this.mode = this.mode === "kitty" ? "cells" : "kitty"; } }
  move(dx: number, dy: number): void {
    this.x = Math.max(0, this.x + dx); this.y = Math.max(0, this.y + dy);
    this.dispose();
  }
  get active(): boolean { return this.resourceId !== null; }

  render(width: number, height: number, pixels: {width: number; height: number}): { lines: string[]; graphic?: { png: Buffer; cols: number; rows: number; top: number; left: number } } {
    const frame = this.frame;
    const bodyTop = 5;
    const bodyRows = Math.max(1, height - bodyTop - 2);
    const cols = Math.max(1, Math.min(frame?.width ?? 80, width));
    const rows = Math.max(1, Math.min(frame?.height ?? 25, bodyRows));
    const useCells = this.mode === "cells" || width < 8 || height < 8;
    const x = Math.min(this.x, Math.max(0, (frame?.width ?? 80) - cols));
    const y = Math.min(this.y, Math.max(0, (frame?.height ?? 25) - rows));
    const lines = [
      `WOE pack · ${sanitizeDynamicText(this.path.split("/").at(-1) ?? "")}`,
      frame ? `${sanitizeDynamicText(frame.title)} · ${sanitizeDynamicText(frame.author || "unknown artist")} / ${sanitizeDynamicText(frame.group || "unknown group")} · ${frame.width}×${frame.height} · ${this.index + 1}/${this.entries.length}` : sanitizeDynamicText(this.error),
      sanitizeDynamicText(frame?.name ?? ""),
      `, previous  . next  ${this.kittyEnabled ? `v ${this.mode === "kitty" ? "terminal cells" : "Kitty graphics"}` : "Kitty unavailable"}  arrows pan/scroll  Ctrl+Q close`,
      "─".repeat(Math.max(1, width)),
    ];
    if (frame) {
      if (useCells) lines.push(...textRows(frame, x, y, cols, rows));
      else for (let n = 0; n < rows; n++) lines.push("");
    }
    while (lines.length < height - 2) lines.push("");
    lines.push(`Archive Resource · original bytes retained · ${this.mode === "kitty" ? "Kitty" : "cells"} · ${width}×${height} cells / ${pixels.width}×${pixels.height} px`);
    lines.push("Esc normal Detail navigation · Alt+←/→ history · ? actions");
    if (!frame || useCells) return { lines };
    try {
      if (!this.graphicCache || this.graphicCache.frame !== frame || this.graphicCache.x !== x || this.graphicCache.y !== y || this.graphicCache.cols !== cols || this.graphicCache.rows !== rows) {
        this.graphicCache = { frame, x, y, cols, rows, png: png(frame, x, y, cols, rows) };
      }
      return { lines, graphic: { png: this.graphicCache.png, cols, rows, top: bodyTop + 1, left: 1 } };
    }
    catch (error) {
      lines[1] = `Kitty raster unavailable: ${sanitizeDynamicText(error instanceof Error ? error.message : String(error))}`;
      lines.splice(bodyTop, rows, ...textRows(frame, x, y, cols, rows));
      return { lines };
    }
  }

  place(graphic: { png: Buffer; cols: number; rows: number; top: number; left: number }): void {
    this.dispose();
    const b64 = graphic.png.toString("base64");
    process.stdout.write(`\x1b[${graphic.top};${graphic.left}H`);
    for (let offset = 0; offset < b64.length; offset += 4096) {
      const part = b64.slice(offset, offset + 4096);
      const more = offset + 4096 < b64.length ? 1 : 0;
      const options = offset === 0 ? `a=T,f=100,t=d,i=${this.imageId},c=${graphic.cols},r=${graphic.rows},C=1,q=2,m=${more}` : `m=${more}`;
      process.stdout.write(`\x1b_G${options};${part}\x1b\\`);
    }
    this.placed = true;
  }

  dispose(): void {
    if (this.placed) process.stdout.write(`\x1b_Ga=d,d=I,i=${this.imageId},q=2\x1b\\`);
    this.placed = false;
  }

  close(): void { this.dispose(); this.generation++; this.frame = null; this.graphicCache = null; this.resourceId = null; this.revisionKey = ""; }
}
