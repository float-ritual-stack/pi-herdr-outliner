import { connect } from "node:net";

/**
 * A client for ep0ch-door's control socket (the door's docs/AGENT-INTERFACE.md):
 * one JSON request per line, one `{"ok":…}` answer per line. The door owns
 * what an action does; this only asks. Used when an agent runs in a door's
 * terminal tile (EP0CH_TILE set), where the door is the place to show a note,
 * not a Herdr split.
 */

/** No door is listening at that path (none started, or it quit). */
export class DoorUnreachable extends Error {}

/**
 * The door is there but didn't answer in time. Not DoorUnreachable: it may still
 * do what it was asked, so the caller must not show the note somewhere else too.
 */
export class DoorSilent extends Error {}

/** Sends one request and resolves to the door's `result`; a refusal throws with the door's reason. */
export function doorRequest(path: string, request: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const socket = connect(path, () => socket.write(JSON.stringify(request) + "\n"));
    const timer = setTimeout(() => finish(() => reject(new DoorSilent(`the door at ${path} did not answer in ${timeoutMs / 1000}s`))), timeoutMs);
    socket.on("data", chunk => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      finish(() => {
        let answer: { ok?: boolean; result?: unknown; error?: unknown };
        try { answer = JSON.parse(buffer.slice(0, newline)); } catch { return reject(new Error("the door answered with something other than JSON")); }
        if (answer.ok) resolve(answer.result);
        else reject(new Error(String(answer.error ?? "the door refused")));
      });
    });
    socket.on("error", error => finish(() => reject(new DoorUnreachable(`no door at ${path} (${error.message})`))));
    socket.on("close", () => finish(() => reject(new DoorUnreachable(`the door at ${path} closed without answering`))));
  });
}

/**
 * Opens a block in the door as an agent's `open`: attributed to `actor` on
 * the door's screen, and never moving the person's focus (the door's rule for
 * every agent action).
 *
 * - `from`: the tile the caller runs in (EP0CH_TILE). The door opens it where
 *   that tile's opens land, its link (PIE-491: the daily layout links the
 *   claude tile to its middle detail), so the caller never names a reader.
 * - `reader`: a reader tile by name.
 *
 * Only when the door doesn't know the tile or reader (its refusal "no tile
 * <name> …" or "no reader <name> …"), or is older than `from` ("open takes no
 * from"), is it asked again without one: where the door's own open puts notes.
 * Any other refusal (the reader holds an edit, the screen can't open notes) is
 * the answer, so the note never lands in whatever reader the person has
 * focused instead.
 */
export async function openInDoor(path: string, blockId: string, options: { actor: string; reader?: string; from?: string }): Promise<{ reader?: string | null; id?: string }> {
  const request = { cmd: "act", action: "open", args: { id: blockId }, as: options.actor };
  if (options.from) {
    try {
      return (await doorRequest(path, { ...request, args: { id: blockId, from: options.from } })) as { reader?: string | null; id?: string };
    } catch (error) {
      if (!(error instanceof Error) || error instanceof DoorUnreachable || error instanceof DoorSilent) throw error;
      const unknownTile = error.message.startsWith(`no tile ${options.from};`) || error.message.startsWith(`no tile ${options.from} `);
      if (!unknownTile && !error.message.startsWith("open takes no from")) throw error;
    }
  } else if (options.reader) {
    try {
      return (await doorRequest(path, { ...request, reader: options.reader })) as { reader?: string; id?: string };
    } catch (error) {
      if (!(error instanceof Error) || error instanceof DoorUnreachable || error instanceof DoorSilent) throw error;
      if (!error.message.startsWith(`no reader ${options.reader} `)) throw error;
    }
  }
  return (await doorRequest(path, request)) as { reader?: string; id?: string };
}
