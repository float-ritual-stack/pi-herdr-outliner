import type { Block } from "./types";

export interface NoteCandidate {
  source: Block;
  inferredType?: string;
  inferredTags: string[];
  rejectedTags: string[];
  typeLocked: boolean;
  requestAllowed: boolean;
  /** Explicit permission to act on this note, including an older request. */
  explicitReconsideration?: boolean;
  /** Previously observed prose request passages; new notes have none. */
  seenRequestPassages?: string[];
  lastRequestKey?: string;
  /** One explicit reconsideration's direction; absent on ordinary background runs. */
  instructions?: string;
}

/** The service owns metadata and commits a bounded result; the model never writes. */
export interface NotePlan {
  summary: string;
  inboxRoute?: import("./inbox-routing").InboxRoutingDecision;
  type?: string;
  tags: string[];
  fulfillment?: {
    key: string;
    operation: "property-inventory" | "answer";
    /** Complete authored text for this same note, not a second output block. */
    text: string;
    summary: string;
  };
  /** A new user request was recognized, but no supported result could be produced. */
  unfulfilledRequest?: { key: string; reason: string };
}
