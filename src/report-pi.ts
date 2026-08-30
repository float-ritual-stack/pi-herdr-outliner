import { setTimeout as sleep } from "node:timers/promises";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  KeybindingsManager,
  Markdown,
  ProcessTerminal,
  setCapabilities,
  setKeybindings,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { OutlinerClient, type OutlinerWatcher } from "./client";
import { createPiDetailInputListener, decodePiDetailInput } from "./detail-pi-input";
import {
  navigateOutlinerLink,
  outlinerLinkUri,
} from "./outliner-links";
import { currentPaneRuntime } from "./pane-control";
import { resolvePaths } from "./paths";
import { formatMissingReportSession } from "./report-startup";
import {
  createReportController,
  renderAgentReportMarkdown,
  renderAgentReportSelectionLines,
  type ReportEffects,
  type ReportState,
} from "./report-controller";
import {
  OUTLINER_PROTOCOL_VERSION,
  type AgentReport,
  type AgentReportSummary,
  type AgentReportPromotion,
  type OutlinerServiceStatus,
  type OutlinerClientRegistration,
} from "./types";

initTheme(undefined, false);
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
if (process.env.HERDR_ENV === "1") {
  setCapabilities({ ...getCapabilities(), hyperlinks: true });
}

const paths = resolvePaths();
const client = new OutlinerClient(paths.socket);
const configuredSessionId = process.env.OUTLINER_REPORT_SESSION_ID?.trim();
if (!configuredSessionId) {
  let reports: Array<Pick<AgentReportSummary, "sessionId">> = [];
  let listingError: string | undefined;
  try {
    reports = await client.request<AgentReportSummary[]>({ action: "reports.list" });
  } catch (reportListError) {
    try {
      const reportClients = await client.request<OutlinerClientRegistration[]>({
        action: "clients.list",
        role: "report",
      });
      reports = [...new Set(reportClients.map((reportClient) => reportClient.contextId))]
        .sort()
        .map((sessionId) => ({ sessionId }));
    } catch {
      listingError = reportListError instanceof Error
        ? reportListError.message
        : String(reportListError);
    }
  }
  console.error(formatMissingReportSession(reports, listingError));
  process.exit(2);
}
const sessionId: string = configuredSessionId;
const clientId = crypto.randomUUID();
const terminal = new ProcessTerminal();
let stopping = false;
let watcher: OutlinerWatcher | null = null;
let workQueue = Promise.resolve();

class ReportComponent implements Component {
  private scrollOffset = 0;
  private cacheKey = "";
  private cachedLines: string[] = [];
  private previousRevision: number | undefined;

  constructor(
    private readonly state: Readonly<ReportState>,
    private readonly height: () => number,
  ) {}

  scroll(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
  }

  scrollToStart(): void {
    this.scrollOffset = 0;
  }

  scrollToEnd(): void {
    this.scrollOffset = Number.MAX_SAFE_INTEGER;
  }

  ensureSelectionVisible(): void {
    if (this.state.selectionAnchor === null) return;
    const bodyHeight = Math.max(1, this.height() - 5);
    if (this.state.cursorLine < this.scrollOffset) this.scrollOffset = this.state.cursorLine;
    if (this.state.cursorLine >= this.scrollOffset + bodyHeight) {
      this.scrollOffset = this.state.cursorLine - bodyHeight + 1;
    }
  }

  render(width: number): string[] {
    const height = Math.max(1, this.height());
    const bodyHeight = Math.max(1, height - 5);
    const revision = this.state.report?.revision;
    if (revision !== this.previousRevision) {
      this.previousRevision = revision;
      this.scrollOffset = 0;
    }
    const selectionLines = renderAgentReportSelectionLines(this.state);
    const document = selectionLines.length === 0 ? renderAgentReportMarkdown(this.state) : "";
    const key = `${width}\u0000${selectionLines.join("\n")}\u0000${document}`;
    if (key !== this.cacheKey) {
      this.cacheKey = key;
      this.cachedLines = selectionLines.length > 0
        ? selectionLines.map((line) => truncateToWidth(line, width))
        : new Markdown(document, 0, 0, getMarkdownTheme()).render(width);
    }
    const maximum = Math.max(0, this.cachedLines.length - bodyHeight);
    this.scrollOffset = Math.min(this.scrollOffset, maximum);
    const selectionStart = this.state.selectionAnchor === null
      ? null
      : Math.min(this.state.selectionAnchor, this.state.cursorLine) + 1;
    const selectionEnd = this.state.selectionAnchor === null
      ? null
      : Math.max(this.state.selectionAnchor, this.state.cursorLine) + 1;
    const selection = selectionStart === null ? "" : ` · excerpt ${selectionStart}-${selectionEnd}`;
    const label = `Last agent report · Disposable${selection}`;
    const output = [
      "",
      `\x1b[1;36m${truncateToWidth(label, width)}\x1b[0m`,
      "─".repeat(width),
      ...this.cachedLines.slice(this.scrollOffset, this.scrollOffset + bodyHeight),
    ];
    while (output.length < height - 2) output.push("");
    output.push(truncateToWidth(this.state.status, width));
    output.push(`\x1b[2m${truncateToWidth(
      "k keep  v excerpt  x discard  o open first ref  ↑↓ scroll/select  g/G bounds  q close",
      width,
    )}\x1b[0m`);
    return output.slice(0, height);
  }

