import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AI_PROMPT_DIRECTORY, initializeAiPrompts, loadGotoPrompt, loadInboxPrompts, loadNotePrompts } from "../src/ai-prompts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function directory() {
  const root = await mkdtemp(join(tmpdir(), "ai-prompts-")); roots.push(root);
  await cp(DEFAULT_AI_PROMPT_DIRECTORY, root, { recursive: true });
  return root;
}

test("missing and blank instructions never silently fall back to packaged prompts", async () => {
  const root = await directory();
  const path = join(root, "inbox-editor.md");
  await writeFile(path, " \n");
  await expect(loadInboxPrompts(root)).rejects.toThrow("file must not be empty");
  await rm(path);
  await expect(loadInboxPrompts(root)).rejects.toThrow("cannot read file");
});

test("Jev prompt edits must retain the result contracts consumed by the application", async () => {
  const root = await directory();
  const path = join(root, "inbox-relationships.json");
  const original = JSON.parse(await readFile(path, "utf8"));
  original.relationship.criteria.newOption = "Another option";
  await writeFile(path, JSON.stringify(original));
  await expect(loadInboxPrompts(root)).rejects.toThrow("relationship.criteria must contain exactly duplicate, related, unrelated");
  await writeFile(join(root, "goto-ranking.json"), JSON.stringify({ instructions: "Rank", criteria: ["zero", "one", "two", "three", "four"] }));
  await expect(loadGotoPrompt(root)).rejects.toThrow("exactly four score descriptions");
});

test("oversized prompt files are rejected before entering model context", async () => {
  const root = await directory();
  await writeFile(join(root, "inbox-editor.md"), "x".repeat(64 * 1024 + 1));
  await expect(loadInboxPrompts(root)).rejects.toThrow("file exceeds 64 KiB");
});

test("failed seeding leaves no published directory and can be retried", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ai-prompts-seed-")); roots.push(parent);
  const root = join(parent, "prompts");
  const copyFile = fs.copyFile;
  let copies = 0;
  const copy = spyOn(fs, "copyFile").mockImplementation(async (...args) => {
    if (++copies === 2) throw new Error("Injected copy failure");
    await copyFile(...args);
  });
  try {
    await expect(initializeAiPrompts(root)).rejects.toThrow("Injected copy failure");
    expect(copies).toBe(2);
    expect(await readdir(parent)).toEqual([]);
  } finally { copy.mockRestore(); }
  await initializeAiPrompts(root);
  expect((await loadInboxPrompts(root)).editor).toContain("Inbox editor");
  expect((await loadGotoPrompt(root)).ranking.criteria).toHaveLength(4);
  expect(await readdir(parent)).toEqual(["prompts"]);
});

test("initialization preserves an existing empty directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ai-prompts-seed-")); roots.push(parent);
  const root = join(parent, "prompts");
  await mkdir(root);
  await initializeAiPrompts(root);
  expect(await readdir(root)).toEqual([]);
  expect(await readdir(parent)).toEqual(["prompts"]);
});

test("initialization preserves a directory created while defaults are being copied", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ai-prompts-seed-")); roots.push(parent);
  const root = join(parent, "prompts");
  const copyFile = fs.copyFile;
  let copies = 0;
  const copy = spyOn(fs, "copyFile").mockImplementation(async (...args) => {
    await copyFile(...args);
    if (++copies === 1) await mkdir(root);
  });
  try {
    await initializeAiPrompts(root);
    expect(await readdir(root)).toEqual([]);
    expect(await readdir(parent)).toEqual(["prompts"]);
  } finally { copy.mockRestore(); }
});

test("concurrent seeders publish one complete directory and clean their staging files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ai-prompts-seed-")); roots.push(parent);
  const root = join(parent, "prompts");
  const rename = fs.rename;
  const ready = Promise.withResolvers<void>();
  let arrivals = 0;
  const publish = spyOn(fs, "rename").mockImplementation(async (...args) => {
    if (++arrivals === 2) ready.resolve();
    await ready.promise;
    await rename(...args);
  });
  try {
    await Promise.all([initializeAiPrompts(root), initializeAiPrompts(root)]);
    expect(arrivals).toBe(2);
    expect((await loadInboxPrompts(root)).editor).toContain("Inbox editor");
    expect((await loadGotoPrompt(root)).ranking.criteria).toHaveLength(4);
    expect(await readdir(parent)).toEqual(["prompts"]);
  } finally { publish.mockRestore(); }
});

test("workspace initialization seeds once and never resets custom, invalid or removed files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ai-prompts-seed-")); roots.push(parent);
  const root = join(parent, "prompts");
  await initializeAiPrompts(root);
  expect((await loadInboxPrompts(root)).editor).toContain("Inbox editor");
  const editor = join(root, "inbox-editor.md");
  await writeFile(editor, "My custom instructions");
  await initializeAiPrompts(root);
  expect((await loadInboxPrompts(root)).editor).toBe("My custom instructions");
  await writeFile(editor, "");
  await initializeAiPrompts(root);
  await expect(loadInboxPrompts(root)).rejects.toThrow("must not be empty");
  await rm(editor);
  await initializeAiPrompts(root);
  await expect(loadInboxPrompts(root)).rejects.toThrow("cannot read file");
});

test("existing prompt installations gain note assistance once without replacing authored prompts", async () => {
  const root = await directory();
  await rm(join(root, "note-answer.md"));
  await rm(join(root, "note-assistance.json"));
  await writeFile(join(root, "inbox-editor.md"), "Authored Inbox instructions");
  await initializeAiPrompts(root);
  expect((await loadInboxPrompts(root)).editor).toBe("Authored Inbox instructions");
  expect((await loadNotePrompts(root)).request.criteria).toHaveProperty("property-inventory");
  await writeFile(join(root, "note-answer.md"), "Authored answer instructions");
  await initializeAiPrompts(root);
  expect((await loadNotePrompts(root)).answer).toBe("Authored answer instructions");
  await rm(join(root, "note-answer.md"));
  await initializeAiPrompts(root);
  await expect(loadNotePrompts(root)).rejects.toThrow("cannot read file");
});

test('Inbox prompt comparison describes missing guidance without replacing customization',async()=>{
 const root=await mkdtemp(join(tmpdir(),'prompt-comparison-'));
 try {
  await initializeAiPrompts(join(root,'prompts'));
  const path=join(root,'prompts','inbox-editor.md');await writeFile(path,'Custom editorial preference.\n');
  const loaded=await loadInboxPrompts(join(root,'prompts'));
  const evidence=loaded.revisions[0]!;
  expect(evidence.packagedDifferences?.added.length).toBeGreaterThan(0);
  expect(evidence.packagedDifferences?.removed).toContain('Custom editorial preference.');
  expect(await readFile(path,'utf8')).toBe('Custom editorial preference.\n');
 }finally{await rm(root,{recursive:true,force:true});}
});
