// Kind 1, data: a record put into a block. `read` returns a title, fields and a body; the service
// writes them as one real block it owns ([moon.phase::Full Moon] and so on), under the block that
// asks, so views, queries and backlinks see it like any block. Computed here from the date alone:
// no network, nothing private.

interface Request { operation: string; input: { key: string } }

const SYNODIC_DAYS = 29.530588853;
/** A new moon: 2000-01-06 18:14 UTC. */
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);
const PHASES = [
  "New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous",
  "Full Moon", "Waning Gibbous", "Last Quarter", "Waning Crescent",
] as const;

function moon(date: string) {
  const noon = Date.parse(`${date}T12:00:00Z`);
  const age = ((((noon - KNOWN_NEW_MOON) / 86_400_000) % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS;
  const illumination = Math.round(((1 - Math.cos((2 * Math.PI * age) / SYNODIC_DAYS)) / 2) * 100);
  const phase = PHASES[Math.round((age / SYNODIC_DAYS) * 8) % 8]!;
  return { age: Math.round(age * 10) / 10, illumination, phase };
}

const request = (await Bun.stdin.json()) as Request;
const date = request.input.key;
if (request.operation !== "read" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) {
  process.stdout.write(JSON.stringify({ ok: false, code: "not-found" }));
} else {
  const today = moon(date);
  process.stdout.write(JSON.stringify({
    ok: true,
    value: {
      record: {
        title: `Moon on ${date}: ${today.phase}`,
        fields: [
          { key: "phase", value: today.phase },
          { key: "illumination", value: `${today.illumination}%` },
          { key: "age", value: `${today.age} days` },
          { key: "date", value: date },
        ],
        body: `${today.illumination}% lit, ${today.age} days since the new moon.`,
      },
    },
  }));
}
