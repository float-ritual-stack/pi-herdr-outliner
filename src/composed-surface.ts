import {TreePreviewInput} from './tree-preview-input';
import {osc52ClipboardWrite} from './terminal';
import { HStack, type Component } from "@earendil-works/pi-tui";
import type { OutlinerRequester } from "./client-target";
import { PiDetailInputStreamDecoder } from "./detail-pi-input";
import { dispatchNavigation, resolveNavigationDestination, type TreeNavigation } from "./navigation-routes";
import type { createDetailController, DetailViewport } from "./detail-controller";
import type { OutlinerActionKeymap } from "./outliner-actions";
import { navigateOutlinerLink } from "./outliner-links";
import { openCapturePopup, openGotoPopup, openTreePane, openVirtualBranchNavigatorPopup } from "./pane-control";
import { parsePropertySummaryKeys } from "./property-summary";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createTreeController } from "./tree-controller";
import {
  isTreeMouseSequence, parseTreePrimaryClick, parseTreeSecondaryClick, parseTreeWheel,
  treeClickActivates, treeDisclosureAtClick, treeLinkAtClick, treeRowAtClick,
  type TreeMouseTarget,
} from "./tree-mouse";
import { renderTreeFrame } from "./tree-renderer";
import type { BrowsingContextPublication, OutlinerNavigationTarget, OutlinerRegion, OutlinerUiCommand } from "./types";

/** Tree and Detail retain distinct selections even when they share one client. */
export function composedTreeNavigation(options: {
  client: OutlinerRequester;
  clientId: string;
  contextId: string;
  detail: Pick<ReturnType<typeof createDetailController>, "state" | "handleUiCommand">;
  viewport(): DetailViewport;
  revealBlock(blockId: string): Promise<void>;
  schedulePreview(task: () => Promise<void>): void;
}): TreeNavigation {
  const {client, clientId, contextId, detail} = options;
  // Tree's source is its own occurrence, not the primary Detail's document.
  const resolve: TreeNavigation["resolve"] = async (intent, routeOptions) => {
    if (intent === "open") return resolveNavigationDestination(client, clientId, intent, {...routeOptions, sourceRegion: "tree"});
    return {sourceClientId: clientId, targetClientId: clientId, intent, resolution: "context", targetRegion: intent === "reveal" ? "tree" : "detail"};
  };
  return {
    readerLabel: "linked Detail",
    async publish(target, previewTarget, rowId) {
      const publication = await client.request<BrowsingContextPublication>({action: "browsing-context.publish", sourceClientId: clientId, contextId, target, dispatchPreview: false});
      await client.request({action: "clients.update", clientId, treeSelection: target && rowId ? {target, rowId} : null});
      if (target && previewTarget) {
        // Publication runs outside the input lane. Queue the mutation without
        // awaiting it: Tree can flush publications from inside that same lane.
        options.schedulePreview(() => detail.handleUiCommand({command: "preview", targetClientId: clientId, targetRegion: "detail", target}, options.viewport()));
      }
      return publication;
    },
    resolve,
    async dispatch(target, intent, routeOptions) {
      if (intent === "open") return dispatchNavigation(client, clientId, target, intent, {...routeOptions, sourceRegion: "tree"});
      const destination = await resolve(intent);
      let command: OutlinerUiCommand;
      if (intent === "reveal") {
        if (target.kind !== "block") throw new Error("Tree can reveal only a block target");
        command = {command: "reveal", targetClientId: clientId, targetRegion: "tree", target};
        await options.revealBlock(target.blockId);
      } else {
        command = {command: intent, targetClientId: clientId, targetRegion: "detail", target};
        await detail.handleUiCommand(command, options.viewport());
      }
      return {...destination, command};
    },
    async edit(blockId) {
      const route = await resolve("open");
      await client.request({action: "ui.command.send", command: {command: "edit", targetClientId: route.targetClientId, targetRegion: "detail", target: {kind: "block", blockId}}});
    },
  };
}

export function composedWidths(width: number): { tree: number; detail: number; detailX: number } {
  const tree = Math.max(1, Math.min(40, Math.floor((width - 1) / 3)));
  return {tree, detail: Math.max(1, width - tree - 1), detailX: tree + 1};
}

export function composedPointer(data: string, width: number): { region: OutlinerRegion; data: string } | null {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
  if (!match) return null;
  const column = Number(match[2]) - 1;
  const {detailX} = composedWidths(width);
  if (column < detailX) return {region: "tree", data};
  return {region: "detail", data: `\x1b[<${match[1]};${Number(match[2]) - detailX};${match[3]}${match[4]}`};
}

export class ComposedLayout extends HStack {
  constructor(tree: Component, detail: Component, private readonly width: () => number) {
    super([{component: tree}, {component: detail}], {gap: 1});
    this.resize();
  }
  setDetail(component: Component): void {
    this.removeChild(this.entries[1]!.component);
    this.addChild(component);
    this.resize();
  }
  resize(): void {
    const sizes = composedWidths(this.width());
    for (const [index, size] of [sizes.tree, sizes.detail].entries()) {
      Object.assign(this.entries[index]!, {basis: size, minSize: size, maxSize: size, grow: 0, shrink: 0});
    }

  }
}

