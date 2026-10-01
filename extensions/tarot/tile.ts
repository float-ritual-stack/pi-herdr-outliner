// Kind 4, a whole tile: a terminal program the door runs in a tile of kind `tarot.reading`. It draws
// itself and reaches the outline only through the service's actions (`extensions.act`), so what it
// writes is attributed to ext:tarot, exactly as when an agent runs the same action.
//
// The door starts it with the command, cwd and env from `extensions.list` (`tileKinds`), adds its own
// EP0CH_CONTROL, and passes the tile's saved args as `--name=value` (here `--block=<id>`).
import { connect } from "node:net";
import { draw, type Card } from "./deck";

const args = Object.fromEntries(process.argv.slice(2).flatMap((arg) => {
  const match = /^--([a-z][a-z0-9-]*)=(.*)$/.exec(arg);
  return match ? [[match[1]!, match[2]!]] : [];
}));
const socketPath = process.env.OUTLINER_SOCKET_PATH;
const outline = process.env.OUTLINER_OUTLINE;

/** One request to the outline service: a JSON line out, a JSON line back. */
function request<T>(body: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!socketPath) return reject(new Error("no OUTLINER_SOCKET_PATH: open this tile from the door"));
    const socket = connect(socketPath);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      socket.end();
      const response = JSON.parse(buffer.slice(0, end)) as { ok: boolean; result?: T; error?: string };
      if (response.ok) resolve(response.result as T);
      else reject(new Error(response.error));
    });
    socket.on("error", reject);
    socket.write(`${JSON.stringify({ id: crypto.randomUUID(), ...(outline ? { outline } : {}), ...body })}\n`);
  });
}

let draws = 0;
let status = args.block ? "d draws again · k keeps it · q closes" : "d draws again · q closes (open with a block to keep)";
let card: Card = draw(`${new Date().toISOString().slice(0, 10)} 0`);

function paint(): void {
  const width = Math.max(30, Math.min(process.stdout.columns ?? 60, 60));
  const line = (text = "") => `│ ${text.padEnd(width - 4)} │`;
  const meaning = card.meaning.length > width - 4 ? `${card.meaning.slice(0, width - 5)}…` : card.meaning;
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write([
    `┌${"─".repeat(width - 2)}┐`,
    line(`\x1b[1m${card.name}\x1b[0m${card.upright ? "" : " (reversed)"}`.padEnd(width - 4 + 8)),
    line(),
    line(meaning),
    line(),
    `└${"─".repeat(width - 2)}┘`,
    "",
    status,
  ].join("\n"));
}

async function key(input: string): Promise<void> {
  if (input === "q" || input === "\x03") {
    process.stdout.write("\x1b[2J\x1b[H");
    process.exit(0);
  }
  try {
    if (input === "d") {
      draws += 1;
      card = draw(`${new Date().toISOString().slice(0, 10)} ${draws}`);
      // The same draw through the service, so an agent's draw and this one agree.
      const result = await request<{ message?: string }>({ action: "extensions.act", extension: "tarot", extensionAction: "draw", args: { draw: String(draws) } });
      status = result.message ?? status;
    } else if (input === "k" && args.block) {
      const result = await request<{ message?: string }>({ action: "extensions.act", extension: "tarot", extensionAction: "keep", blockId: args.block, args: { draw: String(draws) } });
      status = result.message ?? "kept";
    }
  } catch (error) {
    status = `couldn't reach the outline: ${error instanceof Error ? error.message : String(error)}`;
  }
  paint();
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => void key(chunk.toString("utf8")));
process.stdout.on("resize", paint);
paint();
