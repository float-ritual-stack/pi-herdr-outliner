import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NOTE_TYPES } from "./note-kinds";

export const DEFAULT_AI_PROMPT_DIRECTORY = fileURLToPath(new URL("../prompts/", import.meta.url));
const MAX_PROMPT_BYTES = 64 * 1024;
const PROMPT_FILENAMES = ["inbox-editor.md", "inbox-relationships.json", "goto-ranking.json"];
const NOTE_PROMPT_FILENAMES = ["note-assistance.json", "note-answer.md"];
const NOTE_PROMPT_UPGRADE = ".note-assistance-v1";

/** Evidence of the bytes used by a job, not an editable second prompt authority. */
export interface PromptRevision {
  path: string;
  sha256: string;
  text: string;
  packagedSha256?: string;
  packagedDifferences?: {added:string[];removed:string[];truncated:boolean};
}

export class PromptFileError extends Error {
  constructor(path: string, problem: string) {
    super(`AI prompt ${basename(path)}: ${problem} (${path})`);
    this.name = "PromptFileError";
  }
}

interface Question<Criteria> {
  instructions: string;
  criteria: Criteria;
}

export interface InboxPrompts {
  editor: string;
  relationships: {
    relationship: Question<Record<"duplicate" | "related" | "unrelated", string>>;
    coverage: Question<Record<"true" | "false", string>>;
  };
  revisions: PromptRevision[];
}

export interface NotePrompts {
  type: Question<Record<string, string>>;
  tag: { instructions: string };
  request: Question<Record<string, string>>;
  requestParagraph: string;
  inventoryKey: string;
  thresholds: { type: number; tag: number; request: number };
  answer: string;
  revisions: PromptRevision[];
}

