import { afterEach, expect, test } from "bun:test";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ToolCall } from "@earendil-works/pi-ai";
import { Marked, type Tokens } from "marked";
import { DEFAULT_AI_PROMPT_DIRECTORY } from "../src/ai-prompts";
import type { InboxModelOptions } from "../src/inbox-model";
import type { InboxUsage } from "../src/inbox-types";
import { createNoteModel, inventoryAnswer, noteTagCandidates, type NoteModelContext } from "../src/note-assistance-model";
import { contentOfText, passageKey, requestPassages } from "../src/note-content";
import { NoteAssistanceRepository } from "../src/note-assistance-repository";
import { parseProperties } from "../src/properties";
import { OutlinerStore } from "../src/store";
import type { Block, PropertyInventory } from "../src/types";

interface Question { type: "choice" | "noul"; instructions: string; criteria?: Record<string, string> }
interface JevRequest { state: { note: string; complete: boolean; existingProperties: Block["properties"]; context: Record<string, unknown> }; questions: Record<string, Question> }
interface Judgments {
  type?: string;
  typeConfidence?: number;
  tags?: string[];
  request?: "none" | "property-inventory" | "answer" | "unsupported";
  requestConfidence?: number;
  paragraph?: string;
  key?: string;
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function block(text: string, overrides: Partial<Block> = {}): Block {
  return {
    id: "note-source", parentId: null, position: 0, revision: 3, author: "user", text,
    properties: parseProperties(text), createdAt: "2026-09-22T12:00:00Z", updatedAt: "2026-09-22T12:00:00Z", ...overrides,
  };
}

function inventory(key = "type", overrides: Partial<PropertyInventory> = {}): PropertyInventory {
  return { key, propertyScope: "block", items: [{ key, value: "note", count: 2 }, { key, value: "reference", count: 1 }],
    totalValues: 2, totalBlocks: 5, matchedBlocks: 3, offset: 0, nextOffset: null, complete: true, sequence: 42, ...overrides };
}

function response(body: JevRequest, judgments: Judgments = {}) {
  const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
    if (question.type === "noul") {
      const tag = question.instructions.split("Candidate tag: ").at(-1)!;
      return [id, { type: "noul", noul: judgments.tags?.includes(tag) ? 0.97 : 0.03 }];
    }
    let choice = "none";
    if (id === "type") choice = judgments.type ?? "note";
    if (id === "request") choice = judgments.request ?? "none";
    if (id === "paragraph" && judgments.paragraph) choice = Object.entries(question.criteria ?? {})
      .find(([, text]) => text === judgments.paragraph)?.[0] ?? "none";
    if (id === "key") choice = Object.entries(question.criteria ?? {})
      .find(([, text]) => text === judgments.key)?.[0] ?? "none";
    return [id, { type: "choice", choice, confidence: id === "type" ? judgments.typeConfidence ?? 0.97 : judgments.requestConfidence ?? 0.97 }];
  }));
  return { answers, usage: { input_tokens: 120, output_tokens: 25 } };
}

async function fixture(text: string, judgments: Judgments = {}) {
  const root = await mkdtemp(join(tmpdir(), "note-model-")); roots.push(root);
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4.1", defaultThinkingLevel: "off" }));
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-not-a-live-key" } }));
  const promptDirectory = join(root, "prompts");
  await cp(DEFAULT_AI_PROMPT_DIRECTORY, promptDirectory, { recursive: true });
  const requests: JevRequest[] = [];
  const inventoryCalls: string[] = [];
  const options: InboxModelOptions = {
    workspaceRoot: root, agentDir, promptDirectory, sessionDirectory: join(root, "sessions"), jevApiKey: "fixture-not-a-live-key",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body as string) as JevRequest; requests.push(body);
      return Response.json(response(body, judgments));
    },
    stream: () => { throw new Error("Unexpected Pi answer request"); },
  };
  const context: NoteModelContext = {
    candidate: { source: block(text), inferredTags: [], rejectedTags: [], typeLocked: false, requestAllowed: true },
    tags: [], propertyKeys: ["type", "tag", "project"], read: () => null, search: () => [],
    inventory: key => { inventoryCalls.push(key); return inventory(key); },
    signal: new AbortController().signal, progress() {},
  };
  return { root, options, context, requests, inventoryCalls };
}

