import { queryRequestProblem } from "./block-query";
import type { ChangeAttribution } from "./change-feed";
import { MentionRepository } from "./mentions";
import { EditRecoveryRepository } from "./edit-recovery";
import { proposeEditMerge } from "./edit-merge-model";
import {searchInboxHistory,visibleInboxSearch} from './inbox-search';
import {rankSearchWithJev} from './search-ranking';
import { blockDisplayTitle } from "./references";
import { previewPropertyParse } from "./properties";
import { rankGotoWithJev, visibleGotoResults } from "./goto-search";
import { InboxWorker, assistantActivity } from "./inbox-worker";
import { InboxRepository, summarizeInboxResult } from "./inbox-repository";
import { NoteAssistanceRepository } from "./note-assistance-repository";
import type { NoteModel } from "./note-assistance-model";
import type { InboxModel, InboxResult, InboxStatus } from "./inbox-types";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { hostname as systemHostname } from "node:os";
import { dirname } from "node:path";
import {
  ATTENTION_MAX_SUPPORTING_MARKS,
  attentionClientState,
  attentionSourceState,
  emptyAttentionState,
  normalizeAttentionMark,
} from "./attention";
import { readAuthoredLinks } from "./authored-links";
import { normalizeResourceProjectionRequest, readResourceProjections } from "./resource-projection";
import { normalizeAnnotationReferenceContext } from "./annotations";
import type { HerdrRuntimeRegistry } from "./herdr-registry";
import { isFragmentId, resolveFragment } from "./fragments";
import { OutlinerStore } from "./store";
import {
  resourceAddressLabel,
  normalizeResourceId,
  normalizeRetainedResourceRevisionRef,
  normalizeResourceProviderCommandInput,
} from "./resources";
import {
  negotiateResourcePresentation,
  normalizeResourcePresentationContext,
  TUI_RESOURCE_PRESENTATION_CONTEXT,
} from "./resource-presentation";
import { WorkflowManager } from "./workflows";
import {
  OUTLINER_CAPABILITIES,
  OUTLINER_MIN_CLIENT_PROTOCOL,
  OUTLINER_PROTOCOL_VERSION,
  type OutlinerServiceOutline,
  type OutlinerViewAddress,
  type NavigationLinkState,
  type OutlinerNavigationResolution,
  clientSupportsRole,
  type OutlinerRegion,
  type AnnotationBatchReceipt,
  type AnnotationAgentProposalReceipt,
  type AttentionClientState,
  type AttentionMark,
  type AttentionMarkInput,
  type Block,
  type BrowsingContextPublication,
  type BookmarkRemoveReceipt,
  type BookmarkToggleReceipt,
  type CaptureReceipt,
  type CaptureOwner,
  type CaptureOwnerClaim,
  type CaptureOwnerLocation,
  type QuickCaptureDraft,
  type ComputedExecutionResult,
  type ComputedInvocation,
  type DeliveryReceipt,
  type DeliverySyncReceipt,
  type NavigationState,
  type OutlinerClientRegistration,
  type OutlinerClientRole,
  type OutlinerClientRuntime,
  type OutlinerEvent,
  type OutlinerEventEnvelope,
  type OutlinerChange,
  type OutlinerChangeKind,
  type MutationProvenance,
  type OutlinerNavigationDispatch,
  type InternResourceReceipt,
  type OutlinerNavigationIntent,
  type OutlinerNavigationTarget,
  type OutlinerUiCommand,
  type PageAddressFollowResult,
  type OutlinerRequest,
  type RoadmapItemCreateReceipt,
  type OutlinerResponse,
  type WorkflowRun,
  type WorkflowPromotionReceipt,
  type WorkflowStartInput,
  type WorkflowTransitionInput,
  type Resource,
  type ResourceDescription,
  type ResourceCapability,
  type ResourceProviderCommandResult,
  type ResourceRetentionCollectionReceipt,
  type ResourceRetentionPin,
  type ResourceRetentionReference,
  type ResourceRevisionRef,
} from "./types";

function eventResultId(value: unknown, label: string): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string"
  ) {
    throw new Error(`${label} result is missing its ID`);
  }
  return value.id;
}

function annotationReconcileChanged(value: unknown): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    !("changed" in value) ||
    typeof value.changed !== "boolean"
  ) {
    throw new Error("Annotation reconcile result is missing its changed flag");
  }
  return value.changed;
}

/**
 * Request-level meanings that replace the store's per-block kind: an annotation
 * request's source edit and created blocks are all `annotate`, a draft save is
 * `draft`, and a bookmark toggle stays `other`.
 */
function requestChangeKind(action: unknown): OutlinerChangeKind | undefined {
  if (typeof action !== "string") return undefined;
  if (action.startsWith("annotations.")) return "annotate";
  if (action === "capture.draft.save" || action === "capture.draft.clear") return "draft";
  if (action === "bookmarks.toggle" || action === "bookmarks.remove") return "other";
  return undefined;
}

/** Provenance the request declared for its mutation; self-reported by the client. */
function declaredActor(request: OutlinerRequest): MutationProvenance | undefined {
  const mutation = "mutation" in request ? request.mutation : undefined;
  if (mutation && typeof mutation === "object") {
    return {
      author: mutation.author,
      ...(mutation.actorId ? { actorId: mutation.actorId } : {}),
      ...(mutation.sessionId ? { sessionId: mutation.sessionId } : {}),
      ...(mutation.taskId ? { taskId: mutation.taskId } : {}),
    };
  }
  const author = "author" in request ? request.author : undefined;
  const provenance = "provenance" in request ? request.provenance : undefined;
  if (!author && !provenance) return undefined;
  return {
    author: author ?? "user",
    ...(provenance?.actorId ? { actorId: provenance.actorId } : {}),
    ...(provenance?.sessionId ? { sessionId: provenance.sessionId } : {}),
    ...(provenance?.taskId ? { taskId: provenance.taskId } : {}),
  };
}

export class OutlinerServer {
  private inbox: InboxWorker | undefined;
  private readonly inboxRepository: InboxRepository;
  private readonly mentions: MentionRepository;
  private readonly editRecovery: EditRecoveryRepository;
  private readonly editMergeJobs = new Map<string, AbortController>();
  private readonly noteRepository: NoteAssistanceRepository;
  private inboxUnavailable = "Automatic Inbox cleanup is not enabled for this service";
  private activeGotoRankings = 0;
  private captureOwner: CaptureOwner | null = null;
  private captureTransfer?: {token: string; clientId: string; requestId: string; revision: number; deadline: number};
  private server: Server | null = null;
  private readonly navigationLinks = new Map<string, OutlinerViewAddress>();
  private readonly subscribers = new Map<Socket, OutlinerClientRegistration>();
  private readonly browsingContextTargets = new Map<string, OutlinerNavigationTarget | null>();
  private readonly attentionStates = new Map<string, AttentionClientState>();
  private readonly attentionTimers = new Map<string, Timer>();
  private readonly workflows: WorkflowManager;
  private readonly hostname = systemHostname();
  private outline: OutlinerServiceOutline | undefined;

  constructor(
    readonly store: OutlinerStore,
    readonly socketPath: string,
    readonly herdrRegistry?: HerdrRuntimeRegistry,
    private readonly promptDirectory?: string,
  ) {
    this.workflows = new WorkflowManager(store);
    this.mentions = new MentionRepository(store,store.workspaceRoot);
    this.editRecovery = new EditRecoveryRepository(store);
    this.inboxRepository = new InboxRepository(store);
    this.noteRepository = new NoteAssistanceRepository(store);
    // Baseline before accepting edits or awaiting provider configuration.
    this.noteRepository.initialize();
  }

