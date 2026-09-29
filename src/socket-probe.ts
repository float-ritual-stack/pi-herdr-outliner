import { existsSync } from "node:fs";
import { connect } from "node:net";

/**
 * What a Unix socket path holds right now: nothing (`absent`), a stale file
 * nobody listens on (`refused`), a listener (`answers`), or no verdict within
 * the timeout (`silent`, a busy listener or a stuck one). Callers decide what
 * `silent` means for them; nothing is written or unlinked here.
 */
export type SocketProbe = "absent" | "refused" | "answers" | "silent";

export function probeSocket(socket: string, timeoutMs = 1_000): Promise<SocketProbe> {
  if (!existsSync(socket)) return Promise.resolve("absent");
  return new Promise(settle => {
    const probe = connect(socket);
    const done = (result: SocketProbe) => { clearTimeout(timer); probe.destroy(); settle(result); };
    const timer = setTimeout(() => done("silent"), timeoutMs);
    probe.once("connect", () => done("answers"));
    probe.once("error", (error: NodeJS.ErrnoException) =>
      done(error.code === "ENOENT" ? "absent" : error.code === "ECONNREFUSED" ? "refused" : "silent"));
  });
}
