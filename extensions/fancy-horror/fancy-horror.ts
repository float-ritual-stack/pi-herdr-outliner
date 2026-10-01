// Kind 3, rich component: data plus a view composed from the shared primitives (card, badge, stat,
// bar, checklist, sparkline). Every client draws the primitives, so this folder ships no client code.
// Its behaviour is an action, `ward`, whose write is a real block; the next run reads it back from
// the block's children. All omens are made up.

interface Context { block: { id: string; revision: number }; children: { id: string; text: string }[]; now: string }
interface Request {
  operation: "run" | "act";
  input: {
    handler?: string;
    argument?: string | null;
    action?: string;
    target?: { blockId: string; argument?: string | null };
    context: Context;
  };
}

const OMENS = [
  "a door that closes by itself",
  "three crows on the phone line",
  "a song you never added, on repeat",
  "your own handwriting on a note you didn't write",
  "the lift stops at a floor that isn't there",
  "a cat that watches the hallway",
  "the clock is a minute fast, then a minute slow",
];

function seed(text: string): number {
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return hash;
}

/** The week's omens for a sign: three of them, the same all week. */
function omens(sign: string, week: string): string[] {
  const start = seed(`${sign} ${week}`);
  return [0, 1, 2].map((offset) => OMENS[(start + offset * 3) % OMENS.length]!);
}

function weekOf(now: Date): string {
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

/** A warding is a child block that starts "Warded off …"; that is the component's state, kept in the outline. */
function warded(children: Context["children"]): Set<string> {
  return new Set(children.map((child) => child.text.split("\n", 1)[0]!).filter((line) => line.startsWith("Warded off "))
    .map((line) => line.slice("Warded off ".length).trim()));
}

function respond(value: unknown): void {
  process.stdout.write(JSON.stringify({ ok: true, value }));
}

const request = (await Bun.stdin.json()) as Request;
const { input } = request;
const sign = (input.argument ?? input.target?.argument ?? "").toLowerCase();
const week = weekOf(new Date(input.context.now));
const list = omens(sign, week);
const done = warded(input.context.children);

if (request.operation === "act" && input.action === "ward") {
  const next = list.find((omen) => !done.has(omen));
  if (!next) respond({ message: "Every omen this week is warded off" });
  else respond({ message: `Warded off ${next}`, writes: [{ op: "create", parentId: input.target!.blockId, text: `Warded off ${next}` }] });
} else if (request.operation === "run") {
  const days = Array.from({ length: 7 }, (_, day) => (seed(`${sign} ${week} ${day}`) % 9) + 1);
  const left = list.filter((omen) => !done.has(omen)).length;
  const dread = Math.max(0, Math.round(days.reduce((sum, value) => sum + value, 0) / 7) - (list.length - left) * 2);
  const tone = dread >= 7 ? "bad" : dread >= 4 ? "warn" : "good";
  const name = sign.charAt(0).toUpperCase() + sign.slice(1);
  respond({
    title: `${name} · week of ${week}`,
    // The truth. `json` returns it; `csv` takes the checklist's rows from it.
    data: { sign, week, dread, days, omens: list.map((omen) => ({ omen, warded: done.has(omen) })) },
    view: {
      type: "card",
      title: `${name}: week of ${week}`,
      subtitle: left ? `${left} omen${left === 1 ? "" : "s"} still at large` : "all quiet",
      badge: { label: dread >= 7 ? "dire" : dread >= 4 ? "uneasy" : "calm", tone },
      children: [
        { type: "row", children: [
          { type: "stat", label: "Dread", value: dread, unit: "/ 10", tone },
          { type: "sparkline", label: "This week", values: days },
        ] },
        { type: "bar", label: "Dread", value: dread, max: 10, tone },
        { type: "checklist", items: list.map((omen) => ({ label: omen, done: done.has(omen) })) },
      ],
    },
  });
} else {
  process.stdout.write(JSON.stringify({ ok: false, code: "invalid-config" }));
}
