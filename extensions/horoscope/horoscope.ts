// Kind 2, inline output: the smallest complete handler. The service runs this once per call (one JSON
// request on stdin, one response on stdout) and keeps the markdown under the `horoscope::` line.
// Everything here is made up; it reads nothing and calls nothing.

interface Request {
  operation: string;
  input: { handler: string; argument: string | null; options: { day?: string }; context: { now: string } };
}

const OPENINGS = [
  "The kettle knows something you don't.",
  "A drawer you rarely open is worth opening.",
  "Someone will ask you for a pen; have two.",
  "The bus is late, and that is the gift.",
  "Your plants have opinions about the curtains.",
  "An old notebook has the answer, on page eleven.",
];
const ADVICE = [
  "Write the small thing down before it grows.",
  "Say yes to soup.",
  "Leave one task unfinished on purpose.",
  "Tidy one shelf, not the room.",
  "Return the borrowed umbrella.",
  "Take the stairs, then sit for a while.",
];
const COLOURS = ["teal", "rust", "moss", "amber", "slate", "plum"];

/** A small, stable number from text: the same sign and day always read the same. */
function seed(text: string): number {
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return hash;
}

function reading(sign: string, date: string) {
  const number = seed(`${sign.toLowerCase()} ${date}`);
  return {
    opening: OPENINGS[number % OPENINGS.length]!,
    advice: ADVICE[(number >>> 8) % ADVICE.length]!,
    colour: COLOURS[(number >>> 16) % COLOURS.length]!,
    lucky: (number % 89) + 1,
  };
}

function answer(value: unknown): void {
  process.stdout.write(JSON.stringify({ ok: true, value }));
}

const request = (await Bun.stdin.json()) as Request;
if (request.operation !== "run") {
  process.stdout.write(JSON.stringify({ ok: false, code: "invalid-config" }));
} else {
  const sign = (request.input.argument ?? "").toLowerCase();
  const now = new Date(request.input.context.now);
  if (request.input.options.day === "tomorrow") now.setUTCDate(now.getUTCDate() + 1);
  const date = now.toISOString().slice(0, 10);
  const today = reading(sign, date);
  const name = sign.charAt(0).toUpperCase() + sign.slice(1);
  answer({
    title: `${name} · ${date}`,
    markdown: [
      `**${name}, ${date}.** ${today.opening}`,
      "",
      `- Advice: ${today.advice}`,
      `- Colour: ${today.colour}`,
      `- Lucky number: ${today.lucky}`,
    ].join("\n"),
  });
}
