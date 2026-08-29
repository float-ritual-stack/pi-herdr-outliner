export type DispatchMarkerResult =
  | { kind: "none" }
  | { kind: "invalid"; error: string }
  | { kind: "match"; payload: string };

const PREFIX = "float.dispatch(";

export function parseStandaloneDispatchMarker(input: string): DispatchMarkerResult {
  const text = input.trim();
  if (!text.startsWith("float.dispatch")) return { kind: "none" };
  if (!text.startsWith(PREFIX)) {
    return { kind: "invalid", error: `Expected ${PREFIX}… )` };
  }

  let depth = 1;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  for (let index = PREFIX.length; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character !== ")") continue;
    depth -= 1;
    if (depth !== 0) continue;
    if (text.slice(index + 1).trim()) {
      return { kind: "none" };
    }
    const payload = text.slice(PREFIX.length, index).trim();
    return payload
      ? { kind: "match", payload }
      : { kind: "invalid", error: "Dispatch payload cannot be empty" };
  }

  if (quote) return { kind: "invalid", error: "Unterminated quote in dispatch marker" };
  return { kind: "invalid", error: "Unterminated dispatch marker" };
}
