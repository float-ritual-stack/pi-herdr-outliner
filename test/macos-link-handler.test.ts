import { expect, test } from "bun:test";
import { join } from "node:path";

const directory = join(import.meta.dir, "..", "macos", "pi-outliner-link");

async function run(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const processHandle = Bun.spawn(args, {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("macOS link-handler installer scripts are valid Bash with actionable help", async () => {
  for (const script of ["install.sh", "uninstall.sh"]) {
    const syntax = await run("bash", "-n", script);
    expect(syntax.exitCode, syntax.stderr).toBe(0);
  }

  const installHelp = await run("bash", "install.sh", "--help");
  expect(installHelp.exitCode, installHelp.stderr).toBe(0);
  expect(installHelp.stdout).toContain("--host HOST");
  expect(installHelp.stdout).toContain("--config PATH");
  expect(installHelp.stdout).toContain("--force-config");
  expect(installHelp.stdout).toContain("Shift-Command-click");
  expect(installHelp.stdout).toContain("pi-outliner://goto/PIE-130");

  const uninstallHelp = await run("bash", "uninstall.sh", "--help");
  expect(uninstallHelp.exitCode, uninstallHelp.stderr).toBe(0);
  expect(uninstallHelp.stdout).toContain("--purge-config");

  const unsafeUninstall = await run("bash", "uninstall.sh", "--app-dir", "/tmp/not-an-app");
  expect(unsafeUninstall.exitCode).toBe(2);
  expect(unsafeUninstall.stderr).toContain("must end in .app");
});
