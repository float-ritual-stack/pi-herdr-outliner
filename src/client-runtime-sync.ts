import { hostname } from "node:os";
import { OutlinerClient } from "./client";
import { HerdrRuntimeRegistry } from "./herdr-registry";
import { HerdrRegistryRunner } from "./herdr-runtime";
import type { OutlinerClientRuntime } from "./types";

const RUNTIME_FIELDS = [
  "hostname",
  "paneId",
  "terminalId",
  "workspaceId",
  "tabId",
  "paneX",
  "paneY",
  "focused",
  "visible",
] as const;

function sameRuntime(
  left: OutlinerClientRuntime | undefined,
  right: OutlinerClientRuntime | undefined,
): boolean {
  return RUNTIME_FIELDS.every((field) => left?.[field] === right?.[field]);
}

function runtimeForTerminal(
  registry: HerdrRuntimeRegistry,
  terminalId: string,
): OutlinerClientRuntime {
  const host = hostname();
  const paneId = registry.paneIdForTerminal(terminalId);
  const pane = paneId === undefined ? undefined : registry.panes.get(paneId);
  if (pane === undefined) return { hostname: host, terminalId };
  const positioned = registry.layouts.get(pane.tab_id)?.panes
    .find((candidate) => candidate.pane_id === pane.pane_id);
  const rect = positioned?.rect;
  return {
    hostname: host,
    paneId: pane.pane_id,
    terminalId: pane.terminal_id,
    workspaceId: pane.workspace_id,
    tabId: pane.tab_id,
    ...(rect === undefined ? {} : { paneX: rect.x, paneY: rect.y }),
    focused: registry.focusedPaneId === pane.pane_id,
    visible:
      (registry.focusedWorkspaceId === null || registry.focusedWorkspaceId === pane.workspace_id) &&
      (registry.focusedTabId === null || registry.focusedTabId === pane.tab_id),
  };
}

export interface ClientRuntimeSync {
  suspend(): void;
  synchronize(): Promise<void>;
  stop(): Promise<void>;
}

export function startClientRuntimeSync(options: {
  client: OutlinerClient;
  clientId: string;
  initialRuntime: OutlinerClientRuntime | undefined;
  herdrSocketPath: string | undefined;
  onError(error: Error): void;
}): ClientRuntimeSync | null {
  const terminalId = options.initialRuntime?.terminalId;
  const herdrSocketPath = options.herdrSocketPath?.trim();
  if (!terminalId || !herdrSocketPath) return null;

  const registry = new HerdrRuntimeRegistry();
  const runner = new HerdrRegistryRunner(registry, herdrSocketPath, {
    diagnostic: () => {},
    includePaneAgentStatus: false,
  });
  let stopped = false;
  let active = false;
  let revision = -1;
  let lastRuntime = options.initialRuntime;
  let pending = Promise.resolve();

  const schedule = (force: boolean): Promise<void> => {
    if (stopped || (!force && !active)) return pending;
    if (!force && revision === registry.revision) return pending;
    pending = pending.then(async () => {
      const observedRevision = registry.revision;
      if (!force && revision === observedRevision) return;
      const runtime = registry.phase === "ready"
        ? runtimeForTerminal(registry, terminalId)
        : lastRuntime;
      if (!force && sameRuntime(lastRuntime, runtime)) {
        revision = observedRevision;
        return;
      }
      await options.client.request({
        action: "clients.update",
        clientId: options.clientId,
        runtime,
      });
      lastRuntime = runtime;
      revision = observedRevision;
    }).catch((error) => {
      options.onError(error instanceof Error ? error : new Error(String(error)));
    });
    return pending;
  };

  runner.start();
  const timer = setInterval(() => void schedule(false), 250);
  return {
    suspend() {
      active = false;
    },
    synchronize() {
      active = true;
      return schedule(true);
    },
    async stop() {
      if (stopped) return;
      active = false;
      stopped = true;
      clearInterval(timer);
      await runner.stop();
      await pending;
    },
  };
}
