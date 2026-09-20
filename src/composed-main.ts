export {};

// Explicit experiment; the existing separate-pane launch remains available.
process.env.OUTLINER_COMPOSED_SURFACE = "1";
await import("./detail-pi");
