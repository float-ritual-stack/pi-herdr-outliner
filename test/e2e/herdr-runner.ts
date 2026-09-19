import { Database } from "bun:sqlite";
import { Terminal as Screen } from "@xterm/headless";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OutlinerClient } from "../../src/client";
import { resolvePaths } from "../../src/paths";
import { forwardService, type ForwardedRequest, type OptionalResponseMatch, type ResponseBarrier } from "./service-forwarder";
import {
  OUTLINER_PROTOCOL_VERSION,
  type OutlinerClientRegistration,
  type OutlinerServiceStatus,
} from "../../src/types";

const PLUGIN_ID = "float.pi-outliner";
const HERDR_PROTOCOL = 22;
const COMMAND_TIMEOUT_MS = 15_000;
const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 75;

export interface HerdrScenarioSession {
  readonly projectRoot: string;
  readonly artifactDirectory: string;
  readonly panes: { launcher: string; service: string; tree: string; detail: string };
  readonly database: Database;
  readonly client: OutlinerClient;
  rejectCompetingService(): Promise<CommandResult>;
  attachClient(): Promise<{ write(input: string): Promise<void>; visible(): Promise<string> }>;
  openCapturePopup(blockId: string, socketPath: string): Promise<void>;
  openRemoteBrowsingContext(options?: { renderer?: "pi-tui" | "ansi"; treeTransport?: "direct" | "forwarded"; detailTransport?: "direct" | "forwarded" }): Promise<{ workspaceRoot: string; tree: string; detail: string; firstTreeFrameMs: number }>;
  forwardedTreeRequests(): readonly ForwardedRequest[];
  forwardedDetailRequests(): readonly ForwardedRequest[];
  holdDetailResponse(match: OptionalResponseMatch): ResponseBarrier;
  focus(paneId: string): Promise<void>;
  keys(paneId: string, ...keys: string[]): Promise<void>;
  text(paneId: string, text: string): Promise<void>;
  visible(paneId: string): Promise<string>;
  waitVisible(paneId: string, text: string): Promise<string>;
  waitFor<T>(
    label: string,
    read: () => T | Promise<T>,
    accept: (value: T) => boolean,
    timeoutMs?: number,
  ): Promise<T>;
  registrations(): Promise<OutlinerClientRegistration[]>;
  checkpoint(name: string): Promise<void>;
  record(name: string, value: unknown): Promise<void>;
}

type Scenario = {
  name: string;
  prepare(projectRoot: string): Promise<void>;
  run(session: HerdrScenarioSession): Promise<void>;
};

type ScenarioResult =
  | { status: "passed"; artifactDirectory: string }
  | { status: "failed"; artifactDirectory: string; error: string };

type JsonRecord = Record<string, unknown>;
type CommandResult = { stdout: string; stderr: string; exitCode: number };
type PaneInfo = {
  paneId: string;
  workspaceId: string;
  tabId: string;
  cwd?: string;
  foregroundCwd?: string;
};
type ProcessInfo = {
  paneId: string;
  shellPid?: number;
  processes: Array<{
    pid: number;
    name: string;
    cmdline?: string;
  }>;
};
type HerdrStatus = {
  version: string;
  protocol: number;
  socket: string;
  session: string;
};
type ActionOutput = {
  servicePane: string;
  treePane: string;
  detailPane: string;
  browsingContextId: string;
  workspaceRoot: string;
};
type ProcessIdentity = { pid: number; startTicks: string };

type ProcessEvidence = {
  paneId: string;
  pid: number;
  name: string;
  cwd: string;
  cmdline?: string;
  environment: Record<string, string>;
};

function recordValue(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function stringValue(record: JsonRecord, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
  return value;
}

function optionalString(record: JsonRecord, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
  return value;
}


function integerValue(record: JsonRecord, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label}.${key} must be a safe integer`);
  }
  return value;
}

function optionalInteger(record: JsonRecord, key: string, label: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label}.${key} must be a safe integer`);
  }
  return value;
}

function arrayValue(record: JsonRecord, key: string, label: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`${label}.${key} must be an array`);
  return value;
}

