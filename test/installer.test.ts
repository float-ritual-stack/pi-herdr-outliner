import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
