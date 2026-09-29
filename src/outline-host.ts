import { Database } from "bun:sqlite";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { aiPromptDirectory, initializeAiPrompts } from "./ai-prompts";
import type { HerdrRuntimeRegistry } from "./herdr-registry";
import { OUTLINE_NAME_PATTERN, readOutlineDescriptor, socketAbsent } from "./known-outlines";
import { hostedOutlinePaths, outlineHostPaths } from "./paths";
import { OutlinerServer } from "./server";
import { OutlinerStore } from "./store";
import {
  type HostedOutlineList,
  type HostedOutlineSummary,
  OUTLINER_HOST_CAPABILITIES,
  OUTLINER_MIN_CLIENT_PROTOCOL,
  OUTLINER_PROTOCOL_VERSION,
  type OutlinerHostStatus,
  type OutlinerResponse,
  type OutlinerServiceStatus,
} from "./types";
import { acquireWorkspaceOwnership } from "./workspace-ownership";

/*
 * The outline host (PIE-457): one process per user and machine, one socket,
 * any number of outlines, like a tmux server. Whatever is in `outlines/` exists;
 * nothing else is scanned, hashed or registered, and an outline is only ever
 * born through `outlines.create`.
 *
 * Every connection talks to one outline (one request, or one subscription), so
 * the host reads only the first line, picks the outline its `outline` field
 * names (or the default), and hands the socket and what it already read to that
 * outline's OutlinerServer, which serves it exactly as a standalone service would.
 */

export interface HostedOutline {
  name: string;
  /** The real database path (an adopted link resolved). */
  database: string;
  adopted: boolean;
  /** Side files: prompts, assistant sessions. */
  stateDirectory: string;
  workspaceRoot: string;
  promptDirectory: string;
  store: OutlinerStore;
  server: OutlinerServer;
}

export interface OutlineHostOptions {
  stateRoot: string;
  /** Where requests without `outline` go. It must already exist; the host never creates it. */
  defaultOutline?: string;
  /** Shared by every outline: Herdr's panes are one machine-wide fact. */
  herdrRegistry?: HerdrRuntimeRegistry;
  /** `OUTLINER_PROMPT_DIR`: one prompt folder for every outline, used as is. */
  promptDirectory?: string;
  /** Called once per outline after it opens (the Inbox agent starts here). A failure is logged. */
  onOpen?: (outline: HostedOutline) => void | Promise<void>;
  log?: (message: string) => void;
}

const HOST_ACTIONS = new Set(["outlines.list", "outlines.create", "outlines.adopt"]);
/** A first line longer than this is not a request; the connection is dropped. */
const MAX_FIRST_LINE = 64 * 1024 * 1024;

function isOutlineName(name: unknown): name is string {
  return typeof name === "string" && OUTLINE_NAME_PATTERN.test(name);
}

function requireName(name: unknown): string {
  if (!isOutlineName(name)) {
    throw new Error(`An outline name must be a short slug of lowercase letters, digits and hyphens (${OUTLINE_NAME_PATTERN.source}); got ${JSON.stringify(name)}`);
  }
  return name;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function lstatOrUndefined(path: string) {
  try { return lstatSync(path); }
  catch (error) { if (errorCode(error) === "ENOENT") return undefined; throw error; }
}

const SQLITE_HEADER = "SQLite format 3\u0000";

function hasSqliteHeader(path: string): boolean {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    return readSync(descriptor, header, 0, header.length, 0) === header.length && header.toString("latin1") === SQLITE_HEADER;
  } finally {
    closeSync(descriptor);
  }
}

/** Whether a SQLite file has the outliner's tables. Opens without creating or migrating anything. */
function isOutlinerDatabase(path: string): boolean {
  const database = new Database(path, { create: false, readwrite: true });
  try {
    const tables = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('blocks', 'metadata')").all();
    return tables.length === 2;
  } finally {
    database.close();
  }
}

/**
 * An adopted database keeps the folder its slice-1 descriptor records (a
 * `outline.json` beside `outliner.sqlite`); without one, its own folder.
 */
function adoptedWorkspaceRoot(database: string): string {
  const folder = dirname(database);
  if (basename(database) === "outliner.sqlite") {
    const descriptor = readOutlineDescriptor(folder);
    if (descriptor.kind === "ok") return resolve(descriptor.descriptor.root);
  }
  return folder;
}