export class ComposedTree implements Component {
  readonly controller;
  private frameLines: string[] = [];
  private previewInput = new TreePreviewInput();
  private mouseTargets: readonly (TreeMouseTarget | null | undefined)[] = [];
  private readonly input = new PiDetailInputStreamDecoder();
  private readonly propertyKeys = parsePropertySummaryKeys(process.env.OUTLINER_PROPERTY_SUMMARY_KEYS);

  constructor(private readonly options: {
    client: OutlinerRequester; clientId: string; contextId: string; workspaceRoot: string;
    navigation: TreeNavigation; actionKeymap: OutlinerActionKeymap;
    width(): number; height(): number; focused(): boolean; focus(): void;
    invalidate(): void; stop(): void;
    detach(target: OutlinerNavigationTarget, direction: "right" | "down"): Promise<void>;
  }) {
    this.controller = createTreeController({
      clientId: options.clientId, browsingContextId: options.contextId,
      workspaceRoot: options.workspaceRoot, navigation: options.navigation,
      actionKeymap: options.actionKeymap, request: input => options.client.request(input),
      ...(process.env.HERDR_ENV === "1" ? {
        openGotoPopup: () => openGotoPopup({ workspaceRoot: options.workspaceRoot, sourceClientId: options.clientId, sourceRegion: "tree" }),
      } : {}),
      async createTreePane(root,direction) { openTreePane({workspaceRoot:options.workspaceRoot,root,direction}); },
      createDetailPane: (blockId, direction = "right") => options.detach({kind: "block", blockId}, direction),
      async openCapturePopup(capturedFromBlockId) { openCapturePopup({workspaceRoot: options.workspaceRoot, capturedFromBlockId}); },
      openVirtualBranchNavigator(viewId, adapter) { openVirtualBranchNavigatorPopup({workspaceRoot: options.workspaceRoot, browsingContextId: options.contextId, sourceClientId: options.clientId, sourceRole: "tree", viewId, ...(adapter ? {adapter} : {})}); },
      focusSelf: options.focus, terminalWidth: options.width, terminalHeight: options.height,
      invalidate: options.invalidate, stop: options.stop,
    });
  }

  render(width: number): string[] {
    const rendered = renderTreeFrame(this.controller.view(), width, this.options.height(), this.controller.view().scrollStartEntryIndex ?? 0, {
      clearScreen: false, focused: this.options.focused(), propertyKeys: this.propertyKeys,
    });
    this.controller.setViewportStart(rendered.scrollStartEntryIndex, rendered.expandedPage);
    if(rendered.breadcrumbStart !== undefined) this.controller.setBreadcrumbStart(rendered.breadcrumbStart);
    this.frameLines = this.previewInput.render(rendered.frame.split("\n").slice(0,this.options.height()).map(line=>truncateToWidth(line,width)),rendered.preview,this.controller.view().localPreview);
    this.mouseTargets = rendered.mouseTargets;
    return this.frameLines;
  }
  invalidate(): void {}

  async handleInput(data: string): Promise<void> {
    if (isTreeMouseSequence(data)) {
      if(this.previewInput.handle(data,this.controller,text=>process.stdout.write(osc52ClipboardWrite(text)),this.options.invalidate))return;
      if (this.controller.view().mode === "goto") return this.controller.handleGotoMouse(data);
      const secondary = parseTreeSecondaryClick(data);
      if (secondary) return this.controller.handleAction("tree.menu.open", secondary);
      const wheel = parseTreeWheel(data);
      if (wheel) return this.controller.handleTreeWheel(wheel);
      const click = parseTreePrimaryClick(data);
      if (!click) return;
      const disclosure = treeDisclosureAtClick(this.mouseTargets, data);
      if (disclosure) return this.controller.handleDisclosure(disclosure);
      const row = treeRowAtClick(this.mouseTargets, data);
      const link = treeLinkAtClick(this.frameLines, data);
      if (link?.startsWith("pi-outliner-action:")) return this.controller.handleAction(link.slice("pi-outliner-action:".length));
      if (link && treeClickActivates(click)) {
        if (row) await this.controller.handleRowClick(row);
        await navigateOutlinerLink(this.options.client, link, {sourceClientId: this.options.clientId, navigation: this.options.navigation});
      } else if (row) await this.controller.handleRowClick(row, treeClickActivates(click));
      return;
    }
    for (const input of this.input.push(data)) {
      if (input.kind === "paste") await this.controller.handlePaste(input.text);
      else await this.controller.handleKeypress(input.str, input.key, input.inputAction);
    }
  }
  async flushInput(): Promise<void> {
    for (const input of this.input.flush()) {
      if (input.kind === "paste") await this.controller.handlePaste(input.text);
      else await this.controller.handleKeypress(input.str, input.key, input.inputAction);
    }
  }
}
