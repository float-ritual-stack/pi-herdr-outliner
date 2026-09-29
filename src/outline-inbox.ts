import { join } from "node:path";
import { checkInboxModelConfiguration, createInboxModel, inboxEditingBudget } from "./inbox-model";
import { createNoteModel } from "./note-assistance-model";
import type { OutlinerServer } from "./server";

export interface OutlineInboxOptions {
  workspaceRoot: string;
  promptDirectory: string;
  /** The outline's side folder; assistant sessions live in `assistant-sessions/` beneath it. */
  stateDirectory: string;
  /** True once the service is stopping; a late configuration result is then dropped. */
  stopped: () => boolean;
}

/**
 * Starts one outline's Inbox agent once its provider configuration loads. Socket
 * readiness and capture saves never wait for it. Used by the single-outline
 * service and by the outline host for each outline it opens.
 */
export function startOutlineInbox(server: OutlinerServer, options: OutlineInboxOptions): void {
  if (process.env.OUTLINER_INBOX_AGENT === "0") return;
  server.setInboxUnavailable("Checking Inbox agent configuration");
  void checkInboxModelConfiguration({ workspaceRoot: options.workspaceRoot }).then(configuration => {
    if (options.stopped()) return;
    if (configuration.configured) {
      let timeoutMs: number;
      try { timeoutMs = inboxEditingBudget(); }
      catch (error) { server.setInboxUnavailable((error as Error).message); return; }
      const modelOptions = {
        timeoutMs, workspaceRoot: options.workspaceRoot, promptDirectory: options.promptDirectory,
        sessionDirectory: join(options.stateDirectory, "assistant-sessions"),
      };
      server.enableInbox(createInboxModel(modelOptions), process.env.TYPESAFE_API_KEY && process.env.OUTLINER_NOTE_ASSISTANCE !== "0"
        ? createNoteModel(modelOptions) : undefined);
    }
    else server.setInboxUnavailable(configuration.message);
  }).catch(() => {
    if (!options.stopped()) server.setInboxUnavailable("Inbox model configuration could not be loaded");
  });
}
