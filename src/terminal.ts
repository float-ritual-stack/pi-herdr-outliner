export interface TerminalKey {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  sequence?: string;
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

  consume(str: string, key: TerminalKey): TerminalInputAction {
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