  invalidate(): void {
    this.cacheKey = "";
  }
}

const effects: ReportEffects = {
  load() {
    return client.request<AgentReport>({ action: "reports.get", sessionId });
  },
  promote(startLine, endLine) {
    return client.request<AgentReportPromotion>({
      action: "reports.promote",
      sessionId,
      ...(startLine === undefined ? {} : { startLine }),
      ...(endLine === undefined ? {} : { endLine }),
    });
  },
  async clear() {
    await client.request({ action: "reports.clear", sessionId });
  },
  async openReference(target) {
    await navigateOutlinerLink(client, outlinerLinkUri(target.kind, target.value, {
      ...(target.fragmentId ? { fragmentId: target.fragmentId } : {}),
      ...(target.preserveSource ? { preserveSource: true } : {}),
      ...(target.intent ? { intent: target.intent } : {}),
    }));
  },
  async openPromoted(block) {
    await navigateOutlinerLink(client, outlinerLinkUri("block", block.id));
  },
};

let component: ReportComponent;
const controller = createReportController(effects, () => {
  component?.ensureSelectionVisible();
  tui.requestRender();
});
const tui = new TuiAltScreen(terminal, false, undefined, {
  mouse: true,
  openUrl(url) {
    if (!stopping) enqueueWork(async () => {
      await navigateOutlinerLink(client, url);
    });
  },
});
component = new ReportComponent(controller.state, () => terminal.rows);
tui.setLayoutRoot(component);

function enqueueWork(task: () => void | Promise<void>): void {
  workQueue = workQueue.then(task).catch((error) => controller.onServiceError(error));
}

async function waitForService(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const service = await client.request<OutlinerServiceStatus>({ action: "ping" }, 300);
      if (service.protocolVersion === OUTLINER_PROTOCOL_VERSION) return;
    } catch {
      // Retry until the startup deadline.
    }
    await sleep(100);
  }
  throw new Error("Compatible outliner service is not available");
}

function startWatcher(): void {
  watcher = client.watch({
    client: {
      clientId,
      role: "report",
      contextId: sessionId,
      runtime: currentPaneRuntime(),
    },
    onEvent: (event) => enqueueWork(() => controller.onServiceEvent(event)),
    onError: (error) => controller.onServiceError(error),
  });
}

async function stop(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await client.request({ action: "reports.clear", sessionId }, 300);
  } catch {
    // Service shutdown also drops the in-memory report.
  }
  await watcher?.stop();
  try {
    await terminal.drainInput(100, 20);
  } catch {
    // Best effort during terminal shutdown.
  }
  tui.stop({ preserveScreen: true });
  process.exit(exitCode);
}

async function handleInput(data: string): Promise<void> {
  const input = decodePiDetailInput(data);
  if (input.kind !== "key") return;
  if (input.key.ctrl && (input.key.name === "c" || input.key.name === "q")) {
    await stop();
    return;
  }
  if (input.str === "q") {
    await stop();
    return;
  }
  if (input.str === "k") await controller.dispatch({ type: "report.keep" });
  else if (input.str === "v") await controller.dispatch({ type: "selection.toggle" });
  else if (input.str === "x") await controller.dispatch({ type: "report.discard" });
  else if (input.str === "o") await controller.dispatch({ type: "reference.open" });
  else if (input.str === "g") {
    component.scrollToStart();
    tui.requestRender();
  } else if (input.str === "G") {
    component.scrollToEnd();
    tui.requestRender();
  } else if (input.key.name === "up" || input.key.name === "down") {
    const delta = input.key.name === "up" ? -1 : 1;
    await controller.dispatch({ type: "cursor.move", delta });
    if (controller.state.selectionAnchor === null) component.scroll(delta);
  } else if (input.key.name === "pageup" || input.key.name === "pagedown") {
    component.scroll((input.key.name === "pageup" ? -1 : 1) * Math.max(1, terminal.rows - 7));
    tui.requestRender();
  }
}

tui.addInputListener(createPiDetailInputListener((data) => {
  if (!stopping) enqueueWork(() => handleInput(data));
}, () => tui.hasOverlay()));

try {
  await waitForService();
  await controller.initialize();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("SIGHUP", () => void stop());
process.stdout.on("resize", () => tui.requestRender());
tui.start();
startWatcher();
