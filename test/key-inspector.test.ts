import {expect, test} from "bun:test";
import {visibleWidth} from "@earendil-works/pi-tui";
import {KeyInspector} from "../src/key-inspector";

test("key inspection distinguishes an Alt prefix from literal Option-produced text", () => {
  const inspector = new KeyInspector();
  expect(inspector.handle("x")).toBe(false);
  inspector.open();
  expect(inspector.handle("\x1bl")).toBe(true);
  const alt = inspector.render(300, 30).join("\n");
  expect(alt).toContain("1b 6c");
  expect(alt).toContain("Alt+L");
  expect(alt).toContain("tree.navigation.link");
  inspector.open();
  inspector.handle("¬");
  const literal = inspector.render(300, 30).join("\n");
  expect(literal).toContain("c2 ac");
  expect(literal).toContain("U+00AC");
  expect(literal).not.toContain("Alt+L");
  expect(literal).not.toContain("tree.navigation.link");
  inspector.dispose();
});

test("inspector records modified arrows and Escape but Ctrl+Q only closes the inspector", () => {
  const inspector = new KeyInspector();
  inspector.open();
  inspector.handle("\x1b[1;4C");
  expect(inspector.render(300, 30).join("\n")).toContain("Alt+Shift+ArrowRight");
  inspector.handle("\x1b");
  expect(inspector.active).toBe(true);
  expect(inspector.render(300, 30).join("\n")).toContain("U+001B");
  expect(inspector.handle("\x11")).toBe(true);
  expect(inspector.active).toBe(false);
  expect(inspector.handle("x")).toBe(false);
  inspector.dispose();
});

test("inspection bounds retained raw chunks and escapes terminal commands", () => {
  const inspector = new KeyInspector();
  inspector.open();
  for (let i = 0; i < 10; i++) inspector.handle(Buffer.from(`record-${i}`));
  let text = inspector.render(300, 150).join("\n");
  expect(text).not.toContain("record-0");
  expect(text).not.toContain("record-1");
  expect(text).toContain("record-2");
  inspector.handle("\x1b]52;c;danger\x07" + "x".repeat(1000));
  text = inspector.render(1000, 100).join("\n");
  expect(text).toContain("512 bytes");
  expect(text).not.toContain("\x1b");
  expect(text).not.toContain("\x07");
  const narrow = inspector.render(27, 12);
  expect(narrow).toHaveLength(12);
  expect(narrow.every(line => visibleWidth(line) <= 27)).toBe(true);
  inspector.dispose();
});

test("the bounded persistent readline probe reports decoded keys and releases its stream", () => {
  const inspector = new KeyInspector();
  inspector.open();
  inspector.handle("\x1b[");
  inspector.handle("1;4C");
  const text = inspector.render(300, 40).join("\n");
  expect(text).toContain("Readline:");
  expect(text).toContain("Alt+Shift+ArrowRight");
  inspector.dispose();
  expect(inspector.active).toBe(false);
  inspector.open();
  expect(inspector.render(300, 20).join("\n")).not.toContain("1;4C");
  inspector.dispose();
});

test("a decoder or chord error remains inspectable instead of escaping into the app", () => {
  const inspector = new KeyInspector();
  inspector.open();
  expect(inspector.handle("+")).toBe(true);
  const text = inspector.render(200, 30).join("\n");
  expect(text).toContain('Text: "+"');
  expect(text).toContain("Hex: 2b");
  expect(text).toContain("parser error:");
  expect(inspector.active).toBe(true);
  inspector.dispose();
});