const call = (name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id: crypto.randomUUID(), name, arguments: args });

function scripted(steps: Array<(context: Context) => ToolCall[]>): NonNullable<InboxModelOptions["stream"]> {
  let turn = 0;
  return (_model, context) => {
    const step = steps[turn++];
    if (!step) throw new Error("Unexpected model continuation");
    const message: AssistantMessage = {
      role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-4.1", content: step(context), stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "toolUse", message });
    return stream;
  };
}

test("a fresh inventory request reads authoritative counts and writes a dated complete answer", async () => {
  const request = "List every distinct `type` value currently used in this outline.";
  const f = await fixture(`System type inventory\n\n${request}`, { request: "property-inventory", paragraph: request, key: "type", type: "reference" });
  const model = createNoteModel(f.options);
  const result = await model(f.context);
  expect(f.inventoryCalls).toEqual(["type"]);
  expect(result.plan).toMatchObject({ type: "reference", fulfillment: { operation: "property-inventory", summary: "Listed all 2 distinct type values" } });
  expect(result.plan.fulfillment?.text).toContain(request);
  expect(result.plan.fulfillment?.text).toContain("## Result — ");
  expect(result.plan.fulfillment?.text).toContain("**2 distinct type values**, from 3 of 5 active canonical blocks");
  expect(result.plan.fulfillment?.text).toContain("| note | 2 |");
  expect(result.plan.fulfillment?.text).toContain("Observed workspace sequence: 42");
  expect(result.usage).toMatchObject({ jevCalls: 1, jevSuccessfulCalls: 1, inputTokens: 120, outputTokens: 25 });

  f.context.candidate.lastRequestKey = result.plan.fulfillment!.key;
  const repeated = await model(f.context);
  expect(repeated.plan.fulfillment).toBeUndefined();
  expect(f.inventoryCalls).toEqual(["type"]);
});

test("soft-wrapped requests stay complete and rewrapping does not make them fresh", async () => {
  const request = "Please list all distinct `type` values currently used in this outline.";
  const wrapped = "Please list all distinct\n`type` values currently used in this outline.";
  const f = await fixture(`Type inventory\n\n${wrapped}`, { request: "property-inventory", paragraph: request, key: "type" });
  const model = createNoteModel(f.options);
  const result = await model(f.context);
  expect(f.requests[0]!.state.context.eligibleRequestPassages).toEqual(["Type inventory", request]);
  expect(result.plan.fulfillment?.operation).toBe("property-inventory");
  expect(f.inventoryCalls).toEqual(["type"]);

  f.context.candidate.seenRequestPassages = requestPassages(f.context.candidate.source.text).map(passageKey);
  f.context.candidate.source = block(`Type inventory\n\n${request}`);
  expect((await model(f.context)).plan.fulfillment).toBeUndefined();
  expect(f.requests[1]!.questions.request).toBeUndefined();
  expect(f.inventoryCalls).toEqual(["type"]);
});

test("blank, quoted and code-only lines end prose runs without joining separate requests", () => {
  for (const separator of ["", "> Quoted context", "```text\nCode context\n```", "`Code context`", "\n    Indented code\n"]) {
    expect(requestPassages(`List all\ntype values\n${separator}\nSummarize our\nnavigation notes`)).toEqual([
      "List all type values", "Summarize our navigation notes",
    ]);
  }
  expect(requestPassages("List `type` values.\nDo `not` deploy.")).toEqual(["List `type` values.", "Do `not` deploy."]);
});

test("inventory values remain literal data after canonical note application", async () => {
  const request = "List all distinct tag values.";
  const f = await fixture(`Tag inventory\n\n${request}`, { request: "property-inventory", paragraph: request, key: "tag" });
  const store = new OutlinerStore(join(f.root, "outliner.sqlite"));
  try {
    const repository = new NoteAssistanceRepository(store);
    repository.initialize();
    const values = ["#rabbit-hole", "one`tick", "two``ticks", "left|right", String.raw`path\segment`, String.raw`path\|#topic`, "`#inside`"];
    for (const [index, value] of values.entries()) {
      const note = store.create(`Literal property ${index}\n[tag::${value}]`);
      expect(note.properties).toContainEqual({ key: "tag", value });
    }
    const source = store.create(f.context.candidate.source.text);
    f.context.candidate = repository.candidateFor(source.id)!;
    const before = store.propertyInventory({ key: "tag" });
    f.context.inventory = key => store.propertyInventory({ key });
    const result = await createNoteModel(f.options)(f.context);
    repository.apply("literal-inventory", f.context.candidate, result.plan, result.usage);
    const canonical = store.require(source.id);
    const table = new Marked().lexer(canonical.text).find((token): token is Tokens.Table => token.type === "table");
    expect(table?.type).toBe("table");
    if (table?.type !== "table") throw new Error("Missing inventory table");
    const cells = table.rows.map(row => row.map(cell => cell.tokens.map(token => "text" in token ? token.text : "").join("")));
    expect(cells).toEqual(before.items.map(item => [item.value, String(item.count)]));
    expect(canonical.properties.filter(property => property.key === "tag")).toEqual([]);
    expect(canonical.properties).toContainEqual({ key: "request-status", value: "fulfilled" });
    expect(store.propertyInventory({ key: "tag" }).items).toEqual(before.items);
  } finally { store.close(); }
});

test("historical or ordinary content with no current request is only organized", async () => {
  const f = await fixture("Historical discussion\n\nWe could add a feature that lists type values.", { request: "none", type: "design-note" });
  const result = await createNoteModel(f.options)(f.context);
  expect(result.plan).toMatchObject({ type: "design-note", tags: [] });
  expect(result.plan.fulfillment).toBeUndefined();
  expect(result.plan.unfulfilledRequest).toBeUndefined();
  expect(f.inventoryCalls).toEqual([]);
});

test("explicit Assist supplies current intent separately from the note's historical age", async () => {
  const request = "Please list the distinct type values.";
  const f = await fixture(`Historical inventory request\n\n${request}`, { request: "property-inventory", paragraph: request, key: "type" });
  f.context.candidate.source.createdAt = "1998-03-14T00:00:00Z";
  f.context.candidate.explicitReconsideration = true;
  f.context.candidate.seenRequestPassages = requestPassages(f.context.candidate.source.text).map(passageKey);
  const result = await createNoteModel(f.options)(f.context);
  expect(f.requests[0]!.state.context).toMatchObject({ currentRequestEligible: true, explicitReconsideration: true });
  expect(result.plan.fulfillment?.operation).toBe("property-inventory");
});

test("an unrelated paragraph or same-line sentence cannot reactivate a historical request", async () => {
  const old = "Historical inventory\n\nPlease list all distinct type values.";
  const request = "Please list all distinct type values.";
  for (const separator of ["\n\n", " "]) {
    const f = await fixture(`${old}${separator}The garden is doing well.`, { request: "property-inventory", paragraph: request, key: "type" });
    f.context.candidate.seenRequestPassages = requestPassages(old).map(passageKey);
    const result = await createNoteModel(f.options)(f.context);
    expect(f.requests[0]!.state.note).toContain(request);
    expect(f.requests[0]!.state.context.eligibleRequestPassages).toEqual(["The garden is doing well."]);
    expect(Object.values(f.requests[0]!.questions.paragraph!.criteria!)).not.toContain(request);
    expect(result.plan.fulfillment).toBeUndefined();
    expect(result.plan.unfulfilledRequest).toBeUndefined();
    expect(f.inventoryCalls).toEqual([]);
  }
});

test("a fresh request remains eligible after many old passages, and unchanged notes offer no request", async () => {
  const old = Array.from({ length: 25 }, (_, i) => `Historical observation ${i}.`).join("\n");
  const request = "Please list the distinct tag values.";
  const f = await fixture(`${old}\n\n${request}`, { request: "property-inventory", paragraph: request, key: "tag" });
  f.context.candidate.seenRequestPassages = requestPassages(old).map(passageKey);
  const result = await createNoteModel(f.options)(f.context);
  expect(f.requests[0]!.state.context.eligibleRequestPassages).toEqual([request]);
  expect(result.plan.fulfillment?.operation).toBe("property-inventory");
  expect(f.inventoryCalls).toEqual(["tag"]);
  f.context.candidate.seenRequestPassages = requestPassages(f.context.candidate.source.text).map(passageKey);
  const repeated = await createNoteModel(f.options)(f.context);
  expect(f.requests[1]!.questions.request).toBeUndefined();
  expect(repeated.plan.fulfillment).toBeUndefined();
  expect(f.inventoryCalls).toEqual(["tag"]);
});

test("authored hashtags retain request meaning while metadata does not create new passages", async () => {
  const request = "List the tag values relevant to #navigation.";
  const f = await fixture(`Tag inventory\n[type::note]\n\n${request}`, { request: "property-inventory", paragraph: request, key: "tag" });
  const first = await createNoteModel(f.options)(f.context);
  expect(f.requests[0]!.state.note).toContain("#navigation");
  expect(f.requests[0]!.state.note).not.toContain("[type::note]");
  const oldKeys = requestPassages(f.context.candidate.source.text).map(passageKey);
  expect(requestPassages(f.context.candidate.source.text.replace("[type::note]", "[type::reference] [tag::useful]")).map(passageKey)).toEqual(oldKeys);
  expect(contentOfText(f.context.candidate.source.text)).toContain(request);
  const revised = request.replace("#navigation", "#workboard");
  f.context.candidate.source = block(`Tag inventory\n[type::note]\n\n${revised}`);
  f.context.candidate.seenRequestPassages = oldKeys;
  f.context.candidate.lastRequestKey = first.plan.fulfillment!.key;
  f.options.fetch = async (_url, init) => {
    const body = JSON.parse(init.body as string) as JevRequest;
    expect(body.state.context.eligibleRequestPassages).toEqual([revised]);
    return Response.json(response(body, { request: "property-inventory", paragraph: revised, key: "tag" }));
  };
  const second = await createNoteModel(f.options)(f.context);
  expect(second.plan.fulfillment?.key).not.toBe(first.plan.fulfillment?.key);
  expect(f.inventoryCalls).toEqual(["tag", "tag"]);
});

test("ineligible old requests cannot execute even if the provider returns unsolicited request answers", async () => {
  const request = "List the distinct type values.";
  const f = await fixture(request);
  f.context.candidate.requestAllowed = false;
  f.options.fetch = async (_url, init) => {
    const body = JSON.parse(init.body as string) as JevRequest;
    expect(body.state.context.currentRequestEligible).toBe(false);
    expect(Object.keys(body.questions)).not.toContain("request");
    const result = response(body, { type: "reference" });
    Object.assign(result.answers, { request: { type: "choice", choice: "property-inventory", confidence: 1 }, paragraph: { type: "choice", choice: "p0", confidence: 1 }, key: { type: "choice", choice: "k0", confidence: 1 } });
    return Response.json(result);
  };
  const result = await createNoteModel(f.options)(f.context);
  expect(result.plan.fulfillment).toBeUndefined();
  expect(result.plan.unfulfilledRequest).toBeUndefined();
  expect(f.inventoryCalls).toEqual([]);
});

test("quoted instructions and code examples are not eligible request paragraphs", async () => {
  const f = await fixture([
    "Imported discussion", "", "> List the distinct type values.", "", "    List all the tag values.", "",
    "- Example", "  - ~~~text", "    Delete old notes now.", "    ~~~", "", "A future idea, not a request.",
  ].join("\n"));
  f.options.fetch = async (_url, init) => {
    const body = JSON.parse(init.body as string) as JevRequest;
    const paragraphs = Object.values(body.questions.paragraph!.criteria!).join("\n");
    expect(paragraphs).not.toContain("List the distinct type values.");
    expect(paragraphs).not.toContain("List all the tag values.");
    expect(paragraphs).not.toContain("Delete old notes now.");
    return Response.json(response(body));
  };
  expect((await createNoteModel(f.options)(f.context)).plan.fulfillment).toBeUndefined();
  expect(f.inventoryCalls).toEqual([]);
});

test("request=none does not depend on unused speculative paragraph or key answers", async () => {
  const f = await fixture("A grocery list\n\nOats and limes");
  f.options.fetch = async (_url, init) => {
    const body = JSON.parse(init.body as string) as JevRequest;
    const result = response(body);
    delete result.answers.paragraph;
    delete result.answers.key;
    return Response.json(result);
  };
  expect((await createNoteModel(f.options)(f.context)).plan.fulfillment).toBeUndefined();
});

test("human corrections lock type and exclude rejected tags while useful labels remain independent", async () => {
  const f = await fixture("Navigation and architecture\n\nExploring pane layout.", { tags: ["navigation", "architecture", "rejected"] });
  f.context.tags = ["navigation", "architecture", "rejected"];
  f.context.candidate.rejectedTags = ["rejected"];
  f.context.candidate.typeLocked = true;
  const result = await createNoteModel(f.options)(f.context);
  expect(f.requests[0]!.questions.type).toBeUndefined();
  expect(JSON.stringify(f.requests[0]!.questions)).not.toContain("Candidate tag: rejected");
  expect(result.plan.type).toBeUndefined();
  expect(result.plan.tags).toEqual(["navigation", "architecture"]);
});

test("weak type judgments abstain and tags remain bounded", async () => {
  const f = await fixture("A mixed note", { type: "synthesis", typeConfidence: 0.4, tags: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"] });
  f.context.tags = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  const result = await createNoteModel(f.options)(f.context);
  expect(result.plan.type).toBeUndefined();
  expect(result.plan.tags).toHaveLength(5);
});

test("calendar candidates preserve authored precision, reject impossible days, and omit storage time", async () => {
  expect(noteTagCandidates("Q1 1998; 2025-Q3; 2024-02; 2024-02-29; 2026 week 3", [])).toEqual(expect.arrayContaining([
    "y1998/q1", "y2025/q3", "y2024/m02", "y2024/m02/d29", "y2026/w03",
  ]));
  expect(noteTagCandidates("Invalid 2026-02-31", [])).not.toContain("y2026/m02/d31");
  const f = await fixture("Imported notebook [captured-at::2099-04-15]\n\nThis material belongs to Q1 1998.", { tags: ["y1998/q1"] });
  f.context.candidate.source.createdAt = "2099-04-15T00:00:00Z";
  f.context.candidate.source.updatedAt = "2099-04-16T00:00:00Z";
  const result = await createNoteModel(f.options)(f.context);
  expect(result.plan.tags).toContain("y1998/q1");
  expect(JSON.stringify(f.requests[0])).not.toContain("2099-");
  expect(JSON.stringify(f.requests[0]!.questions)).not.toContain("y2099");
});

test("prompt edits reload between runs without rebuilding the model", async () => {
  const f = await fixture("Navigation thoughts", { type: "reference", typeConfidence: 0.7 });
  const model = createNoteModel(f.options);
  const first = await model(f.context);
  expect(first.plan.type).toBe("reference");
  const path = join(f.options.promptDirectory!, "note-assistance.json");
  const prompt = JSON.parse(await readFile(path, "utf8"));
  prompt.type.instructions = "Revised local type judgment";
  prompt.thresholds.type = 0.9;
  await writeFile(path, JSON.stringify(prompt));
  const second = await model(f.context);
  expect(second.plan.type).toBeUndefined();
  expect(f.requests[1]!.questions.type!.instructions).toBe("Revised local type judgment");
  expect(second.usage.promptRevisions?.[0]?.sha256).not.toBe(first.usage.promptRevisions?.[0]?.sha256);
});

test("malformed provider responses never become plans or perform reads", async () => {
  const f = await fixture("List the distinct type values.");
  const invalid: unknown[] = [null, [], {}, { answers: { type: { type: "choice", choice: "invented-type", confidence: 1 } } },
    { answers: { type: { type: "choice", choice: "note", confidence: 9 } } }];
  for (const value of invalid) {
    f.options.fetch = async () => Response.json(value);
    await expect(createNoteModel(f.options)(f.context)).rejects.toThrow("Invalid note classification response");
  }
  f.options.fetch = async (_url, init) => {
    const result = response(JSON.parse(init.body as string));
    const tagKey = Object.keys(result.answers).find(key => key.startsWith("tag_"))!;
    result.answers[tagKey] = { type: "noul", noul: 2 };
    return Response.json(result);
  };
  await expect(createNoteModel(f.options)(f.context)).rejects.toThrow("Invalid note tag response");
  f.options.fetch = async () => new Response("not json");
  await expect(createNoteModel(f.options)(f.context)).rejects.toThrow("Invalid note classification response");
  f.options.fetch = async () => new Response("provider secret must not surface", { status: 500 });
  await expect(createNoteModel(f.options)(f.context)).rejects.toThrow("Note organization provider is unavailable");
  expect(f.inventoryCalls).toEqual([]);
});

test("unsupported, unresolved-key, and incomplete inventory requests explicitly remain open", async () => {
  const request = "Please carry out this current request.";
  for (const kind of ["unsupported", "property-inventory"] as const) {
    const f = await fixture(request, { request: kind, paragraph: request });
    const result = await createNoteModel(f.options)(f.context);
    expect(result.plan.fulfillment).toBeUndefined();
    expect(result.plan.unfulfilledRequest?.reason).toContain(kind === "unsupported" ? "outside" : "property key");
    expect(f.inventoryCalls).toEqual([]);
  }
  const f = await fixture(request, { request: "property-inventory", paragraph: request, key: "type" });
  f.context.inventory = key => inventory(key, { complete: false, nextOffset: 1000, totalValues: 1500 });
  const result = await createNoteModel(f.options)(f.context);
  expect(result.plan.fulfillment).toBeUndefined();
  expect(result.plan.unfulfilledRequest?.reason).toContain("incomplete");
  expect(() => inventoryAnswer(inventory("type", { complete: false }), "today")).toThrow("truncated");
});

test("generic answers run the real Pi tools and receive explicit reconsideration instructions", async () => {
  const request = "Summarize our navigation decisions.";
  const f = await fixture(`Navigation summary\n\n${request}`, { request: "answer", paragraph: request, type: "synthesis" });
  const finalText = `${f.context.candidate.source.text}\n\n## Answer\nThe decision is recorded in ((evidence-note)).`;
  f.context.candidate.instructions = "Keep this concise and preserve the historical context.";
  f.context.search = () => [];
  f.context.read = id => id === "evidence-note" ? block("Navigation decisions\n\nUse hubs for orientation and focused Tree for structure.", { id }) : null;
  f.options.stream = scripted([
    context => {
      expect(context.tools?.map(tool => tool.name).sort()).toEqual(["finish_cleanup", "property_inventory", "read_note", "search_notes"]);
      const user = context.messages.find(message => message.role === "user")!;
      const text = typeof user.content === "string" ? user.content : user.content.filter(item => item.type === "text").map(item => item.text).join("");
      expect(JSON.parse(text)).toMatchObject({ currentRequest: request, userPreferences: f.context.candidate.instructions });
      expect(context.systemPrompt).toContain("You fulfill one fresh, bounded request");
      return [call("search_notes", { query: "navigation decisions" })];
    },
    () => [call("read_note", { blockId: "evidence-note" })],
    context => {
      const last = context.messages.at(-1)!;
      expect(last.role).toBe("toolResult");
      expect(JSON.stringify(last)).toContain("Use hubs for orientation");
      return [call("finish_cleanup", { summary: "Summarized the navigation decisions", source: { disposition: "file", text: finalText }, notes: [], tasks: [], updates: [] })];
    },
  ]);
  const result = await createNoteModel(f.options)(f.context);
  expect(f.requests[0]!.state.context.userPreferences).toBe(f.context.candidate.instructions);
  expect(result.plan.fulfillment).toMatchObject({ operation: "answer", text: finalText });
  expect(result.usage.provider).toBe("typesafe + openai");
  expect(result.usage.inputTokens).toBeGreaterThan(120);
  expect(result.usage.piSessions).toHaveLength(1);
  expect(result.usage.piSessions![0]!.outcome).toBe("completed");
  expect(await Bun.file(result.usage.piSessions![0]!.path!).exists()).toBe(true);
});

test("the answer uses captured prompt bytes during a job and reloads the next job", async () => {
  const request = "Summarize this navigation note.";
  const f = await fixture(request, { request: "answer", paragraph: request });
  const path = join(f.options.promptDirectory!, "note-answer.md");
  const original = "Answer the note. Captured prompt A.";
  const revised = "Answer the note. Revised prompt B.";
  await writeFile(path, original);
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let fetches = 0;
  const fetch = f.options.fetch!;
  f.options.fetch = async (url, init) => {
    if (++fetches === 1) { started.resolve(); await resume.promise; }
    return fetch(url, init);
  };
  const systems: string[] = [];
  const begin = (context: Context) => { systems.push(context.systemPrompt ?? ""); return [call("search_notes", { query: "navigation" })]; };
  const finish = () => [call("finish_cleanup", { summary: "Answered", source: { disposition: "file", text: `${request}\n\n## Answer\nUse curated hubs.` }, notes: [], tasks: [], updates: [] })];
  f.options.stream = scripted([begin, finish, begin, finish]);
  const model = createNoteModel(f.options);
  const pending = model(f.context);
  await started.promise;
  await writeFile(path, revised);
  resume.resolve();
  const first = await pending;
  const second = await model(f.context);
  expect(systems[0]).toStartWith(original + "\n");
  expect(systems[1]).toStartWith(revised + "\n");
  expect(first.usage.promptRevisions?.filter(revision => revision.path === path).every(revision => revision.text === original)).toBe(true);
  expect(second.usage.promptRevisions?.filter(revision => revision.path === path).every(revision => revision.text === revised)).toBe(true);
});

test("Pi hold leaves the request open and never substitutes a made-up answer", async () => {
  const request = "Summarize the missing design decision.";
  const f = await fixture(request, { request: "answer", paragraph: request });
  f.options.stream = scripted([() => [call("finish_cleanup", {
    summary: "No evidence found", source: { disposition: "hold", text: f.context.candidate.source.text, reason: "The design decision is not present in the supplied notes" }, notes: [], tasks: [], updates: [],
  })]]);
  const result = await createNoteModel(f.options)(f.context);
  expect(result.plan.fulfillment).toBeUndefined();
  expect(result.plan.unfulfilledRequest?.reason).toContain("not present");
});

test("failed Pi setup or inference preserves the successful Jev usage", async () => {
  const request = "Summarize our navigation decisions.";
  for (const setup of [true, false]) {
    const f = await fixture(request, { request: "answer", paragraph: request });
    if (setup) await rm(join(f.options.agentDir!, "settings.json"));
    else f.options.stream = scripted([() => [call("search_notes", { query: "navigation" })]]);
    let failure: (Error & { usage?: InboxUsage }) | undefined;
    try { await createNoteModel(f.options)(f.context); }
    catch (error) { failure = error as Error & { usage?: InboxUsage }; }
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.usage).toMatchObject({ jevCalls: 1, jevSuccessfulCalls: 1 });
    expect(failure!.usage!.inputTokens).toBe(setup ? 120 : 220);
    expect(failure!.usage!.outputTokens).toBe(setup ? 25 : 45);
    expect(failure!.usage!.provider).toBe(setup ? "typesafe" : "typesafe + openai");
    expect(failure!.usage!.promptRevisions?.some(revision => revision.path.endsWith("note-assistance.json"))).toBe(true);
  }
});

test('Jev-only classification records the truncated input window',async()=>{
 const f=await fixture('Long note\n\n'+'architecture '.repeat(1500));
 const result=await createNoteModel(f.options)(f.context);
 expect(result.usage.notChecked).toContainEqual({area:'classification',reason:'Only the first 12,000 characters were classified; requests beyond that bound were not evaluated'});
});
