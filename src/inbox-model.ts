import {InboxPlanValidationError} from "./inbox-attempts";
import { validateInboxPlan } from "./inbox-repository";

import {recordInboxOmission} from "./inbox-observations";
import { configuredPiAssistant, isolatedAssistantResources, AssistantConfigurationError } from "./pi-assistant-config";
import { join } from "node:path";
import {
  createAgentSession, defineTool, estimateTokens,
  SettingsManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadInboxPrompts, loadNotePrompts, PromptFileError, type InboxPrompts } from "./ai-prompts";
import type { InboxModel, InboxModelContext, InboxPlan, InboxUsage } from "./inbox-types";
import type { Block } from "./types";
import { AssistantSession } from "./assistant-session";
import { resolvePaths } from "./paths";

const JEV_MODEL = "jev-1.13.0";
const JEV_INPUT_PRICE = 0.042 / 1_000_000;
const MAX_SOURCE_CHARS = 60_000;
const READ_CHARS = 12_000;
const SEARCH_LIMIT = 6;
const TOOL_NAMES = ["read_note", "search_notes", "finish_cleanup"];

export interface InboxModelOptions {
  workspaceRoot?: string;
  promptDirectory?: string;
  agentDir?: string;
  sessionDirectory?: string;
  timeoutMs?: number;
  maxTurns?: number;
  maxTotalTokens?: number;
  maxOutputTokens?: number;
  maxToolCalls?: number;
  jevApiKey?: string;
  jevTimeoutMs?: number;
  /** Provider transport seam for deterministic SDK tests; production uses Pi's authenticated runtime. */
  stream?: AgentSession["agent"]["streamFunction"];
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export class InboxModelUnavailableError extends Error {
  usage?: InboxUsage;
  constructor(message = "Inbox model unavailable; check Pi authentication and provider availability") {
    super(message);
    this.name = "InboxModelUnavailableError";
  }
}

/** This note needs intervention; unrelated captures can still be processed. */
export class InboxNoteError extends Error {
  constructor(message: string) { super(message); this.name = "InboxNoteError"; }
}

async function configuration(options: InboxModelOptions, signal?: AbortSignal) {
  try { return await configuredPiAssistant(options.agentDir, signal); }
  catch (error) {
    if (error instanceof AssistantConfigurationError) {
      const message = {
        settings: "Inbox needs a configured model in Pi settings",
        default: "Inbox needs a default provider and model in Pi settings",
        auth: "Inbox needs an available authenticated model in Pi",
        runtime: "Inbox model configuration could not be loaded",
      }[error.code];
      throw new InboxModelUnavailableError(message);
    }
    throw error;
  }
}

export async function checkInboxModelConfiguration(options: InboxModelOptions = {}): Promise<{
  configured: boolean; message: string; provider?: string; model?: string;
}> {
  try {
    const { model } = await configuration(options, AbortSignal.timeout(10_000));
    return {
      configured: true, provider: model.provider, model: model.id,
      message: options.jevApiKey ?? process.env.TYPESAFE_API_KEY
        ? "Inbox editor ready" : "Inbox editor ready; Jev relationship checks are not configured",
    };
  } catch (error) {
    return { configured: false, message: error instanceof InboxModelUnavailableError ? error.message : "Inbox model configuration could not be loaded" };
  }
}

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const id = text(200);
const planSchema = Type.Object({
  summary: text(1600),
  source: Type.Object({
    text: text(MAX_SOURCE_CHARS),
    disposition: Type.Union([Type.Literal("file"), Type.Literal("archive"), Type.Literal("hold")]),
    reason: Type.Optional(text(1600)),
  }, { additionalProperties: false }),
  notes: Type.Array(Type.Object({ text: text(30_000), parentId: Type.Optional(id) }, { additionalProperties: false }), { maxItems: 8 }),
  tasks: Type.Array(Type.Object({
    title: text(250), body: text(20_000),
    priority: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    project: Type.Literal("pi-outliner"), arc: text(100),
    tracks: Type.Array(text(100), { maxItems: 8 }), relatedTo: Type.Optional(Type.Array(id, { maxItems: 8 })),
  }, { additionalProperties: false }), { maxItems: 6 }),
  updates: Type.Array(Type.Object({
    blockId: id, expectedRevision: Type.Integer({ minimum: 1 }), text: text(MAX_SOURCE_CHARS),
  }, { additionalProperties: false }), { maxItems: 4 }),
}, { additionalProperties: false });


function live(block: Block | null): block is Block {
  return !!block && !block.deletedAt && !block.effectiveDeletedRootId;
}

function evidence(block: Block, offset = 0, length = READ_CHARS) {
  return {
    id: block.id, parentId: block.parentId, revision: block.revision, text: block.text.slice(offset, offset + length),
    offset, totalCharacters: block.text.length, complete: offset === 0 && block.text.length <= length,
    nextOffset: offset + length < block.text.length ? offset + length : null,
    author: block.author, createdAt: block.createdAt, updatedAt: block.updatedAt, properties: block.properties,
  };
}

interface Relationship {
  blockId: string; relationship: "duplicate" | "related" | "unrelated";
  confidence: number; probabilities: Record<string, number>; sourceCovered: number;
}

/** Relationships describe only the actual supplied candidate text; retrieval still owns coverage. */
async function relationships(source: Block, candidates: Block[], prompts: InboxPrompts["relationships"], options: InboxModelOptions, signal: AbortSignal, tokenAllowance: number) {
  const apiKey = options.jevApiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey || !candidates.length) return null;
  const questions = Object.fromEntries(candidates.flatMap((_, i) => [
    [`relationship_${i}`, {
      type: "choice",
      instructions: `The candidate is \`candidates[${i}]\`; the source is \`source\`.\n${prompts.relationship.instructions}`,
      criteria: prompts.relationship.criteria,
    }],
    [`covered_${i}`, {
      type: "noul",
      instructions: `The candidate is \`candidates[${i}]\`; the source is \`source\`.\n${prompts.coverage.instructions}`,
      criteria: prompts.coverage.criteria,
    }],
  ]));
  const body = JSON.stringify({ model: JEV_MODEL, state: { source: evidence(source, 0, 18_000), candidates: candidates.map(b => evidence(b, 0, 6000)) }, questions });
  // Estimate before sending and account observed provider usage afterward. Bytes are
  // not tokens: treating them as equal rejected ordinary notes far below the budget.
  if (Math.ceil(body.length / 4) + 2048 > tokenAllowance) return null;
  const response = await (options.fetch ?? fetch)("https://api.typesafe.ai/v1/systemone", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, redirect: "error",
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(options.jevTimeoutMs ?? 8000)]),
  });
  if (!response.ok) throw new Error("Jev relationship checks unavailable");
  const result = await response.json() as {
    answers?: Record<string, { type?: string; choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  const judged: Relationship[] = candidates.map((block, i) => {
    const a = result.answers?.[`relationship_${i}`]; const covered = result.answers?.[`covered_${i}`];
    if (a?.type !== "choice" || !["duplicate", "related", "unrelated"].includes(a.choice ?? "") || !probability(a.confidence)
      || !a.probabilities || !["duplicate", "related", "unrelated"].every(key => probability(a.probabilities![key]))
      || covered?.type !== "noul" || !probability(covered.noul)) throw new Error("Invalid Jev relationship response");
    return { blockId: block.id, relationship: a.choice as Relationship["relationship"], confidence: a.confidence, probabilities: a.probabilities, sourceCovered: covered.noul };
  });
  return { judged, inputTokens: safeTokens(result.usage?.input_tokens), outputTokens: safeTokens(result.usage?.output_tokens) };
}

function safeTokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Total editing run, including every Pi turn and tool call. Never resets on progress. */
export function inboxEditingBudget(env: Record<string, string | undefined> = process.env): number {
  const value = env.OUTLINER_INBOX_TIMEOUT_MS;
  if (value === undefined) return 300_000;
  const budget = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(budget) || budget < 1 || budget > 1_800_000) {
    throw new Error("OUTLINER_INBOX_TIMEOUT_MS must be an integer from 1 to 1800000 (milliseconds)");
  }
  return budget;
}

