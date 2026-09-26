import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Herdr graphics setting makes the ANSI Resource offer Kitty in a generic terminal", () => {
  const configHome = mkdtempSync(join(tmpdir(), "ansi-pack-herdr-capability-"));
  const configPath = join(configHome, "herdr", "config.toml");
  const run = (enabled: boolean, inheritedOuterHint = false) => {
    writeFileSync(configPath, `[experimental]\nkitty_graphics = ${enabled}\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, HERDR_ENV: "1", TERM: "xterm-256color", XDG_CONFIG_HOME: configHome };
    if (inheritedOuterHint) env.TERM_PROGRAM = "ghostty";
    else delete env.TERM_PROGRAM;
    delete env.TMUX;
    delete env.KITTY_WINDOW_ID;
    delete env.GHOSTTY_RESOURCES_DIR;
    delete env.OUTLINER_KITTY_GRAPHICS;
    const result = spawnSync(process.execPath, ["-e", `import { AnsiPackPrototype } from "./src/ansi-pack-prototype.ts"; console.log(new AnsiPackPrototype(() => {}).render(80, 24, { width: 720, height: 432 }).lines[3]);`], {
      cwd: join(import.meta.dir, ".."), env, encoding: "utf8",
    });
    expect(result.status).toBe(0);
    return result.stdout;
  };
  try {
    mkdirSync(join(configHome, "herdr"));
    expect(run(true)).toContain("v terminal cells");
    expect(run(false, true)).toContain("Kitty unavailable");
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});
