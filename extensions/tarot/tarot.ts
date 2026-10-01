// The actions of the tarot extension (`act`), so an agent can draw and keep without the tile.
import { draw, readingText } from "./deck";

interface Request {
  operation: string;
  input: { action: string; args?: Record<string, string>; target?: { blockId: string }; context?: { now: string } };
}

const request = (await Bun.stdin.json()) as Request;
const now = request.input.context?.now ?? new Date().toISOString();
const date = now.slice(0, 10);
const card = draw(`${date} ${request.input.args?.draw ?? "0"}`);
const reply = (value: unknown) => process.stdout.write(JSON.stringify({ ok: true, value }));

if (request.operation !== "act") process.stdout.write(JSON.stringify({ ok: false, code: "invalid-config" }));
else if (request.input.action === "draw") reply({ message: `${card.name}${card.upright ? "" : " (reversed)"}: ${card.meaning}` });
else if (request.input.action === "keep" && request.input.target) {
  reply({ message: `kept ${card.name}`, writes: [{ op: "create", parentId: request.input.target.blockId, text: readingText(card, date) }] });
} else process.stdout.write(JSON.stringify({ ok: false, code: "invalid-config" }));
