import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  ATTENTION_MAX_SUPPORTING_MARKS,
  attentionClientState,
  attentionSourceState,
  emptyAttentionState,
  normalizeAttentionMark,
} from "./attention";
import type { HerdrRuntimeRegistry } from "./herdr-registry";
import { isFragmentId, resolveFragment } from "./fragments";
import { OutlinerStore } from "./store";
import { WorkflowManager } from "./workflows";
import {
  OUTLINER_PROTOCOL_VERSION,
  type AnnotationBatchReceipt,
  type AttentionClientState,
  type AttentionMark,
  type AttentionMarkInput,
  type Block,
  type BrowsingContextPublication,
  type CaptureReceipt,
  type DeliveryReceipt,
  type NavigationState,
  type OutlinerClientRegistration,
  type OutlinerClientRole,
  type OutlinerClientRuntime,
  type OutlinerEvent,
  type OutlinerEventEnvelope,
  type OutlinerNavigationDispatch,
  type OutlinerNavigationIntent,
  type PageAddressFollowResult,
  type OutlinerRequest,
  type RoadmapItemCreateReceipt,
  type OutlinerResponse,
  type WorkflowRun,
  type WorkflowStartInput,
  type WorkflowTransitionInput,
  type SelectionContext,
} from "./types";

export class OutlinerServer {
  private server: Server | null = null;
  private readonly subscribers = new Map<Socket, OutlinerClientRegistration>();
  private readonly browsingContextTargets = new Map<string, string | null>();
  private readonly attentionStates = new Map<string, AttentionClientState>();
  private readonly attentionTimers = new Map<string, Timer>();
  private readonly workflows: WorkflowManager;