export async function loadNotePrompts(directory?: string): Promise<NotePrompts> {
  const path = aiPromptDirectory(directory);
  const revision = await readPrompt(path, "note-assistance.json");
  const answer = await readPrompt(path, "note-answer.md");
  const data = object(json(revision), revision.path, ["type", "tag", "request", "requestParagraph", "inventoryKey", "thresholds"], "document");
  const question = (name: "type" | "request", keys: readonly string[]): Question<Record<string, string>> => {
    const value = object(data[name], revision.path, ["instructions", "criteria"], name);
    const criteria = object(value.criteria, revision.path, [...keys], `${name}.criteria`);
    return { instructions: nonempty(value.instructions, revision.path, `${name}.instructions`),
      criteria: Object.fromEntries(keys.map(key => [key, nonempty(criteria[key], revision.path, `${name}.criteria.${key}`)])) };
  };
  const tag = object(data.tag, revision.path, ["instructions"], "tag");
  const limits = object(data.thresholds, revision.path, ["type", "tag", "request"], "thresholds");
  const threshold = (key: string): number => {
    const value = limits[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new PromptFileError(revision.path, `thresholds.${key} must be between 0 and 1`);
    return value;
  };
  return {
    type: question("type", NOTE_TYPES), request: question("request", ["none", "property-inventory", "answer", "unsupported"]),
    tag: { instructions: nonempty(tag.instructions, revision.path, "tag.instructions") },
    requestParagraph: nonempty(data.requestParagraph, revision.path, "requestParagraph"),
    inventoryKey: nonempty(data.inventoryKey, revision.path, "inventoryKey"),
    thresholds: { type: threshold("type"), tag: threshold("tag"), request: threshold("request") },
    answer: answer.text, revisions: [revision, answer],
  };
}

export function aiPromptDirectory(directory?: string): string {
  return resolve(directory ?? process.env.OUTLINER_PROMPT_DIR ?? DEFAULT_AI_PROMPT_DIRECTORY);
}

/** Initialize a new workspace's editable files. Existing files, even invalid ones, belong to the user. */
export async function initializeAiPrompts(directory: string): Promise<void> {
  directory = resolve(directory);
  async function exists(path = directory): Promise<boolean> {
    try { await lstat(path); return true; }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }
  if (await exists()) {
    // Upgrade a recognized installation once. Empty/custom directories and deliberate
    // deletions after this upgrade stay owned by the user.
    if (await exists(join(directory, NOTE_PROMPT_UPGRADE)) ||
      !(await Promise.all(PROMPT_FILENAMES.map(name => exists(join(directory, name))))).every(Boolean)) return;
    for (const name of NOTE_PROMPT_FILENAMES) {
      try { await copyFile(join(DEFAULT_AI_PROMPT_DIRECTORY, name), join(directory, name), constants.COPYFILE_EXCL); }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
    }
    await writeFile(join(directory, NOTE_PROMPT_UPGRADE), "1\n", { flag: "wx" }).catch(error => {
      if (error?.code !== "EEXIST") throw error;
    });
    return;
  }
  const staging = await mkdtemp(join(dirname(directory), `.${basename(directory)}-seed-`));
  try {
    // Finish each copy before cleanup can run on failure.
    for (const name of [...PROMPT_FILENAMES, ...NOTE_PROMPT_FILENAMES]) {
      await copyFile(join(DEFAULT_AI_PROMPT_DIRECTORY, name), join(staging, name), constants.COPYFILE_EXCL);
    }
    await writeFile(join(staging, NOTE_PROMPT_UPGRADE), "1\n", { flag: "wx" });
    if (await exists()) return;
    try { await rename(staging, directory); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error
        && (error.code === "EEXIST" || error.code === "ENOTEMPTY")) return;
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function readPrompt(directory: string, name: string): Promise<PromptRevision> {
  const path = join(directory, name);
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch { throw new PromptFileError(path, "cannot read file; restore it or correct OUTLINER_PROMPT_DIR"); }
  if (bytes.length > MAX_PROMPT_BYTES) throw new PromptFileError(path, "file exceeds 64 KiB");
  const text = bytes.toString("utf8");
  if (!text.trim()) throw new PromptFileError(path, "file must not be empty");
  const sha256=createHash("sha256").update(bytes).digest("hex");
  if(name!=="inbox-editor.md")return {path,text,sha256};
  const packaged=resolve(directory)===resolve(DEFAULT_AI_PROMPT_DIRECTORY)?bytes:await readFile(join(DEFAULT_AI_PROMPT_DIRECTORY,name));
  const packagedSha256=createHash("sha256").update(packaged).digest("hex");
  const lines=(value:string)=>value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const activeLines=lines(text),packagedLines=lines(packaged.toString("utf8"));
  const added=packagedLines.filter(line=>!activeLines.includes(line));
  const removed=activeLines.filter(line=>!packagedLines.includes(line));
  return {path,text,sha256,packagedSha256,...sha256!==packagedSha256?{packagedDifferences:{
    added:added.slice(0,4).map(line=>line.slice(0,300)),removed:removed.slice(0,4).map(line=>line.slice(0,300)),
    truncated:added.length>4||removed.length>4||[...added,...removed].some(line=>line.length>300),
  }}:{}};
}

function object(value: unknown, path: string, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new PromptFileError(path, `${label} must contain exactly ${keys.join(", ")}`);
  }
  return value as Record<string, unknown>;
}

function nonempty(value: unknown, path: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new PromptFileError(path, `${label} must be a nonempty string`);
  return value;
}

function json(revision: PromptRevision): unknown {
  try { return JSON.parse(revision.text); }
  catch { throw new PromptFileError(revision.path, "invalid JSON; correct the file and retry"); }
}

function question<Keys extends string>(value: unknown, path: string, label: string, keys: Keys[]): Question<Record<Keys, string>> {
  const data = object(value, path, ["instructions", "criteria"], label);
  const criteria = object(data.criteria, path, keys, `${label}.criteria`);
  return {
    instructions: nonempty(data.instructions, path, `${label}.instructions`),
    criteria: Object.fromEntries(keys.map(key => [key, nonempty(criteria[key], path, `${label}.criteria.${key}`)])) as Record<Keys, string>,
  };
}

/** Read once at the job boundary. There is no watcher, cache, or stale-file fallback. */
export async function loadInboxPrompts(directory?: string): Promise<InboxPrompts> {
  const root = aiPromptDirectory(directory);
  const [editor, relationships] = await Promise.all([
    readPrompt(root, "inbox-editor.md"), readPrompt(root, "inbox-relationships.json"),
  ]);
  const data = object(json(relationships), relationships.path, ["relationship", "coverage"], "document");
  return {
    editor: editor.text,
    relationships: {
      relationship: question(data.relationship, relationships.path, "relationship", ["duplicate", "related", "unrelated"]),
      coverage: question(data.coverage, relationships.path, "coverage", ["true", "false"]),
    },
    revisions: [editor, relationships],
  };
}

export async function loadGotoPrompt(directory?: string): Promise<{ ranking: Question<string[]>; revisions: PromptRevision[] }> {
  const revision = await readPrompt(aiPromptDirectory(directory), "goto-ranking.json");
  const data = object(json(revision), revision.path, ["instructions", "criteria"], "document");
  if (!Array.isArray(data.criteria) || data.criteria.length !== 4) {
    throw new PromptFileError(revision.path, "criteria must contain exactly four score descriptions (0–3)");
  }
  return {
    ranking: {
      instructions: nonempty(data.instructions, revision.path, "instructions"),
      criteria: data.criteria.map((value, i) => nonempty(value, revision.path, `criteria[${i}]`)),
    },
    revisions: [revision],
  };
}
