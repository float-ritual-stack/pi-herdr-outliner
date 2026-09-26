// Disposable PIE-388 launcher. The ZIP becomes a Resource in a private fixture.
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createOutlinerClient } from "../src/client";
import { resolveClientPaths } from "../src/paths";
import type { InternResourceReceipt } from "../src/types";

const defaultPack = "/home/evan/.codex/attachments/f2bd85c3-f7e1-4a95-a946-5e7a066bdf79/woe0697a (1).zip";
const pack = resolve(process.argv[2] ?? defaultPack);
const root = await mkdtemp(join(tmpdir(), "outliner-ansi-pack-spike-"));
const archive = join(root, "art-pack.zip");
const env: NodeJS.ProcessEnv = {
  ...process.env,
  OUTLINER_WORKSPACE_ROOT: root,
  OUTLINER_STATE_DIR: join(root, ".state"),
  OUTLINER_CONFIG_PATH: join(root, "no-client-config.json"),
  OUTLINER_REMOTE: "0",
  OUTLINER_INBOX_AGENT: "0",
  OUTLINER_NOTE_ASSISTANCE: "0",
  HERDR_ENV: "0",
};
delete env.HERDR_SOCKET_PATH;
const code = (name: string) => join(import.meta.dir, "..", "src", name);
let service: ReturnType<typeof spawn> | null = null;
try {
  await copyFile(pack, archive);
  service = spawn(process.execPath, ["run", code("server-main.ts")], {
    env, stdio: ["ignore", "pipe", "inherit"],
  });
  const client = createOutlinerClient(resolveClientPaths(env));
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (service.exitCode !== null) throw new Error(`Private Outliner service exited with ${service.exitCode}`);
    try { await client.requireCompatibleService(); ready = true; break; }
    catch { await Bun.sleep(100); }
  }
  if (!ready) throw new Error("Private Outliner service did not become ready");
  const { resource } = await client.request<InternResourceReceipt>({
    action: "resources.intern-filesystem", input: { path: "art-pack.zip", mediaType: "application/zip" },
  });
  const target = encodeURIComponent(JSON.stringify({ kind: "resource", resourceId: resource.id }));
  console.error(`ANSI pack spike · ${basename(pack)} · private fixture ${root}`);
  const detail = spawn(process.execPath, ["run", code("detail-main.ts")], {
    env: { ...env, OUTLINER_DETAIL_RENDERER: process.env.OUTLINER_DETAIL_RENDERER ?? "pi-tui", OUTLINER_DETAIL_TARGET: target },
    stdio: "inherit",
  });
  const exitCode = await new Promise<number>(done => {
    detail.once("error", error => { console.error(error); done(1); });
    detail.once("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
  process.exitCode = exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (service?.exitCode === null) {
    service.kill("SIGTERM");
    await Promise.race([
      new Promise<void>(done => service!.once("exit", () => done())),
      Bun.sleep(2_000).then(() => { service?.kill("SIGKILL"); }),
    ]);
  }
  await rm(root, { recursive: true, force: true });
}