  constructor(
    readonly store: OutlinerStore,
    readonly socketPath: string,
    readonly herdrRegistry?: HerdrRuntimeRegistry,
  ) {
    this.workflows = new WorkflowManager(store);
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.socketPath), { recursive: true });
    if (existsSync(this.socketPath)) {
      if (await this.socketIsActive()) throw new Error(`Outliner service is already running at ${this.socketPath}`);
      unlinkSync(this.socketPath);
    }
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    const started = Promise.withResolvers<void>();
    server.once("error", started.reject);
    server.listen(this.socketPath, () => {
      server.off("error", started.reject);
      started.resolve();
    });
    try {
      await started.promise;
    } catch (error) {
      this.server = null;
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    for (const subscriber of this.subscribers.keys()) subscriber.destroy();
    this.subscribers.clear();
    for (const timer of this.attentionTimers.values()) clearTimeout(timer);
    this.attentionTimers.clear();
    this.attentionStates.clear();
    this.browsingContextTargets.clear();
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
    this.server = null;
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
  }

  private async socketIsActive(): Promise<boolean> {
    const connected = Promise.withResolvers<boolean>();
    const socket = createConnection(this.socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      connected.resolve(false);
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      connected.resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      connected.resolve(false);
    });
    return connected.promise;
  }

  private pruneDestroyedSubscribers(): void {
    for (const socket of this.subscribers.keys()) {
      if (socket.destroyed) this.removeSubscriber(socket);
    }
  }


  private normalizeContextId(value: string): string {
    const contextId = value?.trim();
    if (
      !contextId ||
      contextId.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(contextId)
    ) {
      throw new Error("Browsing context ID must be 1-200 printable characters");
    }
    return contextId;
  }



  private normalizeClientBlockId(value: unknown): string {
    const blockId = typeof value === "string" ? value.trim() : "";
    if (
      !blockId ||
      blockId.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(blockId)
    ) {
      throw new Error("Client currentBlockId must be 1-200 printable characters");
    }
    this.store.require(blockId);
    return blockId;
  }

  private removeSubscriber(socket: Socket): void {
    const removed = this.subscribers.get(socket);
    this.subscribers.delete(socket);
    if (
      removed &&
      ![...this.subscribers.values()].some((client) => client.contextId === removed.contextId)
    ) {
      this.browsingContextTargets.delete(removed.contextId);
    }
  }

  private registerSubscriber(
    socket: Socket,
    registration: OutlinerClientRegistration,
  ): OutlinerClientRegistration {
    if (!registration || typeof registration !== "object") {
      throw new Error("Client registration is required");
    }
    const clientId = registration.clientId?.trim();
    if (
      !clientId ||
      clientId.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(clientId)
    ) {
      throw new Error("Client registration clientId must be 1-200 printable characters");
    }
    if (registration.role !== "tree" && registration.role !== "detail") {
      throw new Error(`Invalid client role: ${String(registration.role)}`);
    }
    const contextId = this.normalizeContextId(registration.contextId);
    this.pruneDestroyedSubscribers();
    if (this.subscribers.has(socket)) {
      throw new Error("Socket already owns a client registration");
    }
    for (const [owner, client] of this.subscribers) {
      if (owner !== socket && client.clientId === clientId) {
        throw new Error(`Client ID is already registered: ${clientId}`);
      }
    }
    let runtime: OutlinerClientRuntime | undefined;
    if (registration.runtime !== undefined) {
      if (
        !registration.runtime ||
        typeof registration.runtime !== "object" ||
        Array.isArray(registration.runtime)
      ) {
        throw new Error("Client runtime must be an object");
      }
      const stringKeys = ["paneId", "terminalId", "workspaceId", "tabId"] as const;
      const numberKeys = ["paneX", "paneY"] as const;
      const runtimeKeys = [...stringKeys, ...numberKeys];
      const unknownKey = Object.keys(registration.runtime)
        .find((key) => !runtimeKeys.includes(key as typeof runtimeKeys[number]));
      if (unknownKey) throw new Error(`Invalid client runtime ${unknownKey}`);
      const stringEntries = stringKeys.flatMap((key) => {
        const value = registration.runtime?.[key];
        if (value === undefined) return [];
        if (
          typeof value !== "string" ||
          !value.trim() ||
          value.length > 500 ||
          /[\u0000-\u001f\u007f]/.test(value)
        ) {
          throw new Error(`Invalid client runtime ${key}`);
        }
        return [[key, value.trim()] as const];
      });
      const numberEntries = numberKeys.flatMap((key) => {
        const value = registration.runtime?.[key];
        if (value === undefined) return [];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new Error(`Invalid client runtime ${key}`);
        }
        return [[key, value] as const];
      });
      if (stringEntries.length > 0 || numberEntries.length > 0) {
        runtime = Object.fromEntries([...stringEntries, ...numberEntries]);
      }
    }
    if (registration.locked !== undefined && typeof registration.locked !== "boolean") {
      throw new Error("Client locked state must be boolean");
    }
    if (registration.role === "tree" && registration.locked) {
      throw new Error("Only Detail clients can be locked");
    }
    const currentBlockId = registration.currentBlockId === undefined
      ? undefined
      : this.normalizeClientBlockId(registration.currentBlockId);
    const normalized: OutlinerClientRegistration = {
      clientId,
      role: registration.role,
      contextId,
      ...(registration.role === "detail" ? { locked: registration.locked ?? false } : {}),
      ...(currentBlockId ? { currentBlockId } : {}),
      ...(runtime ? { runtime } : {}),
    };
    const stored = this.herdrRegistry === undefined
      ? normalized
      : this.withoutTopology(normalized);
    this.subscribers.set(socket, stored);
    return this.reconcileClientRuntime(stored);
  }

  private withoutTopology(
    client: OutlinerClientRegistration,
  ): OutlinerClientRegistration {
    const terminalId = client.runtime?.terminalId;
    const registration = { ...client };
    delete registration.runtime;
    return terminalId === undefined
      ? registration
      : { ...registration, runtime: { terminalId } };
  }

  private reconcileClientRuntime(
    client: OutlinerClientRegistration,
  ): OutlinerClientRegistration {
    const registry = this.herdrRegistry;
    if (registry === undefined) return client;

    const unavailable = this.withoutTopology(client);
    const terminalId = unavailable.runtime?.terminalId;
    if (registry.phase !== "ready" || terminalId === undefined) return unavailable;

    const paneId = registry.paneIdForTerminal(terminalId);
    const pane = paneId === undefined ? undefined : registry.panes.get(paneId);
    if (pane === undefined) return unavailable;

    const positioned = registry.layouts.get(pane.tab_id)?.panes
      .find((candidate) => candidate.pane_id === pane.pane_id);
    const rect = positioned?.rect;
    const hasCoordinates = (
      typeof rect === "object" &&
      rect !== null &&
      typeof rect.x === "number" &&
      Number.isFinite(rect.x) &&
      rect.x >= 0 &&
      typeof rect.y === "number" &&
      Number.isFinite(rect.y) &&
      rect.y >= 0
    );
    return {
      ...client,
      runtime: {
        paneId: pane.pane_id,
        terminalId: pane.terminal_id,
        workspaceId: pane.workspace_id,
        tabId: pane.tab_id,
        ...(hasCoordinates ? { paneX: rect.x, paneY: rect.y } : {}),
        focused: registry.focusedPaneId === pane.pane_id,
        visible:
          (registry.focusedWorkspaceId === null || registry.focusedWorkspaceId === pane.workspace_id) &&
          (registry.focusedTabId === null || registry.focusedTabId === pane.tab_id),
      },
    };
  }

  private listClients(role?: OutlinerClientRole): OutlinerClientRegistration[] {
    this.pruneDestroyedSubscribers();
    return [...this.subscribers.values()]
      .map((client) => this.reconcileClientRuntime(client))
      .filter((client) => role === undefined || client.role === role)
      .sort((left, right) =>
        left.role.localeCompare(right.role) || left.clientId.localeCompare(right.clientId)
      );
  }

  private hasAvailableTopology(client: OutlinerClientRegistration): boolean {
    return this.herdrRegistry === undefined || Boolean(
      client.runtime?.paneId &&
      client.runtime.workspaceId &&
      client.runtime.tabId
    );
  }

  private hasClient(clientId: string): boolean {
    this.pruneDestroyedSubscribers();
    return [...this.subscribers.values()].some((client) => client.clientId === clientId);
  }

  private clientById(clientId: string): OutlinerClientRegistration {
    const client = this.listClients().find((candidate) => candidate.clientId === clientId);
    if (!client) throw new Error("Navigation source is not a live Outliner pane");
    return client;
  }

  private updateClient(
    clientId: string,
    update: { locked?: boolean; currentBlockId?: string | null },
  ): OutlinerClientRegistration {
    if (update.locked === undefined && update.currentBlockId === undefined) {
      throw new Error("Client update must change locked or currentBlockId");
    }
    for (const [socket, client] of this.subscribers) {
      if (client.clientId !== clientId) continue;
      const updated = { ...client };
      if (update.locked !== undefined) {
        if (client.role !== "detail") throw new Error("Only Detail clients can be locked");
        updated.locked = update.locked;
      }
      if (update.currentBlockId === null) {
        delete updated.currentBlockId;
      } else if (update.currentBlockId !== undefined) {
        updated.currentBlockId = this.normalizeClientBlockId(update.currentBlockId);
      }
      this.subscribers.set(socket, updated);
      return this.reconcileClientRuntime(updated);
    }
    throw new Error(`Client is not registered: ${clientId}`);
  }

  private attentionClient(clientId: string): OutlinerClientRegistration {
    const client = this.listClients().find((candidate) => candidate.clientId === clientId);
    if (!client) throw new Error(`Attention target client is not registered: ${clientId}`);
    return client;
  }

  private attentionState(clientId: string): AttentionClientState {
    const existing = this.attentionStates.get(clientId) ?? emptyAttentionState(clientId);
    const now = Date.now();
    const marks = existing.marks.filter((mark) => Date.parse(mark.expiresAt) > now);
    if (marks.length === existing.marks.length) return existing;
    const expiredPending = existing.marks.filter((mark) =>
      Date.parse(mark.expiresAt) <= now && mark.returnCuePending
    ).length;
    const next = attentionClientState(
      clientId,
      marks,
      marks.length > 0 ? existing.pendingCount - expiredPending : 0,
    );
    if (marks.length === 0) this.attentionStates.delete(clientId);
    else this.attentionStates.set(clientId, next);
    return next;
  }

  private attentionTimerKey(clientId: string, markId: string): string {
    return `${clientId}\u0000${markId}`;
  }

  private cancelAttentionTimer(clientId: string, markId: string): void {
    const key = this.attentionTimerKey(clientId, markId);
    const timer = this.attentionTimers.get(key);
    if (timer) clearTimeout(timer);
    this.attentionTimers.delete(key);
  }

  private scheduleAttentionExpiry(mark: AttentionMark): void {
    this.cancelAttentionTimer(mark.targetClientId, mark.markId);
    const key = this.attentionTimerKey(mark.targetClientId, mark.markId);
    const delay = Math.max(0, Date.parse(mark.expiresAt) - Date.now());
    const timer = setTimeout(() => {
      this.attentionTimers.delete(key);
      const current = this.attentionStates.get(mark.targetClientId);
      if (!current) return;
      const expired = current.marks.find((candidate) => candidate.markId === mark.markId);
      const marks = current.marks.filter((candidate) => candidate.markId !== mark.markId);
      const next = attentionClientState(
        mark.targetClientId,
        marks,
        marks.length > 0
          ? current.pendingCount - (expired?.returnCuePending ? 1 : 0)
          : 0,
      );
      if (marks.length === 0) this.attentionStates.delete(mark.targetClientId);
      else this.attentionStates.set(mark.targetClientId, next);
      this.emitAttention(mark.targetClientId, "attention.expired", next);
    }, delay);
    timer.unref?.();
    this.attentionTimers.set(key, timer);
  }

  private setAttention(input: AttentionMarkInput, advance: boolean): AttentionClientState {
    const client = this.attentionClient(input.targetClientId);
    const source = this.store.require(input.target.sourceBlockId);
    const mark = normalizeAttentionMark(input, client, source);
    if (advance && mark.role !== "current") {
      throw new Error("Attention advance requires a current mark");
    }
    if (mark.target.kind === "file" && client.role !== "detail") {
      throw new Error("File attention requires a Detail target client");
    }

    const existing = this.attentionState(client.clientId);
    const removedMarkIds = new Set(
      existing.marks.filter((candidate) =>
        candidate.markId === mark.markId ||
        (mark.role === "current" && candidate.role === "current")
      ).map((candidate) => candidate.markId),
    );
    let marks = existing.marks.filter((candidate) => !removedMarkIds.has(candidate.markId));
    if (mark.role === "supporting") {
      const supporting = marks.filter((candidate) => candidate.role === "supporting");
      const overflow = supporting.length - ATTENTION_MAX_SUPPORTING_MARKS + 1;
      if (overflow > 0) {
        const removed = new Set(
          supporting.slice(0, overflow).map((candidate) => candidate.markId),
        );
        for (const markId of removed) {
          removedMarkIds.add(markId);
          this.cancelAttentionTimer(client.clientId, markId);
        }
        marks = marks.filter((candidate) => !removed.has(candidate.markId));
      }
    } else {
      for (const candidate of existing.marks) {
        if (candidate.role === "current") this.cancelAttentionTimer(client.clientId, candidate.markId);
      }
    }
    marks.push(mark);
    const cuePending = mark.returnCuePending;
    const removedPending = existing.marks.filter((candidate) =>
      removedMarkIds.has(candidate.markId) && candidate.returnCuePending
    ).length;
    const next = attentionClientState(
      client.clientId,
      marks,
      existing.pendingCount - removedPending + (cuePending ? 1 : 0),
    );
    this.attentionStates.set(client.clientId, next);
    this.scheduleAttentionExpiry(mark);
    return next;
  }

  private clearAttention(input: { targetClientId: string; markId?: string }): AttentionClientState {
    this.attentionClient(input.targetClientId);
    const existing = this.attentionState(input.targetClientId);
    const marks = input.markId
      ? existing.marks.filter((mark) => mark.markId !== input.markId)
      : [];
    for (const mark of existing.marks) {
      if (!marks.some((candidate) => candidate.markId === mark.markId)) {
        this.cancelAttentionTimer(input.targetClientId, mark.markId);
      }
    }
    const removedPending = existing.marks.filter((mark) =>
      !marks.some((candidate) => candidate.markId === mark.markId) &&
      mark.returnCuePending
    ).length;
    const next = attentionClientState(
      input.targetClientId,
      marks,
      input.markId ? existing.pendingCount - removedPending : 0,
    );
    if (marks.length === 0) this.attentionStates.delete(input.targetClientId);
    else this.attentionStates.set(input.targetClientId, next);
    return next;
  }

  private acknowledgeAttention(
    input: { targetClientId: string; markId?: string },
  ): AttentionClientState {
    this.attentionClient(input.targetClientId);
    const existing = this.attentionState(input.targetClientId);
    const acknowledgedAt = new Date().toISOString();
    const marks = existing.marks.map((mark) =>
      !input.markId || mark.markId === input.markId
        ? { ...mark, acknowledgedAt, returnCuePending: false }
        : mark
    );
    const newlyAcknowledged = existing.marks.filter((mark) =>
      (!input.markId || mark.markId === input.markId) && mark.returnCuePending
    ).length;
    const next = attentionClientState(
      input.targetClientId,
      marks,
      input.markId ? existing.pendingCount - newlyAcknowledged : 0,
    );
    if (marks.length > 0) this.attentionStates.set(input.targetClientId, next);
    return next;
  }

  private workflowAttentionMarkId(runId: string, ordinal: number): string {
    return `workflow:${runId}:${ordinal}`;
  }

  private workflowAttentionInput(
    run: WorkflowRun,
    step: WorkflowRun["route"][number],
    targetClientId: string,
    focus = false,
  ): AttentionMarkInput {
    return {
      markId: this.workflowAttentionMarkId(run.runId, step.ordinal),
      targetClientId,
      target: step.target,
      tone: "current",
      role: "current",
      sender: `workflow:${run.runId.slice(0, 8)}`,
      expiresInMs: 60 * 60 * 1_000,
      reveal: true,
      focus,
    };
  }

  private startWorkflow(input: WorkflowStartInput) {
    if (input.targetClientId) {
      this.attentionClient(input.targetClientId);
      if (!input.capabilities.includes("attention.mark")) {
        throw new Error("Targeted workflows require the attention.mark capability");
      }
    }
    return this.workflows.start(input);
  }

  private transitionWorkflow(input: WorkflowTransitionInput): WorkflowRun {
    let before = this.workflows.get(input.runId);
    if (input.targetClientId && input.targetClientId !== before.targetClientId) {
      this.attentionClient(input.targetClientId);
      if (before.targetClientId && this.hasClient(before.targetClientId)) {
        throw new Error("A live workflow target cannot be replaced");
      }
      before = this.workflows.retarget(before.runId, input.targetClientId);
    }
    const targetClientId = input.targetClientId ?? before.targetClientId;
    if (targetClientId) {
      this.attentionClient(targetClientId);
      if (!before.capabilities.includes("attention.mark")) {
        throw new Error("Workflow run lacks attention.mark capability");
      }
    }
    if (
      targetClientId &&
      input.action !== "pause" &&
      input.action !== "branch" &&
      input.action !== "end"
    ) {
      const candidateIndex = before.status === "ready" && input.action === "next"
        ? 0
        : input.action === "previous"
        ? Math.max(0, (before.currentStepIndex ?? 0) - 1)
        : input.action === "next" || input.action === "skip"
        ? Math.min(before.route.length - 1, (before.currentStepIndex ?? 0) + 1)
        : before.currentStepIndex ?? 0;
      const step = before.route[candidateIndex];
      if (step) {
        const target = this.attentionClient(targetClientId);
        const source = this.store.require(step.target.sourceBlockId);
        normalizeAttentionMark(
          this.workflowAttentionInput(before, step, targetClientId, input.focus ?? false),
          target,
          source,
        );
      }
    }
    const next = this.workflows.transition(input);
    if (!targetClientId) return next;

    if (input.action === "end") {
      const previous = before.currentStepIndex === null ? null : before.route[before.currentStepIndex];
      if (previous) {
        const attention = this.clearAttention({
          targetClientId,
          markId: this.workflowAttentionMarkId(before.runId, previous.ordinal),
        });
        this.emitAttention(targetClientId, "workflows.transition", attention);
      }
      return next;
    }
    if (input.action === "pause" || input.action === "branch") return next;
    const step = next.currentStepIndex === null ? null : next.route[next.currentStepIndex];
    if (!step) return next;
    const attentionInput = this.workflowAttentionInput(
      next,
      step,
      targetClientId,
      input.focus ?? false,
    );
    const attention = this.setAttention(attentionInput, true);
    this.emitAttention(targetClientId, "workflows.transition", attention, {
      markId: attentionInput.markId,
      reveal: true,
      focus: attentionInput.focus ?? false,
    }, step.target.sourceBlockId);
    return next;
  }

  private cancelWorkflow(runId: string): WorkflowRun {
    const before = this.workflows.get(runId);
    const next = this.workflows.cancel(runId);
    const step = before.currentStepIndex === null ? null : before.route[before.currentStepIndex];
    if (before.targetClientId && step) {
      const attention = this.clearAttention({
        targetClientId: before.targetClientId,
        markId: this.workflowAttentionMarkId(before.runId, step.ordinal),
      });
      this.emitAttention(before.targetClientId, "workflows.cancel", attention);
    }
    return next;
  }

  private emitAttention(
    targetClientId: string,
    action: string,
    attention: AttentionClientState,
    attentionInstruction?: OutlinerEvent["attentionInstruction"],
    blockId?: string,
  ): void {
    this.broadcast({
      id: crypto.randomUUID(),
      domain: "attention",
      action,
      sequence: this.store.sequence,
      attention,
      ...(attentionInstruction ? { attentionInstruction } : {}),
      ...(blockId ? { blockId } : {}),
    });
  }

  private refreshAttentionForBlock(blockId: string): void {
    let source: Block | null = null;
    try {
      source = this.store.require(blockId);
    } catch {
      source = null;
    }
    for (const [clientId, state] of this.attentionStates) {
      let changed = false;
      const marks = state.marks.map((mark) => {
        if (mark.target.sourceBlockId !== blockId) return mark;
        const sourceState = attentionSourceState(mark, source);
        if (sourceState === mark.sourceState) return mark;
        changed = true;
        return { ...mark, sourceState };
      });
      if (!changed) continue;
      const next = attentionClientState(clientId, marks, state.pendingCount);
      this.attentionStates.set(clientId, next);
      this.emitAttention(clientId, "attention.stale", next);
    }
  }

  private sameTab(
    left: OutlinerClientRegistration,
    right: OutlinerClientRegistration,
  ): boolean {
    return Boolean(
      left.runtime?.workspaceId &&
      left.runtime.tabId &&
      left.runtime.workspaceId === right.runtime?.workspaceId &&
      left.runtime.tabId === right.runtime?.tabId
    );
  }

  private navigationIntent(value: unknown): OutlinerNavigationIntent {
    if (value === "preview" || value === "open" || value === "reveal") return value;
    throw new Error("Navigation intent must be preview, open, or reveal");
  }

  private validateFragmentTarget(blockId: string, fragmentId: string | undefined): void {
    const target = this.store.blockContext(blockId).selected!;
    if (!fragmentId) return;
    if (!isFragmentId(fragmentId)) throw new Error(`Invalid fragment ID: ${fragmentId}`);
    const fragment = resolveFragment(target.text, fragmentId);
    if (fragment.status === "missing") {
      throw new Error(`Fragment not found: ${blockId}^${fragmentId}`);
    }
    if (fragment.status === "duplicate") {
      throw new Error(`Fragment is duplicated: ${blockId}^${fragmentId}`);
    }
  }

  private detailPool(source: OutlinerClientRegistration): OutlinerClientRegistration[] {
    if (!this.hasAvailableTopology(source)) return [];
    const details = this.listClients("detail")
      .filter((client) => this.hasAvailableTopology(client));
    const candidates = source.runtime?.workspaceId && source.runtime.tabId
      ? details.filter((client) => this.sameTab(source, client))
      : details.filter((client) => client.contextId === source.contextId);
    return candidates.sort((left, right) =>
      (left.runtime?.paneX ?? Number.MAX_SAFE_INTEGER) -
        (right.runtime?.paneX ?? Number.MAX_SAFE_INTEGER) ||
      (left.runtime?.paneY ?? Number.MAX_SAFE_INTEGER) -
        (right.runtime?.paneY ?? Number.MAX_SAFE_INTEGER) ||
      left.clientId.localeCompare(right.clientId)
    );
  }

  private resolveUnlockedDetail(
    source: OutlinerClientRegistration,
    intent: "preview" | "open",
    preserveSource = false,
  ): Omit<OutlinerNavigationDispatch, "command"> {
    const pool = this.detailPool(source);
    if (pool.length === 0) {
      throw new Error("No Detail is available in this tab · open another Detail");
    }
    const candidates = preserveSource
      ? pool.filter((client) => client.clientId !== source.clientId)
      : pool;
    const target = candidates.find((client) => !client.locked);
    if (!target) {
      if (preserveSource) {
        throw new Error(
          "No other unlocked Detail is available · unlock one or open another Detail",
        );
      }
      throw new Error("All Details in this tab are locked · unlock one or open another Detail");
    }
    return {
      sourceClientId: source.clientId,
      targetClientId: target.clientId,
      intent,
      resolution: "unlocked",
    };
  }

  private resolveNavigationTarget(
    sourceClientId: string,
    intent: OutlinerNavigationIntent,
    preserveSource = false,
  ): Omit<OutlinerNavigationDispatch, "command"> {
    const source = this.clientById(sourceClientId);
    if (intent !== "reveal") {
      return this.resolveUnlockedDetail(source, intent, preserveSource);
    }
    if (!this.hasAvailableTopology(source)) {
      throw new Error("No Tree destination is available in this pane's context or tab");
    }
    if (source.role === "tree") {
      return {
        sourceClientId,
        targetClientId: source.clientId,
        intent,
        resolution: "self",
      };
    }
    const contextCandidates = this.listClients("tree")
      .filter((client) => this.hasAvailableTopology(client))
      .filter((client) => client.contextId === source.contextId);
    if (contextCandidates.length === 1) {
      return {
        sourceClientId,
        targetClientId: contextCandidates[0]!.clientId,
        intent,
        resolution: "context",
      };
    }
    const sameTabCandidates = this.listClients("tree")
      .filter((client) => this.hasAvailableTopology(client))
      .filter((client) => this.sameTab(source, client));
    if (sameTabCandidates.length === 1) {
      return {
        sourceClientId,
        targetClientId: sameTabCandidates[0]!.clientId,
        intent,
        resolution: "same-tab",
      };
    }
    if (sameTabCandidates.length === 0) {
      throw new Error("No Tree destination is available in this pane's context or tab");
    }
    throw new Error("Multiple same-tab Tree destinations share no browsing context");
  }

  handle(
    request: OutlinerRequest,
    subscribedClient?: OutlinerClientRegistration,
  ): OutlinerResponse {
    try {
      let result: unknown;
      const action = request.action;
      switch (action) {
        case "ping":
          result = { status: "ready", protocolVersion: OUTLINER_PROTOCOL_VERSION };
          break;
        case "blocks.query":
          result = this.store.queryBlocks(request.query);
          break;
        case "children":
          result = this.store.children(request.parentId);
          break;
        case "workspace.snapshot":
          result = this.store.readWorkspaceSnapshot(request.view);
          break;
        case "events.subscribe":
          result = { subscribed: true, client: subscribedClient ?? request.client };
          break;
        case "clients.list":
          if (
            request.role !== undefined &&
            request.role !== "tree" &&
            request.role !== "detail"
          ) {
            throw new Error(`Invalid client role: ${String(request.role)}`);
          }
          result = this.listClients(request.role);
          break;
        case "clients.update":
          result = this.updateClient(request.clientId, request);
          break;
        case "attention.get":
          this.attentionClient(request.targetClientId);
          result = this.attentionState(request.targetClientId);
          break;
        case "attention.mark":
          result = this.setAttention(request.input, false);
          break;
        case "attention.advance":
          result = this.setAttention(request.input, true);
          break;
        case "attention.clear":
          result = this.clearAttention(request.input);
          break;
        case "attention.acknowledge":
          result = this.acknowledgeAttention(request.input);
          break;
        case "workflows.start":
          result = this.startWorkflow(request.input);
          break;
        case "workflows.get":
          result = this.workflows.get(request.runId);
          break;
        case "workflows.list":
          result = this.workflows.list(request.limit);
          break;
        case "workflows.structure":
          result = this.workflows.structure(request.runId);
          break;
        case "workflows.plan":
          result = this.workflows.savePlan(request.input);
          break;
        case "workflows.transition":
          result = this.transitionWorkflow(request.input);
          break;
        case "workflows.cancel":
          result = this.cancelWorkflow(request.runId);
          break;
        case "workflows.promotion.preview":
          result = this.workflows.previewPromotion(request.input);
          break;
        case "workflows.promotion.commit":
          result = this.workflows.commitPromotion(request.input, request.provenance);
          break;
        case "blocks.context":
          result = this.store.blockContext(request.blockId);
          break;
        case "browsing-context.get": {
          const contextId = this.normalizeContextId(request.contextId);
          const blockId = this.browsingContextTargets.get(contextId) ?? null;
          let target: SelectionContext = { selected: null, ancestors: [], children: [] };
          if (blockId) {
            try {
              target = this.store.blockContext(blockId);
            } catch (error) {
              if (!(error instanceof Error) || error.message !== `Block not found: ${blockId}`) throw error;
              this.browsingContextTargets.delete(contextId);
            }
          }
          result = { contextId, target };
          break;
        }
        case "browsing-context.publish": {
          if (
            request.dispatchPreview !== undefined &&
            typeof request.dispatchPreview !== "boolean"
          ) {
            throw new Error("Browsing context dispatchPreview must be boolean");
          }
          const contextId = this.normalizeContextId(request.contextId);
          const target = request.blockId
            ? this.store.blockContext(request.blockId)
            : { selected: null, ancestors: [], children: [] };
          this.browsingContextTargets.set(contextId, request.blockId);
          let preview: OutlinerNavigationDispatch | undefined;
          let unavailable: string | undefined;
          if (request.blockId && request.dispatchPreview !== false) {
            try {
              const route = this.resolveNavigationTarget(request.sourceClientId, "preview");
              preview = {
                ...route,
                command: {
                  targetClientId: route.targetClientId,
                  command: "preview",
                  blockId: request.blockId,
                },
              };
            } catch (error) {
              unavailable = error instanceof Error ? error.message : String(error);
            }
          }
          result = {
            contextId,
            target,
            ...(preview ? { preview } : {}),
            ...(unavailable ? { unavailable } : {}),
          } satisfies BrowsingContextPublication;
          break;
        }
        case "navigation.resolve":
          result = this.resolveNavigationTarget(
            request.sourceClientId,
            this.navigationIntent(request.intent),
            request.preserveSource,
          );
          break;
        case "navigation.dispatch": {
          const intent = this.navigationIntent(request.intent);
          this.validateFragmentTarget(request.blockId, request.fragmentId);
          const route = this.resolveNavigationTarget(
            request.sourceClientId,
            intent,
            request.preserveSource,
          );
          result = {
            ...route,
            command: {
              targetClientId: route.targetClientId,
              command: intent,
              blockId: request.blockId,
              ...(request.fragmentId ? { fragmentId: request.fragmentId } : {}),
            },
          } satisfies OutlinerNavigationDispatch;
          break;
        }
        case "ui.command.send": {
          if (!this.hasClient(request.command.targetClientId)) {
            throw new Error(`Target client is not registered: ${request.command.targetClientId}`);
          }
          const target = this.clientById(request.command.targetClientId);
          if (
            request.command.command === "open" ||
            request.command.command === "replace"
          ) {
            const operation = request.command.command === "replace" ? "replace" : "open";
            if (target.role !== "detail") {
              throw new Error(`Direct ${operation} target must be a Detail client`);
            }
            if (operation === "open" && target.locked) {
              throw new Error("Invoking Detail is locked");
            }
            if (!request.command.blockId) {
              throw new Error(`Direct ${operation} requires a block ID`);
            }
            this.store.require(request.command.blockId);
          }
          if (request.command.command === "backlinks.select") {
            if (target.role !== "detail") {
              throw new Error("Backlink selection target must be a Detail client");
            }
            if (!request.command.targetBlockId || !request.command.sourceBlockId) {
              throw new Error("Backlink selection requires target and source block IDs");
            }
            this.store.require(request.command.targetBlockId);
            this.store.require(request.command.sourceBlockId);
          }
          if (request.command.fragmentId) {
            if (!request.command.blockId) {
              throw new Error("Fragment navigation requires a block ID");
            }
            this.validateFragmentTarget(request.command.blockId, request.command.fragmentId);
          }
          result = { accepted: true, command: request.command };
          break;
        }
        case "get":
          result = this.store.require(request.blockId);
          break;
        case "create":
          result = this.store.create(
            request.text,
            request.parentId,
            request.author,
            request.provenance,
          );
          break;
        case "annotations.list":
          result = this.store.listAnnotationThreads(request.query);
          break;
        case "annotations.create":
          result = this.store.createAnnotation(
            request.requestId,
            request.input,
            request.author,
            request.provenance,
          );
          break;
        case "annotations.reply":
          result = this.store.replyToAnnotation(
            request.requestId,
            request.input,
            request.author,
            request.provenance,
          );
          break;
        case "annotations.batch":
          result = this.store.createAnnotationBatch(
            request.requestId,
            request.operations,
            request.author,
            request.provenance,
          );
          break;
        case "annotations.reanchor":
          result = this.store.reanchorAnnotationThreads(
            request.input,
            request.mutation,
          );
          break;
        case "annotations.lifecycle":
          result = this.store.setAnnotationLifecycle(
            request.input,
            request.mutation,
          );
          break;
        case "roadmap.items.create":
          result = this.store.createRoadmapItem(
            request.input,
            request.author,
            request.provenance,
          );
          break;
        case "deliveries.ensure":
          result = this.store.ensureDelivery(
            request.input,
            request.author,
            request.provenance,
          );
          break;
        case "capture.create":
          result = this.store.capture(
            request.requestId,
            request.text,
            request.source,
            request.capturedFromBlockId,
            request.author,
            request.provenance,
          );
          break;
        case "update":
          result = this.store.update(
            request.blockId,
            request.text,
            request.expectedUpdatedAt,
            request.mutation,
          );
          break;
        case "move":
          result = this.store.move(request.blockId, request.parentId, request.position);
          break;
        case "delete":
          result = this.store.delete(request.blockId);
          break;
        case "trash.restore":
          result = this.store.restore(request.blockId);
          break;
        case "trash.purge":
          this.store.purge(request.blockId, request.confirmation);
          result = { purged: request.blockId };
          break;
        case "virtual.occurrences.reorder":
          result = this.store.reorderVirtualOccurrences(
            request.viewId,
            request.orderedBlockIds,
          );
          break;
        case "references.resolve":
          result = this.store.resolveBlockReferences(request.text);
          break;
        case "references.backlinks":
          result = this.store.queryBacklinks(request.query);
          break;
        case "pages.resolve":
          result = this.store.resolvePageAddress(request.address);
          break;
        case "pages.follow":
          result = this.store.followPageAddress(
            request.address,
            request.author,
            request.provenance,
          );
          break;
        case "pages.complete":
          result = this.store.completePageAddresses(request.query, request.limit);
          break;
        case "pages.rename":
          result = this.store.renamePageAddress(
            request.blockId,
            request.address,
            request.expectedUpdatedAt,
          );
          break;
        case "pages.alias":
          result = this.store.addPageAlias(request.blockId, request.address);
          break;
        case "pages.remove":
          result = this.store.removePageAddress(
            request.blockId,
            request.address,
            request.expectedUpdatedAt,
          );
          break;
        case "work-ids.status":
          result = this.store.workIdAllocatorStatus();
          break;
        case "work-ids.configure":
          result = this.store.configureWorkIdPrefix(request.prefix);
          break;
        case "work-ids.allocate":
          result = this.store.allocateWorkId(
            request.blockId,
            request.expectedUpdatedAt,
          );
          break;
        case "properties.patch":
          result = this.store.patchProperties(
            request.blockId,
            request.expectedUpdatedAt,
            request.operations,
            request.mutation,
          );
          break;
        case "activity.recent":
          result = this.store.recentEditActivity({
            afterCursor: request.afterCursor,
            since: request.since,
            limit: request.limit,
            author: request.author,
          });
          break;
        case "properties.catalog":
          result = this.store.propertyCatalog(
            request.key,
            request.prefix,
            request.limit,
            request.propertyScope,
          );
          break;
        case "selection.get":
          result = this.store.getSelection();
          break;
        case "selection.set":
          result = this.store.setSelection(request.blockId);
          break;
        case "navigation.state":
          result = this.store.navigationState();
          break;
        case "navigation.back":
          result = this.store.navigateHistory("back");
          break;
        case "navigation.forward":
          result = this.store.navigateHistory("forward");
          break;
        default: {
          const unsupportedAction: never = action;
          throw new Error(`Unsupported action: ${String(unsupportedAction)}`);
        }
      }
      return { id: request.id, ok: true, result, sequence: this.store.sequence };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        sequence: this.store.sequence,
      };
    }
  }

  private eventFor(request: OutlinerRequest, response: Extract<OutlinerResponse, { ok: true }>): OutlinerEvent | null {
    let domain: OutlinerEvent["domain"];
    let blockId: string | undefined;
    let contextId: string | undefined;
    let command: OutlinerEvent["command"];
    let attention: AttentionClientState | undefined;
    let attentionInstruction: OutlinerEvent["attentionInstruction"];
    switch (request.action) {
      case "create":
        domain = "content";
        blockId = (response.result as Block).id;
        break;
      case "roadmap.items.create":
        domain = "content";
        blockId = (response.result as RoadmapItemCreateReceipt).block.id;
        break;
      case "deliveries.ensure": {
        const receipt = response.result as DeliveryReceipt;
        if (!receipt.created) return null;
        domain = "content";
        blockId = receipt.delivery.id;
        break;
      }
      case "capture.create": {
        const receipt = response.result as CaptureReceipt;
        if (receipt.deduplicated) return null;
        domain = "content";
        blockId = receipt.block.id;
        break;
      }
      case "annotations.create":
      case "annotations.reply":
      case "annotations.batch": {
        const receipt = response.result as AnnotationBatchReceipt;
        if (receipt.deduplicated) return null;
        domain = "content";
        blockId = receipt.annotations[0]?.block.id;
        break;
      }
      case "annotations.lifecycle":
        domain = "content";
        blockId = request.input.annotationId;
        break;
      case "attention.mark":
      case "attention.advance":
        domain = "attention";
        blockId = request.input.target.sourceBlockId;
        attention = response.result as AttentionClientState;
        attentionInstruction = {
          markId: request.input.markId,
          reveal: request.input.reveal ?? false,
          focus: request.input.focus ?? false,
        };
        break;
      case "attention.clear":
      case "attention.acknowledge":
        domain = "attention";
        attention = response.result as AttentionClientState;
        blockId = attention.marks.find((mark) =>
          !request.input.markId || mark.markId === request.input.markId
        )?.target.sourceBlockId;
        break;
      case "attention.get":
        return null;
      case "update":
      case "move":
      case "delete":
      case "trash.restore":
      case "trash.purge":
      case "properties.patch":
      case "pages.rename":
      case "pages.alias":
      case "pages.remove":
      case "work-ids.allocate":
        domain = "content";
        blockId = request.blockId;
        break;
      case "work-ids.configure":
        domain = "content";
        break;
      case "pages.follow": {
        const followed = response.result as PageAddressFollowResult;
        if (!followed.created) return null;
        domain = "content";
        blockId = followed.block?.id;
        break;
      }
      case "virtual.occurrences.reorder":
        domain = "view";
        blockId = request.viewId;
        break;
      case "selection.set":
        domain = "selection";
        blockId = request.blockId ?? undefined;
        break;
      case "navigation.back":
      case "navigation.forward":
        domain = "selection";
        blockId = (response.result as NavigationState).selection.selected?.id;
        break;
      case "ui.command.send":
        domain = "ui";
        blockId = request.command.blockId ?? request.command.targetBlockId;
        command = request.command;
        break;
      case "navigation.dispatch": {
        const dispatched = response.result as OutlinerNavigationDispatch;
        domain = "ui";
        blockId = request.blockId;
        command = dispatched.command;
        break;
      }
      case "browsing-context.publish": {
        const published = response.result as BrowsingContextPublication;
        domain = "browsing-context";
        contextId = published.contextId;
        blockId = request.blockId ?? undefined;
        command = published.preview?.command;
        break;
      }
      default:
        return null;
    }

    return {
      id: crypto.randomUUID(),
      domain,
      action: request.action,
      sequence: response.sequence,
      blockId,
      command,
      ...(attention ? { attention } : {}),
      ...(attentionInstruction ? { attentionInstruction } : {}),
      contextId,
    };
  }

  private broadcast(event: OutlinerEvent): void {
    this.pruneDestroyedSubscribers();
    const envelope: OutlinerEventEnvelope = { event };
    const line = `${JSON.stringify(envelope)}\n`;
    const contextLine = event.domain === "browsing-context"
      ? `${JSON.stringify({ event: { ...event, command: undefined } } satisfies OutlinerEventEnvelope)}\n`
      : line;
    for (const [subscriber, client] of this.subscribers) {
      if (event.domain === "ui" && event.command?.targetClientId !== client.clientId) {
        continue;
      }
      if (event.domain === "attention" && event.attention?.targetClientId !== client.clientId) {
        continue;
      }
      if (event.domain === "browsing-context") {
        if (event.contextId === client.contextId) subscriber.write(contextLine);
        if (event.command?.targetClientId === client.clientId) {
          subscriber.write(`${JSON.stringify({
            event: {
              ...event,
              id: crypto.randomUUID(),
              domain: "ui",
              contextId: undefined,
            },
          } satisfies OutlinerEventEnvelope)}\n`);
        }
        continue;
      }
      subscriber.write(line);
    }
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.once("close", () => this.removeSubscriber(socket));
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          let request: OutlinerRequest | undefined;
          let response: OutlinerResponse;
          try {
            request = JSON.parse(line) as OutlinerRequest;
            const subscribedClient = request.action === "events.subscribe"
              ? this.registerSubscriber(socket, request.client)
              : undefined;
            response = this.handle(request, subscribedClient);
          } catch (error) {
            response = {
              id: request?.id ?? "invalid",
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              sequence: this.store.sequence,
            };
          }
          socket.write(`${JSON.stringify(response)}\n`);
          if (request && response.ok) {
            const event = this.eventFor(request, response);
            if (event) this.broadcast(event);
            if (event?.domain === "content" && event.blockId) {
              this.refreshAttentionForBlock(event.blockId);
            }
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
  }
}
