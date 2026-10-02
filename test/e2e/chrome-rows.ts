// Measures content rows (Tree rows plus Preview document rows) at several sizes, compact and full chrome.
// Prints a ROWS line; run the same file against another checkout to compare (PIE-525 used it against main).
import {runHerdrScenario} from "./herdr-runner";
import {contentRows, prepareFixture} from "./pane-bars";

const sizes = [[160, 26], [160, 30], [160, 45], [240, 26], [240, 45]] as const;
const result = await runHerdrScenario({name: "chrome-rows", async prepare() {}, async run(s) {
  const terminal = await s.attachClient();
  await terminal.resize(160, 45);
  const {note} = await prepareFixture(s);
  const out: Record<string, unknown> = {};
  const toggle = async (label: string) => {
    await s.keys(s.panes.tree, "?");
    await s.waitVisible(s.panes.tree, "Find:");
    await s.text(s.panes.tree, label);
    await s.waitVisible(s.panes.tree, `Find: ${label}`);
    await s.keys(s.panes.tree, "enter");
    await s.waitFor("menu closed", () => s.visible(s.panes.tree), f => !f.includes("Find:"));
  };
  const branch = (await s.visible(s.panes.tree)).includes("[▐]");
  for (const level of ["compact", "full"]) {
    if (level === "full") {
      if (branch) { await toggle("Tree chrome"); await toggle("Preview chrome"); }
      else await toggle("Expanded layout");
    }
    for (const [columns, rows] of sizes) {
      await terminal.resize(columns, rows);
      await s.revealTree(s.panes.tree, note.id);
      await s.waitFor(`settled ${columns}x${rows}`, () => s.visible(s.panes.tree), f => /BODY LINE 0[1-3]|ROW 0[1-9]/.test(f) && !f.includes("Find:"));
      await new Promise(r => setTimeout(r, 600));
      const settled = await s.visible(s.panes.tree);
      out[`${level}-${columns}x${rows}`] = contentRows(settled);
      await s.record(`frame-${level}-${columns}x${rows}`, settled);
    }
    await terminal.resize(160, 45);
  }
  console.error("ROWS " + JSON.stringify({version: branch ? "pie525" : "main", ...out}));
}});
console.log(JSON.stringify(result));
