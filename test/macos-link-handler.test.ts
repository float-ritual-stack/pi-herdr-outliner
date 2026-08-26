import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = join(import.meta.dir, "..", "macos", "pi-outliner-link");

async function runWithEnv(
  args: string[],
  env?: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const processHandle = Bun.spawn(args, {
    cwd: directory,
    env: env ? { ...process.env, ...env } : process.env,
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

function run(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runWithEnv(args);
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

test("macOS bridge scripts refuse to replace or remove an unrelated app bundle", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-outliner-mac-script-"));
  const fakeBin = join(temporary, "bin");
  const unrelatedApp = join(temporary, "Safari.app");
  mkdirSync(join(unrelatedApp, "Contents"), { recursive: true });
  writeFileSync(join(unrelatedApp, "Contents", "Info.plist"), "not the outliner app");
  mkdirSync(fakeBin);
  const commands: Record<string, string> = {
    uname: "#!/bin/sh\necho Darwin\n",
    plutil: "#!/bin/sh\necho com.apple.Safari\n",
    xcrun: "#!/bin/sh\nexit 0\n",
    codesign: "#!/bin/sh\nexit 0\n",
    ditto: "#!/bin/sh\nexit 0\n",
  };
  for (const [name, content] of Object.entries(commands)) {
    const path = join(fakeBin, name);
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }
  const env = {
    HOME: temporary,
    PATH: `${fakeBin}:/bin:/usr/bin`,
  };

  try {
    const install = await runWithEnv(
      ["bash", "install.sh", "--app-dir", unrelatedApp],
      env,
    );
    expect(install.exitCode).toBe(2);
    expect(install.stderr).toContain(
      "Refusing to replace app with bundle id com.apple.Safari",
    );
    expect(existsSync(unrelatedApp)).toBe(true);

    const uninstall = await runWithEnv(
      ["bash", "uninstall.sh", "--app-dir", unrelatedApp, "--purge-config"],
      env,
    );
    expect(uninstall.exitCode).toBe(2);
    expect(uninstall.stderr).toContain(
      "Refusing to remove app with bundle id com.apple.Safari",
    );
    expect(existsSync(unrelatedApp)).toBe(true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
