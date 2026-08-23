export {};

// Runtime selection avoids starting both side-effectful terminal executables.
const renderer = process.env.OUTLINER_DETAIL_RENDERER ?? "pi-tui";

if (renderer === "pi-tui") {
  await import("./detail-pi");
} else if (renderer === "ansi") {
  await import("./detail");
} else {
  throw new Error(`Unsupported Detail renderer: ${renderer}`);
}
