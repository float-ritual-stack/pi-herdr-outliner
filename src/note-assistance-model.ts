import {chooseInboxRoute} from "./inbox-routing";
import {recordInboxOmission} from "./inbox-observations";
import { combinedInboxUsage } from "./inbox-usage";
import { createHash } from "node:crypto";
import { loadNotePrompts,loadInboxRoutingPrompt } from "./ai-prompts";
import { createInboxModel, type InboxModelOptions } from "./inbox-model";
import type { InboxUsage } from "./inbox-types";
import type { NoteCandidate, NotePlan } from "./note-assistance-types";
import type { Block, PropertyInventory } from "./types";
import { contentOfText, passageKey, requestPassages } from "./note-content";

export interface NoteModelContext {
  candidate: NoteCandidate;
  routeInbox?: {hasChildren:boolean};
  tags: string[];
  propertyKeys: string[];
  read: (id: string) => Block | null;
  search: (query: string) => Block[];
  inventory: (key: string) => PropertyInventory;
  signal: AbortSignal;
  progress: (message: string) => void;
  reportUsage?: (usage: InboxUsage) => void;
  /** The `@name`s extensions' agents answer: their lines are requests to them, never to note assistance. */
  agentNames?: () => ReadonlySet<string>;
}

export type NoteModel = (context: NoteModelContext) => Promise<{ plan: NotePlan; usage: InboxUsage }>;

const MODEL = "jev-1.13.0";
const stopWords = new Set("about after again also another before being block blocks could from have here into just like more note notes other our some system that their them there these they thing things this those type types value values want what when where which while with would your from been does each every first found list make much need only should than then through using used will were work".split(" "));

