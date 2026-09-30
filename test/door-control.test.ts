import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoorUnreachable, openInDoor } from "../src/door-control";

/**
 * A stand-in for ep0ch-door's control socket: answers each JSON line with
 * `answer(request)` and records the requests. No real door is involved.
 */
async function fakeDoor(answer: (request: any) => { ok: boolean; result?: unknown; error?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "door-control-"));
  const path = join(dir, "door.sock");
  const requests: any[] = [];
  const server: Server = createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString();
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        requests.push(request);
        socket.write(JSON.stringify(answer(request)) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return { path, dir, requests, close: () => new Promise<void>(resolve => server.close(() => { rmSync(dir, { recursive: true, force: true }); resolve(); })) };
}

let door: Awaited<ReturnType<typeof fakeDoor>> | undefined;
afterEach(async () => { await door?.close(); door = undefined; });

const BLOCK = "0c0ffee0-1111-4222-8333-444455556666";

describe("showing a block in ep0ch-door", () => {
  test("an agent's open of the middle reader, attributed to the actor", async () => {
    door = await fakeDoor(() => ({ ok: true, result: { reader: "5", id: BLOCK } }));
    expect(await openInDoor(door.path, BLOCK, { actor: "claude-code", reader: "middle" })).toEqual({ reader: "5", id: BLOCK });
    expect(door.requests).toEqual([{ cmd: "act", action: "open", args: { id: BLOCK }, as: "claude-code", reader: "middle" }]);
  });

  test("a door without that tile shows it where its own open puts notes", async () => {
    door = await fakeDoor(request => (request.reader ? { ok: false, error: "no tile middle" } : { ok: true, result: { reader: "2" } }));
    expect(await openInDoor(door.path, BLOCK, { actor: "claude-code", reader: "middle" })).toEqual({ reader: "2" });
    expect(door.requests.map(request => request.reader ?? null)).toEqual(["middle", null]);
  });

  test("a refusal is thrown with the door's reason", async () => {
    door = await fakeDoor(() => ({ ok: false, error: "the menu screen can't open blocks; open the board or desk first" }));
    await expect(openInDoor(door.path, BLOCK, { actor: "claude-code" })).rejects.toThrow("can't open blocks");
  });

  test("no door listening is DoorUnreachable, so the caller can show it elsewhere", async () => {
    const dir = mkdtempSync(join(tmpdir(), "door-control-"));
    try {
      await expect(openInDoor(join(dir, "gone.sock"), BLOCK, { actor: "claude-code", reader: "middle" })).rejects.toBeInstanceOf(DoorUnreachable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the CLI's door-open: the result on stdout, exit 3 when no door answers", async () => {
    door = await fakeDoor(() => ({ ok: true, result: { reader: "5", id: BLOCK } }));
    const run = (control: string) => Bun.spawn([process.execPath, "src/cli.ts", "door-open", BLOCK, "--actor", "claude-code", "--reader", "middle"], {
      env: { ...process.env, EP0CH_CONTROL: control },
      stdout: "pipe",
      stderr: "pipe",
    });
    const ok = run(door.path);
    expect(await new Response(ok.stdout).text()).toBe(`{"reader":"5","id":"${BLOCK}"}\n`);
    expect(await ok.exited).toBe(0);
    expect(door.requests[0]).toMatchObject({ as: "claude-code", reader: "middle" });

    const gone = run(join(door.dir, "gone.sock"));
    expect(await new Response(gone.stderr).text()).toContain("error: no door at");
    expect(await gone.exited).toBe(3);
  });
});
