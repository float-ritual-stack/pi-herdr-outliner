export interface TerminalKey {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  sequence?: string;
}

export const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";
export const BRACKETED_PASTE_DISABLE = "\x1b[?2004l";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function consumeCsi(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b || (code >= 0x80 && code <= 0x9f)) return index;
    if (code >= 0x40 && code <= 0x7e) return index + 1;
  }
  return value.length;
}

function consumeStringControl(
  value: string,
  start: number,
  acceptsBellTerminator: boolean,
): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x9c || (acceptsBellTerminator && code === 0x07)) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return value.length;
}

function consumeEscapeSequence(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code >= 0x20 && code <= 0x2f) {
      index += 1;
      continue;
    }
    return code >= 0x30 && code <= 0x7e ? index + 1 : index;
  }
  return index;
}

export function sanitizeDynamicText(value: string, preserveLineBreaks = false): string {
  let sanitized = "";
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index);

    if (code === 0x1b) {
      const introducer = value.charCodeAt(index + 1);
      if (introducer === 0x5b) {
        index = consumeCsi(value, index + 2);
      } else if (
        introducer === 0x5d ||
        introducer === 0x50 ||
        introducer === 0x58 ||
        introducer === 0x5e ||
        introducer === 0x5f
      ) {
        index = consumeStringControl(value, index + 2, introducer === 0x5d);
      } else {
        index = consumeEscapeSequence(value, index + 1);
      }
      continue;
    }

    if (code === 0x9b) {
      index = consumeCsi(value, index + 1);
      continue;
    }
    if (
      code === 0x90 ||
      code === 0x98 ||
      code === 0x9d ||
      code === 0x9e ||
      code === 0x9f
    ) {
      index = consumeStringControl(value, index + 1, code === 0x9d);
      continue;
    }
    if (code === 0x09) {
      sanitized += "    ";
    } else if (code === 0x0a && preserveLineBreaks) {
      sanitized += "\n";
    } else if (code > 0x1f && (code < 0x7f || code > 0x9f)) {
      sanitized += value[index];
    }
    index += 1;
  }
  return sanitized;
}

const MODIFIED_ENTER_SEQUENCES: Record<string, true> = {
  "13~": true,
  "[13;2u": true,
  "\x1b[13;2u": true,
  "\x1b[13;2~": true,
};

export function isModifiedEnter(str: string, key: TerminalKey): boolean {
  if (key.name === "return" && key.shift) return true;
  return Boolean(MODIFIED_ENTER_SEQUENCES[key.sequence ?? ""] || MODIFIED_ENTER_SEQUENCES[str]);
}

export function isDetailToggle(str: string, key: TerminalKey): boolean {
  return key.name === "." || str === ".";
}

export type TerminalInputAction = "pass" | "suppress" | "modified-enter";

export class TerminalInputDecoder {
  #modifiedEnterSuffix: string | null = null;
  #paste: string | null = null;

  constructor(private readonly onPaste?: (text: string) => void) {}

  consume(str: string, key: TerminalKey): TerminalInputAction {
    const sequence = key.sequence ?? str;
    const isPasteStart =
      key.name === "paste-start" || sequence === BRACKETED_PASTE_START;
    const isPasteEnd =
      key.name === "paste-end" || sequence === BRACKETED_PASTE_END;

    if (isPasteStart) {
      this.#paste = "";
      return "suppress";
    }
    if (this.#paste !== null) {
      if (isPasteEnd) {
        const text = this.#paste;
        this.#paste = null;
        this.onPaste?.(text);
      } else {
        this.#paste += sequence;
      }
      return "suppress";
    }
    if (isPasteEnd) return "suppress";

    if (key.sequence === "\x1b[27;2;") {
      this.#modifiedEnterSuffix = "";
      return "suppress";
    }
    if (this.#modifiedEnterSuffix === null) {
      return isModifiedEnter(str, key) ? "modified-enter" : "pass";
    }

    this.#modifiedEnterSuffix += str;
    if (this.#modifiedEnterSuffix === "13~") {
      this.#modifiedEnterSuffix = null;
      return "modified-enter";
    }
    if (!"13~".startsWith(this.#modifiedEnterSuffix)) {
      this.#modifiedEnterSuffix = null;
    }
    return "suppress";
  }
}

export function isPrintableInput(str: string, key: TerminalKey): boolean {
  if (!str || key.ctrl || key.meta || isModifiedEnter(str, key) || key.sequence?.includes("\x1b")) {
    return false;
  }
  return [...str].every((character) => character >= " " && character !== "\x7f");
}

export function truncate(value: string, width: number): string {
  if (width <= 1) return "";
  return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
}

export function renderMarkdownLine(line: string): string {
  if (/^#{1,6}\s/.test(line)) return `\x1b[1;36m${line}\x1b[0m`;
  if (/^\s*[-*+]\s/.test(line)) return line.replace(/^([ \t]*)([-*+])/, "$1\x1b[33m$2\x1b[0m");
  return line.replace(/`([^`]+)`/g, "\x1b[32m`$1`\x1b[0m");
}