  /** The named outline this service runs, reported by `ping`. */
  setOutline(outline: OutlinerServiceOutline | undefined): void {
    this.outline = outline;
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.socketPath), { recursive: true });
    if (existsSync(this.socketPath)) {
      if (await this.socketIsActive()) throw new Error(`Outliner service is already running at ${this.socketPath}`);
      unlinkSync(this.socketPath);
    }
    this.store.changes.onBackgroundChanges = changes => this.publishChanges(undefined, changes);
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
    for (const job of this.editMergeJobs.values()) job.abort();
    await this.inbox?.stop();
    const server = this.server;
    if (!server) return;
    this.store.changes.onBackgroundChanges = undefined;
    for (const subscriber of this.subscribers.keys()) subscriber.destroy();
    this.subscribers.clear();
    this.captureOwner = null;
    this.captureTransfer = undefined;
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

  enableInbox(model: InboxModel, noteModel?: NoteModel): void {
    if (this.inbox) throw new Error("Inbox processor already started");
    if (!this.server) throw new Error("Start the service before its Inbox processor");
    this.inbox = new InboxWorker(this.store, model, result => this.inboxChanged(result), {
      repository: this.inboxRepository, notes: this.noteRepository, noteModel,
    });
    this.inbox.wake();
  }

  private inboxChanged(result?: InboxResult): void {
    // The worker's writes were recorded as background changes; publish them before its status.
    this.store.changes.flushBackground();
    if (result?.state === "applied" || result?.state === "undone") {
      for (const blockId of new Set([result.sourceId, ...result.outputIds])) this.refreshAttentionForBlock(blockId);
    }
    this.broadcast({ id: crypto.randomUUID(), domain: "inbox", action: "inbox.status", sequence: this.store.sequence });
  }

  setInboxUnavailable(message: string): void {
    this.inboxUnavailable = message;
    this.broadcast({ id: crypto.randomUUID(), domain: "inbox", action: "inbox.status", sequence: this.store.sequence });
  }

  private inboxStatus(attentionOnly = false, resultsOffset = 0): InboxStatus {
    if (typeof attentionOnly !== "boolean") throw new Error("attentionOnly must be a boolean");
    if (!Number.isSafeInteger(resultsOffset) || resultsOffset < 0) throw new Error("resultsOffset must be a nonnegative integer");
    if (this.inbox) return this.inbox.status(attentionOnly, resultsOffset);
    // Recovery and history do not depend on a currently usable model/provider.
    const { results, attentionCount } = assistantActivity(this.store, this.inboxRepository, this.noteRepository, attentionOnly, resultsOffset);
    return {
      enabled: false, paused: true, state: "unavailable", message: this.inboxUnavailable,
      pending: this.inboxRepository.pending().length, results: results.slice(0, 30).map(summarizeInboxResult), resultsTruncated: results.length > 30,
      attentionCount, attentionOnly, resultsOffset: attentionOnly ? 0 : resultsOffset,
    };
  }

  private requireInbox(): InboxWorker {
    if (!this.inbox) throw new Error(this.inboxUnavailable);
    return this.inbox;
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



  private normalizeNavigationTarget(
    value: unknown,
    availability: "require-current" | "retain" = "require-current",
  ): OutlinerNavigationTarget {
    if (!value || typeof value !== "object" || !("kind" in value)) {
      throw new Error("Navigation target is required");
    }
    if (value.kind === "block") {
      const blockId = "blockId" in value && typeof value.blockId === "string"
        ? value.blockId.trim()
        : "";
      const fragmentId = "fragmentId" in value && typeof value.fragmentId === "string"
        ? value.fragmentId.trim()
        : undefined;
      if (!blockId || blockId.length > 200 || /[\u0000-\u001f\u007f]/.test(blockId)) {
        throw new Error("Navigation block ID must be 1-200 printable characters");
      }
      if (fragmentId && !isFragmentId(fragmentId)) {
        throw new Error(`Invalid fragment ID: ${fragmentId}`);
      }
      if (availability === "require-current") this.validateFragmentTarget(blockId, fragmentId);
      return { kind: "block", blockId, ...(fragmentId ? { fragmentId } : {}) };
    }
    if (value.kind === "resource") {
      const referenceContext = "referenceContext" in value && value.referenceContext !== undefined
        ? normalizeAnnotationReferenceContext(value.referenceContext) : undefined;
      const resourceId = normalizeResourceId(
        "resourceId" in value ? value.resourceId : undefined,
      );
      if (availability === "retain") {
        const revision = "revision" in value && value.revision !== undefined
          ? normalizeRetainedResourceRevisionRef(value.revision)
          : null;
        if (revision && revision.resourceId !== resourceId) {
          throw new Error("Resource revision reference does not match the target resource");
        }
        return {
          kind: "resource",
          resourceId,
          ...(revision ? { revision } : {}),
          ...(referenceContext ? { referenceContext } : {}),
        };
      }
      const resource = this.store.resources.require(resourceId);
      const revision = "revision" in value && value.revision !== undefined
        ? this.store.resources.describe(resource.id, true, value.revision).requestedRevision
        : null;
      return {
        kind: "resource",
        resourceId: resource.id,
        ...(revision ? { revision } : {}),
        ...(referenceContext ? { referenceContext } : {}),
      };
    }
    throw new Error("Navigation target kind must be block or resource");
  }

  private removeSubscriber(socket: Socket): void {
    const removed = this.subscribers.get(socket);
    this.subscribers.delete(socket);
    if (removed?.clientId === this.captureOwner?.clientId) {
      this.captureOwner = null;
      this.captureTransfer = undefined;
    }
    if (removed) {
      for (const [key, destination] of this.navigationLinks) {
        if (key === JSON.stringify([removed.clientId, "tree"]) || key === JSON.stringify([removed.clientId, "detail"]) || destination.clientId === removed.clientId) this.navigationLinks.delete(key);
      }
    }
    if (
      removed &&
      ![...this.subscribers.values()].some((client) => client.contextId === removed.contextId)
    ) {
      this.browsingContextTargets.delete(removed.contextId);
    }
    if (removed) this.emitClientView("clients.unregister", removed.clientId);
  }

  private emitClientView(action: string, clientId: string): void {
    this.broadcast({id: crypto.randomUUID(), domain: "view", action, clientId, sequence: this.store.sequence});
  }

  private normalizeClientRuntime(
    runtime: OutlinerClientRuntime | undefined,
  ): OutlinerClientRuntime | undefined {
    if (runtime === undefined) return undefined;
    if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
      throw new Error("Client runtime must be an object");
    }
    const stringKeys = ["hostname", "paneId", "terminalId", "workspaceId", "tabId"] as const;
    const numberKeys = ["paneX", "paneY"] as const;
    const booleanKeys = ["focused", "visible"] as const;
    const runtimeKeys = [...stringKeys, ...numberKeys, ...booleanKeys];
    const unknownKey = Object.keys(runtime)
      .find((key) => !runtimeKeys.includes(key as typeof runtimeKeys[number]));
    if (unknownKey) throw new Error(`Invalid client runtime ${unknownKey}`);
    const stringEntries = stringKeys.flatMap((key) => {
      const value = runtime[key];
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
      const value = runtime[key];
      if (value === undefined) return [];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid client runtime ${key}`);
      }
      return [[key, value] as const];
    });
    const booleanEntries = booleanKeys.flatMap((key) => {
      const value = runtime[key];
      if (value === undefined) return [];
      if (typeof value !== "boolean") {
        throw new Error(`Invalid client runtime ${key}`);
      }
      return [[key, value] as const];
    });
    return stringEntries.length > 0 || numberEntries.length > 0 || booleanEntries.length > 0
      ? Object.fromEntries([...stringEntries, ...numberEntries, ...booleanEntries])
      : undefined;
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
    if (registration.role !== "tree" && registration.role !== "detail" && registration.role !== "composed" && registration.role !== "observer") {
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
      if (registration.role === "composed" && client.role === "composed" && client.contextId === contextId) {
        throw new Error("This browsing context already has a composed primary reader");
      }
    }
    const runtime = this.normalizeClientRuntime(registration.runtime);
    const currentTarget = registration.currentTarget === undefined
      ? undefined
      : this.normalizeNavigationTarget(registration.currentTarget, "retain");
    const resourcePresentation = registration.resourcePresentation === undefined
      ? undefined
      : normalizeResourcePresentationContext(registration.resourcePresentation);
    if (!clientSupportsRole(registration, "detail") && resourcePresentation) {
      throw new Error("Only Detail clients can declare Resource presentation capabilities");
    }
    const normalized: OutlinerClientRegistration = {
      clientId,
      role: registration.role,
      contextId,
      ...(currentTarget ? { currentTarget } : {}),
      ...(runtime ? { runtime } : {}),
      ...(resourcePresentation ? { resourcePresentation } : {}),
      ...this.normalizeComposedState(registration.role, registration.focusedRegion, registration.treeSelection),
    };
    const stored = this.herdrRegistry === undefined || this.clientOwnsTopology(normalized)
      ? normalized
      : this.withoutTopology(normalized);
    this.subscribers.set(socket, stored);
    return this.reconcileClientRuntime(stored);
  }

  private currentCaptureOwner(): CaptureOwner | null {
    this.pruneDestroyedSubscribers();
    return this.captureOwner;
  }

  private requireCaptureOwner(clientId?: string): void {
    const owner = this.currentCaptureOwner();
    if ((owner && owner.clientId !== clientId) || (clientId && owner?.clientId !== clientId)) {
      throw Error("Capture owner changed; return to the active Capture surface or retain writing in history");
    }
  }

  private claimCaptureOwner(clientId: string, location: CaptureOwnerLocation, transferToken?: string): CaptureOwnerClaim {
    if (!this.hasClient(clientId)) throw Error("Capture owner must have a live client connection");
    for (const field of ["hostname", "herdrSocket", "paneId"] as const) {
      if (typeof location?.[field] !== "string" || !location[field] || location[field].length > 4096 || /[\u0000-\u001f\u007f]/.test(location[field])) {
        throw Error("Invalid Capture owner location");
      }
    }
    if (typeof location.popup !== "boolean" || (location.launching !== undefined && typeof location.launching !== "boolean")) throw Error("Invalid Capture owner presentation");
    const owner = this.currentCaptureOwner();
    if (transferToken !== undefined) {
      const transfer = this.captureTransfer, draft = this.store.quickCaptureDraft();
      if (!transfer || transfer.token !== transferToken || transfer.deadline <= Date.now() ||
        owner?.clientId !== transfer.clientId || draft?.requestId !== transfer.requestId || draft.revision !== transfer.revision) {
        throw Error("Capture handoff expired or changed; the draft remains retained");
      }
    } else if (owner && owner.clientId !== clientId) return {acquired: false, owner};
    this.captureOwner = {clientId, hostname: location.hostname, herdrSocket: location.herdrSocket, paneId: location.paneId, popup: location.popup, ...(location.launching ? {launching: true} : {})};
    this.captureTransfer = undefined;
    return {acquired: true, owner: this.captureOwner};
  }

  private withoutTopology(
    client: OutlinerClientRegistration,
  ): OutlinerClientRegistration {
    const { hostname, terminalId } = client.runtime ?? {};
    const registration = { ...client };
    delete registration.runtime;
    return hostname === undefined && terminalId === undefined
      ? registration
      : {
        ...registration,
        runtime: {
          ...(hostname === undefined ? {} : { hostname }),
          ...(terminalId === undefined ? {} : { terminalId }),
        },
      };
  }

  private clientOwnsTopology(client: OutlinerClientRegistration): boolean {
    const clientHostname = client.runtime?.hostname;
    return clientHostname !== undefined && clientHostname !== this.hostname;
  }

  private reconcileClientRuntime(
    client: OutlinerClientRegistration,
  ): OutlinerClientRegistration {
    const registry = this.herdrRegistry;
    if (registry === undefined || this.clientOwnsTopology(client)) return client;

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
        hostname: this.hostname,
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
      .filter((client) => role === undefined || clientSupportsRole(client, role))
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

  private presentResource(
    description: ResourceDescription,
    destination: OutlinerClientRegistration,
  ): ResourceDescription {
    const presentation = negotiateResourcePresentation(
      description,
      destination.resourcePresentation ?? TUI_RESOURCE_PRESENTATION_CONTEXT,
    );
    const availableCommands =
      presentation.capabilities.command.status === "available" &&
        description.requestedRevision === null
        ? description.remoteEntity?.commandDescriptors ?? []
        : [];
    if (
      presentation.selected?.representation === "native-document" &&
      description.pdf
    ) {
      return {
        ...description,
        capabilities: presentation.capabilities,
        availableCommands,
        presentation,
        nativePayload: this.store.resources.nativePdfPayload(
          description.resource.id,
          description.pdf.nativeRepresentation.id,
        ),
      };
    }
    return {
      ...description,
      capabilities: presentation.capabilities,
      availableCommands,
      presentation,
    };
  }

  private requireAvailableResourceCapability(
    description: ResourceDescription,
    capability: ResourceCapability,
    ignoreProviderAccess = false,
  ): void {
    const decision = description.capabilities[capability];
    const obstacle = Object.entries(decision.factors).find(
      ([factor, assessment]) =>
        !(ignoreProviderAccess && (factor === "credentials" || factor === "connectivity")) &&
        (assessment.state === "blocked" || assessment.state === "unknown"),
    )?.[1];
    if (!obstacle) return;
    const detail = "detail" in obstacle ? obstacle.detail : `${capability} is unavailable`;
    throw new Error(`Resource ${capability} unavailable: ${detail}`);
  }

  private activeResourceRevisions(resourceId?: string): ResourceRevisionRef[] {
    return this.listClients().flatMap(client => [client.currentTarget, client.previewTarget].flatMap(target =>
      target?.kind === "resource" && target.revision && (resourceId === undefined || target.resourceId === resourceId) ? [target.revision] : []));
  }

  private updateClient(
    clientId: string,
    update: {
      navigationProtection?: string | null;
      currentTarget?: OutlinerNavigationTarget | null;
      previewTarget?: OutlinerNavigationTarget | null;
      runtime?: OutlinerClientRuntime | null;
      focusedRegion?: OutlinerRegion;
      treeSelection?: OutlinerClientRegistration["treeSelection"] | null;
    },
  ): OutlinerClientRegistration {
    if (
      update.navigationProtection === undefined &&
      update.currentTarget === undefined && update.previewTarget === undefined &&
      update.runtime === undefined && update.focusedRegion === undefined && update.treeSelection === undefined
    ) {
      throw new Error("Client update must change a target, protection, runtime, or region");
    }
    for (const [socket, client] of this.subscribers) {
      if (client.clientId !== clientId) continue;
      if (update.treeSelection === null && client.role !== "composed") throw new Error("Only composed clients have internal regions");
      const updated = { ...client };
      if (update.navigationProtection !== undefined) {
        if (!clientSupportsRole(client, "detail") || (update.navigationProtection !== null && (typeof update.navigationProtection !== "string" || update.navigationProtection.length > 200))) throw new Error("Invalid navigation protection");
        updated.navigationProtection = update.navigationProtection;
      }
      Object.assign(updated, this.normalizeComposedState(client.role, update.focusedRegion, update.treeSelection ?? undefined, false));
      if (update.treeSelection === null) delete updated.treeSelection;
      if (update.previewTarget === null) delete updated.previewTarget;
      else if (update.previewTarget !== undefined) {
        updated.previewTarget = this.normalizeNavigationTarget(update.previewTarget, "retain");
      }
      if (update.currentTarget === null) {
        delete updated.currentTarget;
      } else if (update.currentTarget !== undefined) {
        updated.currentTarget = this.normalizeNavigationTarget(update.currentTarget, "retain");
      }
      if (update.runtime === null) {
        delete updated.runtime;
      } else if (update.runtime !== undefined) {
        const runtime = this.normalizeClientRuntime(update.runtime);
        if (runtime === undefined) delete updated.runtime;
        else updated.runtime = runtime;
      }
      this.subscribers.set(socket, updated);
      if (JSON.stringify(client.currentTarget) !== JSON.stringify(updated.currentTarget)) {
        this.emitClientView("clients.update", clientId);
      }
      return this.reconcileClientRuntime(updated);
    }
    throw new Error(`Client is not registered: ${clientId}`);
  }

  private normalizeComposedState(
    role: OutlinerClientRole,
    focusedRegion: OutlinerRegion | undefined,
    treeSelection: OutlinerClientRegistration["treeSelection"],
    initial = true,
  ): Pick<OutlinerClientRegistration, "focusedRegion" | "treeSelection"> {
    if (role !== "composed") {
      if (focusedRegion !== undefined || treeSelection !== undefined) throw new Error("Only composed clients have internal regions");
      return {};
    }
    if (focusedRegion !== undefined && focusedRegion !== "tree" && focusedRegion !== "detail") throw new Error("Invalid composed focus region");
    if (treeSelection !== undefined && (!treeSelection || typeof treeSelection.rowId !== "string" || !treeSelection.rowId || treeSelection.rowId.length > 2000)) {
      throw new Error("Composed Tree selection requires an occurrence row ID");
    }
    return {
      ...(focusedRegion !== undefined || initial ? {focusedRegion: focusedRegion ?? "tree"} : {}),
      ...(treeSelection ? {treeSelection: {...treeSelection, target: this.normalizeNavigationTarget(treeSelection.target, "retain")}} : {}),
    };
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
      this.emitAttention("attention.expired", next);
    }, delay);
    timer.unref?.();
    this.attentionTimers.set(key, timer);
  }

  private setAttention(input: AttentionMarkInput, advance: boolean): AttentionClientState {
    const client = this.attentionClient(input.targetClientId);
    if (client.role === "composed" && (input.reveal || input.focus) && input.targetRegion !== "tree" && input.targetRegion !== "detail") throw new Error("Composed attention navigation requires an explicit target region");
    if (input.targetRegion !== undefined && !clientSupportsRole(client, input.targetRegion)) throw new Error("Attention target region is unavailable");
    if (input.targetRegion === "tree" && input.target.kind === "file") throw new Error("File attention requires the Detail region");
    const source = this.store.require(input.target.sourceBlockId);
    const mark = normalizeAttentionMark(input, client, source);
    if (advance && mark.role !== "current") {
      throw new Error("Attention advance requires a current mark");
    }
    if (mark.target.kind === "file" && !clientSupportsRole(client, "detail")) {
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
      ...(this.attentionClient(targetClientId).role === "composed" ? {targetRegion: "detail" as const} : {}),
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
        this.emitAttention("workflows.transition", attention);
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
    this.emitAttention("workflows.transition", attention, {
      ...(this.attentionClient(targetClientId).role === "composed" ? {targetRegion: "detail" as const} : {}),
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
      this.emitAttention("workflows.cancel", attention);
    }
    return next;
  }

  private emitAttention(
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
      this.emitAttention("attention.stale", next);
    }
  }

  private sameTab(
    left: OutlinerClientRegistration,
    right: OutlinerClientRegistration,
  ): boolean {
    return Boolean(
      left.runtime?.hostname &&
      right.runtime?.hostname &&
      left.runtime.workspaceId &&
      left.runtime.tabId &&
      left.runtime.hostname === right.runtime?.hostname &&
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

  private navigationView(view: OutlinerViewAddress, destination = false): OutlinerClientRegistration {
    if (!view || (view.region !== "tree" && view.region !== "detail")) throw new Error("Navigation requires an explicit logical view region");
    const client = this.clientById(view.clientId);
    if (!clientSupportsRole(client, view.region) || (destination && view.region !== "detail")) throw new Error("Open destination must be a live Detail view");
    return client;
  }

  private navigationLinkState(source: OutlinerViewAddress): NavigationLinkState {
    const sourceClient = this.navigationView(source);
    const destination = this.navigationLinks.get(JSON.stringify([source.clientId, source.region])) ?? null;
    const nearby = (client: OutlinerClientRegistration): number => {
      if (client.clientId === destination?.clientId) return 0;
      if (client.clientId === source.clientId) return 1;
      if (client.runtime?.hostname && client.runtime.hostname === sourceClient.runtime?.hostname) {
        return client.runtime.tabId && client.runtime.tabId === sourceClient.runtime?.tabId ? 2 : 3;
      }
      return client.runtime?.paneId ? 4 : 5;
    };
    const clients = this.listClients("detail").filter(client => {
      // A ready local registry can disprove a claimed Herdr terminal. Missing
      // topology alone says nothing about remote or non-Herdr readers.
      return !(this.herdrRegistry?.phase === "ready" && !this.clientOwnsTopology(client) &&
        client.runtime?.terminalId && !this.herdrRegistry.paneIdForTerminal(client.runtime.terminalId));
    });
    const groupKey = (client: OutlinerClientRegistration) => [client.runtime?.hostname, client.runtime?.workspaceId, client.runtime?.tabId].join("/");
    return {source, destination, destinations: clients.sort((a, b) => nearby(a) - nearby(b) || groupKey(a).localeCompare(groupKey(b))).map(client => {
      const target = client.currentTarget ?? client.previewTarget;
      const block = target?.kind === "block" ? this.store.get(target.blockId) : null;
      const resource = target?.kind === "resource" ? this.store.resources.get(target.resourceId) : null;
      const label = block ? (blockDisplayTitle(block) === block.id ? "Untitled block" : blockDisplayTitle(block)) : resource ? resourceAddressLabel(resource.address)
        : target ? "Unavailable document" : "Empty Detail";
      const runtime = client.runtime;
      const registry = !this.clientOwnsTopology(client) && this.herdrRegistry?.phase === "ready" ? this.herdrRegistry : undefined;
      const workspace = runtime?.workspaceId ? registry?.workspaces.get(runtime.workspaceId) : undefined;
      const tab = runtime?.tabId ? registry?.tabs.get(runtime.tabId) : undefined;
      const named = (record: Record<string, unknown> | undefined, fallback: string | undefined) => typeof record?.label === "string" && record.label.trim() ? record.label : fallback;
      const groupLabel = runtime?.paneId
        ? [named(workspace, runtime.workspaceId), named(tab, runtime.tabId)].filter(Boolean).join(" › ")
        : "Other connected views";
      const location = runtime?.paneId
        ? [groupLabel, runtime.hostname, `pane ${runtime.paneId}`].filter(Boolean).join(" · ")
        : `Location unavailable${runtime?.hostname ? ` · ${runtime.hostname}` : ""} · client ${client.clientId.slice(0, 8)}`;
      return {view: {clientId: client.clientId, region: "detail" as const}, label,
        groupLabel, description: `${client.role === "composed" ? "Composed Detail" : "Detail"} · ${location}${!client.currentTarget && client.previewTarget ? " · inspecting Preview" : ""}`,
        ...(runtime?.paneId && runtime.hostname && runtime.hostname === sourceClient.runtime?.hostname ? {placementPaneId: runtime.paneId} : {}),
        ...(sourceClient.runtime?.paneId && (!runtime?.paneId || runtime.hostname !== sourceClient.runtime.hostname) ? {otherLocation: true} : {}),
        ...(target ? {target} : {}), ...(client.navigationProtection ? {protection: client.navigationProtection} : {})};
    })};
  }

  private resolveExplicitOpen(source: OutlinerClientRegistration, sourceRegion?: OutlinerViewAddress["region"], destination?: OutlinerViewAddress, preserveSource = false): OutlinerNavigationResolution {
    const region = sourceRegion ?? (source.role === "tree" || source.role === "detail" ? source.role : undefined);
    if (!region) throw new Error("Composed Open requires sourceRegion: tree or detail");
    this.navigationView({clientId: source.clientId, region});
    const chosen = destination ?? this.navigationLinks.get(JSON.stringify([source.clientId, region]));
    if (!chosen) throw new Error("No linked destination · use Link destination, Open once, or a new Detail split");
    let target: OutlinerClientRegistration;
    try { target = this.navigationView(chosen, true); }
    catch { throw new Error("Linked destination closed · choose a destination or open a new Detail split"); }
    if (preserveSource && chosen.clientId === source.clientId && region === chosen.region) throw new Error("Choose another destination to preserve this source");
    if (target.navigationProtection) throw new Error(`Destination is protected: ${target.navigationProtection} · finish or cancel it there`);
    return {sourceClientId: source.clientId, targetClientId: chosen.clientId, targetRegion: chosen.region, intent: "open", resolution: destination ? "chosen" : "linked"};
  }

  private resolveNavigationTarget(
    sourceClientId: string,
    intent: OutlinerNavigationIntent,
    preserveSource = false,
    sourceRegion?: OutlinerViewAddress["region"],
    destination?: OutlinerViewAddress,
  ): Omit<OutlinerNavigationDispatch, "command"> {
    const source = this.clientById(sourceClientId);
    if (source.role === "observer") throw new Error("Observers cannot initiate navigation");
    if (intent === "open") return this.resolveExplicitOpen(source, sourceRegion, destination, preserveSource);
    if (intent === "preview") {
      return {sourceClientId, targetClientId: sourceClientId, targetRegion: source.role === "tree" ? "tree" : "detail", intent, resolution: "self"};
    }
    const primary = this.listClients("composed").find(client => client.contextId === source.contextId);
    if (primary && !preserveSource) {
      return { sourceClientId, targetClientId: primary.clientId, intent, resolution: "context", targetRegion: intent === "reveal" ? "tree" : "detail" };
    }
    if (!this.hasAvailableTopology(source)) {
      throw new Error("Herdr pane discovery is unavailable · wait for the service registry to reconnect");
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
        ...(contextCandidates[0]!.role === "composed" ? { targetRegion: "tree" as const } : {}),
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
        ...(sameTabCandidates[0]!.role === "composed" ? { targetRegion: "tree" as const } : {}),
        intent,
        resolution: "same-tab",
      };
    }
    if (sameTabCandidates.length === 0) {
      throw new Error("No Tree destination is available in this pane's context or tab");
    }
    throw new Error("Multiple same-tab Tree destinations share no browsing context");
  }

  async handleAsync(
    request: OutlinerRequest,
    subscribedClient?: OutlinerClientRegistration,
  ): Promise<OutlinerResponse> {
    if (request.action === "edit-recovery.assist") {
      let cancel: AbortController | undefined;
      try {
        const record = this.editRecovery.get(request.recoveryId);
        if (record.revision !== request.expectedRevision || record.state !== "retained") throw Error("Recovery changed; reopen it before asking for a merge");
        if (this.editMergeJobs.has(record.id)) throw Error("A merge is already running for this draft");
        cancel = new AbortController();
        this.editMergeJobs.set(record.id, cancel);
        const proposal = await proposeEditMerge(record, {workspaceRoot:this.store.workspaceRoot,stateDirectory:dirname(this.socketPath),promptDirectory:this.promptDirectory}, cancel.signal);
        cancel.signal.throwIfAborted();
        const result = this.editRecovery.propose(record.id, record.revision, proposal);
        return {id:request.id,ok:true,result,sequence:this.store.sequence};
      } catch (error) {
        return {id:request.id,ok:false,error:error instanceof Error ? error.message : String(error),sequence:this.store.sequence};
      } finally {
        if (cancel && this.editMergeJobs.get(request.recoveryId) === cancel) this.editMergeJobs.delete(request.recoveryId);
      }
    }
    if(request.action==="resources.describe"){
      try {
        // This built-in only reads an immutable Inbox before-image. It cannot
        // execute arbitrary producers, tools, or external requests on preview.
        const checked=this.handle(request,subscribedClient);
        if(!checked.ok||!this.store.resources.isCaptureHistory(request.target.resourceId))return checked;
        const description=this.store.resources.describe(request.target.resourceId,true,request.target.revision);
        if(request.target.revision===undefined&&!description.computed&&!description.source.policy.deniedCapabilities.includes("read"))await this.store.resources.executeComputedResource(request.target.resourceId,true);
        return this.handle(request,subscribedClient);
      } catch(error){return {id:request.id,ok:false,error:error instanceof Error?error.message:String(error),sequence:this.store.sequence};}
    }
    if (request.action === "inbox.search") {
      try {
        if(request.semantic!==undefined&&typeof request.semantic!=="boolean")throw new Error("semantic must be a boolean");
        let result=searchInboxHistory(this.store,request.query);
        if(request.semantic&&this.activeGotoRankings<2){
          this.activeGotoRankings++;
          try{result=await rankSearchWithJev(request.query,result,{promptDirectory:this.promptDirectory});}
          finally{this.activeGotoRankings--;}
          result.matches=result.matches.filter(match=>match.revisions.every(saved=>{
            const current=this.store.get(saved.id);return current&&!current.effectiveDeletedRootId&&!current.deletedAt&&current.revision===saved.revision;
          }));
        }else if(request.semantic)result.semantic={status:"unavailable",message:"Jev busy; showing text matches"};
        return {id:request.id,ok:true,result:visibleInboxSearch(result),sequence:this.store.sequence};
      }catch(error){return {id:request.id,ok:false,error:error instanceof Error?error.message:String(error),sequence:this.store.sequence};}
    }
    if (request.action === "tree.search") {
      try {
        if (request.semantic !== undefined && typeof request.semantic !== "boolean") throw new Error("semantic must be a boolean");
        let result = this.store.searchTree(request.query);
        if (request.semantic && this.activeGotoRankings < 2) {
          this.activeGotoRankings++;
          try { result = await rankGotoWithJev(request.query, result, { promptDirectory: this.promptDirectory }); }
          finally { this.activeGotoRankings--; }
          // A model answer cannot resurrect a deleted or edited candidate.
          result.matches = result.matches.filter(match => {
            const current = this.store.get(match.block.id);
            return current && !current.effectiveDeletedRootId && !current.deletedAt && current.revision === match.block.revision;
          });
        } else if (request.semantic) {
          result.semantic = { status: "unavailable", message: "Jev busy; showing text matches" };
        }
        return { id: request.id, ok: true, result: visibleGotoResults(result), sequence: this.store.sequence };
      } catch (error) {
        return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error), sequence: this.store.sequence };
      }
    }
    if (
      request.action !== "resources.open" &&
      request.action !== "resources.refresh" &&
      request.action !== "resources.command.execute" &&
      request.action !== "resources.follow-authored" &&
      request.action !== "computed.execute"
    ) {
      return this.handle(request, subscribedClient);
    }
    if (request.action === "resources.follow-authored") {
      try {
        const result = await this.store.resources.followAuthoredReference(request.reference);
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
    try {
      const destination = this.clientById(request.destinationClientId);
      if (!clientSupportsRole(destination, "detail")) {
        throw new Error("Resource documents require a Detail destination");
      }
      let result: unknown;
      if (request.action === "resources.open") {
        const target = this.normalizeNavigationTarget(request.target);
        if (target.kind !== "resource") {
          throw new Error("Resource document target must be a resource");
        }
        const description = await this.store.resources.open(
          target.resourceId,
          true,
          target.revision,
        );
        result = this.presentResource(description, destination);
      } else if (request.action === "resources.refresh") {
        const local = this.presentResource(
          this.store.resources.describe(request.resourceId, true),
          destination,
        );
        this.requireAvailableResourceCapability(local, "refresh", true);
        const description = await this.store.resources.refresh(
          request.resourceId,
          true,
        );
        result = this.presentResource(description, destination);
      } else if (request.action === "computed.execute") {
        const local = this.presentResource(
          this.store.resources.describe(request.resourceId, true),
          destination,
        );
        this.requireAvailableResourceCapability(local, "refresh", true);
        const receipt = await this.store.resources.executeComputedResource(
          request.resourceId,
          true,
        );
        const description = this.presentResource(
          this.store.resources.describe(request.resourceId, true),
          destination,
        );
        result = { receipt, description } satisfies ComputedExecutionResult;
      } else {
        const input = normalizeResourceProviderCommandInput(request.input);
        const resource = this.store.resources.require(request.resourceId);
        if (resource.provider !== "jira" && resource.provider !== "linear") {
          throw new Error("Resource provider commands require a Jira or Linear Resource");
        }
        if (input.provider !== resource.provider) {
          throw new Error("Resource provider command does not match the resolved Resource");
        }
        const local = this.presentResource(
          this.store.resources.describe(resource.id, true),
          destination,
        );
        this.requireAvailableResourceCapability(local, "command");
        if (
          !local.availableCommands.some((descriptor) =>
            descriptor.provider === input.provider &&
            descriptor.command === input.command
          )
        ) {
          throw new Error("Resource provider command is not available for this entity");
        }
        const receipt = await this.store.resources.executeRemoteEntityCommand(
          resource.id,
          input,
        );
        const description = this.presentResource(
          this.store.resources.describe(resource.id, true),
          destination,
        );
        result = { receipt, description } satisfies ResourceProviderCommandResult;
      }
      return { id: request.id, ok: true, result, sequence: this.store.sequence };
    } catch (error) {
      const problem = queryRequestProblem(error);
      return {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(problem ? { problem } : {}),
        sequence: this.store.sequence,
      };
    }
  }

  handle(
    request: OutlinerRequest,
    subscribedClient?: OutlinerClientRegistration,
  ): OutlinerResponse {
    try {
      let result: unknown;
      const action = request.action;
      switch (action) {
        case "inbox.search": result = visibleInboxSearch(searchInboxHistory(this.store,request.query)); break;
        case "inbox.status": result = this.inboxStatus(request.attentionOnly, request.resultsOffset); break;
        case "inbox.result": {
          const repository = this.noteRepository.hasResult(request.resultId) ? this.noteRepository : this.inboxRepository;
          result = {...repository.getResult(request.resultId), beforeSource: repository.beforeSource(request.resultId)};
          break;
        }
        case "inbox.pause": result = this.requireInbox().pause(); break;
        case "inbox.resume": result = this.requireInbox().resume(); break;
        case "inbox.retry": result = this.requireInbox().reconsider(request.sourceId, request.instructions); break;
        case "inbox.undo": {
          this.inboxChanged(this.noteRepository.hasResult(request.resultId)
            ? this.noteRepository.undo(request.resultId)
            : this.inboxRepository.undo(request.resultId, blocks => this.noteRepository.checkpointRestored(blocks)));
          result = this.inboxStatus();
          break;
        }
        case "ping":
          result = { status: "ready", protocolVersion: OUTLINER_PROTOCOL_VERSION, minClientProtocol: OUTLINER_MIN_CLIENT_PROTOCOL, capabilities: [...OUTLINER_CAPABILITIES], location:{hostname:this.hostname,workspaceRoot:this.store.workspaceRoot,database:this.store.database.filename,stateDirectory:dirname(this.store.database.filename)}, ...(this.outline ? { outline: { ...this.outline } } : {}) };
          break;
        case "blocks.query":
          result = request.fields === undefined
            ? this.store.queryBlocks(request.query)
            : this.store.queryProjectedBlocks(request.query, request.fields);
          break;
        case "blocks.read":
          result = this.store.readBlocks(request.ids, request.fields);
          break;
        case "views.read": {
          const options = { limit: request.limit, offset: request.offset, expectedRevision: request.expectedRevision };
          result = request.format === "tree"
            ? this.store.readSavedView(request.viewId, options, "tree")
            : this.store.readSavedView(request.viewId, options);
          break;
        }
        case "blocks.authored-links":
          result = readAuthoredLinks(this.store, request.ownerBlockId);
          break;
        case "resources.projection.read":
          result = readResourceProjections(this.store, normalizeResourceProjectionRequest(request));
          break;
        case "children":
          result = this.store.children(request.parentId);
          break;
        case "files.complete":
          result = this.store.resources.completeFilesystemPaths(request.prefix);
          break;
        case "files.read":
          result = this.store.resources.readFilesystemReference(request.path);
          break;
        case "workspace.snapshot":
          result = this.store.readWorkspaceSnapshot(request.view);
          break;
        case "tree.index":
          result = this.store.readTreeIndex(request.view);
          break;
        case "tree.query":
          result = this.store.queryTree(request.query);
          break;
        case "tree.focus":
          result = this.store.focusTree(request.query);
          break;
        case "tree.search":
          if (request.semantic) throw new Error("Semantic search requires asynchronous dispatch");
          result = visibleGotoResults(this.store.searchTree(request.query));
          break;
        case "events.subscribe":
          result = { subscribed: true, client: subscribedClient ?? request.client };
          break;
        case "changes.since":
          result = this.store.changes.since(request.sequence, request.limit);
          break;
        case "clients.list":
          if (
            request.role !== undefined &&
            request.role !== "tree" &&
            request.role !== "detail" &&
            request.role !== "composed" &&
            request.role !== "observer"
          ) {
            throw new Error(`Invalid client role: ${String(request.role)}`);
          }
          result = this.listClients(request.role);
          break;
        case "working-selection.get":
          result = this.store.workingSelections.get(request.ownerClientId);
          break;
        case "working-selection.save":
          result = this.store.workingSelections.save(request.input);
          break;
        case "working-selection.recoverable":
          result = this.store.workingSelections.recoverable(request.ownerClientId, this.listClients().map(client => client.clientId));
          break;
        case "working-selection.resume":
          result = this.store.workingSelections.resume(request.ownerClientId, request.selectionId, request.expectedRevision,
            this.listClients().map(client => client.clientId));
          break;
        case "clients.update":
          result = this.updateClient(request.clientId, request);
          break;
        case "resource-sources.create":
          result = this.store.resources.createSource(request.input);
          break;
        case "resource-sources.list":
          result = this.store.resources.listSources();
          break;
        case "resource-sources.get":
          result = this.store.resources.requireSource(request.sourceId);
          break;
        case "computed.invocations.create":
          result = this.store.resources.createComputedInvocation(request.input);
          break;
        case "computed.invocations.revise":
          result = this.store.resources.reviseComputedInvocation(request.input);
          break;
        case "computed.handlers.resolve":
          result = this.store.resources.resolveComputedHandler(request.reference);
          break;
        case "computed.executions.list":
          result = this.store.resources.computedExecutionHistory(request.resourceId);
          break;
        case "resources.intern":
          result = this.store.resources.intern(request.input);
          break;
        case "resources.intern-filesystem":
          result = this.store.resources.internFilesystem(request.input);
          break;
        case "resources.lookup-filesystem": {
          const lookup = this.store.resources.resolveAuthoredReference({
            kind: "filesystem",
            path: request.path,
          });
          result = lookup.kind === "ready" ? this.store.resources.require(lookup.resourceId) : null;
          break;
        }
        case "resources.get":
          result = this.store.resources.require(request.resourceId);
          break;
        case "resources.relocate":
          result = this.store.resources.relocate(request.input);
          break;
        case "resources.write-filesystem": {
          const destination = this.clientById(request.destinationClientId);
          if (!clientSupportsRole(destination, "detail")) {
            throw new Error("Filesystem Resource writes require a Detail destination");
          }
          const local = this.presentResource(
            this.store.resources.describe(request.input.resourceId, true),
            destination,
          );
          this.requireAvailableResourceCapability(local, "write", true);
          this.store.resources.writeFilesystem(request.input);
          result = this.presentResource(
            this.store.resources.describe(request.input.resourceId, true),
            destination,
          );
          break;
        }
        case "resources.retention.get":
          result = this.store.resources.retentionPolicy();
          break;
        case "resources.retention.configure":
          result = this.store.resources.configureRetention(request.input);
          break;
        case "resources.retention.inspect":
          result = this.store.resources.inspectRetention(
            request.resourceId,
            this.activeResourceRevisions(request.resourceId),
          );
          break;
        case "resources.retention.pin":
          result = this.store.resources.pinRetention(request.input);
          break;
        case "resources.retention.unpin":
          result = this.store.resources.unpinRetention(request.pinId);
          break;
        case "resources.retention.reference":
          result = this.store.resources.referenceRetention(request.input);
          break;
        case "resources.retention.unreference":
          result = this.store.resources.unreferenceRetention(request.referenceId);
          break;
        case "resources.collect":
          result = this.store.resources.collectRetention(
            request.mode,
            request.resourceId,
            this.activeResourceRevisions(request.resourceId),
          );
          break;
        case "resources.describe": {
          const destination = this.clientById(request.destinationClientId);
          const target = this.normalizeNavigationTarget(request.target);
          if (target.kind !== "resource") {
            throw new Error("Resource description target must be a resource");
          }
          result = this.presentResource(
            this.store.resources.describe(
              target.resourceId,
              true,
              target.revision,
            ),
            destination,
          );
          break;
        }
        case "computed.execute":
        case "resources.open":
        case "resources.refresh":
        case "resources.follow-authored":
        case "resources.command.execute":
          throw new Error(`${request.action} requires asynchronous dispatch`);
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
          result = {
            contextId,
            target: this.browsingContextTargets.get(contextId) ?? null,
          };
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
          const target = request.target === null
            ? null
            : this.normalizeNavigationTarget(request.target);
          this.browsingContextTargets.set(contextId, target);
          let preview: OutlinerNavigationDispatch | undefined;
          let unavailable: string | undefined;
          if (target && request.dispatchPreview !== false) {
            try {
              const route = this.resolveNavigationTarget(request.sourceClientId, "preview");
              preview = {
                ...route,
                command: {
                  targetClientId: route.targetClientId,
                  ...(route.targetRegion ? {targetRegion: route.targetRegion} : {}),
                  command: "preview",
                  target,
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
        case "navigation.link.get":
          result = this.navigationLinkState(request.source);
          break;
        case "navigation.link.set": {
          this.navigationView(request.source);
          const key = JSON.stringify([request.source.clientId, request.source.region]);
          const before = this.navigationLinks.get(key);
          if (request.destination === null) this.navigationLinks.delete(key);
          else { this.navigationView(request.destination, true); this.navigationLinks.set(key, {...request.destination}); }
          result = this.navigationLinkState(request.source);
          const after = this.navigationLinks.get(key);
          if (before?.clientId !== after?.clientId || before?.region !== after?.region) this.emitClientView("navigation.link.set", request.source.clientId);
          break;
        }
        case "navigation.resolve":
          result = this.resolveNavigationTarget(
            request.sourceClientId,
            this.navigationIntent(request.intent),
            request.preserveSource,
            request.sourceRegion,
            request.destination,
          );
          break;
        case "navigation.dispatch": {
          const intent = this.navigationIntent(request.intent);
          if (request.focusTarget !== undefined && intent !== "reveal" && intent !== "open") {
            throw new Error("Explicit focus requires open or reveal intent");
          }
          const navigationTarget = this.normalizeNavigationTarget(request.target);
          const route = this.resolveNavigationTarget(
            request.sourceClientId,
            intent,
            request.preserveSource,
            request.sourceRegion,
            request.destination,
          );
          let command: OutlinerUiCommand;
          if (intent === "reveal") {
            if (navigationTarget.kind !== "block") {
              throw new Error("Resource targets cannot be revealed in the block Tree");
            }
            command = {
              targetClientId: route.targetClientId,
              ...(route.targetRegion ? {targetRegion: route.targetRegion} : {}),
              command: "reveal",
              target: navigationTarget,
              ...(request.focusTarget ? { focus: true } : {}),
            };
          } else {
            command = {
              targetClientId: route.targetClientId,
              ...(route.targetRegion ? {targetRegion: route.targetRegion} : {}),
              command: intent,
              target: navigationTarget,
              ...(request.focusTarget !== undefined ? {focus: request.focusTarget} : {}),
            };
          }
          result = { ...route, command } satisfies OutlinerNavigationDispatch;
          break;
        }
        case "ui.command.send": {
          if (!this.hasClient(request.command.targetClientId)) {
            throw new Error(`Target client is not registered: ${request.command.targetClientId}`);
          }
          const target = this.clientById(request.command.targetClientId);
          if (target.role === "observer") throw new Error("Observers are not navigation destinations");
          const region = request.command.targetRegion;
          if (target.role === "composed" && region !== "tree" && region !== "detail") throw new Error("Composed commands require an explicit target region: tree or detail");
          if (region !== undefined && (region !== "tree" && region !== "detail" || !clientSupportsRole(target, region))) throw new Error("Command target region is unavailable");
          const targetsDetail = target.role === "detail" || region === "detail";
          if (targetsDetail && target.navigationProtection &&
            ("target" in request.command && request.command.target && request.command.command !== "preview")) {
            throw new Error(`Destination is protected: ${target.navigationProtection}`);
          }
          if (target.role === "composed" && region === "tree" && !["focus", "reveal"].includes(request.command.command)) throw new Error("This command requires the Detail region");
          if ("target" in request.command && request.command.target !== undefined) {
            request.command.target = this.normalizeNavigationTarget(request.command.target);
          }
          if (
            request.command.command === "open" ||
            request.command.command === "replace"
          ) {
            const operation = request.command.command === "replace" ? "replace" : "open";
            if (!clientSupportsRole(target, "detail")) {
              throw new Error(`Direct ${operation} target must be a Detail client`);
            }
          }
          if (request.command.command === "backlinks.select") {
            if (!clientSupportsRole(target, "detail")) {
              throw new Error("Backlink selection target must be a Detail client");
            }
            if (!request.command.targetBlockId || !request.command.sourceBlockId) {
              throw new Error("Backlink selection requires target and source block IDs");
            }
            this.store.require(request.command.targetBlockId);
            this.store.require(request.command.sourceBlockId);
          }
          if (request.command.command === "comment.selection") {
            const capture = request.command.renderedSelection;
            if (!clientSupportsRole(target, "detail")) {
              throw new Error("Rendered selection comment target must be a Detail client");
            }
            if (!capture.quote.trim()) {
              throw new Error("Rendered selection comment requires a non-empty quote");
            }
            const capturedAtMs = Date.parse(capture.capturedAt);
            if (
              (capture.validation !== "herdr-keybinding" && capture.validation !== "detail-pointer") ||
              !Number.isInteger(capture.contentRevision) ||
              capture.contentRevision < 0 ||
              typeof capture.snapshotText !== "string" ||
              !Number.isFinite(capturedAtMs) ||
              new Date(capturedAtMs).toISOString() !== capture.capturedAt
            ) {
              throw new Error("Rendered selection evidence is invalid");
            }
            const currentBlockId = target.currentTarget?.kind === "block"
              ? target.currentTarget.blockId
              : undefined;
            if (
              capture.detailClientId !== target.clientId ||
              capture.contextId !== target.contextId ||
              capture.hostBlockId !== currentBlockId ||
              capture.paneId !== target.runtime?.paneId
            ) {
              throw new Error("Rendered selection no longer matches the target Detail");
            }
            this.store.requireActive(capture.hostBlockId);
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
        case "mentions.ingest": result=this.mentions.ingest(request.message); break;
        case "mentions.list": result=this.mentions.list(request.scope,request.limit); break;
        case "mentions.message": result=this.mentions.message(request.messageKey); break;
        case "mentions.clear": result=this.mentions.clear(request.scope); break;
        case "mentions.save": result=this.mentions.save(request.messageKey); break;
        case "bookmarks.root":
          result = this.store.bookmarksRoot();
          break;
        case "bookmarks.status":
          result = this.store.bookmarkStatus(request.targetBlockId);
          break;
        case "bookmarks.resolve":
          result = this.store.resolveBookmark(request.recordId);
          break;
        case "bookmarks.toggle":
          result = this.store.toggleBookmark(
            request.targetBlockId,
            request.expectedRecordId,
            request.label,
            request.author,
            request.provenance,
          );
          break;
        case "bookmarks.remove":
          result = this.store.removeBookmark(request.recordId, request.expectedRevision);
          break;
        case "annotations.list":
          result = this.store.listAnnotationThreads(request.query);
          break;
        case "annotations.get":
          result = this.store.getAnnotation(request.annotationId);
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
        case "annotations.reconcile":
          result = this.store.reconcileAnnotationThreads(request.input);
          break;
        case "annotations.approve-resolution":
          result = this.store.approveAnnotationResolution(request.input);
          break;
        case "annotations.agent-package":
          result = this.store.getAnnotationAgentPackage(request.annotationId);
          break;
        case "annotations.agent-receipt":
          result = this.store.getAnnotationAgentReceipt(request.requestId);
          break;
        case "annotations.propose-agent":
          result = this.store.proposeAnnotationAgentResolution(request.requestId, request.input);
          break;
        case "annotations.review-agent":
          result = this.store.reviewAnnotationAgentResolution(request.input);
          break;
        case "annotations.agent-evidence":
          result = this.store.summarizeAnnotationAgentEvidence(request.limit);
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
        case "deliveries.sync":
          result = this.store.syncDelivery(request.input, request.mutation);
          break;
        case "deliveries.ensure":
          result = this.store.ensureDelivery(
            request.input,
            request.author,
            request.provenance,
          );
          break;
        case "capture.create":
          if (request.expectedDraftRevision !== undefined || request.requestId === this.store.quickCaptureDraft()?.requestId) {
            this.requireCaptureOwner(request.ownerClientId);
          }
          result = this.store.capture(
            request.requestId,
            request.text,
            request.source,
            request.capturedFromBlockId,
            request.author,
            request.provenance,
            request.expectedDraftRevision,
          );
          break;
        case "capture.retitle":
          result = this.store.retitleCapture(
            request.blockId,
            request.expectedRevision,
            request.title,
            request.mutation,
          );
          break;
        case "capture.owner.get":
          result = this.currentCaptureOwner();
          break;
        case "capture.owner.claim":
          result = this.claimCaptureOwner(request.clientId, request.location, request.transferToken);
          break;
        case "capture.owner.handoff": {
          this.requireCaptureOwner(request.clientId);
          const draft = this.store.quickCaptureDraft();
          if (!draft || draft.requestId !== request.requestId || draft.revision !== request.expectedDraftRevision) {
            throw Error("Capture changed before handoff");
          }
          this.captureTransfer = {token: crypto.randomUUID(), clientId: request.clientId,
            requestId: draft.requestId, revision: draft.revision, deadline: Date.now() + 30_000};
          result = {token: this.captureTransfer.token};
          break;
        }
        case "capture.draft.get":
          result = this.store.quickCaptureDraft();
          break;
        case "edit-recovery.assist":
          throw Error("Merge proposals require asynchronous dispatch");
        case "edit-recovery.start":
          result = this.editRecovery.start(request.input);
          break;
        case "edit-recovery.get":
          result = this.editRecovery.get(request.recoveryId);
          break;
        case "edit-recovery.list":
          result = this.editRecovery.list(request.blockId,request.includeHistory);
          break;
        case "edit-recovery.restore":
          result = this.editRecovery.restore(request.recoveryId,request.requestId,request.version);
          break;
        case "edit-recovery.refresh":
          result = this.editRecovery.refresh(request.recoveryId,request.expectedRevision);
          break;
        case "edit-recovery.propose":
          if (request.proposal.source !== "manual") throw Error("Agent proposals use the service merge operation");
          result = this.editRecovery.propose(request.recoveryId,request.expectedRevision,request.proposal);
          break;
        case "edit-recovery.cancel":
          this.editMergeJobs.get(request.recoveryId)?.abort();
          result = {retained:true};
          break;
        case "edit-recovery.commit":
          result = this.editRecovery.commit(request.recoveryId,request.expectedRevision,request.text,request.basedOnRevision,request.mutation,request.identityChanges);
          break;
        case "edit-recovery.discard":
          result = this.editRecovery.discard(request.recoveryId,request.expectedRevision);
          break;
        case "edit-recovery.separate":
          result = this.editRecovery.separate(request.recoveryId,request.expectedRevision,request.mutation);
          break;
        case "capture.draft.save":
          this.requireCaptureOwner(request.input.ownerClientId);
          result = this.store.database.transaction(() => {
            const reviewed = request.input.recovery;
            if (!reviewed) return this.store.saveQuickCaptureDraft(request.input);
            const draft = this.store.quickCaptureDraft();
            const record = this.editRecovery.get(reviewed.id);
            if (!draft?.blockId || draft.blockId !== record.blockId || draft.revision !== request.input.expectedRevision) {
              throw Error("Capture changed before writing-history save");
            }
            const block = this.editRecovery.commit(reviewed.id, reviewed.revision, request.input.text,
              reviewed.basedOnBlockRevision, {author: "user", actorId: "capture"});
            // The note, history receipt and capture pointer advance together;
            // failure of any capture guard rolls back the recovery commit too.
            return this.store.saveQuickCaptureDraft(request.input, block.revision);
          })();
          break;
        case "capture.draft.clear":
          this.requireCaptureOwner(request.ownerClientId);
          result = this.store.clearQuickCaptureDraft(request.expectedRevision);
          break;
        case "checklist.query":
          result = this.store.queryChecklist(request.blockId, request.query);
          break;
        case "checklist.search":
          result = this.store.searchChecklist(request.query);
          break;
        case "checklist.update":
          result = this.store.updateChecklist(request.blockId, request.input, request.mutation);
          break;
        case "update":
          result = this.store.update(
            request.blockId,
            request.text,
            request.expectedRevision,
            request.mutation,
            "text",
            request.identityChanges,
          );
          break;
        case "move":
          result = this.store.move(request.blockId, request.parentId, request.position, request.mutation);
          break;
        case "delete":
          result = this.store.delete(request.blockId, request.mutation);
          break;
        case "trash.restore":
          result = this.store.restore(request.blockId, request.mutation);
          break;
        case "trash.purge":
          this.store.purge(request.blockId, request.confirmation);
          result = { purged: request.blockId };
          break;
        case "virtual.occurrences.order":
          result = this.store.virtualBranchOrder(request.viewId);
          break;
        case "virtual.occurrences.place":
          result = this.store.placeVirtualOccurrences(request.input);
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
            request.expectedRevision,
          );
          break;
        case "pages.alias":
          result = this.store.addPageAlias(request.blockId, request.address);
          break;
        case "pages.remove":
          result = this.store.removePageAddress(
            request.blockId,
            request.address,
            request.expectedRevision,
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
            request.expectedRevision,
          );
          break;
        case "properties.patch":
          result = this.store.patchProperties(
            request.blockId,
            request.expectedRevision,
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
            kinds: request.kinds,
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
        case "properties.preview":
          result = previewPropertyParse(request.text);
          break;
        case "properties.inventory":
          result = this.store.propertyInventory(request);
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
      const problem = queryRequestProblem(error);
      return {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(problem ? { problem } : {}),
        sequence: this.store.sequence,
      };
    }
  }

  /** Builds the broadcast for a successful request; `publishChanges` expands content events per recorded change. */
  private eventFor(
    request: OutlinerRequest,
    response: Extract<OutlinerResponse, { ok: true }>,
    previousSequence: number,
  ): OutlinerEvent | null {
    let domain: OutlinerEvent["domain"];
    let blockId: string | undefined;
    let resourceId: string | undefined;
    let sourceId: string | undefined;
    let contextId: string | undefined;
    let command: OutlinerEvent["command"];
    let attention: AttentionClientState | undefined;
    let attentionInstruction: OutlinerEvent["attentionInstruction"];
    switch (request.action) {
      case "mentions.ingest": {
        const receipt=response.result as {deduplicated:boolean;references:number};
        if(receipt.deduplicated||!receipt.references)return null;
        domain="mentions";break;
      }
      case "mentions.clear":
        if(!(response.result as {removed:number}).removed)return null;
        domain="mentions";break;
      case "resource-sources.create":
        domain = "resource-catalog";
        sourceId = eventResultId(response.result, "Resource source");
        break;
      case "computed.invocations.create":
      case "computed.invocations.revise": {
        const invocation = response.result as ComputedInvocation;
        domain = "resource-catalog";
        resourceId = invocation.resourceId;
        break;
      }
      case "computed.execute": {
        const execution = response.result as ComputedExecutionResult;
        domain = "resource-catalog";
        resourceId = execution.receipt.resourceId;
        break;
      }
      case "resources.intern": {
        const receipt = response.result as InternResourceReceipt;
        if (!receipt.created) return null;
        domain = "resource-catalog";
        resourceId = receipt.resource.id;
        break;
      }
      case "resources.intern-filesystem": {
        const receipt = response.result as InternResourceReceipt;
        if (!receipt.created) return null;
        domain = "resource-catalog";
        resourceId = receipt.resource.id;
        break;
      }
      case "resources.follow-authored": {
        const receipt = response.result as InternResourceReceipt;
        if (!receipt.created) return null;
        domain = "resource-catalog";
        resourceId = receipt.resource.id;
        break;
      }
      case "resources.relocate":
        domain = "resource-catalog";
        resourceId = (response.result as Resource).id;
        break;
      case "resources.open":
        return null;
      case "resources.refresh":
        domain = "resource-catalog";
        resourceId = (response.result as ResourceDescription).resource.id;
        break;
      case "resources.write-filesystem":
        domain = "resource-catalog";
        resourceId = (response.result as ResourceDescription).resource.id;
        break;

      case "resources.command.execute": {
        const commandResult = response.result as ResourceProviderCommandResult;
        domain = "resource-catalog";
        resourceId = commandResult.receipt.resourceId;
        break;
      }
      case "resources.retention.configure":
        domain = "resource-catalog";
        break;
      case "resources.retention.pin": {
        const receipt = response.result as { pin: ResourceRetentionPin; created: boolean };
        if (!receipt.created) return null;
        domain = "resource-catalog";
        resourceId = receipt.pin.resourceId;
        break;
      }
      case "resources.retention.unpin":
        if (!(response.result as { removed: boolean }).removed) return null;
        domain = "resource-catalog";
        break;
      case "resources.retention.reference": {
        const receipt = response.result as {
          reference: ResourceRetentionReference;
          created: boolean;
        };
        if (!receipt.created) return null;
        domain = "resource-catalog";
        resourceId = receipt.reference.resourceId;
        break;
      }
      case "resources.retention.unreference":
        if (!(response.result as { removed: boolean }).removed) return null;
        domain = "resource-catalog";
        break;
      case "resources.collect": {
        const receipt = response.result as ResourceRetentionCollectionReceipt;
        if (receipt.evicted.length === 0 && receipt.purged.length === 0) return null;
        domain = "resource-catalog";
        resourceId = receipt.resourceId ?? undefined;
        break;
      }
      case "create":
      case "edit-recovery.separate":
        domain = "content";
        blockId = (response.result as Block).id;
        break;
      case "edit-recovery.commit":
        domain = "content";
        blockId = (response.result as Block).id;
        break;
      case "bookmarks.toggle":
        domain = "content";
        blockId = (response.result as BookmarkToggleReceipt).record.id;
        break;
      case "bookmarks.remove":
        domain = "content";
        blockId = (response.result as BookmarkRemoveReceipt).record.id;
        break;
      case "roadmap.items.create":
        domain = "content";
        blockId = (response.result as RoadmapItemCreateReceipt).block.id;
        break;
      case "deliveries.sync": {
        const receipt = response.result as DeliverySyncReceipt;
        if (!receipt.changed) return null;
        domain = "content";
        blockId = receipt.task.id;
        break;
      }
      case "deliveries.ensure": {
        const receipt = response.result as DeliveryReceipt;
        if (!receipt.created) return null;
        domain = "content";
        blockId = receipt.delivery.id;
        break;
      }
      case "mentions.save":
      case "capture.create": {
        const receipt = response.result as CaptureReceipt;
        if (receipt.deduplicated) return null;
        domain = "content";
        blockId = receipt.block.id;
        break;
      }
      case "workflows.promotion.commit": {
        const receipt = response.result as WorkflowPromotionReceipt;
        if (receipt.deduplicated) return null;
        domain = "content";
        blockId = receipt.block.id;
        break;
      }
      case "capture.retitle":
        domain = "content";
        blockId = (response.result as Block).id;
        break;
      case "capture.draft.save":
        if (response.sequence === previousSequence) return null;
        blockId = (response.result as QuickCaptureDraft).blockId;
        if (!blockId) return null;
        domain = "content";
        break;
      case "capture.draft.clear":
        if (response.sequence === previousSequence) return null;
        domain = "content";
        break;
      case "annotations.create":
      case "annotations.reply":
      case "annotations.batch": {
        const receipt = response.result as AnnotationBatchReceipt;
        if (receipt.deduplicated) return null;
        domain = "content";
        blockId = receipt.annotations[0]?.block.id;
        break;
      }
      case "annotations.reconcile":
        if (!annotationReconcileChanged(response.result)) return null;
        domain = "content";
        break;
      case "annotations.approve-resolution":
        domain = "content";
        blockId = request.input.annotationId;
        break;
      case "annotations.propose-agent": {
        const receipt = response.result as AnnotationAgentProposalReceipt;
        if (receipt.deduplicated) return null;
        domain = "content";
        blockId = request.input.annotationId;
        break;
      }
      case "annotations.review-agent":
        domain = "content";
        blockId = request.input.annotationId;
        break;
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
          ...(request.input.targetRegion ? {targetRegion: request.input.targetRegion} : {}),
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
      case "checklist.update":
        if (response.sequence === previousSequence) return null;
        domain = "content";
        blockId = request.blockId;
        break;
      case "update":
      case "properties.patch":
      case "pages.rename":
      case "pages.alias":
      case "pages.remove":
      case "work-ids.allocate":
        domain = "content";
        blockId = request.blockId;
        break;
      case "move":
      case "delete":
      case "trash.restore":
      case "trash.purge":
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
      case "virtual.occurrences.place":
        domain = "view";
        blockId = request.input.expected.viewId;
        break;
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
        blockId = "target" in request.command && request.command.target?.kind === "block"
          ? request.command.target.blockId
          : request.command.command === "backlinks.select"
            ? request.command.targetBlockId
            : undefined;
        resourceId = "target" in request.command && request.command.target?.kind === "resource"
          ? request.command.target.resourceId
          : undefined;
        command = request.command;
        break;
      case "navigation.dispatch": {
        const dispatched = response.result as OutlinerNavigationDispatch;
        domain = "ui";
        blockId = request.target.kind === "block" ? request.target.blockId : undefined;
        resourceId = request.target.kind === "resource" ? request.target.resourceId : undefined;
        command = dispatched.command;
        break;
      }
      case "browsing-context.publish": {
        const published = response.result as BrowsingContextPublication;
        domain = "browsing-context";
        contextId = published.contextId;
        blockId = published.target?.kind === "block" ? published.target.blockId : undefined;
        resourceId = published.target?.kind === "resource"
          ? published.target.resourceId
          : undefined;
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
      resourceId,
      command,
      ...(attention ? { attention } : {}),
      sourceId,
      ...(attentionInstruction ? { attentionInstruction } : {}),
      contextId,
    };
  }

  /**
   * Publishes committed feed changes as live events, one per change, so the
   * feed covers exactly what subscribers receive. `base` is the request's own
   * event, whose fields (domain aside) the change events keep.
   */
  private publishChanges(base: OutlinerEvent | undefined, changes: readonly OutlinerChange[]): OutlinerEvent[] {
    const events: OutlinerEvent[] = changes.map(change => ({
      ...(base ?? {}),
      id: crypto.randomUUID(),
      // Branch-local ranks keep their `view` domain for existing subscribers.
      domain: change.kind === "reorder" ? "view" : "content",
      action: base?.action ?? change.action,
      sequence: change.sequence,
      change,
      blockId: change.blockId ?? base?.blockId,
    }));
    for (const event of events) this.broadcast(event);
    for (const event of events) {
      if (event.domain === "content" && event.blockId) this.refreshAttentionForBlock(event.blockId);
    }
    if (events.some(event => event.domain === "content")) this.inbox?.wake();
    return events;
  }

  private broadcast(event: OutlinerEvent): void {
    this.pruneDestroyedSubscribers();
    const envelope: OutlinerEventEnvelope = { event };
    const line = `${JSON.stringify(envelope)}\n`;
    const contextLine = event.domain === "browsing-context"
      ? `${JSON.stringify({ event: { ...event, command: undefined } } satisfies OutlinerEventEnvelope)}\n`
      : line;
    for (const [subscriber, client] of this.subscribers) {
      if (subscriber.destroyed || subscriber.readableEnded || subscriber.writableEnded) continue;
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

  private async respond(socket: Socket, line: string): Promise<void> {
    let request: OutlinerRequest | undefined;
    let response: OutlinerResponse;
    let attribution: ChangeAttribution | undefined;
    const previousSequence = this.store.sequence;
    try {
      request = JSON.parse(line) as OutlinerRequest;
      const subscribedClient = request.action === "events.subscribe"
        ? this.registerSubscriber(socket, request.client)
        : undefined;
      const current = request;
      attribution = this.store.changes.attribution({
        action: String(current.action),
        actor: declaredActor(current),
        kind: requestChangeKind(current.action),
        collect: true,
      });
      response = await this.store.changes.run(attribution, () => this.handleAsync(current, subscribedClient));
    } catch (error) {
      const problem = queryRequestProblem(error);
      response = {
        id: request?.id ?? "invalid",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(problem ? { problem } : {}),
        sequence: this.store.sequence,
      };
    }
    // Changes are already durable in the feed; a failure below only costs the live event.
    const changes = attribution ? this.store.changes.committed(attribution) : [];
    socket.write(`${JSON.stringify(response)}\n`);
    try {
      this.publish(request, response, previousSequence, changes);
    } catch (error) {
      // The changes are durable in the feed; subscribers recover them with changes.since.
      process.stderr.write(`outliner: live event publication failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private publish(
    request: OutlinerRequest | undefined,
    response: OutlinerResponse,
    previousSequence: number,
    changes: readonly OutlinerChange[],
  ): void {
    const base = request && response.ok ? this.eventFor(request, response, previousSequence) ?? undefined : undefined;
    if (changes.length > 0) {
      // A failed request can still have committed earlier transactions.
      this.publishChanges(base?.domain === "content" || base?.domain === "view" ? base : request && {
        id: "", domain: "content", action: String(request.action), sequence: response.sequence,
      }, changes);
      if (base && base.domain !== "content" && base.domain !== "view") this.broadcast(base);
      return;
    }
    if (!base) return;
    this.broadcast(base);
    if (base.domain === "content" && base.blockId) this.refreshAttentionForBlock(base.blockId);
    if (base.domain === "content") this.inbox?.wake();
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.once("close", () => this.removeSubscriber(socket));
    // A peer that vanishes mid-write (EPIPE, ECONNRESET) is routine for a long-lived service:
    // drop it like a close. Without a listener, Bun 1.4 raises these as unhandled errors.
    socket.on("error", () => this.removeSubscriber(socket));
    let buffer = "";
    let requestQueue = Promise.resolve();
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          requestQueue = requestQueue.then(() => this.respond(socket, line));
        }
        newline = buffer.indexOf("\n");
      }
    });
  }
}
