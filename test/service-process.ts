import { join } from "node:path";

/**
 * A real service process for tests, in a scratch state root. `env` replaces the
 * defaults; nothing inherits the caller's Outliner settings, so a test never
 * reaches a real outline. `startup()` resolves with the ready line, or null if
 * the service exits first.
 */
export function launchService(env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/server-main.ts")], {
    env: { PATH: process.env.PATH, OUTLINER_REMOTE: "0", OUTLINER_INBOX_AGENT: "0", ...env },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
    timeout: 15_000, killSignal: "SIGKILL",
  });
  const stderr = new Response(child.stderr).text();
  async function startup(): Promise<Record<string, unknown> | null> {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return null;
        output += decoder.decode(chunk.value, { stream: true });
        const line = output.split("\n").find(text => text.includes('"status":"ready"'));
        if (line) return JSON.parse(line) as Record<string, unknown>;
      }
    } finally {
      reader.releaseLock();
    }
  }
  return { child, stderr, startup };
}

/** The environment of a service for `project` under a scratch directory. */
export function scratchServiceEnv(root: string, project = "project"): Record<string, string> {
  return {
    OUTLINER_WORKSPACE_ROOT: join(root, project),
    OUTLINER_STATE_DIR: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
  };
}
