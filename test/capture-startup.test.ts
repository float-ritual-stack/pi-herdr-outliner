import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTLINER_PROTOCOL_VERSION } from "../src/types";

test("changed write entrypoints reject an incompatible service before touching drafts or content", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-old-service-"));
  const socketPath = join(root, "old.sock");
  const actions: string[] = [];
  const server = createServer((socket) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
      if (!text.includes("\n")) return;
      const request = JSON.parse(text.slice(0, text.indexOf("\n")));
      actions.push(request.action);
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result:
        request.action === "ping" ? { status: "ready", protocolVersion: OUTLINER_PROTOCOL_VERSION - 1 } : null,
      })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    for (const args of [
      ["src/capture-main.ts"],
      ["src/cli.ts", "capture", "--text", "Must not be sent"],
      ["src/cli.ts", "update", "--id", "block-1", "--text", "Must not be sent", "--expected", "1"],
      ["src/cli.ts", "work-id-allocate", "--id", "block-1", "--expected", "1"],
    ]) {
      const child = Bun.spawn([process.execPath, ...args], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, HERDR_ENV: "1", OUTLINER_REMOTE: "1", OUTLINER_SOCKET_PATH: socketPath,
          OUTLINER_WORKSPACE_ROOT: root, OUTLINER_STATE_DIR: join(root, "state") },
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 3_000,
      });
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("incompatible Outliner protocol");
    }
    expect(actions).toEqual(["ping", "ping", "ping", "ping"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
