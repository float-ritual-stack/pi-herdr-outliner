import {
  decodeKittyPrintable,
  isKeyRelease,
  Key,
  matchesKey,
  parseKey,
  type KeyId,
  type TuiInputListener,
} from "@earendil-works/pi-tui";
import type { TerminalInputAction, TerminalKey } from "./terminal";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export function createPiDetailInputListener(
  onInput: (data: string) => void,
  shouldPassThrough?: () => boolean,
): TuiInputListener {
  return (data) => {
    if (shouldPassThrough?.()) return undefined;
    if (!isKeyRelease(data)) onInput(data);
    return { consume: true };
  };
}

export type PiDetailInput =
  | { kind: "paste"; text: string }
  | {
      kind: "key";
      str: string;
      key: TerminalKey;
      inputAction: TerminalInputAction;
    };

interface PiKeyMapping {
  id: KeyId;
  key: Readonly<TerminalKey>;
  inputAction?: TerminalInputAction;
}

const KEY_MAPPINGS: readonly PiKeyMapping[] = [
  {
    id: Key.shift("enter"),
    key: { name: "return", shift: true },
    inputAction: "modified-enter",
  },
  { id: Key.ctrl("q"), key: { name: "q", ctrl: true } },
  { id: Key.ctrl("c"), key: { name: "c", ctrl: true } },
  { id: Key.ctrl("s"), key: { name: "s", ctrl: true } },
  { id: Key.ctrl("space"), key: { name: "space", ctrl: true } },
  { id: Key.ctrl("a"), key: { name: "a", ctrl: true } },
  { id: Key.ctrl("e"), key: { name: "e", ctrl: true } },
  { id: Key.super("a"), key: { name: "a", meta: true } },
  { id: Key.ctrlShift("a"), key: { name: "a", ctrl: true, shift: true } },
  { id: Key.alt("b"), key: { name: "b", meta: true } },
  { id: Key.alt("f"), key: { name: "f", meta: true } },
  { id: Key.alt("left"), key: { name: "left", meta: true } },
  { id: Key.alt("right"), key: { name: "right", meta: true } },
  { id: Key.ctrl("left"), key: { name: "left", ctrl: true } },
  { id: Key.ctrl("right"), key: { name: "right", ctrl: true } },
  { id: Key.shift("left"), key: { name: "left", shift: true } },
  { id: Key.shift("right"), key: { name: "right", shift: true } },
  { id: Key.shift("up"), key: { name: "up", shift: true } },
  { id: Key.shift("down"), key: { name: "down", shift: true } },
  { id: Key.shift("home"), key: { name: "home", shift: true } },
  { id: Key.shift("end"), key: { name: "end", shift: true } },
  { id: Key.ctrlShift("left"), key: { name: "left", ctrl: true, shift: true } },
  { id: Key.ctrlShift("right"), key: { name: "right", ctrl: true, shift: true } },
  { id: Key.altShift("b"), key: { name: "b", meta: true, shift: true } },
  { id: Key.altShift("f"), key: { name: "f", meta: true, shift: true } },
  { id: Key.altShift("left"), key: { name: "left", meta: true, shift: true } },
  { id: Key.altShift("right"), key: { name: "right", meta: true, shift: true } },
  { id: Key.enter, key: { name: "return" } },
  { id: Key.tab, key: { name: "tab" } },
  { id: Key.escape, key: { name: "escape" } },
  { id: Key.backspace, key: { name: "backspace" } },
  { id: Key.delete, key: { name: "delete" } },
  { id: Key.left, key: { name: "left" } },
  { id: Key.right, key: { name: "right" } },
  { id: Key.up, key: { name: "up" } },
  { id: Key.down, key: { name: "down" } },
  { id: Key.home, key: { name: "home" } },
  { id: Key.end, key: { name: "end" } },
  { id: Key.pageUp, key: { name: "pageup" } },
  { id: Key.pageDown, key: { name: "pagedown" } },
];

function keyInput(
  key: TerminalKey,
  str = "",
  inputAction: TerminalInputAction = "pass",
): PiDetailInput {
  return { kind: "key", str, key, inputAction };
}

function rawPrintable(data: string): string | undefined {
  if (data.length === 0 || data.includes("\x1b")) return undefined;
  if ([...data].some((character) => character < " " || character === "\x7f")) {
    return undefined;
  }
  return data;
}

function decodeModifyOtherKeysPrintable(data: string): string | undefined {
  const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
  if (!match) return undefined;
  const modifier = Number.parseInt(match[1], 10) - 1;
  const codepoint = Number.parseInt(match[2], 10);
  if (
    (modifier !== 0 && modifier !== 1) ||
    codepoint < 32 ||
    codepoint > 0x10ffff
  ) {
    return undefined;
  }
  return String.fromCodePoint(codepoint);
}

export function decodePiDetailInput(data: string): PiDetailInput {
  if (data.startsWith(BRACKETED_PASTE_START) && data.endsWith(BRACKETED_PASTE_END)) {
    return {
      kind: "paste",
      text: data.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length),
    };
  }

  for (const mapping of KEY_MAPPINGS) {
    if (matchesKey(data, mapping.id)) {
      return keyInput(
        { ...mapping.key, sequence: data },
        "",
        mapping.inputAction,
      );
    }
  }

  const printable =
    decodeKittyPrintable(data) ?? decodeModifyOtherKeysPrintable(data) ?? rawPrintable(data);
  if (printable !== undefined) {
    return keyInput(
      {
        name: [...printable].length === 1 ? printable : undefined,
        sequence: printable,
      },
      printable,
    );
  }

  const parsed = parseKey(data);
  const parts = parsed?.split("+") ?? [];
  const name = parts.at(-1);
  return keyInput({
    name,
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    meta: parts.includes("alt") || parts.includes("super"),
    sequence: data,
  });
}
