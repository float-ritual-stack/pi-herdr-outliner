import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeClientConfig } from "../src/paths";

for (const source of [undefined, "", 'model = "example"\n']) {
  test(`mentions installer handles ${source === undefined ? "missing" : source === "" ? "empty" : "existing"} config`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mentions-installer-"));
    const home = join(directory, "codex");
    const config = join(home, "config.toml");
    try {
      if (source !== undefined) {
        await mkdir(home);
        await writeFile(config, source);
      }
      const run = async () => {
        const child = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/install-codex-mentions.ts"), directory], {
          env: { ...process.env, CODEX_HOME: home }, stdout: "pipe", stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      };
      const result = await run();
      expect(result.exitCode).toBe(0);
      const installed = await readFile(config, "utf8");
      expect((Bun.TOML.parse(installed) as { notify: string[] }).notify).toEqual([
        process.execPath, join(import.meta.dir, "../src/mentions-codex.ts"), "--workspace", directory,
      ]);
      expect(installed.endsWith(source ?? "")).toBe(true);
      const backups = (await readdir(home)).filter(name => name.startsWith("config.toml.before-mentions-"));
      expect(backups).toHaveLength(source === undefined ? 0 : 1);
      if (source !== undefined) expect(await readFile(join(home, backups[0]!), "utf8")).toBe(source);
      else expect(result.stdout).not.toContain("Backup:");
      expect((await run()).exitCode).toBe(0);
      expect(await readFile(config, "utf8")).toBe(installed);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("installer migrates the old comment default for capture and preserves custom bindings on rerun", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outliner-installer-"));
  const config = join(directory, "config.toml");
  const shellSetup = join(directory, "herdr-stub.sh");
  // Exercise the real installer/config rewrite without installing a plugin or
  // contacting the user's Herdr server. Bash functions precede its PATH lookup.
  await writeFile(shellSetup, `herdr() {
    case "$*" in
      --version) printf 'herdr 0.9.1\\n' ;;
      'plugin list '*) printf '{}\\n' ;;
      'plugin install '*|'plugin action list '*) return 0 ;;
      'status server') return 1 ;;
      *) printf 'Unexpected Herdr call: %s\\n' "$*" >&2; return 99 ;;
    esac
  }
`);
  const original = `onboarding = false
[[keys.command]]
key = "prefix+shift+c"
type = "plugin_action"
command = "float.pi-outliner.comment-selection"
[[keys.command]]
key = "prefix+alt+k"
command = "some-other-action"
[[keys.command]]
key = "prefix+alt+o"
type = "plugin_action"
command = "float.pi-outliner.open-composed"
[[keys.command]]
key = "prefix+alt+x"
type = "plugin_action"
command = "float.pi-outliner.obsolete"
`;
  await writeFile(config, original);
  const run = async (...args: string[]) => {
    const child = Bun.spawn(["bash", join(import.meta.dir, "../install.sh"), "--yes", "--plain", "--config", config, ...args], {
      env: { ...process.env, BASH_ENV: shellSetup }, stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };
  try {
    expect((await run()).exitCode).toBe(0);
    const first = await readFile(config, "utf8");
    const keys = (Bun.TOML.parse(first) as { keys: { command: Array<{ key: string; command: string }> } }).keys.command;
    expect(keys.filter(k => k.command === "float.pi-outliner.capture")).toEqual([
      expect.objectContaining({ key: "prefix+shift+c" }),
    ]);
    expect(keys.find(k => k.command === "float.pi-outliner.comment-selection")?.key).toBe("prefix+shift+a");
    expect(keys.find(k => k.command === "some-other-action")?.key).toBe("prefix+alt+k");
    expect(keys.find(k => k.command === "float.pi-outliner.open-composed")?.key).toBe("prefix+alt+o");
    expect(keys.some(k => k.command === "float.pi-outliner.obsolete")).toBe(false);
    expect((await run()).exitCode).toBe(0);
    expect(await readFile(config, "utf8")).toBe(first);

    expect(keys.find(k => k.command === "float.pi-outliner.open-tree")?.key).toBe("prefix+shift+u");
    for (const args of [["--tree-key"], ["--tree-key", "--no-config"], ["--tree-key", "-y"]]) {
      const missingChord = await run(...args);
      expect(missingChord.exitCode).not.toBe(0);
      expect(missingChord.stderr).toContain("--tree-key requires a chord");
      expect(await readFile(config, "utf8")).toBe(first);
    }
    expect((await run("--tree-key", "prefix+u")).exitCode).not.toBe(0);
    expect((await run("--tree-key", "prefix+alt+k")).exitCode).not.toBe(0);
    expect(await readFile(config, "utf8")).toBe(first);
    const conflict = await run("--capture-key", "prefix+shift+a");
    expect(conflict.exitCode).not.toBe(0);
    expect(conflict.stderr).toContain("keys must be different");
    expect(await readFile(config, "utf8")).toBe(first);
    const occupied = await run("--capture-key", "prefix+alt+k");
    expect(occupied.exitCode).not.toBe(0);
    expect(occupied.stderr).toContain("already used");
    expect(await readFile(config, "utf8")).toBe(first);
    const composedConflict = await run("--capture-key", "prefix+alt+o");
    expect(composedConflict.exitCode).not.toBe(0);
    expect(composedConflict.stderr).toContain("already used by float.pi-outliner.open-composed");
    expect(await readFile(config, "utf8")).toBe(first);

    expect((await run("--capture-key", "prefix+shift+c", "--comment-key", "prefix+shift+y", "--tree-key", "prefix+alt+j")).exitCode).toBe(0);
    const configured = await readFile(config, "utf8");
    expect((await run()).exitCode).toBe(0);
    expect(await readFile(config, "utf8")).toBe(configured);
    expect((await run("--no-config", "--capture-key", "prefix+shift+i")).exitCode).toBe(0);
    expect(await readFile(config, "utf8")).toBe(configured);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function runClaudeModInstaller(configDir: string, ...args: string[]) {
  // A scratch state and config root: the installer asks which listed folders are bound to an outline.
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/install-claude-mod.ts"), ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, OUTLINER_STATE_DIR: join(configDir, "outliner-state"), XDG_CONFIG_HOME: join(configDir, "xdg") },
    stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("Claude mod installer replaces other copies of the mod and keeps unrelated settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-mod-installer-"));
  const settingsPath = join(directory, "settings.json");
  const worktreeCopy = join(directory, "old-worktree/claude-mod");
  const unrelated = join(directory, "other-plugin");
  const modDir = join(import.meta.dir, "../claude-mod");
  try {
    await mkdir(join(worktreeCopy, ".claude-plugin"), { recursive: true });
    await writeFile(join(worktreeCopy, ".claude-plugin/plugin.json"), '{"name":"pi-outliner"}');
    await mkdir(join(unrelated, ".claude-plugin"), { recursive: true });
    await writeFile(join(unrelated, ".claude-plugin/plugin.json"), '{"name":"other"}');
    const original = { theme: "dark", env: { KEEP: "1", CLAUDE_CODE_PLUGIN_DIRS: `${unrelated}:${worktreeCopy}` } };
    await writeFile(settingsPath, JSON.stringify(original));

    // No folder needed: each session follows the outline its folder is bound to.
    const first = await runClaudeModInstaller(directory);
    expect(first.exitCode).toBe(0);
    const installed = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(installed.theme).toBe("dark");
    expect(installed.env).toEqual({
      KEEP: "1",
      CLAUDE_CODE_PLUGIN_DIRS: `${unrelated}:${modDir}`,
      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1",
    });
    const backups = (await readdir(directory)).filter(name => name.startsWith("settings.json.before-claude-mod-"));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(await readFile(join(directory, backups[0]!), "utf8"))).toEqual(original);

    const text = await readFile(settingsPath, "utf8");
    const again = await runClaudeModInstaller(directory);
    expect(again.stdout).toContain("already installed");
    expect(await readFile(settingsPath, "utf8")).toBe(text);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude mod installer opts folders out, keeps strict mode on request, and refuses relative folders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-mod-installer-"));
  const configDir = join(directory, "claude");
  const envOf = async () => JSON.parse(await readFile(join(configDir, "settings.json"), "utf8")).env;
  try {
    const relative = await runClaudeModInstaller(configDir, "--exclude", "work");
    expect(relative.exitCode).not.toBe(0);
    expect(relative.stderr).toContain("must be absolute");

    expect((await runClaudeModInstaller(configDir, "--exclude", "/scratch/private", "--exclude", "/scratch/other/")).exitCode).toBe(0);
    let env = await envOf();
    expect(env.PI_OUTLINER_MENTIONS_MODE).toBe("folder");
    expect(env.PI_OUTLINER_MENTIONS_WORKSPACES).toBe("/scratch/private:/scratch/other");
    expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBe(join(import.meta.dir, "../claude-mod"));
    // A later run without folders keeps the opt-outs.
    expect((await runClaudeModInstaller(configDir)).stdout).toContain("already installed");

    // Strict mode: folders given bare (the old form) or with --allowlist; the opt-outs never become allowed folders.
    const strict = await runClaudeModInstaller(configDir, "/w");
    expect(strict.exitCode).toBe(0);
    expect(strict.stdout).toContain("Dropped the listed folders");
    env = await envOf();
    expect([env.PI_OUTLINER_MENTIONS_MODE, env.PI_OUTLINER_MENTIONS_WORKSPACES]).toEqual(["allowlist", "/w"]);
    expect((await runClaudeModInstaller(configDir, "--allowlist", "/v")).exitCode).toBe(0);
    expect((await envOf()).PI_OUTLINER_MENTIONS_WORKSPACES).toBe("/w:/v");
    // A run without folders keeps an explicit strict mode; opting out needs --folder first.
    expect((await runClaudeModInstaller(configDir)).stdout).toContain("Strict mode kept");
    expect((await runClaudeModInstaller(configDir, "--exclude", "/x")).exitCode).not.toBe(0);
    expect((await runClaudeModInstaller(configDir, "--folder")).exitCode).toBe(0);
    env = await envOf();
    expect([env.PI_OUTLINER_MENTIONS_MODE, env.PI_OUTLINER_MENTIONS_WORKSPACES]).toEqual([undefined, undefined]);
    expect((await runClaudeModInstaller(configDir, "--exclude", "/x", "/y")).exitCode).not.toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude mod installer leaves a list from before folder mode opted out until --folder drops it, naming folders bound to no outline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-mod-installer-"));
  const settingsPath = join(directory, "settings.json");
  const bound = join(directory, "garden");
  try {
    await mkdir(bound, { recursive: true });
    writeClientConfig({ XDG_CONFIG_HOME: join(directory, "xdg"), OUTLINER_STATE_DIR: join(directory, "outliner-state") }, { mode: "host", workspaceRoot: bound, outline: "fred-notes" });
    await writeFile(settingsPath, JSON.stringify({ env: { PI_OUTLINER_MENTIONS_WORKSPACES: `${bound}:/scratch/unbound` } }));
    const kept = await runClaudeModInstaller(directory);
    expect(kept.exitCode).toBe(0);
    expect(kept.stdout).toContain("with no mode: those folders are opted out");
    expect(kept.stdout).toContain("--folder");
    let env = JSON.parse(await readFile(settingsPath, "utf8")).env;
    expect(env.PI_OUTLINER_MENTIONS_WORKSPACES).toBe(`${bound}:/scratch/unbound`);
    expect(env.PI_OUTLINER_MENTIONS_MODE).toBeUndefined();

    const moved = await runClaudeModInstaller(directory, "--folder");
    expect(moved.exitCode).toBe(0);
    expect(moved.stdout).toContain("Dropped the allowlist");
    expect(moved.stdout).toContain("feed nothing: /scratch/unbound.");
    expect(moved.stdout).not.toContain(`nothing: ${bound}`);
    env = JSON.parse(await readFile(settingsPath, "utf8")).env;
    expect(env.PI_OUTLINER_MENTIONS_WORKSPACES).toBeUndefined();
    expect(env.PI_OUTLINER_MENTIONS_MODE).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("install.sh installs the Claude mod from the managed plugin root only when asked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outliner-installer-claude-"));
  const shellSetup = join(directory, "herdr-stub.sh");
  const root = join(import.meta.dir, "..");
  await writeFile(shellSetup, `herdr() {
    case "$*" in
      --version) printf 'herdr 0.9.1\\n' ;;
      'plugin list '*) printf '{"result":{"plugins":[{"plugin_id":"float.pi-outliner","plugin_root":"${root}","version":"0.1.1"}]}}\\n' ;;
      'plugin install '*|'plugin action list '*) return 0 ;;
      *) printf 'Unexpected Herdr call: %s\\n' "$*" >&2; return 99 ;;
    esac
  }
`);
  const run = async (...args: string[]) => {
    const child = Bun.spawn(["bash", join(import.meta.dir, "../install.sh"), "--yes", "--plain", "--no-config", ...args], {
      env: { ...process.env, BASH_ENV: shellSetup, CLAUDE_CONFIG_DIR: directory }, stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };
  const settingsPath = join(directory, "settings.json");
  try {
    expect((await run()).exitCode).toBe(0);
    expect(await Bun.file(settingsPath).exists()).toBe(false);

    // The mod step needs no folder: each session follows its folder's binding.
    const loaded = await run("--claude-mod");
    expect(loaded.exitCode).toBe(0);
    let env = JSON.parse(await readFile(settingsPath, "utf8")).env;
    expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBe(join(root, "claude-mod"));
    expect(env.PI_OUTLINER_MENTIONS_WORKSPACES).toBeUndefined();

    expect((await run("--claude-workspace", "relative")).exitCode).not.toBe(0);
    expect((await run("--claude-exclude", "relative")).exitCode).not.toBe(0);
    expect((await run("--claude-workspace", "/work/one", "--claude-exclude", "/work/two")).exitCode).not.toBe(0);

    expect((await run("--claude-exclude", "/work/private notes")).exitCode).toBe(0);
    env = JSON.parse(await readFile(settingsPath, "utf8")).env;
    expect([env.PI_OUTLINER_MENTIONS_MODE, env.PI_OUTLINER_MENTIONS_WORKSPACES]).toEqual(["folder", "/work/private notes"]);

    // --claude-workspace is strict mode: only those folders feed.
    const installed = await run("--claude-workspace", "/work/one", "--claude-workspace", "/work/two words");
    expect(installed.exitCode).toBe(0);
    env = JSON.parse(await readFile(settingsPath, "utf8")).env;
    expect([env.PI_OUTLINER_MENTIONS_MODE, env.PI_OUTLINER_MENTIONS_WORKSPACES]).toEqual(["allowlist", "/work/one:/work/two words"]);

    const text = await readFile(settingsPath, "utf8");
    expect((await run("--claude-workspace", "/work/three", "--no-claude-mod")).exitCode).toBe(0);
    expect(await readFile(settingsPath, "utf8")).toBe(text);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
