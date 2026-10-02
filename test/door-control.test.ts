import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoorSilent, DoorUnreachable, doorRequest, openInDoor } from "../src/door-control";

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
  test("from the caller's own tile: the door picks the reader (that tile's link), and says which", async () => {
    door = await fakeDoor(() => ({ ok: true, result: { reader: "middle", id: BLOCK } }));
    expect(await openInDoor(door.path, BLOCK, { actor: "claude-code", from: "claude" })).toEqual({ reader: "middle", id: BLOCK });
    expect(door.requests).toEqual([{ cmd: "act", action: "open", args: { id: BLOCK, from: "claude" }, as: "claude-code" }]);
  });

  test("a door without that tile, or older than from=, is asked again without it: where its own open puts notes", async () => {
    for (const refusal of ["no tile claude; tiles: #1 tree (t1), or focused", "open takes no from; it takes id"]) {
      door = await fakeDoor(request => (request.args.from ? { ok: false, error: refusal } : { ok: true, result: { reader: "side" } }));
      expect(await openInDoor(door.path, BLOCK, { actor: "claude-code", from: "claude" })).toEqual({ reader: "side" });
      expect(door.requests.map(request => request.args.from ?? null)).toEqual(["claude", null]);
      await door.close(); door = undefined;
    }
  });

  test("from alone (the Claude mod): the person on middle, a door without the tile lands it where its opens land, never naming middle", async () => {
    // The door refuses an agent that names the reader the person is on (ep0ch-door round 3); this caller never does.
    door = await fakeDoor(request => (request.args.from ? { ok: false, error: "no tile claude-gone; tiles: #1 tree, #2 middle, #3 side, focused, or a block id" } : request.reader ? { ok: false, error: "middle has the person's keys; an agent doesn't open there" } : { ok: true, result: { reader: "side", id: BLOCK } }));
    expect(await openInDoor(door.path, BLOCK, { actor: "claude-code", from: "claude-gone" })).toEqual({ reader: "side", id: BLOCK });
    expect(door.requests.map(request => [request.args.from ?? null, request.reader ?? null])).toEqual([["claude-gone", null], [null, null]]);
  });

  test("with a reader too, a door older than from= is asked for that reader, then for none", async () => {
    door = await fakeDoor(request => (request.args.from ? { ok: false, error: "open takes no from; it takes id" } : request.reader ? { ok: true, result: { reader: "5", id: BLOCK } } : { ok: true, result: { reader: "2" } }));
    expect(await openInDoor(door.path, BLOCK, { actor: "claude-code", from: "claude", reader: "middle" })).toEqual({ reader: "5", id: BLOCK });
    expect(door.requests.map(request => [request.args.from ?? null, request.reader ?? null])).toEqual([["claude", null], [null, "middle"]]);
    await door.close(); door = undefined;
    // A door that knows from= is never asked for the reader.
    door = await fakeDoor(() => ({ ok: true, result: { reader: "side", id: BLOCK } }));
    expect(await openInDoor(door.path, BLOCK, { actor: "claude-code", from: "claude", reader: "middle" })).toEqual({ reader: "side", id: BLOCK });
    expect(door.requests).toHaveLength(1);
    await door.close(); door = undefined;
    // An old door with no middle either: where its own open puts notes.
    door = await fakeDoor(request => (request.args.from ? { ok: false, error: "open takes no from; it takes id" } : request.reader ? { ok: false, error: "no reader middle on the desk; readers: 2" } : { ok: true, result: { reader: "2" } }));
    expect(await openInDoor(door.path, BLOCK, { actor: "claude-code", from: "claude", reader: "middle" })).toEqual({ reader: "2" });
    expect(door.requests).toHaveLength(3);
  });

  test("any other refusal from the tile's link is the answer, never asked again", async () => {
    door = await fakeDoor(request => (request.args.from ? { ok: false, error: "reader middle is holding an edit or a comment on another note" } : { ok: true, result: {} }));
    await expect(openInDoor(door.path, BLOCK, { actor: "claude-code", from: "claude" })).rejects.toThrow("holding an edit");
    expect(door.requests).toHaveLength(1);
  });

  test("an agent's open of the middle reader, attributed to the actor", async () => {
    door = await fakeDoor(() => ({ ok: true, result: { reader: "5", id: BLOCK } }));
    expect(await openInDoor(door.path, BLOCK, { actor: "claude-code", reader: "middle" })).toEqual({ reader: "5", id: BLOCK });
    expect(door.requests).toEqual([{ cmd: "act", action: "open", args: { id: BLOCK }, as: "claude-code", reader: "middle" }]);
  });

  test("a door without that tile shows it where its own open puts notes", async () => {
    // The door's own refusal for a reader it doesn't have (Desk.pickReader).
    door = await fakeDoor(request => (request.reader ? { ok: false, error: "no reader middle on the desk; readers: 1 (tree), 2 (side), focused, or a block id" } : { ok: true, result: { reader: "2" } }));
    expect(await openInDoor(door.path, BLOCK, { actor: "claude-code", reader: "middle" })).toEqual({ reader: "2" });
    expect(door.requests.map(request => request.reader ?? null)).toEqual(["middle", null]);
  });

  test("any other refusal of the middle reader is the answer: never asked again without it (that would be the focused reader)", async () => {
    door = await fakeDoor(request => (request.reader ? { ok: false, error: "reader middle is holding an edit or a comment on another note" } : { ok: true, result: { reader: "1" } }));
    await expect(openInDoor(door.path, BLOCK, { actor: "claude-code", reader: "middle" })).rejects.toThrow("holding an edit");
    expect(door.requests).toHaveLength(1);
  });

  test("a door that takes the request but doesn't answer is DoorSilent, not DoorUnreachable: the note isn't shown twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "door-control-"));
    const path = join(dir, "door.sock");
    const held: Socket[] = [];
    const server = createServer(socket => { held.push(socket); });
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      const error = await doorRequest(path, { cmd: "act" }, 100).catch(e => e);
      expect(error).toBeInstanceOf(DoorSilent);
      expect(error).not.toBeInstanceOf(DoorUnreachable);
    } finally {
      held.forEach(socket => socket.destroy());
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a link left pointing at a door that quit (ECONNREFUSED on a stale socket file) is DoorUnreachable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "door-control-"));
    const path = join(dir, "door.sock");
    // A door killed outright: its socket file stays, nothing listens on it.
    const crashed = Bun.spawn([process.execPath, "-e", `require("node:net").createServer().listen(${JSON.stringify(path)}); setInterval(() => {}, 1e6)`]);
    for (let i = 0; i < 200 && !existsSync(path); i++) await Bun.sleep(10);
    crashed.kill("SIGKILL");
    await crashed.exited;
    expect(existsSync(path)).toBe(true);
    const link = join(dir, "agent-door-claude.sock");
    symlinkSync(path, link);
    try {
      await expect(openInDoor(link, BLOCK, { actor: "claude-code", reader: "middle" })).rejects.toBeInstanceOf(DoorUnreachable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
