// Measures transclusions.read on fictional notes: time in the service and the answer's size.
// bun scripts/bench-transclusions.ts
import { readTransclusions } from "../src/transclusions";
import type { Block } from "../src/types";

const block = (id: string, text: string): Block => ({ id, text, parentId: null, position: 0, revision: 1, createdAt: "", updatedAt: "", author: "user", properties: [] } as unknown as Block);
/** A realistic plan note of about `kb` KB: headings, prose, steps with ids, nested steps. */
function plan(kb: number, seed: string): string {
  const out = [`Plan ${seed}`];
  for (let i = 0; out.join("\n").length < kb * 1024; i++) {
    if (i % 12 === 0) out.push(`## Section ${i} ^s-${seed}-${i}`, "Some prose about what this part of the plan is for, and who does it.");
    out.push(`- [${"x ~!"[i % 4]}] Step ${i} of the plan, with a few words ^t-${seed}${i.toString(16).padStart(4, "0")}`);
    if (i % 3 === 0) out.push(`  - [ ] Nested follow-up for step ${i}`, `    Keep the receipt for step ${i}.`);
  }
  return out.join("\n");
}
const id = (n: number) => `bench${String(n).padStart(4, "0")}-0000-4000-8000-000000000000`;

/**
 * Cold: every run sees new text (a new revision of each note), so nothing parsed earlier is reused.
 * Warm: the same notes read again (another reader, the next redraw).
 */
function run(name: string, blocks: Block[], targets: { blockId: string; fragmentId?: string }[], host?: string) {
  const time = (fresh: boolean) => {
    const times: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 5; i++) {
      const edition = fresh ? blocks.map(b => ({ ...b, revision: b.revision + i + 1, text: `${b.text}\nEdit ${i} ${Math.random()}` })) : blocks;
      const byId = new Map(edition.map(b => [b.id, b]));
      const t = performance.now();
      const r = readTransclusions(x => byId.get(x) ?? null, targets, { hostBlockId: host });
      times.push(performance.now() - t);
      bytes = JSON.stringify(r).length;
    }
    return { ms: times.sort((a, b) => a - b)[2]!, bytes };
  };
  const cold = time(true), warm = time(false);
  console.log(`${name.padEnd(46)} cold ${cold.ms.toFixed(1).padStart(8)} ms   warm ${warm.ms.toFixed(1).padStart(7)} ms   ${(cold.bytes / 1024).toFixed(0).padStart(6)} KB`);
}

for (const kb of [10, 50]) {
  const same = block(id(1), plan(kb, "a"));
  run(`${kb} KB note, embedded 64 times (same note)`, [same], Array.from({ length: 64 }, () => ({ blockId: same.id })));
  const many = Array.from({ length: 64 }, (_, i) => block(id(100 + i), plan(kb, `n${i}`)));
  run(`${kb} KB notes, 64 different ones`, many, many.map(b => ({ blockId: b.id })));
  run(`${kb} KB note, 64 step slices of it`, [same], Array.from({ length: 64 }, (_, i) => ({ blockId: same.id, fragmentId: `t-a${(i * 5).toString(16).padStart(4, "0")}` })));
}
const leaf = block(id(2), "Leaf note\n- [ ] one step");
const huge = block(id(3), ["Twenty thousand embeds", ...Array.from({ length: 20_000 }, () => `!((${leaf.id}))`)].join("\n"));
run("a note with 20k embeds, embedded once", [leaf, huge], [{ blockId: huge.id }]);
const many = block(id(6), ["Five thousand embeds", ...Array.from({ length: 5_000 }, () => `!((${leaf.id}))`)].join("\n"));
run("a note with 5k embeds (250 KB), embedded once", [leaf, many], [{ blockId: many.id }]);
const realistic = block(id(4), plan(4, "r"));
const hub = block(id(5), ["Week plan", `!((${realistic.id}))`, `!((${realistic.id}^t-r0005))`, `!((${realistic.id}^s-r-12))`].join("\n"));
run("realistic: a 4 KB plan, whole + 2 slices", [realistic, hub], [{ blockId: realistic.id }, { blockId: realistic.id, fragmentId: "t-r0005" }, { blockId: realistic.id, fragmentId: "s-r-12" }], hub.id);
