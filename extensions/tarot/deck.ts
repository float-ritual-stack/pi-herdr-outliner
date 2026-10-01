// The deck both programs share: the action handler (tarot.ts) and the tile (tile.ts). Made up.

export interface Card { name: string; upright: boolean; meaning: string }

const MAJOR = [
  ["The Fool", "a first step, taken lightly", "a step you keep putting off"],
  ["The Magician", "the tools are all on the desk", "a trick that only looks like work"],
  ["The High Priestess", "the quiet answer", "a secret you keep from yourself"],
  ["The Hermit", "a lamp, a long walk, an early night", "too much time in the cave"],
  ["Wheel of Fortune", "the turn you were waiting for", "the same loop again"],
  ["The Star", "repair, slowly", "a wish left unspoken"],
  ["The Moon", "a dream worth writing down", "a fog that lifts by noon"],
  ["The Sun", "plain good news", "joy, a little delayed"],
] as const;

function seed(text: string): number {
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return hash;
}

/** The card for a seed: today's date by default, or the date and a draw number. */
export function draw(seedText: string): Card {
  const number = seed(seedText);
  const [name, upright, reversed] = MAJOR[number % MAJOR.length]!;
  const isUpright = ((number >>> 8) & 1) === 0;
  return { name, upright: isUpright, meaning: isUpright ? upright : reversed };
}

/** A reading as a block's text: the card, then what it means. */
export function readingText(card: Card, date: string): string {
  return `Tarot, ${date}: ${card.name}${card.upright ? "" : " (reversed)"}\n\n${card.meaning}`;
}