function parseJson(text: string, label: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${errorMessage(error)}`);
  }
}

function parseResult(text: string, expectedType: string, label: string): JsonRecord {
  const envelope = recordValue(parseJson(text, label), label);
  stringValue(envelope, "id", label);
  const result = recordValue(envelope.result, `${label}.result`);
  const type = stringValue(result, "type", `${label}.result`);
  if (type !== expectedType) {
    throw new Error(`${label}.result.type was ${JSON.stringify(type)}, expected ${JSON.stringify(expectedType)}`);
  }
  return result;
}


function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack ?? "";
    return stack.includes(error.message) ? stack : `${error.name}: ${error.message}\n${stack}`;
  }
  return String(error);
}
function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}


function safeName(value: string): string {
  const safe = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.slice(0, 60) || "unnamed";
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

class Artifacts {
  private timelineWrite: Promise<void> = Promise.resolve();
  private recordWrite: Promise<void> = Promise.resolve();

  constructor(readonly directory: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async write(name: string, value: unknown): Promise<void> {
    await writeFile(join(this.directory, name), artifactJson(value));
  }

  async event(kind: string, details: unknown = {}): Promise<void> {
    const line = `${JSON.stringify({ at: new Date().toISOString(), kind, details })}\n`;
    this.timelineWrite = this.timelineWrite.then(() => appendFile(join(this.directory, "timeline.jsonl"), line));
    await this.timelineWrite;
  }

  async record(name: string, value: unknown): Promise<void> {
    const entry = { at: new Date().toISOString(), name, value };
    const line = `${JSON.stringify(entry)}\n`;
    this.recordWrite = this.recordWrite.then(() => appendFile(join(this.directory, "records.jsonl"), line));
    await Promise.all([this.recordWrite, this.event("assertion", { name, value })]);
  }

  async flush(): Promise<void> {
    await Promise.all([this.timelineWrite, this.recordWrite]);
  }
}

function commandDisplay(args: readonly string[]): string[] {
  const displayed = [...args];
  const sendText = displayed.indexOf("send-text");
  if (sendText >= 0 && sendText + 3 === displayed.length) {
    const text = displayed[sendText + 2] ?? "";
    displayed[sendText + 2] = `<literal-text bytes=${Buffer.byteLength(text)} sha256=${hash(text)}>`;
  }
  return displayed;
}

async function runCommand(options: {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  artifacts: Artifacts;
  timeoutMs?: number;
  signal?: AbortSignal;
  expectedExitCode?: number;
}): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  await options.artifacts.event("request", {
    command: commandDisplay(options.args),
    cwd: options.cwd,
    timeoutMs,
  });
  const started = Date.now();
  const child = Bun.spawn(options.args, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    signal: options.signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  await options.artifacts.event("response", {
    command: commandDisplay(options.args),
    exitCode,
    durationMs: Date.now() - started,
    stdout,
    stderr,
  });
  if (exitCode !== (options.expectedExitCode ?? 0)) {
    throw new Error(`command exited ${exitCode}: ${commandDisplay(options.args).join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return { stdout, stderr, exitCode };
}

async function poll<T>(options: {
  label: string;
  read: () => T | Promise<T>;
  accept: (value: T) => boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  artifacts?: Artifacts;
}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let attempts = 0;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error(`${options.label} aborted`);
    }
    attempts += 1;
    try {
      const value = await options.read();
      if (options.accept(value)) {
        await options.artifacts?.event("condition", { label: options.label, status: "accepted", attempts });
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  await options.artifacts?.event("condition", {
    label: options.label,
    status: "timed_out",
    attempts,
    lastError: lastError ? errorMessage(lastError) : undefined,
  });
  throw new Error(`${options.label} did not become ready within ${timeoutMs}ms${lastError ? `; last error: ${errorMessage(lastError)}` : ""}`);
}

function makeEnvironment(options: {
  runRoot: string;
  configHome: string;
  stateHome: string;
  dataHome: string;
  cacheHome: string;
  runtimeHome: string;
  outlinerState: string;
  keymapPath: string;
  herdrBinary: string;
}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "COLORTERM", "TZ"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    TMPDIR: join(options.runRoot, "tmp"),
    XDG_CONFIG_HOME: options.configHome,
    XDG_STATE_HOME: options.stateHome,
    XDG_DATA_HOME: options.dataHome,
    XDG_CACHE_HOME: options.cacheHome,
    XDG_RUNTIME_DIR: options.runtimeHome,
    HERDR_ENV: "1",
    HERDR_BIN_PATH: options.herdrBinary,
    OUTLINER_STATE_DIR: options.outlinerState,
    OUTLINER_KEYBINDINGS_PATH: options.keymapPath,
    OUTLINER_DETAIL_RENDERER: "pi-tui",
  };
}

function privateHerdrArgs(binary: string, sessionName: string, args: readonly string[]): string[] {
  return [binary, "--session", sessionName, ...args];
}

function parseHerdrStatus(text: string, expectedSession: string): HerdrStatus {
  const status = recordValue(parseJson(text, "Herdr server status"), "Herdr server status");
  if (status.running !== true || status.compatible !== true || status.endpoint_compatible !== true) {
    throw new Error("Private Herdr server is not running with a compatible endpoint");
  }
  const protocol = integerValue(status, "protocol", "Herdr server status");
  if (protocol !== HERDR_PROTOCOL) {
    throw new Error(`Herdr protocol ${protocol} does not match required protocol ${HERDR_PROTOCOL}`);
  }
  const session = stringValue(status, "session", "Herdr server status");
  if (session !== expectedSession) {
    throw new Error(`Herdr status reported session ${JSON.stringify(session)}, expected ${JSON.stringify(expectedSession)}`);
  }
  return {
    version: stringValue(status, "version", "Herdr server status"),
    protocol,
    socket: stringValue(status, "socket", "Herdr server status"),
    session,
  };
}

function parsePane(value: unknown, label: string): PaneInfo {
  const pane = recordValue(value, label);
  return {
    paneId: stringValue(pane, "pane_id", label),
    workspaceId: stringValue(pane, "workspace_id", label),
    tabId: stringValue(pane, "tab_id", label),
    ...(optionalString(pane, "cwd", label) ? { cwd: optionalString(pane, "cwd", label) } : {}),
    ...(optionalString(pane, "foreground_cwd", label)
      ? { foregroundCwd: optionalString(pane, "foreground_cwd", label) }
      : {}),
  };
}

function parseProcessInfo(text: string): ProcessInfo {
  const result = parseResult(text, "pane_process_info", "pane process-info");
  const info = recordValue(result.process_info, "pane process-info.result.process_info");
  const processes = arrayValue(info, "foreground_processes", "pane process-info.result.process_info").map(
    (value, index) => {
      const label = `pane process-info process ${index}`;
      const processRecord = recordValue(value, label);
      return {
        pid: integerValue(processRecord, "pid", label),
        name: stringValue(processRecord, "name", label),
        ...(optionalString(processRecord, "cmdline", label)
          ? { cmdline: optionalString(processRecord, "cmdline", label) }
          : {}),
      };
    },
  );
  return {
    paneId: stringValue(info, "pane_id", "pane process-info.result.process_info"),
    ...(optionalInteger(info, "shell_pid", "pane process-info.result.process_info") !== undefined
      ? { shellPid: optionalInteger(info, "shell_pid", "pane process-info.result.process_info") }
      : {}),
    processes,
  };
}

function parseActionOutput(text: string): ActionOutput {
  const output = recordValue(parseJson(text, "plugin action stdout"), "plugin action stdout");
  return {
    servicePane: stringValue(output, "servicePane", "plugin action stdout"),
    treePane: stringValue(output, "outlinerPane", "plugin action stdout"),
    detailPane: stringValue(output, "detailPane", "plugin action stdout"),
    browsingContextId: stringValue(output, "browsingContextId", "plugin action stdout"),
    workspaceRoot: stringValue(output, "workspaceRoot", "plugin action stdout"),
  };
}


async function readProcessEnvironment(pid: number): Promise<Record<string, string>> {
  const raw = await readFile(`/proc/${pid}/environ`, "utf8");
  const all = new Map<string, string>();
  for (const entry of raw.split("\0")) {
    const separator = entry.indexOf("=");
    if (separator > 0) all.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  const allowed = [
    "HERDR_ENV",
    "HERDR_SOCKET_PATH",
    "HERDR_PANE_ID",
    "HERDR_TAB_ID",
    "HERDR_WORKSPACE_ID",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "OUTLINER_STATE_DIR",
    "OUTLINER_KEYBINDINGS_PATH",
    "OUTLINER_DETAIL_RENDERER",
    "OUTLINER_WORKSPACE_ROOT",
    "OUTLINER_REMOTE",
    "OUTLINER_SOCKET_PATH",
    "OUTLINER_BROWSING_CONTEXT_ID",
  ];
  const selected: Record<string, string> = {};
  for (const key of allowed) {
    const value = all.get(key);
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

async function processCwd(pid: number): Promise<string> {
  return realpath(`/proc/${pid}/cwd`);
}

function environmentMatches(
  environment: Record<string, string>,
  pane: PaneInfo,
  status: HerdrStatus,
  expected: Record<string, string>,
): boolean {
  return environment.HERDR_ENV === "1" &&
    environment.HERDR_SOCKET_PATH === status.socket &&
    environment.HERDR_PANE_ID === pane.paneId &&
    environment.HERDR_TAB_ID === pane.tabId &&
    environment.HERDR_WORKSPACE_ID === pane.workspaceId &&
    environment.XDG_CONFIG_HOME === expected.XDG_CONFIG_HOME &&
    environment.OUTLINER_STATE_DIR === expected.OUTLINER_STATE_DIR &&
    environment.OUTLINER_KEYBINDINGS_PATH === expected.OUTLINER_KEYBINDINGS_PATH &&
    environment.OUTLINER_DETAIL_RENDERER === expected.OUTLINER_DETAIL_RENDERER;
}

async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    return startTicks && fields[0] !== "Z" ? { pid, startTicks } : null;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ESRCH")) throw error;
    return null;
  }
}

async function collectProcessTree(rootPid: number): Promise<ProcessIdentity[]> {
  const pending = [rootPid];
  const seen = new Set<number>();
  const identities: ProcessIdentity[] = [];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    const identity = await processIdentity(pid);
    if (!identity) continue;
    identities.push(identity);
    try {
      for (const tid of await readdir(`/proc/${pid}/task`)) {
        const children = await readFile(`/proc/${pid}/task/${tid}/children`, "utf8");
        for (const child of children.trim().split(/\s+/)) {
          const childPid = Number(child);
          if (Number.isSafeInteger(childPid) && childPid > 0) pending.push(childPid);
        }
      }
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ESRCH")) throw error;
    }
  }
  return identities;
}

async function sameProcess(identity: ProcessIdentity): Promise<boolean> {
  const current = await processIdentity(identity.pid);
  return current?.startTicks === identity.startTicks;
}

async function waitChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const exited = Promise.withResolvers<boolean>();
  let timeout: ReturnType<typeof setTimeout>;
  const onExit = (): void => {
    clearTimeout(timeout);
    exited.resolve(true);
  };
  timeout = setTimeout(() => {
    child.off("exit", onExit);
    exited.resolve(false);
  }, timeoutMs);
  child.once("exit", onExit);
  return exited.promise;
}

