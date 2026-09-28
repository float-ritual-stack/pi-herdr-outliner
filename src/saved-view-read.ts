import type { OutlinerClient } from "./client";
import type { SavedViewReadOptions, SavedViewReadResult } from "./types";

export type { SavedViewReadOptions, SavedViewReadResult } from "./types";

/**
 * Read a saved view's members through the service's `views.read`, which evaluates
 * membership with Tree's semantics in one transaction. No pane or selection changes.
 */
export async function readSavedView(
  client: Pick<OutlinerClient, "request">,
  viewId: string,
  options: SavedViewReadOptions = {},
): Promise<SavedViewReadResult> {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000)) {
    throw new Error("View read limit must be an integer from 1 through 1000");
  }
  if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) {
    throw new Error("View read offset must be a non-negative integer");
  }
  if (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1)) {
    throw new Error("Expected view revision must be a positive integer");
  }
  return client.request<SavedViewReadResult>({
    action: "views.read",
    viewId,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.offset === undefined ? {} : { offset: options.offset }),
    ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
  });
}