export class OutlineHost {
  readonly socketPath: string;
  readonly outlinesFolder: string;
  readonly defaultOutline: string | undefined;
  private listener: Server | null = null;
  private readonly opened = new Map<string, HostedOutline>();
  private readonly opening = new Map<string, Promise<HostedOutline>>();
  private readonly connections = new Set<Socket>();
  private closing = false;

  constructor(private readonly options: OutlineHostOptions) {
    const paths = outlineHostPaths(options.stateRoot);
    this.socketPath = paths.socket;
    this.outlinesFolder = paths.outlines;
    this.defaultOutline = options.defaultOutline === undefined ? undefined : requireName(options.defaultOutline);
  }

  private get stateRoot(): string {
    return resolve(this.options.stateRoot);
  }

  private log(message: string): void {
    (this.options.log ?? (text => console.error(text)))(message);
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.socketPath), { recursive: true });
    if (existsSync(this.socketPath)) {
      if (!(await socketAbsent(this.socketPath, 250))) throw new Error(`An outline host is already running at ${this.socketPath}`);
      unlinkSync(this.socketPath);
    }
    const listener = createServer(socket => this.accept(socket));
    const started = Promise.withResolvers<void>();
    listener.once("error", started.reject);
    listener.listen(this.socketPath, () => {
      listener.off("error", started.reject);
      started.resolve();
    });
    await started.promise;
    this.listener = listener;
    if (this.defaultOutline && !lstatOrUndefined(hostedOutlinePaths(this.stateRoot, this.defaultOutline).database)) {
      this.log(`Default outline "${this.defaultOutline}" is not in ${this.outlinesFolder}; requests without an outline fail until it is created or adopted.`);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const listener = this.listener;
    this.listener = null;
    const listenerClosed = Promise.withResolvers<void>();
    if (listener) listener.close(error => (error ? listenerClosed.reject(error) : listenerClosed.resolve()));
    else listenerClosed.resolve();
    await Promise.allSettled(this.opening.values());
    const failures: unknown[] = [];
    for (const outline of this.opened.values()) {
      try { await outline.server.close(); } catch (error) { failures.push(error); }
    }
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    for (const outline of this.opened.values()) {
      try { outline.store.close(); } catch (error) { failures.push(error); }
    }
    this.opened.clear();
    await listenerClosed.promise;
    if (listener && existsSync(this.socketPath)) unlinkSync(this.socketPath);
    if (failures.length > 0) throw new AggregateError(failures, "Some outlines did not close cleanly");
  }

  /** What `ping` reports as `host`. */
  status(): OutlinerHostStatus {
    return {
      socket: this.socketPath,
      ...(this.defaultOutline ? { defaultOutline: this.defaultOutline } : {}),
      outlines: this.names(),
    };
  }

  private names(): string[] {
    let entries: string[];
    try { entries = readdirSync(this.outlinesFolder); }
    catch (error) { if (errorCode(error) === "ENOENT") return []; throw error; }
    return entries
      .filter(entry => entry.endsWith(".sqlite") && isOutlineName(entry.slice(0, -".sqlite".length)))
      .map(entry => entry.slice(0, -".sqlite".length))
      .sort();
  }

  private summary(name: string): HostedOutlineSummary {
    const { database } = hostedOutlinePaths(this.stateRoot, name);
    const adopted = lstatOrUndefined(database)?.isSymbolicLink() ?? false;
    let real = database;
    let problem: string | undefined;
    if (adopted) {
      try { real = realpathSync(database); }
      catch { real = resolve(dirname(database), readlinkSync(database)); problem = `The adopted database is missing: ${real}`; }
    }
    return {
      name, database: real, adopted, open: this.opened.has(name), default: name === this.defaultOutline,
      ...(problem ? { problem } : {}),
    };
  }

  /** Every outline in `outlines/`, open or not. Reads only; never creates anything. */
  list(): HostedOutlineList {
    return {
      ...(this.defaultOutline ? { defaultOutline: this.defaultOutline } : {}),
      outlines: this.names().map(name => this.summary(name)),
    };
  }

  private refuseTaken(name: string): void {
    const paths = hostedOutlinePaths(this.stateRoot, name);
    if (lstatOrUndefined(paths.database)) throw new Error(`An outline named "${name}" already exists in ${this.outlinesFolder}`);
    if (lstatOrUndefined(paths.sideFolder)) throw new Error(`${paths.sideFolder} already exists; refusing to reuse it for a new outline named "${name}"`);
  }

  /** Creates a new, empty outline and opens it. Refuses a name already in use; never overwrites. */
  async create(nameInput: unknown): Promise<HostedOutlineSummary> {
    const name = requireName(nameInput);
    this.refuseTaken(name);
    const paths = hostedOutlinePaths(this.stateRoot, name);
    mkdirSync(this.outlinesFolder, { recursive: true });
    // Claim the name exclusively before anything else, so two creates cannot share a file.
    try { closeSync(openSync(paths.database, "wx", 0o600)); }
    catch (error) {
      if (errorCode(error) === "EEXIST") throw new Error(`An outline named "${name}" already exists in ${this.outlinesFolder}`);
      throw error;
    }
    try {
      mkdirSync(paths.sideFolder);
      await this.open(name);
    } catch (error) {
      // Only what this call made: the claimed empty file, its SQLite side files and the new folder.
      for (const suffix of ["", "-wal", "-shm", ".owner.sqlite"]) rmSync(`${paths.database}${suffix}`, { force: true });
      rmSync(paths.sideFolder, { recursive: true, force: true });
      throw error;
    }
    return this.summary(name);
  }

  /**
   * Serves an existing outliner database where it lies, under `name`: a symlink
   * `outlines/<name>.sqlite` to its real path. Its side files stay beside it.
   * Refuses a taken name, a database already in this host, a file that is not
   * an outliner database, and one another process holds.
   */
  async adopt(pathInput: unknown, nameInput: unknown): Promise<HostedOutlineSummary> {
    const name = requireName(nameInput);
    if (typeof pathInput !== "string" || !isAbsolute(pathInput)) throw new Error("outlines.adopt needs the database's absolute path");
    this.refuseTaken(name);
    let real: string;
    try { real = realpathSync(pathInput); }
    catch { throw new Error(`No database at ${pathInput}`); }
    if (!statSync(real).isFile()) throw new Error(`${pathInput} is not a database file`);
    const already = this.list().outlines.find(outline => outline.database === real);
    if (already) throw new Error(`${real} is already served by this host as "${already.name}"`);
    if (!hasSqliteHeader(real)) throw new Error(`${real} is not an outliner database (not a SQLite file)`);
    const ownershipFile = `${real}.owner.sqlite`;
    const hadOwnershipFile = existsSync(ownershipFile);
    // The same check a starting service makes: a database another process serves is refused.
    let release: () => void;
    try { release = acquireWorkspaceOwnership(real); }
    catch (error) {
      if (!hadOwnershipFile) rmSync(ownershipFile, { force: true });
      if (!(error instanceof Error && error.message.startsWith("Outliner workspace is already owned"))) throw error;
      throw new Error(`${real} is in use by another outliner process; stop it before adopting the database`, { cause: error });
    }
    let outliner: boolean;
    try {
      outliner = isOutlinerDatabase(real);
    } finally {
      release();
    }
    if (!outliner) {
      if (!hadOwnershipFile) rmSync(ownershipFile, { force: true });
      throw new Error(`${real} is not an outliner database (no blocks and metadata tables)`);
    }
    mkdirSync(this.outlinesFolder, { recursive: true });
    try { symlinkSync(real, hostedOutlinePaths(this.stateRoot, name).database); }
    catch (error) {
      if (errorCode(error) === "EEXIST") throw new Error(`An outline named "${name}" already exists in ${this.outlinesFolder}`);
      throw error;
    }
    return this.summary(name);
  }

  /** Opens an outline on first use and keeps it open. A failure is that outline's alone and is retried next time. */
  open(name: string): Promise<HostedOutline> {
    if (this.closing) return Promise.reject(new Error("The outline host is stopping"));
    const opened = this.opened.get(name);
    if (opened) return Promise.resolve(opened);
    const pending = this.opening.get(name);
    if (pending) return pending;
    const opening = this.openNow(name).finally(() => this.opening.delete(name));
    this.opening.set(name, opening);
    return opening;
  }

  private async openNow(nameInput: string): Promise<HostedOutline> {
    const name = requireName(nameInput);
    const paths = hostedOutlinePaths(this.stateRoot, name);
    const entry = lstatOrUndefined(paths.database);
    if (!entry) throw new Error(`No outline named "${name}" in ${this.outlinesFolder}; create it with \`outliner outline create ${name}\``);
    const adopted = entry.isSymbolicLink();
    let database: string;
    try { database = realpathSync(paths.database); }
    catch { throw new Error(`Outline "${name}" links to a database that is missing: ${resolve(this.outlinesFolder, readlinkSync(paths.database))}`); }
    const stateDirectory = adopted ? dirname(database) : paths.sideFolder;
    const workspaceRoot = adopted ? adoptedWorkspaceRoot(database) : paths.sideFolder;
    if (!adopted) mkdirSync(stateDirectory, { recursive: true });
    let store: OutlinerStore;
    try {
      store = new OutlinerStore(database, { workspaceRoot });
    } catch (error) {
      throw new Error(`Outline "${name}" could not be opened: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    let server: OutlinerServer | undefined;
    try {
      const promptDirectory = aiPromptDirectory(this.options.promptDirectory ?? join(stateDirectory, "prompts"));
      if (this.options.promptDirectory === undefined) await initializeAiPrompts(promptDirectory);
      server = new OutlinerServer(store, this.socketPath, this.options.herdrRegistry, promptDirectory, { stateDirectory });
      server.setOutline({ name });
      server.setHost(() => this.status());
      server.startHosted();
      if (this.closing) throw new Error("The outline host is stopping");
      const outline: HostedOutline = { name, database, adopted, stateDirectory, workspaceRoot, promptDirectory, store, server };
      this.opened.set(name, outline);
      try { await this.options.onOpen?.(outline); }
      catch (error) { this.log(`Outline "${name}": ${error instanceof Error ? error.message : String(error)}`); }
      return outline;
    } catch (error) {
      try { await server?.close(); } finally { store.close(); }
      throw error;
    }
  }

  private accept(socket: Socket): void {
    this.connections.add(socket);
    socket.setEncoding("utf8");
    socket.once("close", () => this.connections.delete(socket));
    // A peer that vanishes before routing is routine; the outline adds its own handling after.
    socket.on("error", () => {});
    let buffered = "";
    const receive = (chunk: string): void => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        if (buffered.length > MAX_FIRST_LINE) socket.destroy();
        return;
      }
      socket.off("data", receive);
      // Held until the outline takes over, so nothing arrives while nobody listens.
      socket.pause();
      void this.route(socket, buffered.slice(0, newline), buffered).catch(error => {
        this.log(`Outline host could not route a connection: ${error instanceof Error ? error.message : String(error)}`);
        socket.destroy();
      });
    };
    socket.on("data", receive);
  }

  private reply(socket: Socket, response: OutlinerResponse): void {
    // Host answers are not in any outline's sequence.
    socket.end(`${JSON.stringify(response)}\n`);
  }

  private async route(socket: Socket, line: string, buffered: string): Promise<void> {
    let request: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) request = parsed as Record<string, unknown>;
    } catch {
      request = undefined;
    }
    const id = typeof request?.id === "string" ? request.id : "invalid";
    const fail = (error: unknown) => this.reply(socket, {
      id, ok: false, error: error instanceof Error ? error.message : String(error), sequence: 0,
    });
    if (request && HOST_ACTIONS.has(String(request.action))) {
      try {
        this.reply(socket, { id, ok: true, result: await this.handleHostAction(request), sequence: 0 });
      } catch (error) {
        fail(error);
      }
      return;
    }
    const named = request?.outline;
    if (named !== undefined && !isOutlineName(named)) {
      fail(new Error(`outline must be an outline name (${OUTLINE_NAME_PATTERN.source}); got ${JSON.stringify(named)}`));
      return;
    }
    if (request?.action === "ping" && named === undefined && !this.defaultOutline) {
      this.reply(socket, { id, ok: true, result: this.hostPing(), sequence: 0 });
      return;
    }
    const name = named ?? this.defaultOutline;
    if (!name) {
      fail(new Error("This outline host has no default outline; name one with `outline` in the request"));
      return;
    }
    let outline: HostedOutline;
    try {
      outline = await this.open(name);
    } catch (error) {
      fail(error);
      return;
    }
    if (socket.destroyed) return;
    outline.server.acceptConnection(socket, buffered);
    socket.resume();
  }

  /** `ping` on a host with no default outline: the host alone, with no outline's capabilities. */
  private hostPing(): OutlinerServiceStatus {
    return {
      status: "ready",
      protocolVersion: OUTLINER_PROTOCOL_VERSION,
      minClientProtocol: OUTLINER_MIN_CLIENT_PROTOCOL,
      capabilities: [...OUTLINER_HOST_CAPABILITIES],
      host: this.status(),
    };
  }

  private handleHostAction(request: Record<string, unknown>): Promise<unknown> | unknown {
    switch (request.action) {
      case "outlines.list": return this.list();
      case "outlines.create": return this.create(request.name);
      case "outlines.adopt": return this.adopt(request.path, request.name);
      default: throw new Error(`Unsupported host action: ${String(request.action)}`);
    }
  }
}