async function snapshotDatabase(database: Database, destination: string): Promise<void> {
  database.query("VACUUM INTO ?").run(destination);
  const snapshot = new Database(destination, { readonly: true, create: false });
  try {
    const row = recordValue(snapshot.query("PRAGMA integrity_check").get(), "snapshot integrity_check");
    if (row.integrity_check !== "ok") {
      throw new Error(`SQLite snapshot integrity_check returned ${JSON.stringify(row.integrity_check)}`);
    }
  } finally {
    snapshot.close();
  }
}

function combinedError(primary: unknown, evidence: readonly unknown[], cleanup: readonly unknown[]): string | null {
  const sections: string[] = [];
  if (primary) sections.push(`primary error:\n${errorMessage(primary)}`);
  if (evidence.length > 0) {
    sections.push(`evidence errors:\n${evidence.map((error, index) => `${index + 1}. ${errorMessage(error)}`).join("\n")}`);
  }
  if (cleanup.length > 0) {
    sections.push(`cleanup errors:\n${cleanup.map((error, index) => `${index + 1}. ${errorMessage(error)}`).join("\n")}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : null;
}

export async function runHerdrScenario(scenarioInput: Scenario): Promise<ScenarioResult> {
  const runRoot = await mkdtemp(join(tmpdir(), "p267-"));
  const projectRoot = join(runRoot, "project");
  const artifactDirectory = join(runRoot, "artifacts");
  const configHome = join(runRoot, "xdg-config");
  const stateHome = join(runRoot, "xdg-state");
  const dataHome = join(runRoot, "xdg-data");
  const cacheHome = join(runRoot, "xdg-cache");
  const runtimeHome = join(runRoot, "xdg-runtime");
  const outlinerState = join(runRoot, "outliner-state");
  const keymapPath = join(runRoot, "empty-keymap.json");
  const sessionName = `pie267-${crypto.randomUUID().slice(0, 8)}`;
  const pluginRoot = await realpath(resolve(import.meta.dir, "../.."));
  const artifacts = new Artifacts(artifactDirectory);
  await artifacts.initialize();

  let phase = "initialize";
  let primaryError: unknown;
  let primaryFailurePhase: string | undefined;
  const evidenceErrors: unknown[] = [];
  const cleanupErrors: unknown[] = [];
  const resources: { server: ChildProcess | null; database: Database | null; client: Bun.Subprocess | null; screen: Screen | null; treeForwarder: Awaited<ReturnType<typeof forwardService>> | null; detailForwarder: Awaited<ReturnType<typeof forwardService>> | null } = {
    server: null,
    database: null,
    client: null,
    screen: null,
    treeForwarder: null,
    detailForwarder: null,
  };
  let serverLaunchError: Error | null = null;
  let clientOutput = "";
  let panes: HerdrScenarioSession["panes"] | null = null;
  const extraPanes: Record<string, string> = {};
  let checkpointNumber = 0;
  let environment: Record<string, string> = {};
  let herdrBinary = "herdr";
  let herdrStatus: HerdrStatus | null = null;
  let processEvidence: ProcessEvidence[] = [];
  let scenarioName = "invalid-scenario";
  let interruptedError: Error | null = null;
  const abort = new AbortController();
  const interruption = Promise.withResolvers<never>();
  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      if (interruptedError) return;
      interruptedError = new Error(`Herdr scenario interrupted by ${signal}`);
      abort.abort(interruptedError);
      interruption.reject(interruptedError);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  const setPhase = async (next: string): Promise<void> => {
    phase = next;
    await artifacts.event("phase", { phase });
  };

  const runHerdr = (
    args: string[],
    timeoutMs = COMMAND_TIMEOUT_MS,
    signal: AbortSignal | null = abort.signal,
  ): Promise<CommandResult> => runCommand({
    args: privateHerdrArgs(herdrBinary, sessionName, args),
    cwd: projectRoot,
    env: environment,
    artifacts,
    timeoutMs,
    signal: signal ?? undefined,
  });

  const paneRead = async (
    paneId: string,
    source: "visible" | "recent-unwrapped",
    format: "text" | "ansi",
    timeoutMs = COMMAND_TIMEOUT_MS,
    signal: AbortSignal | null = abort.signal,
  ): Promise<string> => {
    const output = await runHerdr([
      "pane",
      "read",
      paneId,
      "--source",
      source,
      "--format",
      format,
      ...(source === "recent-unwrapped" ? ["--lines", "400"] : []),
    ], timeoutMs, signal);
    return output.stdout;
  };

  const getRegistrations = async (): Promise<OutlinerClientRegistration[]> => {
    if (!herdrStatus) throw new Error("Outliner service is not ready");
    const paths = resolvePaths({
      OUTLINER_STATE_DIR: outlinerState,
      OUTLINER_WORKSPACE_ROOT: projectRoot,
    });
    return new OutlinerClient(paths.socket).request<OutlinerClientRegistration[]>({
      action: "clients.list",
    });
  };

  const verifyProcess = async (paneId: string, expectedCwd: string, expectedExtra: Record<string, string> = {}): Promise<ProcessEvidence> => {
    const paneOutput = await runHerdr(["pane", "get", paneId]);
    const paneResult = parseResult(paneOutput.stdout, "pane_info", `pane get ${paneId}`);
    const pane = parsePane(paneResult.pane, `pane get ${paneId}.result.pane`);
    const status = herdrStatus;
    if (!pane || !status) throw new Error(`Missing verified pane identity for ${paneId}`);
    const evidence = await poll<ProcessEvidence | null>({
      label: `isolated process environment for ${paneId}`,
      timeoutMs: STARTUP_TIMEOUT_MS,
      signal: abort.signal,
      artifacts,
      read: async () => {
        const output = await runHerdr(["pane", "process-info", "--pane", paneId], 5_000);
        const info = parseProcessInfo(output.stdout);
        if (info.paneId !== paneId) throw new Error(`process-info returned ${info.paneId} for ${paneId}`);
        const candidates = [
          ...info.processes,
          ...(info.shellPid && !info.processes.some((candidate) => candidate.pid === info.shellPid)
            ? [{ pid: info.shellPid, name: "shell" }]
            : []),
        ];
        for (const candidate of candidates) {
          try {
            const cwd = await processCwd(candidate.pid);
            const candidateEnvironment = await readProcessEnvironment(candidate.pid);
            if (cwd === expectedCwd && environmentMatches(candidateEnvironment, pane, status, { ...environment, ...expectedExtra }) &&
                  Object.entries(expectedExtra).every(([key, value]) => candidateEnvironment[key] === value)) {
              return {
                paneId,
                pid: candidate.pid,
                name: candidate.name,
                cwd,
                ...(candidate.cmdline ? { cmdline: candidate.cmdline } : {}),
                environment: candidateEnvironment,
              };
            }
          } catch {
            // Foreground process snapshots race normal exec transitions; poll the next snapshot.
          }
        }
        return null;
      },
      accept: (value) => value !== null,
    });
    if (!evidence) throw new Error(`No matching process environment for ${paneId}`);
    return evidence;
  };

  const captureAll = async (operations: Promise<unknown>[]): Promise<void> => {
    const results = await Promise.allSettled(operations);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) throw new Error(errors.map(errorMessage).join("\n"));
  };

  const capturePanes = async (
    ownedPanes: HerdrScenarioSession["panes"],
    directory: string,
    cleanup: boolean,
  ): Promise<void> => {
    const paneDirectory = join(directory, "panes");
    await mkdir(paneDirectory, { recursive: true });
    const timeoutMs = cleanup ? 5_000 : COMMAND_TIMEOUT_MS;
    const signal = cleanup ? null : abort.signal;
    await captureAll(Object.entries({ ...ownedPanes, ...extraPanes }).map(async ([label, paneId]) => {
      const [visibleText, visibleAnsi] = await Promise.all([
        paneRead(paneId, "visible", "text", timeoutMs, signal),
        paneRead(paneId, "visible", "ansi", timeoutMs, signal),
      ]);
      await Promise.all([
        writeFile(join(paneDirectory, `${label}.visible.txt`), visibleText),
        writeFile(join(paneDirectory, `${label}.visible.ansi`), visibleAnsi),
      ]);
      if (label !== "service") return;
      const [recentText, recentAnsi] = await Promise.all([
        paneRead(paneId, "recent-unwrapped", "text", timeoutMs, signal),
        paneRead(paneId, "recent-unwrapped", "ansi", timeoutMs, signal),
      ]);
      await Promise.all([
        writeFile(join(paneDirectory, "service.recent.txt"), recentText),
        writeFile(join(paneDirectory, "service.recent.ansi"), recentAnsi),
      ]);
    }));
  };

  const captureCheckpoint = async (name: string, cleanup = false): Promise<void> => {
    if (!resources.database || !panes) throw new Error("Cannot checkpoint before panes and database are ready");
    const readonlyDatabase = resources.database;
    const ownedPanes = panes;
    checkpointNumber += 1;
    const directory = join(
      artifactDirectory,
      "checkpoints",
      `${String(checkpointNumber).padStart(3, "0")}-${safeName(name)}`,
    );
    await mkdir(directory, { recursive: true });
    const databasePath = join(directory, "outliner.sqlite");
    await captureAll([
      snapshotDatabase(readonlyDatabase, databasePath),
      capturePanes(ownedPanes, directory, cleanup),
      getRegistrations().then((value) =>
        writeFile(join(directory, "registrations.json"), artifactJson(value))),
      runHerdr(["api", "snapshot"], 5_000, cleanup ? null : abort.signal).then((output) =>
        writeFile(join(directory, "topology.json"), output.stdout)),
    ]);
    await writeFile(join(directory, "checkpoint.json"), artifactJson({
      name,
      capturedAt: new Date().toISOString(),
      database: databasePath,
      databaseSha256: hash(await readFile(databasePath)),
      panes: { ...ownedPanes, ...extraPanes },
    }));
    if (resources.screen) {
      await new Promise<void>((resolve) => resources.screen!.write("", resolve));
      const screen = resources.screen.buffer.active;
      const lines = Array.from({ length: resources.screen.rows }, (_, row) =>
        screen.getLine(screen.viewportY + row)?.translateToString(true) ?? "");
      await writeFile(join(directory, "attached-client.visible.txt"), `${lines.join("\n")}\n`);
    }
    await artifacts.event("checkpoint", { name, directory });
  };

  const scenarioSession = (): HerdrScenarioSession => {
    if (!resources.database || !panes) throw new Error("Scenario session is not ready");
    const readonlyDatabase = resources.database;
    const ownedPanes = panes;
    const owned = new Set(Object.values(ownedPanes));
    const requireOwned = (paneId: string): void => {
      if (!owned.has(paneId)) throw new Error(`Pane ${JSON.stringify(paneId)} is not owned by this scenario`);
    };
    return {
      projectRoot,
      artifactDirectory,
      panes: ownedPanes,
      database: readonlyDatabase,
      client: new OutlinerClient(resolvePaths({
        OUTLINER_STATE_DIR: outlinerState,
        OUTLINER_WORKSPACE_ROOT: projectRoot,
      }).socket),
      rejectCompetingService() {
        return runCommand({
          args: [process.execPath, "run", join(pluginRoot, "src/server-main.ts")],
          cwd: pluginRoot,
          env: { ...environment, OUTLINER_WORKSPACE_ROOT: projectRoot },
          artifacts,
          signal: abort.signal,
          expectedExitCode: 1,
        });
      },
      async attachClient() {
        if (resources.client) throw new Error("This fixture already owns an attached Herdr client");
        abort.signal.throwIfAborted();
        const decoder = new TextDecoder();
        const screen = new Screen({ cols: 220, rows: 60, allowProposedApi: true });
        resources.screen = screen;
        const clientEnvironment: Record<string, string> = { ...environment, TERM: "xterm-256color" };
        // This is the outer fixture terminal, not a process inside a Herdr pane.
        delete clientEnvironment.HERDR_ENV;
        resources.client = Bun.spawn([herdrBinary, "--session", sessionName], {
          cwd: projectRoot,
          env: clientEnvironment,
          terminal: {
            cols: 220, rows: 60,
            data(_terminal, bytes) {
              appendFileSync(join(artifactDirectory, "attached-client.ansi"), bytes);
              screen.write(bytes);
              clientOutput = (clientOutput + decoder.decode(bytes, { stream: true })).slice(-2_000_000);
            },
          },
        });
        const ownedClient = resources.client;
        await artifacts.write("attached-client.json", { pid: ownedClient.pid, cols: 220, rows: 60 });
        return {
          async visible() {
            if (ownedClient.exitCode !== null) throw new Error(`Attached Herdr client exited ${ownedClient.exitCode}: ${clientOutput}`);
            await new Promise<void>((resolve) => screen.write("", resolve));
            const buffer = screen.buffer.active;
            return Array.from({ length: screen.rows }, (_, row) =>
              buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").join("\n");
          },
          async write(input) {
            abort.signal.throwIfAborted();
            if (ownedClient.exitCode !== null || !ownedClient.terminal) throw new Error("Attached Herdr client exited");
            ownedClient.terminal.write(input);
            await artifacts.event("input", { kind: "attached-client", input });
          },
        };
      },
      forwardedTreeRequests() {
        return resources.treeForwarder?.measurements() ?? [];
      },
      forwardedDetailRequests() {
        return resources.detailForwarder?.measurements() ?? [];
      },
      holdDetailResponse(match) {
        if (!resources.detailForwarder) throw new Error("Detail response barriers require the private forwarded transport");
        return resources.detailForwarder.holdNext(match);
      },
      async openRemoteBrowsingContext({ renderer = "pi-tui", treeTransport = "direct", detailTransport = "direct" } = {}) {
        if (extraPanes.remoteTree) throw new Error("This fixture already owns a remote browsing context");
        const workspaceRoot = join(runRoot, "client-project");
        await mkdir(workspaceRoot);
        const contextId = crypto.randomUUID();
        const workspaceId = (await getRegistrations()).find(value => value.runtime?.paneId === ownedPanes.tree)?.runtime?.workspaceId;
        if (!workspaceId) throw new Error("Owned Tree has no verified workspace");
        const socket = resolvePaths({ OUTLINER_STATE_DIR: outlinerState, OUTLINER_WORKSPACE_ROOT: projectRoot }).socket;
        if (treeTransport === "forwarded") {
          resources.treeForwarder = await forwardService(join(runRoot, "tree-forward.sock"), socket);
        }
        if (detailTransport === "forwarded") {
          resources.detailForwarder = await forwardService(join(runRoot, "detail-forward.sock"), socket);
        }
        const clientEnvironment = {
          OUTLINER_WORKSPACE_ROOT: workspaceRoot,
          OUTLINER_REMOTE: "1",
          OUTLINER_SOCKET_PATH: socket,
          OUTLINER_BROWSING_CONTEXT_ID: contextId,
          OUTLINER_DETAIL_RENDERER: renderer,
        };
        const open = async (entrypoint: "outliner" | "detail", target: string): Promise<string> => {
          const forwarder = entrypoint === "outliner" ? resources.treeForwarder : resources.detailForwarder;
          const paneEnvironment = forwarder
            ? { ...clientEnvironment, OUTLINER_SOCKET_PATH: forwarder.socketPath }
            : clientEnvironment;
          const output = await runHerdr([
            "plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", entrypoint,
            "--placement", entrypoint === "outliner" ? "tab" : "split",
            "--focus",
            ...(entrypoint === "detail"
              ? ["--target-pane", target, "--direction", "down"]
              : ["--workspace", workspaceId]),
            ...Object.entries(paneEnvironment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
          ]);
          const envelope = recordValue(parseJson(output.stdout, "remote pane open"), "remote pane open");
          const result = recordValue(envelope.result, "remote pane open.result");
          const opened = recordValue(result.plugin_pane, "remote pane open.result.plugin_pane");
          const pane = parsePane(opened.pane, "remote pane open.result.plugin_pane.pane");
          if (pane.workspaceId !== workspaceId) throw new Error("Remote launch escaped the owned workspace");
          if (owned.has(pane.paneId)) throw new Error("Remote launch returned an existing pane");
          owned.add(pane.paneId);
          extraPanes[entrypoint === "outliner" ? "remoteTree" : "remoteDetail"] = pane.paneId;
          processEvidence.push(await verifyProcess(pane.paneId, pluginRoot, paneEnvironment));
          return pane.paneId;
        };
        const started = performance.now();
        const tree = await open("outliner", ownedPanes.launcher);
        await poll({ label: "remote Tree first populated frame", timeoutMs: STARTUP_TIMEOUT_MS,
          signal: abort.signal, artifacts, read: () => paneRead(tree, "visible", "text"),
          accept: text => text.includes("Workspace") && text.includes("physical blocks"),
        });
        const firstTreeFrameMs = performance.now() - started;
        const detail = await open("detail", tree);
        await poll({
          label: "remote browsing context registrations", timeoutMs: STARTUP_TIMEOUT_MS,
          signal: abort.signal, artifacts, read: getRegistrations,
          accept: values => values.filter(value => value.contextId === contextId).length === 2 &&
            values.some(value => value.contextId === contextId && value.role === "tree" && value.runtime?.paneId === tree) &&
            values.some(value => value.contextId === contextId && value.role === "detail" && value.runtime?.paneId === detail),
        });
        await artifacts.write("process-environments.json", processEvidence);
        await artifacts.write("remote-browsing-context.json", { workspaceRoot, serviceRoot: projectRoot, tree, detail, contextId, clientEnvironment, treeTransport, treeSocket: resources.treeForwarder?.socketPath ?? socket,
          detailTransport, detailSocket: resources.detailForwarder?.socketPath ?? socket, firstTreeFrameMs,
          timingScope: "launch to first observed populated Tree frame; includes host/process verification and polling overhead" });
        return { workspaceRoot, tree, detail, firstTreeFrameMs };
      },
      async openCapturePopup(blockId, socketPath) {
        if (!resources.client) throw new Error("Popup evidence requires an attached client");
        await runHerdr(["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "capture",
          "--env", `OUTLINER_WORKSPACE_ROOT=${projectRoot}`,
          "--env", `OUTLINER_CAPTURE_FROM_BLOCK_ID=${blockId}`,
          "--env", "OUTLINER_REMOTE=1",
          "--env", `OUTLINER_SOCKET_PATH=${socketPath}`]);
      },
      async focus(paneId) {
        requireOwned(paneId);
        await runHerdr(["plugin", "pane", "focus", paneId]);
        await artifacts.event("input", { kind: "focus", paneId });
      },
      async keys(paneId, ...keys) {
        requireOwned(paneId);
        if (keys.length === 0 || keys.some((key) => !key)) throw new Error("keys requires non-empty Herdr key names");
        await runHerdr(["pane", "send-keys", paneId, ...keys]);
        await artifacts.event("input", { kind: "keys", paneId, keys });
      },
      async text(paneId, text) {
        requireOwned(paneId);
        await runHerdr(["pane", "send-text", paneId, text]);
        await artifacts.event("input", {
          kind: "literal_text",
          paneId,
          bytes: Buffer.byteLength(text),
          sha256: hash(text),
        });
      },
      async visible(paneId) {
        requireOwned(paneId);
        return paneRead(paneId, "visible", "text");
      },
      async waitVisible(paneId, text) {
        requireOwned(paneId);
        if (!text) throw new Error("waitVisible requires non-empty text");
        const waited = await runHerdr([
          "pane",
          "wait-output",
          paneId,
          "--match",
          text,
          "--source",
          "visible",
          "--timeout",
          String(COMMAND_TIMEOUT_MS),
        ], COMMAND_TIMEOUT_MS + 2_000);
        const result = parseResult(waited.stdout, "output_matched", `pane wait-output ${paneId}`);
        if (stringValue(result, "pane_id", `pane wait-output ${paneId}.result`) !== paneId) {
          throw new Error(`Herdr pane wait returned a different pane for ${paneId}`);
        }
        const visible = await paneRead(paneId, "visible", "text");
        if (!visible.includes(text)) throw new Error(`Pane ${paneId} no longer contains ${JSON.stringify(text)}`);
        await artifacts.event("condition", { label: `visible ${paneId}`, text, status: "accepted" });
        return visible;
      },
      waitFor(label, read, accept, timeoutMs) {
        if (!label.trim()) return Promise.reject(new Error("waitFor requires a label"));
        return poll({ label, read, accept, timeoutMs, signal: abort.signal, artifacts });
      },
      registrations: getRegistrations,
      checkpoint: captureCheckpoint,
      record: (name, value) => {
        if (!name.trim()) return Promise.reject(new Error("record requires a name"));
        return artifacts.record(name, value);
      },
    };
  };

  const execute = async (): Promise<void> => {
    if (process.platform !== "linux") throw new Error("PIE-267 Herdr E2E requires Linux /proc process inspection");
    const scenario = scenarioInput;
    scenarioName = scenario.name;
    await setPhase("prepare-isolation");
    await Promise.all([
      mkdir(projectRoot, { recursive: true }),
      mkdir(join(configHome, "herdr"), { recursive: true }),
      mkdir(stateHome, { recursive: true }),
      mkdir(dataHome, { recursive: true }),
      mkdir(cacheHome, { recursive: true }),
      mkdir(runtimeHome, { recursive: true, mode: 0o700 }),
      mkdir(outlinerState, { recursive: true }),
      mkdir(join(runRoot, "tmp"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(configHome, "herdr", "config.toml"), "onboarding = false\n"),
      writeFile(keymapPath, "{}\n"),
    ]);

    const binary = Bun.which("herdr");
    if (!binary) throw new Error("Herdr executable is not on PATH");
    herdrBinary = await realpath(binary);
    environment = makeEnvironment({
      runRoot,
      configHome,
      stateHome,
      dataHome,
      cacheHome,
      runtimeHome,
      outlinerState,
      keymapPath,
      herdrBinary,
    });
    const provenanceCommand = (args: string[]) => runCommand({
      args, cwd: pluginRoot, env: environment, artifacts, timeoutMs: 5_000, signal: abort.signal,
    });
    const [version, revision, dirty] = await Promise.all([
      provenanceCommand([herdrBinary, "--version"]),
      provenanceCommand(["git", "-C", pluginRoot, "rev-parse", "HEAD"]),
      provenanceCommand(["git", "-C", pluginRoot, "status", "--short"]),
    ]);
    const versionMatch = /^herdr\s+(\d+\.\d+\.\d+)\s*$/.exec(version.stdout);
    if (!versionMatch?.[1]) throw new Error(`Unexpected Herdr version output: ${JSON.stringify(version.stdout)}`);
    const cliVersion = versionMatch[1];
    await artifacts.write("provenance.json", {
      pluginRoot,
      revision: revision.stdout.trim(),
      dirty: dirty.stdout.trim().split("\n").filter(Boolean),
      herdrBinary,
      cliVersion,
      platform: process.platform,
      arch: process.arch,
    });
    await artifacts.write("isolation.json", {
      runRoot,
      projectRoot,
      artifactDirectory,
      sessionName,
      configPath: join(configHome, "herdr", "config.toml"),
      keymapPath,
      keymapSha256: hash(await readFile(keymapPath)),
      outlinerState,
      effectiveEnvironment: Object.fromEntries(
        Object.entries(environment).filter(([key]) => key.startsWith("XDG_") || key.startsWith("OUTLINER_") || key === "HERDR_ENV" || key === "HERDR_BIN_PATH"),
      ),
    });

    await setPhase("prepare-fixture");
    await scenario.prepare(projectRoot);

    await setPhase("start-herdr");
    const stdoutFd = openSync(join(artifactDirectory, "herdr-server.stdout.log"), "a");
    const stderrFd = openSync(join(artifactDirectory, "herdr-server.stderr.log"), "a");
    try {
      abort.signal.throwIfAborted();
      resources.server = spawn(herdrBinary, ["--session", sessionName, "server"], {
        cwd: projectRoot,
        env: environment,
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
      resources.server.once("error", (error) => {
        serverLaunchError = error;
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    if (!resources.server.pid) throw new Error("Herdr server process did not expose a pid");
    await artifacts.write("server-process.json", { pid: resources.server.pid, sessionName });

    herdrStatus = await poll({
      label: "private Herdr server",
      timeoutMs: STARTUP_TIMEOUT_MS,
      signal: abort.signal,
      artifacts,
      read: async () => {
        if (serverLaunchError) throw serverLaunchError;
        if (resources.server?.exitCode !== null) throw new Error(`Herdr server exited ${resources.server?.exitCode}`);
        const status = await runHerdr(["status", "server", "--json"], 3_000);
        return parseHerdrStatus(status.stdout, sessionName);
      },
      accept: (status) => status.version === cliVersion,
    });
    const privateConfigRoot = resolve(configHome);
    if (!(resolve(herdrStatus.socket) === privateConfigRoot || resolve(herdrStatus.socket).startsWith(`${privateConfigRoot}${sep}`))) {
      throw new Error(`Private Herdr socket escaped XDG_CONFIG_HOME: ${herdrStatus.socket}`);
    }
    const snapshotOutput = await runHerdr(["api", "snapshot"]);
    const snapshotResult = parseResult(snapshotOutput.stdout, "session_snapshot", "Herdr API snapshot");
    const snapshot = recordValue(snapshotResult.snapshot, "Herdr API snapshot.result.snapshot");
    if (integerValue(snapshot, "protocol", "Herdr API snapshot.result.snapshot") !== HERDR_PROTOCOL) {
      throw new Error("Herdr API snapshot protocol did not match the installed CLI");
    }
    if (stringValue(snapshot, "version", "Herdr API snapshot.result.snapshot") !== cliVersion) {
      throw new Error("Herdr API snapshot version did not match the installed CLI");
    }
    await artifacts.write("herdr-readiness.json", {
      status: herdrStatus,
      apiSnapshot: parseJson(snapshotOutput.stdout, "Herdr API snapshot"),
    });

    await setPhase("link-plugin");
    const linked = await runHerdr(["plugin", "link", pluginRoot, "--enabled"], STARTUP_TIMEOUT_MS);
    await artifacts.write("plugin-link.json", linked);
    parseResult(linked.stdout, "plugin_linked", "plugin link");
    const listed = await runHerdr(["plugin", "list", "--plugin", PLUGIN_ID, "--json"]);
    await artifacts.write("plugin-list.json", listed);
    const pluginList = parseResult(listed.stdout, "plugin_list", "plugin list");
    const plugins = arrayValue(pluginList, "plugins", "plugin list.result");
    if (plugins.length !== 1) throw new Error(`Private registry returned ${plugins.length} matching plugins`);
    const plugin = recordValue(plugins[0], "plugin list.result.plugins[0]");
    const pluginSource = recordValue(plugin.source, "plugin list.result.plugins[0].source");
    const listedRoot = await realpath(stringValue(plugin, "plugin_root", "plugin list.result.plugins[0]"));
    const manifestPath = await realpath(stringValue(plugin, "manifest_path", "plugin list.result.plugins[0]"));
    if (
      stringValue(plugin, "plugin_id", "plugin list.result.plugins[0]") !== PLUGIN_ID ||
      plugin.enabled !== true ||
      stringValue(pluginSource, "kind", "plugin list.result.plugins[0].source") !== "local" ||
      listedRoot !== pluginRoot ||
      manifestPath !== join(pluginRoot, "herdr-plugin.toml")
    ) {
      throw new Error("Private Herdr registry did not link the exact enabled local checkout");
    }

    await setPhase("create-workspace");
    const workspaceEnvironment = [
      "HERDR_ENV",
      "HERDR_BIN_PATH",
      "XDG_CONFIG_HOME",
      "XDG_STATE_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_RUNTIME_DIR",
      "OUTLINER_STATE_DIR",
      "OUTLINER_KEYBINDINGS_PATH",
      "OUTLINER_DETAIL_RENDERER",
    ].flatMap((key) => environment[key] === undefined ? [] : ["--env", `${key}=${environment[key]}`]);
    const workspaceOutput = await runHerdr([
      "workspace",
      "create",
      "--cwd",
      projectRoot,
      "--label",
      `PIE-267 ${safeName(scenario.name)}`,
      "--focus",
      ...workspaceEnvironment,
    ]);
    const workspaceResult = parseResult(workspaceOutput.stdout, "workspace_created", "workspace create");
    const workspace = recordValue(workspaceResult.workspace, "workspace create.result.workspace");
    const tab = recordValue(workspaceResult.tab, "workspace create.result.tab");
    const launcher = parsePane(workspaceResult.root_pane, "workspace create.result.root_pane");
    const workspaceId = stringValue(workspace, "workspace_id", "workspace create.result.workspace");
    const tabId = stringValue(tab, "tab_id", "workspace create.result.tab");
    if (launcher.workspaceId !== workspaceId || launcher.tabId !== tabId) {
      throw new Error("Fresh workspace root pane identity did not match its workspace and tab");
    }
    await runHerdr(["workspace", "focus", workspaceId]);
    const launcherCwd = await realpath(launcher.foregroundCwd ?? launcher.cwd ?? "");
    if (launcherCwd !== projectRoot) throw new Error(`Launcher cwd was ${launcherCwd}, expected ${projectRoot}`);
    await artifacts.write("workspace.json", workspaceOutput);

    await setPhase("invoke-plugin");
    const invocation = await runHerdr(["plugin", "action", "invoke", "open", "--plugin", PLUGIN_ID]);
    await artifacts.write("plugin-invocation.json", invocation);
    const invocationResult = parseResult(invocation.stdout, "plugin_action_invoked", "plugin action invoke");
    const invocationContext = recordValue(
      invocationResult.context,
      "plugin action invoke.result.context",
    );
    if (
      stringValue(
        invocationContext,
        "focused_pane_id",
        "plugin action invoke.result.context",
      ) !== launcher.paneId ||
      await realpath(stringValue(
        invocationContext,
        "focused_pane_cwd",
        "plugin action invoke.result.context",
      )) !== projectRoot
    ) {
      throw new Error("Plugin action invocation context did not target the fresh project launcher");
    }
    const invocationLog = recordValue(invocationResult.log, "plugin action invoke.result.log");
    const logId = stringValue(invocationLog, "log_id", "plugin action invoke.result.log");
    const completedLog = await poll({
      label: `plugin action log ${logId}`,
      timeoutMs: STARTUP_TIMEOUT_MS,
      signal: abort.signal,
      artifacts,
      read: async () => {
        const logsOutput = await runHerdr(["plugin", "log", "list", "--plugin", PLUGIN_ID, "--limit", "50"]);
        const logsResult = parseResult(logsOutput.stdout, "plugin_log_list", "plugin log list");
        const matches = arrayValue(logsResult, "logs", "plugin log list.result")
          .map((value, index) => recordValue(value, `plugin log list.result.logs[${index}]`))
          .filter((log) => log.log_id === logId);
        if (matches.length !== 1) throw new Error(`Expected one correlated plugin log ${logId}, found ${matches.length}`);
        return matches[0];
      },
      accept: (log) => log?.status === "succeeded" || log?.status === "failed",
    });
    if (!completedLog) throw new Error(`Plugin action log ${logId} disappeared`);
    await artifacts.write("plugin-action-log.json", completedLog);
    const logStatus = stringValue(completedLog, "status", "correlated plugin log");
    if (logStatus !== "succeeded") {
      throw new Error(`Plugin action ${logId} failed: ${String(completedLog.error ?? completedLog.stderr ?? "unknown error")}`);
    }
    if (
      completedLog.plugin_id !== PLUGIN_ID ||
      completedLog.action_id !== "open" ||
      completedLog.exit_code !== 0
    ) {
      throw new Error(`Plugin action ${logId} completed with mismatched identity or exit code`);
    }
    const actionStdout = completedLog.stdout;
    if (typeof actionStdout !== "string") throw new Error(`Plugin action ${logId} had no stdout`);
    const action = parseActionOutput(actionStdout);
    if (await realpath(action.workspaceRoot) !== projectRoot) {
      throw new Error(`Plugin action used workspace root ${action.workspaceRoot}, expected ${projectRoot}`);
    }
    const paneIds = [launcher.paneId, action.servicePane, action.treePane, action.detailPane];
    if (new Set(paneIds).size !== paneIds.length) throw new Error("Plugin action returned duplicate owned pane IDs");
    panes = {
      launcher: launcher.paneId,
      service: action.servicePane,
      tree: action.treePane,
      detail: action.detailPane,
    };

    const paneInfos = new Map<string, PaneInfo>();
    for (const paneId of paneIds) {
      const paneOutput = await runHerdr(["pane", "get", paneId]);
      const paneResult = parseResult(paneOutput.stdout, "pane_info", `pane get ${paneId}`);
      const pane = parsePane(paneResult.pane, `pane get ${paneId}.result.pane`);
      if (pane.paneId !== paneId || pane.workspaceId !== workspaceId) {
        throw new Error(`Owned pane ${paneId} did not belong to fresh workspace ${workspaceId}`);
      }
      paneInfos.set(paneId, pane);
    }
    if (paneInfos.get(action.treePane)?.tabId !== tabId || paneInfos.get(action.detailPane)?.tabId !== tabId) {
      throw new Error("Tree and Detail did not open in the invoking fresh tab");
    }

    await setPhase("verify-readiness");
    const paths = resolvePaths({
      OUTLINER_STATE_DIR: outlinerState,
      OUTLINER_WORKSPACE_ROOT: projectRoot,
    });
    const outliner = new OutlinerClient(paths.socket);
    await poll({
      label: "compatible Outliner service",
      timeoutMs: STARTUP_TIMEOUT_MS,
      signal: abort.signal,
      artifacts,
      read: () => outliner.request<OutlinerServiceStatus>({ action: "ping" }, 500),
      accept: (value) =>
        value.status === "ready" && value.protocolVersion === OUTLINER_PROTOCOL_VERSION,
    });
    const registrations = await poll({
      label: "unique Outliner Tree and Detail registrations",
      timeoutMs: STARTUP_TIMEOUT_MS,
      signal: abort.signal,
      artifacts,
      read: getRegistrations,
      accept: (values) => {
        const context = values.filter((registration) => registration.contextId === action.browsingContextId);
        if (context.length !== 2) return false;
        const tree = context.filter(
          (registration) => registration.role === "tree" && registration.runtime?.paneId === action.treePane,
        );
        const detail = context.filter(
          (registration) => registration.role === "detail" && registration.runtime?.paneId === action.detailPane,
        );
        return tree.length === 1 && detail.length === 1;
      },
    });
    const matchingRegistrations = registrations.filter(
      (registration) => registration.contextId === action.browsingContextId,
    );
    for (const registration of matchingRegistrations) {
      const pane = registration.runtime?.paneId ? paneInfos.get(registration.runtime.paneId) : undefined;
      if (!pane || registration.runtime?.workspaceId !== pane.workspaceId || registration.runtime.tabId !== pane.tabId) {
        throw new Error(`Outliner ${registration.role} registration runtime did not match its Herdr pane`);
      }
    }

    const waitOwnedVisible = async (paneId: string, marker: string): Promise<void> => {
      const waited = await runHerdr([
        "pane",
        "wait-output",
        paneId,
        "--match",
        marker,
        "--source",
        "visible",
        "--timeout",
        String(STARTUP_TIMEOUT_MS),
      ], STARTUP_TIMEOUT_MS + 2_000);
      const result = parseResult(waited.stdout, "output_matched", `startup pane wait ${paneId}`);
      if (stringValue(result, "pane_id", `startup pane wait ${paneId}.result`) !== paneId) {
        throw new Error(`Startup pane wait returned a different pane for ${paneId}`);
      }
      const visible = await paneRead(paneId, "visible", "text");
      if (!visible.includes(marker)) throw new Error(`Pane ${paneId} lost startup marker ${JSON.stringify(marker)}`);
    };
    await Promise.all([
      waitOwnedVisible(action.treePane, "Workspace"),
      waitOwnedVisible(action.detailPane, "Workspace"),
    ]);

    processEvidence = await Promise.all([
      verifyProcess(launcher.paneId, projectRoot),
      verifyProcess(action.servicePane, pluginRoot),
      verifyProcess(action.treePane, pluginRoot),
      verifyProcess(action.detailPane, pluginRoot),
    ]);
    await artifacts.write("process-environments.json", processEvidence);

    resources.database = new Database(paths.database, { readonly: true, create: false });
    await setPhase("scenario");
    await captureCheckpoint("initial");
    await scenario.run(scenarioSession());
  };

  const execution = execute();
  try {
    await Promise.race([execution, interruption.promise]);
  } catch (error) {
    primaryError = error;
    primaryFailurePhase = phase;
  } finally {
    if (!primaryError && interruptedError) {
      primaryError = interruptedError;
      primaryFailurePhase = phase;
    }
    phase = "final-evidence";
    if (resources.database && panes) {
      try {
        await captureCheckpoint("final", true);
      } catch (error) {
        evidenceErrors.push(error);
      }
    } else {
      if (panes) {
        try {
          await capturePanes(
            panes,
            join(artifactDirectory, "startup-failure"),
            true,
          );
        } catch (error) {
          evidenceErrors.push(error);
        }
      }
      try {
        const paths = resolvePaths({
          OUTLINER_STATE_DIR: outlinerState,
          OUTLINER_WORKSPACE_ROOT: projectRoot,
        });
        await stat(paths.database);
        const evidenceDatabase = new Database(paths.database, { readonly: true, create: false });
        try {
          const destination = join(artifactDirectory, "startup-failure.sqlite");
          await snapshotDatabase(evidenceDatabase, destination);
          await artifacts.write("startup-failure-snapshot.json", {
            database: destination,
            sha256: hash(await readFile(destination)),
          });
        } finally {
          evidenceDatabase.close();
        }
      } catch (error) {
        if (primaryError && !hasErrorCode(error, "ENOENT")) evidenceErrors.push(error);
      }
    }

    try {
      resources.database?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    resources.database = null;

    phase = "cleanup";
    for (const [view, forwarder] of [["tree", resources.treeForwarder], ["detail", resources.detailForwarder]] as const) {
      if (!forwarder) continue;
      try {
        await artifacts.write(`forwarded-${view}-requests.json`, forwarder.measurements());
      } catch (error) {
        evidenceErrors.push(error);
      } finally {
        await forwarder.close().catch(error => cleanupErrors.push(error));
      }
    }
    if (resources.client) {
      const ownedClient = resources.client;
      try {
        if (ownedClient.exitCode === null) ownedClient.kill("SIGTERM");
        const exited = await Promise.race([ownedClient.exited.then(() => true), delay(2_000).then(() => false)]);
        if (!exited) ownedClient.kill("SIGKILL");
        await Promise.race([
          ownedClient.exited,
          delay(2_000).then(() => { throw new Error("Attached Herdr client survived cleanup"); }),
        ]);
        await artifacts.write("attached-client-exit.json", { pid: ownedClient.pid, exitCode: ownedClient.exitCode });
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        ownedClient.terminal?.close();
        resources.screen?.dispose();
      }
    }
    const ownedServer = resources.server;
    const serverPid = ownedServer?.pid;
    if (ownedServer && serverPid) {
      const ownedProcesses = await collectProcessTree(serverPid).catch((error) => {
        cleanupErrors.push(error);
        return [];
      });
      try {
        await runHerdr(["server", "stop"], 5_000, null);
      } catch (error) {
        if (!(await waitChildExit(ownedServer, 250))) cleanupErrors.push(error);
      }
      if (!(await waitChildExit(ownedServer, 5_000))) {
        try {
          process.kill(-serverPid, "SIGINT");
        } catch (error) {
          if (!hasErrorCode(error, "ESRCH")) cleanupErrors.push(error);
        }
      }
      if (!(await waitChildExit(ownedServer, 2_000))) {
        try {
          process.kill(-serverPid, "SIGTERM");
        } catch (error) {
          if (!hasErrorCode(error, "ESRCH")) cleanupErrors.push(error);
        }
      }
      if (!(await waitChildExit(ownedServer, 2_000))) {
        try {
          process.kill(-serverPid, "SIGKILL");
        } catch (error) {
          if (!hasErrorCode(error, "ESRCH")) cleanupErrors.push(error);
        }
      }
      for (const identity of ownedProcesses) {
        if (!(await sameProcess(identity))) continue;
        try {
          process.kill(identity.pid, "SIGTERM");
        } catch (error) {
          if (!hasErrorCode(error, "ESRCH")) cleanupErrors.push(error);
        }
      }
      await delay(100);
      for (const identity of ownedProcesses) {
        if (!(await sameProcess(identity))) continue;
        try {
          process.kill(identity.pid, "SIGKILL");
        } catch (error) {
          if (!hasErrorCode(error, "ESRCH")) cleanupErrors.push(error);
        }
      }
      const survivors: number[] = [];
      for (const identity of ownedProcesses) if (await sameProcess(identity)) survivors.push(identity.pid);
      if (survivors.length > 0) cleanupErrors.push(new Error(`Owned processes survived cleanup: ${survivors.join(", ")}`));
    }

    abort.abort(new Error("scenario lifecycle complete"));
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    const executionSettled = await Promise.race([
      execution.then(() => true, () => true),
      delay(1_000).then(() => false),
    ]);
    if (!executionSettled) cleanupErrors.push(new Error("Interrupted scenario callback did not settle after teardown"));
    try {
      await artifacts.flush();
    } catch (error) {
      evidenceErrors.push(error);
    }
  }

  let failure = combinedError(primaryError, evidenceErrors, cleanupErrors);
  const manifest = {
    schemaVersion: 1,
    scenario: scenarioName,
    status: failure ? "failed" : "passed",
    startedPath: runRoot,
    completedAt: new Date().toISOString(),
    failurePhase: failure
      ? primaryFailurePhase ?? (evidenceErrors.length > 0 ? "final-evidence" : "cleanup")
      : undefined,
    error: failure ?? undefined,
    projectRoot,
    artifactDirectory,
    sessionName,
    panes,
    processEvidence,
    retained: true,
  };
  try {
    await artifacts.write("manifest.json", manifest);
    await artifacts.flush();
  } catch (error) {
    evidenceErrors.push(error);
    failure = combinedError(primaryError, evidenceErrors, cleanupErrors);
  }

  return failure
    ? { status: "failed", artifactDirectory, error: failure }
    : { status: "passed", artifactDirectory };
}
