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
    const timer = setTimeout(() => finish(() => reject(new DoorUnreachable(`the door at ${path} did not answer`))), timeoutMs);
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
 * every agent action). It goes to the `reader` tile (the daily layout's middle
 * detail); a door without that tile shows it where its own `open` puts notes.
 */
export async function openInDoor(path: string, blockId: string, options: { actor: string; reader?: string }): Promise<{ reader?: string; id?: string }> {
  const request = { cmd: "act", action: "open", args: { id: blockId }, as: options.actor };
  if (options.reader) {
    try {
      return (await doorRequest(path, { ...request, reader: options.reader })) as { reader?: string; id?: string };
    } catch (error) {
      if (error instanceof DoorUnreachable) throw error;
    }
  }
  return (await doorRequest(path, request)) as { reader?: string; id?: string };
}