/** Calendar candidates come from authored content, never storage timestamps. */
export function noteTagCandidates(content: string, known: string[], rejected: string[] = []): string[] {
  const candidates: string[] = [];
  for (const match of content.matchAll(/\b(?:q([1-4])\s*[-,/]?\s*((?:19|20)\d{2})|((?:19|20)\d{2})\s*[-/]?\s*q([1-4]))\b/gi)) {
    candidates.push(`y${match[2] ?? match[3]}/q${match[1] ?? match[4]}`);
  }
  for (const match of content.matchAll(/\b((?:19|20)\d{2})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?\b/g)) {
    if (match[3] && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDate() !== Number(match[3])) continue;
    candidates.push(`y${match[1]}/m${match[2]}${match[3] ? `/d${match[3]}` : ""}`);
  }
  for (const match of content.matchAll(/\b((?:19|20)\d{2})[- /]?w(?:eek\s*)?(0?[1-9]|[1-4]\d|5[0-3])\b/gi)) candidates.push(`y${match[1]}/w${match[2]!.padStart(2, "0")}`);
  candidates.push(...known.slice(0, 30));
  const words = new Map<string, number>();
  for (const match of content.matchAll(/\b[a-z][a-z-]{3,35}\b/gi)) {
    const word = match[0].toLowerCase().replace(/-+$/, "");
    if (!stopWords.has(word)) words.set(word, (words.get(word) ?? 0) + 1);
  }
  candidates.push(...[...words].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([word]) => word));
  const excluded = new Set(rejected.map(value => value.toLowerCase()));
  return [...new Set(candidates.map(value => value.toLowerCase()))].filter(value =>
    value.length <= 80 && /[\p{L}]/u.test(value) && /^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(value) && !excluded.has(value),
  ).slice(0, 48);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function tableCell(value: string): string {
  // Inventory values are literal data, including hashes that would otherwise
  // become authored tags. Escape backslashes with the Markdown punctuation so
  // a value containing "\\|" cannot turn the pipe into a table separator.
  return value.replace(/[\r\n]/g, " ").replace(/([\\`*_[\]{}()#+.!|<>&~-])/g, "\\$1");
}

export function inventoryAnswer(inventory: PropertyInventory, observedAt: string): string {
  if (!inventory.complete) throw new Error("Property inventory is truncated; the request was not fulfilled");
  return `## Result — ${observedAt}\n\n` +
    `Complete inventory of **${inventory.totalValues} distinct ${inventory.key} values**, from ${inventory.matchedBlocks} of ${inventory.totalBlocks} active canonical blocks. ` +
    `Scope: ${inventory.propertyScope}; excludes Trash and projected duplicates. Counts are distinct blocks per value. Observed workspace sequence: ${inventory.sequence}.\n\n` +
    `| ${tableCell(inventory.key)} | Blocks |\n| --- | ---: |\n` +
    inventory.items.map(item => `| ${tableCell(item.value)} | ${item.count} |`).join("\n");
}

export function createNoteModel(options: InboxModelOptions = {}): NoteModel {
  const answer = createInboxModel(options);
  return async context => {
    const started = performance.now();
    const prompts = await loadNotePrompts(options.promptDirectory);
    const routing=context.routeInbox?await loadInboxRoutingPrompt(options.promptDirectory):undefined;
    const apiKey = options.jevApiKey ?? process.env.TYPESAFE_API_KEY;
    if (!apiKey) throw new Error("Note organization needs TypeSafe/Jev configuration");
    const source = context.candidate.source;
    const content = contentOfText(source.text);
    const excerpt = content.slice(0, 12_000);
    const candidates = noteTagCandidates(excerpt, context.tags, context.candidate.rejectedTags);
    const seen = new Set(context.candidate.seenRequestPassages ?? []);
    const eligiblePassages = requestPassages(excerpt, context.agentNames?.()).filter(text => context.candidate.explicitReconsideration || !seen.has(passageKey(text)));
    const paragraphs = eligiblePassages.filter(text => text.length < 2000).slice(0, 16);
    const keys = [...new Set(["type", "tag", ...context.propertyKeys])].slice(0, 120);
    const mayRequest = context.candidate.requestAllowed && content.length <= 12_000 && paragraphs.length > 0;
    const questions: Record<string, unknown> = {
      ...(routing?.policy.enabled?{inbox_route:{type:"choice",...routing.policy.route},inbox_disposable:{type:"noul",instructions:routing.policy.disposable}}:{}),
      ...(!context.candidate.typeLocked ? { type: { type: "choice", ...prompts.type } } : {}),
      ...Object.fromEntries(candidates.map((tag, index) => [`tag_${index}`, { type: "noul", instructions: `${prompts.tag.instructions}\nCandidate tag: ${tag}` }])),
      ...(mayRequest ? {
        request: { type: "choice", ...prompts.request },
        paragraph: { type: "choice", instructions: prompts.requestParagraph,
          criteria: { none: "No fresh direct request", ...Object.fromEntries(paragraphs.map((text, index) => [`p${index}`, text])) } },
        key: { type: "choice", instructions: prompts.inventoryKey,
          criteria: { none: "No single supplied key is explicitly requested", ...Object.fromEntries(keys.map((key, index) => [`k${index}`, key])) } },
      } : {}),
    };
    context.progress("Jev is organizing the note and checking for a current request");
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(options.jevTimeoutMs ?? 15_000)]);
    const response = await (options.fetch ?? fetch)("https://api.typesafe.ai/v1/systemone", {
      method: "POST", redirect: "error", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ model: MODEL, state: { note: excerpt, complete: content.length <= excerpt.length,
        existingProperties: source.properties.filter(property => !["captured-at", "captured-from", "capture-source"].includes(property.key)),
        context: { currentRequestEligible: mayRequest, explicitReconsideration: context.candidate.explicitReconsideration === true,
          eligibleRequestPassages: paragraphs,
          typeLocked: context.candidate.typeLocked, rejectedTags: context.candidate.rejectedTags,
          ...(context.candidate.instructions ? { userPreferences: context.candidate.instructions } : {}) } }, questions }),
    });
    if (!response.ok) throw new Error("Note organization provider is unavailable");
    let decoded: unknown;
    try { decoded = await response.json(); }
    catch { throw new Error("Invalid note classification response"); }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Invalid note classification response");
    const raw = decoded as { answers?: Record<string, { type?: string; choice?: string; confidence?: number; noul?: number }>; usage?: { input_tokens?: number; output_tokens?: number } };
    const choice = (key: string, allowed: string[]): { value: string; confidence: number } => {
      const value = raw.answers?.[key];
      if (value?.type !== "choice" || !allowed.includes(value.choice ?? "") || !probability(value.confidence)) throw new Error("Invalid note classification response");
      return { value: value.choice!, confidence: value.confidence };
    };
    const type = context.candidate.typeLocked ? undefined : choice("type", Object.keys(prompts.type.criteria));
    const tags = candidates.map((tag, index) => {
      const value = raw.answers?.[`tag_${index}`];
      if (value?.type !== "noul" || !probability(value.noul)) throw new Error("Invalid note tag response");
      return { tag, probability: value.noul };
    }).filter(value => value.probability >= prompts.thresholds.tag).sort((a, b) => b.probability - a.probability).slice(0, 5).map(value => value.tag);
    const plan: NotePlan = { summary: "Organized note metadata", tags,
      ...(type && type.confidence >= prompts.thresholds.type ? { type: type.value } : {}) };
    const tokens = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    const usage: InboxUsage = { provider: "typesafe", model: MODEL, inputTokens: tokens(raw.usage?.input_tokens), outputTokens: tokens(raw.usage?.output_tokens),
      cost: tokens(raw.usage?.input_tokens) * 0.042 / 1_000_000, jevCalls: 1, jevSuccessfulCalls: 1, elapsedMs: Math.round(performance.now() - started), promptRevisions: prompts.revisions, notChecked: [] };
    if(content.length>excerpt.length)recordInboxOmission(usage,"classification","Only the first 12,000 characters were classified; requests beyond that bound were not evaluated");
    if(eligiblePassages.length>paragraphs.length)recordInboxOmission(usage,"request passages","Only up to 16 fresh passages shorter than 2,000 characters were considered for requests");
    if(routing){
      usage.promptRevisions!.push(routing.revision);
      plan.inboxRoute=chooseInboxRoute(raw.answers,routing.policy,{complete:content.length<=excerpt.length,hasChildren:context.routeInbox!.hasChildren,steered:!!context.candidate.instructions||context.candidate.explicitReconsideration===true});
      if(plan.inboxRoute.route==='keep'||plan.inboxRoute.route==='archive'){plan.tags=[...context.candidate.inferredTags];delete plan.type;}
    }
    const addAnswerUsage = (additional: InboxUsage) => Object.assign(usage, combinedInboxUsage(usage, additional));
    if (mayRequest) {
      const request = choice("request", Object.keys(prompts.request.criteria));
      if (request.value === "none" || request.confidence < prompts.thresholds.request) return { plan, usage };
      const paragraph = choice("paragraph", ["none", ...paragraphs.map((_, index) => `p${index}`)]);
      const requestText = paragraph.value === "none" ? undefined : paragraphs[Number(paragraph.value.slice(1))];
      if (requestText && request.confidence >= prompts.thresholds.request && paragraph.confidence >= prompts.thresholds.request) {
        let key = "";
        if (request.value === "property-inventory") {
          const selected = choice("key", ["none", ...keys.map((_, index) => `k${index}`)]);
          if (selected.value !== "none" && selected.confidence >= prompts.thresholds.request) key = keys[Number(selected.value.slice(1))]!;
        }
        const requestKey = createHash("sha256").update(`${request.value}:${key}:${requestText.replace(/\s+/g, " ")}`).digest("hex");
        if (requestKey !== context.candidate.lastRequestKey) {
          if (request.value === "property-inventory" && key) {
            const inventory = context.inventory(key);
            if (inventory.complete) {
              plan.fulfillment = { key: requestKey, operation: "property-inventory", summary: `Listed all ${inventory.totalValues} distinct ${key} values`,
                text: `${source.text.trim()}\n\n${inventoryAnswer(inventory, new Date().toISOString())}` };
            } else {
              plan.unfulfilledRequest = { key: requestKey, reason: "The property inventory is incomplete; a partial list cannot fulfill this request" };
              recordInboxOmission(usage,"inventory","Property inventory was incomplete");
            }
          } else if (request.value === "answer") {
            context.progress("Reading Outliner evidence and writing the requested answer");
            let result;
            try {
              result = await answer({ source, purpose: "answer", requestText, read: context.read, search: context.search, inventory: context.inventory,
                instructions: context.candidate.instructions,
                answerPrompt: { text: prompts.answer, revision: prompts.revisions.find(revision => revision.path.endsWith("note-answer.md"))! },
                signal: context.signal, progress: context.progress,
                reportUsage: additional => context.reportUsage?.(combinedInboxUsage(usage, additional)),
              });
            } catch (error) {
              const failure = error instanceof Error ? error : new Error("Note answer failed");
              const additional = (failure as Error & { usage?: InboxUsage }).usage;
              if (additional) addAnswerUsage(additional);
              usage.elapsedMs = Math.round(performance.now() - started);
              throw Object.assign(failure, { usage });
            }
            addAnswerUsage(result.usage);
            if (result.plan.source.disposition === "file") plan.fulfillment = { key: requestKey, operation: "answer", text: result.plan.source.text, summary: result.plan.summary };
            else plan.unfulfilledRequest = { key: requestKey, reason: result.plan.source.reason ?? "Insufficient evidence to answer this request" };
          } else if (request.value === "unsupported") {
            plan.unfulfilledRequest = { key: requestKey, reason: "This request needs actions outside automatic note assistance" };
          } else if (request.value === "property-inventory") {
            plan.unfulfilledRequest = { key: requestKey, reason: "No single supplied property key was confidently identified for the inventory" };
          }
          if (plan.unfulfilledRequest) plan.summary = `Request remains open: ${plan.unfulfilledRequest.reason}`;
        }
      }
    }
    usage.elapsedMs = Math.round(performance.now() - started);
    return { plan, usage };
  };
}
