import { describe, expect, test } from "bun:test";
import { parseStandaloneDispatchMarker } from "../src/dispatch-marker";

describe("standalone float.dispatch markers", () => {
  test("extracts exact multiline and nested payloads", () => {
    expect(parseStandaloneDispatchMarker(`
      float.dispatch({
        thought: "call foo(bar)",
        nested: (one(two))
      })
    `)).toEqual({
      kind: "match",
      payload: `{
        thought: "call foo(bar)",
        nested: (one(two))
      }`,
    });
  });

  test("preserves Unicode, quotes, and escaped delimiters", () => {
    expect(parseStandaloneDispatchMarker(
      String.raw`float.dispatch({text: "queer techno 🐢 \") still text"})`,
    )).toEqual({
      kind: "match",
      payload: String.raw`{text: "queer techno 🐢 \") still text"}`,
    });
  });

  test("does not intercept conversational or trailing text", () => {
    for (const text of [
      "I mentioned float.dispatch({later}) today",
      "float.dispatch({first}) and more",
      "prefix float.dispatch({embedded})",
      "ordinary input",
    ]) {
      expect(parseStandaloneDispatchMarker(text)).toEqual({ kind: "none" });
    }
  });

  test("returns diagnostics for exact malformed markers", () => {
    expect(parseStandaloneDispatchMarker("float.dispatch()")).toEqual({
      kind: "invalid",
      error: "Dispatch payload cannot be empty",
    });
    expect(parseStandaloneDispatchMarker("float.dispatch({oops}")).toEqual({
      kind: "invalid",
      error: "Unterminated dispatch marker",
    });
    expect(parseStandaloneDispatchMarker('float.dispatch({"oops})')).toEqual({
      kind: "invalid",
      error: "Unterminated quote in dispatch marker",
    });
    expect(parseStandaloneDispatchMarker("float.dispatch {oops}")).toEqual({
      kind: "invalid",
      error: "Expected float.dispatch(… )",
    });
  });
});
