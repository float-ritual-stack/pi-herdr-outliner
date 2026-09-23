import type { Block, PropertyInventory, RoadmapItemPriority } from "./types";
import type { PromptRevision } from "./ai-prompts";
import type { AssistantSessionEvidence } from "./assistant-session";

/** A single editorial decision. The service applies it; models never write directly. */
export interface InboxPlan {
  summary: string;
  source: { text: string; disposition: "file" | "archive" | "hold"; reason?: string };
  notes: Array<{ text: string; parentId?: string }>;
  tasks: Array<{
    title: string; body: string; priority: RoadmapItemPriority; project: string;
    arc: string; tracks: string[]; relatedTo?: string[];
  }>;
  updates: Array<{ blockId: string; expectedRevision: number; text: string }>;
}

export interface InboxUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  jevCalls: number;
  jevSuccessfulCalls?: number;
  jevWarning?: string;
  /** Wall time inside model work (summed sequential phases), excluding queue wait and commit. */
  elapsedMs: number;
  /** Absent on legacy attempts: coverage was not recorded. */
  notChecked?: Array<{area:string;reason:string}>;
  promptRevisions?: PromptRevision[];
  piSessions?: AssistantSessionEvidence[];
}

/** Optional additive detail on inbox.result; absent on older services or attempts without recovery. */
export interface InboxResultDetail extends InboxResult {
  beforeSource?: { id: string; text: string; revision: number };
}

export interface InboxResult {
  id: string;
  kind?: "organized" | "fulfilled" | "unfulfilled";
  sourceId: string;
  sourceTitle: string;
  summary: string;
  state: "applied" | "held" | "failed" | "undone" | "canceled";
  outputIds: string[];
  createdAt: string;
  error?: string;
  usage?: InboxUsage;
}

/** Routine progress/history reads carry prompt identities, not every historical body. */
export type InboxResultSummary = Omit<InboxResult, "usage"> & {
  usage?: Omit<InboxUsage, "promptRevisions"> & {
    promptRevisions?: Array<Omit<PromptRevision, "text">>;
  };
};

export interface InboxStatus {
  enabled: boolean;
  paused: boolean;
  state: "idle" | "working" | "paused" | "unavailable";
  message: string;
  pending: number;
  current?: { id: string; title: string };
  results: InboxResultSummary[];
  resultsTruncated: boolean;
  attentionCount: number;
  attentionOnly: boolean;
  resultsOffset: number;
}

export interface InboxModelContext {
  source: Block;
  /** Read and search only. Read results are tracked for commit-time freshness. */
  read: (blockId: string) => Block | null;
  search: (query: string) => Block[];
  purpose?: "edit" | "answer";
  requestText?: string;
  answerPrompt?: { text: string; revision: PromptRevision };
  inventory?: (key: string) => PropertyInventory;
  instructions?: string;
  signal: AbortSignal;
  progress: (message: string) => void;
  /** Retain available attempt evidence even when the worker's cancellation wins. */
  reportUsage?: (usage: InboxUsage) => void;
}

export type InboxModel = (context: InboxModelContext) => Promise<{ plan: InboxPlan; usage: InboxUsage }>;