export function createInboxModel(options: InboxModelOptions = {}): InboxModel {
  const timeoutMs = options.timeoutMs ?? inboxEditingBudget();
  return async (context: InboxModelContext) => {
    const started = performance.now();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([context.signal, deadline]);
    const maxTurns = options.maxTurns ?? 10;
    // This is cumulative across Pi turns (including cached input) and Jev requests,
    // not a single context window. Leave room to retrieve, read, and then edit a note.
    const maxTokens = options.maxTotalTokens ?? 150_000;
    const usage: InboxUsage = { provider: "", model: "", inputTokens: 0, outputTokens: 0, cost: 0, jevCalls: 0, elapsedMs: 0, notChecked: [] };
    usage.jevSuccessfulCalls = 0;
    if (!(options.jevApiKey ?? process.env.TYPESAFE_API_KEY)) usage.jevWarning = "Jev is not configured; Pi edited without relationship judgments";
    if(usage.jevWarning)recordInboxOmission(usage,"relationships",usage.jevWarning);
    const excerpts = new Map<string,number>();
    const reads = new Map<string, { block: Block; ranges: Array<[number, number]> }>();
    const source = structuredClone(context.source);
    let plan: InboxPlan | undefined;
    let rejectedPlan:Error|undefined;
    let session: AgentSession | undefined;
    let trace: AssistantSession | undefined;
    let retainAbort: (() => void) | undefined;
    let searches = 0; let turns = 0; let toolCalls = 0; let contextCharacters = source.text.length;
    let stopped: Error | undefined;
    let providerFailed = false;
    let jevInput = 0; let jevOutput = 0;
    const relationshipCache = new Map<string, Relationship>();
    const snapshotUsage = () => {
      const stats = session?.getSessionStats();
      usage.inputTokens = (stats ? stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite : 0) + jevInput;
      usage.outputTokens = (stats?.tokens.output ?? 0) + jevOutput;
      usage.cost = (stats?.cost ?? 0) + jevInput * JEV_INPUT_PRICE;
      usage.elapsedMs = Math.round(performance.now() - started);
      const partial=[...excerpts].filter(([id,length])=>length>900&&!reads.has(id)).length;
      const incomplete=[...reads.keys()].filter(id=>!fullyRead(id)).length;
      const notChecked=[...usage.notChecked??[]];
      if(partial)notChecked.push({area:"Pi candidate reads",reason:`${partial} retrieved note${partial===1?' was':'s were'} only shown to Pi as search excerpts`});
      if(incomplete)notChecked.push({area:"note reads",reason:`${incomplete} paged read${incomplete===1?' was':'s were'} not completed`});
      return { ...usage, notChecked };
    };
    const interruption = () => context.signal.aborted ? new Error("Inbox cleanup canceled")
      : new InboxNoteError(`Inbox cleanup timed out after ${timeoutMs} ms`);
    const assertActive = () => {
      if (signal.aborted) throw interruption();
      if (stopped) throw stopped;
      if (plan) throw new Error("Inbox cleanup plan is already complete");
    };
    const budget = (message: string): never => { stopped = new Error(message); throw stopped; };
    const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: undefined });
    const recordRead = (block: Block, offset: number, count: number) => {
      const old = reads.get(block.id);
      const ranges = old?.block.revision === block.revision ? old.ranges : [];
      ranges.push([offset, Math.min(block.text.length, offset + count)]);
      reads.set(block.id, { block: structuredClone(block), ranges });
    };
    const fullyRead = (blockId: string) => {
      const read = reads.get(blockId); if (!read) return undefined;
      let end = 0;
      for (const [start, limit] of [...read.ranges].sort((a, b) => a[0] - b[0])) { if (start > end) return undefined; end = Math.max(end, limit); }
      return end >= read.block.text.length ? read.block : undefined;
    };
    try {
      assertActive();
      if (source.text.length > MAX_SOURCE_CHARS) throw new Error("Inbox note exceeds the editor's 60,000-character input limit");
      const prompts = context.purpose === "answer" ? undefined : await loadInboxPrompts(options.promptDirectory);
      let answerPrompt = context.purpose === "answer" ? context.answerPrompt : undefined;
      if (context.purpose === "answer" && !answerPrompt) {
        const captured = await loadNotePrompts(options.promptDirectory);
        answerPrompt = { text: captured.answer, revision: captured.revisions[1]! };
      }
      usage.promptRevisions = answerPrompt ? [answerPrompt.revision] : prompts!.revisions;
      const config = await configuration(options, signal);
      assertActive(); usage.provider = config.model.provider; usage.model = config.model.id;
      const customTools = [
        defineTool({
          name: "read_note", label: "Read note", description: "Read a canonical note and its revision. Follow nextOffset until all text is read before replacing it.",
          parameters: Type.Object({ blockId: id, offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
          async execute(_call, params) {
            assertActive(); context.progress("Reading a related note");
            const block = context.read(params.blockId);
            if (!live(block)) return result({ found: false });
            const offset = params.offset ?? 0;
            if (offset > block.text.length) throw new Error("Read offset exceeds note length");
            contextCharacters += Math.min(READ_CHARS, block.text.length - offset);
            if (contextCharacters > 150_000) budget("Inbox note-reading budget exhausted");
            recordRead(block, offset, READ_CHARS);
            return result(evidence(block, offset));
          },
        }),
        defineTool({
          name: "search_notes", label: "Search notes", description: "Find a bounded shortlist of canonical notes by a short subject query; includes fallible Jev relationship hints when available. Search is not exhaustive.",
          parameters: Type.Object({ query: text(500) }, { additionalProperties: false }),
          async execute(_call, params) {
            assertActive(); searches++; context.progress("Looking for prior notes and related work");
            const candidates = context.search(params.query).filter(b => live(b) && b.id !== source.id).slice(0, SEARCH_LIMIT);
            if(!prompts)recordInboxOmission(usage,"relationships","Relationship judging is not enabled for answer requests");
            recordInboxOmission(usage,"retrieval",`Search used a bounded shortlist of at most ${SEARCH_LIMIT}; other notes were not exhaustively checked`);
            candidates.forEach(block=>excerpts.set(block.id,block.text.length));
            let status = "unavailable";
            const missing = candidates.filter(b => !relationshipCache.has(`${b.id}:${b.revision}`));
            if(prompts && usage.jevCalls>=4 && missing.length)recordInboxOmission(usage,"relationships","Some uncached comparisons were skipped after the four-call limit");
            if (prompts && usage.jevCalls < 4 && missing.length && (options.jevApiKey ?? process.env.TYPESAFE_API_KEY)) {
              usage.jevCalls++; context.progress("Jev is comparing duplicate and related notes");
              try {
                const stats = session?.getSessionStats();
                const hints = await relationships(source, missing, prompts.relationships, options, signal, maxTokens - (stats?.tokens.total ?? 0) - jevInput - jevOutput);
                if (hints) {
                  usage.jevSuccessfulCalls!++;
                  if(source.text.length>18000)recordInboxOmission(usage,"Jev input","Relationship checks saw only the first 18,000 source characters");
                  if(missing.some(block=>block.text.length>6000))recordInboxOmission(usage,"Jev input","Some relationship candidates were limited to their first 6,000 characters");
                  jevInput += hints.inputTokens; jevOutput += hints.outputTokens;
                  missing.forEach((b, i) => relationshipCache.set(`${b.id}:${b.revision}`, hints.judged[i]!));
                } else { usage.jevCalls--; status = "budget"; usage.jevWarning = "Some Jev comparisons were skipped to stay within this note's budget"; recordInboxOmission(usage,"relationships",usage.jevWarning); }
              } catch {
                assertActive();
                // Provider bodies may echo note content or credentials.
                usage.jevWarning = "Some Jev comparisons failed; Pi continued with the retrieved notes"; recordInboxOmission(usage,"relationships",usage.jevWarning);
              }
            }
            assertActive();
            const hints = candidates.flatMap(b => { const hint = relationshipCache.get(`${b.id}:${b.revision}`); return hint ? [hint] : []; });
            if (hints.length) status = hints.length === candidates.length ? "judged" : "partial";
            return result({
              candidates: candidates.map(b => ({
                id: b.id, revision: b.revision, text: b.text.slice(0, 900),
                totalCharacters: b.text.length, complete: b.text.length <= 900,
              })),
              completeness: { kind: "bounded", limit: SEARCH_LIMIT, message: "This shortlist cannot establish absence of other notes." },
              jev: { status, model: JEV_MODEL, relationships: hints },
            });
          },
        }),
        defineTool({
          name: "finish_cleanup", label: "Finish cleanup", description: "Submit the final editorial plan. This records a proposal only; the service checks revisions and applies changes.",
          parameters: planSchema,
          async execute(_call, proposed) {
            assertActive();
            if (context.purpose === "answer" && (proposed.notes.length || proposed.tasks.length || proposed.updates.length || proposed.source.disposition === "archive")) {
              throw new Error("Answer requests can only update their own source note");
            }
            if (context.purpose !== "answer" && !searches && proposed.source.disposition !== "hold") throw new Error("Search prior notes before finishing");
            if (proposed.source.disposition === "hold" && (!proposed.source.reason || proposed.notes.length || proposed.tasks.length || proposed.updates.length || proposed.source.text !== source.text)) {
              throw new Error("A held note needs a specific reason, unchanged source text, and no other changes");
            }
            const updated = new Set<string>();
            for (const update of proposed.updates) {
              const read = fullyRead(update.blockId);
              if (update.blockId === source.id || updated.has(update.blockId)) throw new Error("Use source.text for the source and update each related note at most once");
              if (!read || read.revision !== update.expectedRevision) throw new Error("Read the complete current note before replacing it");
              updated.add(update.blockId);
            }
            for (const note of proposed.notes) if (note.parentId && (!fullyRead(note.parentId) || note.parentId === source.id)) throw new Error("Read a suitable existing container before filing under it");
            for (const task of proposed.tasks) if (task.relatedTo?.some(blockId => !fullyRead(blockId))) throw new Error("Read related work before linking a task");
            try {
              validateInboxPlan(proposed);
              context.validatePlan?.(proposed);
            } catch(error){
              rejectedPlan=error instanceof Error?error:new Error(String(error));
              throw rejectedPlan;
            }
            rejectedPlan=undefined;
            plan = structuredClone(proposed);
            return { ...result({ accepted: true }), terminate: true };
          },
        }),
      ];
      if (context.inventory) customTools.push(defineTool({
        name: "property_inventory", label: "Property inventory", description: "Read exact property values and block counts from the service. Completeness is explicit; a truncated page is not a complete inventory.",
        parameters: Type.Object({ key: text(100) }, { additionalProperties: false }),
        async execute(_call, params) { assertActive(); const inventory=context.inventory!(params.key);
          if(!inventory.complete)recordInboxOmission(usage,"inventory","Property inventory was incomplete");
          return result(inventory); },
      }) as typeof customTools[number]);
      const workspaceRoot = options.workspaceRoot ?? process.cwd();
      trace = new AssistantSession(workspaceRoot, options.sessionDirectory ?? join(
        resolvePaths({ ...process.env, OUTLINER_WORKSPACE_ROOT: workspaceRoot }).stateDir, "assistant-sessions",
      ), source.id, context.purpose ?? "edit");
      const retain = (outcome: "completed" | "failed" | "canceled") => {
        usage.piSessions = [trace!.finish(outcome)];
        context.reportUsage?.(snapshotUsage());
      };
      retainAbort = () => retain(context.signal.aborted ? "canceled" : "failed");
      signal.addEventListener("abort", retainAbort, { once: true });
      assertActive();
      const created = await createAgentSession({
        cwd: options.workspaceRoot ?? process.cwd(), agentDir: config.agentDir, model: config.model,
        modelRuntime: config.runtime, thinkingLevel: config.thinkingLevel,
        tools: [...TOOL_NAMES, ...(context.inventory ? ["property_inventory"] : [])], noTools: "builtin", customTools, resourceLoader: isolatedAssistantResources(answerPrompt?.text ?? prompts!.editor),
        sessionManager: trace.manager,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: timeoutMs } },
          enableSkillCommands: false, enableAnalytics: false, enableInstallTelemetry: false,
        }),
      });
      session = created.session;
      assertActive();
      const stream = options.stream ?? session.agent.streamFunction.bind(session.agent);
      session.agent.streamFunction = (model, modelContext, streamOptions) => {
        assertActive();
        if (++turns > maxTurns) budget("Inbox editor turn budget exhausted");
        const stats = session!.getSessionStats();
        const consumed = stats.tokens.total + jevInput + jevOutput;
        const inputAllowance = modelContext.messages.reduce((sum, message) => sum + estimateTokens(message), 0)
          + Math.ceil(JSON.stringify({ system: modelContext.systemPrompt, tools: modelContext.tools }).length / 4) + 2048;
        if (consumed + inputAllowance >= maxTokens) budget("Inbox editor token budget exhausted");
        const phase = `Editing note · turn ${turns}/${maxTurns}`;
        trace!.progress(phase);
        context.progress(phase);
        return stream(model, modelContext, {
          ...streamOptions, maxTokens: Math.min(options.maxOutputTokens ?? 5000, maxTokens - consumed - inputAllowance),
          signal: AbortSignal.any([signal, ...(streamOptions?.signal ? [streamOptions.signal] : [])]), maxRetries: 0,
        });
      };
      const beforeTool = session.agent.beforeToolCall;
      session.agent.beforeToolCall = async (call, toolSignal) => {
        assertActive();
        if (++toolCalls > (options.maxToolCalls ?? 20)) budget("Inbox editor tool budget exhausted");
        return beforeTool?.(call, toolSignal);
      };
      session.agent.toolExecution = "sequential";
      session.agent.shouldStopAfterTurn = () => !!plan || !!stopped || signal.aborted;
      session.subscribe(event => {
        if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") providerFailed = true;
        if (event.type === "tool_execution_start") trace!.progress(`Tool: ${event.toolName}`);
        if(event.type === "message_end"&&event.message.role==="toolResult"&&event.message.toolName==="finish_cleanup"&&event.message.isError){
          const message=event.message.content.filter(part=>part.type==="text").map(part=>part.text).join("\n");
          rejectedPlan=new InboxPlanValidationError("finish_cleanup",message.slice(0,1600));
        }
      });
      let rejectAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => { session?.agent.abort(); reject(interruption()); };
        signal.addEventListener("abort", rejectAbort, { once: true });
      });
      try {
        await Promise.race([
          session.prompt(JSON.stringify({
            instruction: context.purpose === "answer" ? "Fulfill this current request in its own note. Read evidence and submit the answer with finish_cleanup." : "Edit and organize this Inbox capture. Search existing notes, then submit the useful result with finish_cleanup.",
            source: evidence(source, 0, MAX_SOURCE_CHARS),
            ...(context.requestText ? { currentRequest: context.requestText } : {}),
            ...(context.instructions ? { userPreferences: context.instructions.slice(0, 12_000) } : {}),
          }), { expandPromptTemplates: false }), aborted,
        ]);
      } finally { if (rejectAbort) signal.removeEventListener("abort", rejectAbort); }
      if (signal.aborted) throw interruption();
      if (stopped) throw stopped;
      if (providerFailed) throw new InboxModelUnavailableError();
      if (!plan) throw rejectedPlan??new Error("Inbox editor did not return a cleanup plan");
      const measured = snapshotUsage();
      if (measured.inputTokens + measured.outputTokens > maxTokens) budget("Inbox editor token budget exhausted");
      retain("completed");
      return { plan, usage: snapshotUsage() };
    } catch (error) {
      let failure: Error;
      if (signal.aborted) failure = interruption();
      else if (stopped) failure = rejectedPlan?new InboxPlanValidationError("finish_cleanup",`${stopped.message}; last rejected proposal: ${rejectedPlan.message}`):new InboxNoteError(stopped.message);
      else if (error instanceof InboxPlanValidationError) failure = error;
      else if (error instanceof PromptFileError) failure = error;
      else if (error instanceof InboxModelUnavailableError) failure = error;
      // Known local validation failures are useful; provider/auth error bodies are not safe UI text.
      else if (error instanceof Error && /^(Inbox note exceeds|Inbox editor did not)/.test(error.message)) failure = new InboxNoteError(error.message);
      else failure = new InboxModelUnavailableError();
      // An interrupted provider may not report its final usage; this is observed usage, not a billing receipt.
      // Configuration failures made no inference attempt and have no valid provider usage to persist.
      if (trace) usage.piSessions = [trace.finish(context.signal.aborted ? "canceled" : "failed")];
      if (usage.provider) {
        const measured = snapshotUsage();
        Object.assign(failure, { usage: measured });
        context.reportUsage?.(measured);
      }
      throw failure;
    } finally {
      if (retainAbort) signal.removeEventListener("abort", retainAbort);
      session?.agent.abort(); session?.dispose();
    }
  };
}
