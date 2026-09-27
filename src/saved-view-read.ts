import type { OutlinerClient } from "./client";
import type { BlockCollectionCompleteness, VisibleBlock, VisibleBlockCollection, WorkspaceSnapshot } from "./types";
import { evaluateVirtualBranchMatches, isVirtualBranchDefinition } from "./virtual-branches";

export interface SavedViewReadOptions {
  /** An explicit bounded override; the authored limit remains unchanged. */
  limit?: number;
  expectedRevision?: number;
}

export interface SavedViewReadResult {
  status: "ready" | "invalid" | "unsupported" | "missing" | "changed" | "failed";
  viewId: string;
  revision?: number;
  sequence: number;
  configuredLimit?: number;
  effectiveLimit?: number;
  /** Matching canonical roots, in branch order. Context children are not matches. */
  blocks: VisibleBlock[];
  completeness: BlockCollectionCompleteness | null;
  errors: string[];
}

/** Read membership using Tree's evaluator without touching a pane or selection. */
export async function readSavedView(
  client: Pick<OutlinerClient, "request">,
  viewId: string,
  options: SavedViewReadOptions = {},
): Promise<SavedViewReadResult> {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000)) {
    throw new Error("View read limit must be an integer from 1 through 1000");
  }
  if (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1)) {
    throw new Error("Expected view revision must be a positive integer");
  }
  const snapshot = await client.request<WorkspaceSnapshot>({ action: "workspace.snapshot" });
  const result: SavedViewReadResult = {
    status: "missing", viewId, sequence: snapshot.sequence, blocks: [], completeness: null, errors: [],
  };
  if (snapshot.physical.completeness.kind !== "complete") {
    return { ...result, status: "failed", errors: ["Workspace definition snapshot is incomplete; retry the read"] };
  }
  const definition = snapshot.physical.blocks.find(block => block.id === viewId);
  if (!definition) return { ...result, errors: ["Saved view not found in the active workspace"] };
  result.revision = definition.revision;
  if (options.expectedRevision !== undefined && definition.revision !== options.expectedRevision) {
    return { ...result, status: "changed", errors: ["Saved view revision changed; read the current definition before retrying"] };
  }
  if (!isVirtualBranchDefinition(definition)) {
    return { ...result, status: "unsupported", errors: ["This reader supports type=virtual-branch; other view kinds are not substituted with a property query"] };
  }
  const { roots, state } = await evaluateVirtualBranchMatches(
    definition, snapshot.physical.blocks,
    query => client.request<VisibleBlockCollection>({ action: "blocks.query", query }),
    snapshot.virtualOccurrenceRanks, options.limit,
  );
  if (!state.config) return { ...result, status: "invalid", errors: state.configurationErrors };
  result.configuredLimit = state.config.limit;
  result.effectiveLimit = options.limit ?? state.config.limit;
  if (state.queryError) return { ...result, status: "failed", errors: [state.queryError] };
  // Separate RPC reads may straddle a definition, item or rank mutation. Never
  // label that mixture complete; callers can deliberately retry a changed read.
  const latest = await client.request<WorkspaceSnapshot>({ action: "workspace.snapshot" });
  if (latest.sequence !== snapshot.sequence) {
    return { ...result, status: "changed", errors: ["Workspace changed while reading the saved view; retry for a consistent result"] };
  }
  return { ...result, status: "ready", blocks: roots, completeness: state.completeness };
}
