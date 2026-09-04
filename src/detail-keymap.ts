import {
  DEFAULT_OUTLINER_ACTION_KEYMAP,
  type OutlinerActionKeymap,
  type OutlinerActionMenuItem,
} from "./outliner-actions";
import {
  visibleBacklinkSources,
  type DetailController,
  type DetailIntent,
  type DetailState,
  type DetailViewport,
} from "./detail-controller";
import { textBufferEditorCommand } from "./text-buffer-editor";
import {
  historyNavigationDirection,
  isPrintableInput,
  type TerminalInputAction,
  type TerminalKey,
} from "./terminal";

export interface DetailKeymapOptions {
  controller: DetailController;
  viewport(): DetailViewport;
  stop(): void;
  actionKeymap?: OutlinerActionKeymap;
  openActionMenu?(
    items: readonly OutlinerActionMenuItem[],
    invoke: (actionId: string) => Promise<void>,
  ): void;
  focusDraftSplit?(): void;
  navigatePreview?(direction: "up" | "down" | "pageup" | "pagedown" | "top" | "bottom"): void;
}

export interface DetailKeyHandler {
  (
    str: string,
    key: TerminalKey,
    inputAction: TerminalInputAction,
  ): Promise<void>;
  invoke(actionId: string): Promise<void>;
}

type PageNavigationKey = "up" | "down" | "pageup" | "pagedown";

function isPageNavigationKey(name: string | undefined): name is PageNavigationKey {
  return name === "up" || name === "down" || name === "pageup" || name === "pagedown";
}

export function detailActionMode(
  state: Pick<DetailState, "mode" | "propertyInspector">,
): string {
  return state.propertyInspector.presentation === "dedicated" ? "property" : state.mode;
}

export function createDetailKeyHandler(options: DetailKeymapOptions): DetailKeyHandler {
  const { controller, stop, viewport } = options;
  const actionKeymap = options.actionKeymap ?? DEFAULT_OUTLINER_ACTION_KEYMAP;
  let handleKeypress: DetailKeyHandler;
  let forcedActionId: string | null = null;

  async function invokeAction(actionId: string): Promise<void> {
    const input = actionKeymap.defaultInput(actionId);
    if (!input) {
      await controller.dispatch({
        type: "status.set",
        message: `${actionKeymap.action(actionId).label} has no direct invocation`,
      }, viewport());
      return;
    }
    forcedActionId = actionId;
    try {
      await handleKeypress(input.str, input.key, "pass");
    } finally {
      forcedActionId = null;
    }
  }

  async function dispatch(intent: DetailIntent): Promise<void> {
    await controller.dispatch(intent, viewport());
  }

  async function cancelBuffer(): Promise<void> {
    await dispatch({ type: "buffer.cancel" });
    if (controller.state.refreshPending) await controller.refreshPendingSelection();
  }

  async function handleCompletionKey(key: TerminalKey): Promise<void> {
    if (key.name === "up") await dispatch({ type: "completion.move", delta: -1 });
    else if (key.name === "down") await dispatch({ type: "completion.move", delta: 1 });
    else if (key.name === "return" || key.name === "tab") await dispatch({ type: "completion.accept" });
    else if (key.name === "escape") await dispatch({ type: "completion.dismiss" });
    else await dispatch({ type: "redraw" });
  }


  async function handleBufferKey(str: string, key: TerminalKey, modifiedEnter: boolean): Promise<void> {
    const command = textBufferEditorCommand(str, key, modifiedEnter);
    if (command.type === "undo" || command.type === "redo") {
      await dispatch({ type: command.type === "undo" ? "buffer.undo" : "buffer.redo" });
      return;
    }
    if (controller.state.completion) {
      await handleCompletionKey(key);
      return;
    }
    if (command.type === "save") {
      await dispatch({ type: "buffer.save" });
      return;
    }
    if (
      (key.name === "tab" || (key.ctrl && key.name === "space")) &&
      controller.state.mode === "edit"
    ) {
      await dispatch({ type: "completion.open" });
      return;
    }
    if (command.type === "cancel") {
      await cancelBuffer();
      return;
    }
    if (command.type === "select-all") {
      await dispatch({ type: "buffer.select-all" });
    } else if (command.type === "move") {
      await dispatch({
        type: "buffer.move",
        direction: command.direction,
        extend: command.extend,
      });
    } else if (command.type === "newline") {
      await dispatch({ type: "buffer.newline" });
    } else if (command.type === "backspace") {
      await dispatch({ type: "buffer.backspace" });
    } else if (command.type === "delete") {
      await dispatch({ type: "buffer.delete" });
    } else if (command.type === "insert") {
      await dispatch({ type: "buffer.insert", text: command.text });
    } else {
      await dispatch({ type: "redraw" });
    }
  }

  function propertyInspectorActive(): boolean {
    return controller.state.propertyInspector.presentation === "dedicated" ||
      controller.state.propertyInspector.expanded;
  }

  function focusedPropertyOccurrence(): string | null {
    const region = controller.state.previewRegions.regions.find(
      (candidate) => candidate.id === controller.state.previewRegions.focusedRegionId,
    );
    return region?.kind === "property-entry" ? region.id : null;
  }

  async function handlePropertyEditKey(str: string, key: TerminalKey): Promise<void> {
    if (key.name === "return") {
      await dispatch({ type: "property-inspector.edit.commit" });
      return;
    }
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      await dispatch({ type: "property-inspector.edit.cancel" });
      if (controller.state.refreshPending) await controller.refreshPendingSelection();
      return;
    }
    if ((key.meta && key.name === "a") || (key.ctrl && key.name === "a")) {
      await dispatch({ type: "property-inspector.edit.select-all" });
      return;
    }
    if (key.name === "backspace") {
      await dispatch({ type: "property-inspector.edit.backspace" });
      return;
    }
    if (key.name === "delete") {
      await dispatch({ type: "property-inspector.edit.delete" });
      return;
    }
    if (
      key.name === "left" ||
      key.name === "right" ||
      key.name === "home" ||
      key.name === "end"
    ) {
      await dispatch({ type: "property-inspector.edit.move", direction: key.name });
      return;
    }
    if (isPrintableInput(str, key)) {
      await dispatch({ type: "property-inspector.edit.insert", text: str });
      return;
    }
    await dispatch({ type: "redraw" });
  }

  async function handlePreviewKey(str: string, key: TerminalKey): Promise<void> {
    const dedicatedInspector =
      controller.state.propertyInspector.presentation === "dedicated";
    if (controller.state.propertyInspector.filterDraft !== null) {
      if (key.name === "return") {
        await dispatch({ type: "property-inspector.filter.commit" });
      } else if (key.name === "escape") {
        await dispatch({ type: "property-inspector.filter.cancel" });
      } else if (key.name === "backspace") {
        await dispatch({ type: "property-inspector.filter.backspace" });
      } else if (isPrintableInput(str, key)) {
        await dispatch({ type: "property-inspector.filter.input", text: str });
      } else await dispatch({ type: "redraw" });
      return;
    }
    if (controller.state.backlinks.filterDraft !== null) {
      if (key.name === "return") await dispatch({ type: "backlinks.filter.commit" });
      else if (key.name === "escape") await dispatch({ type: "backlinks.filter.cancel" });
      else if (key.name === "backspace") await dispatch({ type: "backlinks.filter.backspace" });
      else if (isPrintableInput(str, key)) {
        await dispatch({ type: "backlinks.filter.input", text: str });
      } else await dispatch({ type: "redraw" });
      return;
    }
    const direction = historyNavigationDirection(key);
    if (direction) {
      await dispatch({ type: direction === "back" ? "navigation.back" : "navigation.forward" });
    } else if (key.name === "tab") {
      await dispatch({ type: "preview.focus.move", delta: key.shift ? -1 : 1 });
    } else if (key.name === "return") {
      if (focusedPropertyOccurrence()) {
        await dispatch({ type: "property-inspector.edit.begin" });
      } else {
        await dispatch({ type: "preview.activate" });
      }
    } else if (
      str === "/" && propertyInspectorActive() &&
      (!controller.state.backlinks.expanded || focusedPropertyOccurrence() !== null ||
        dedicatedInspector)
    ) {
      await dispatch({ type: "property-inspector.filter.begin" });
    } else if (str === "/" && controller.state.backlinks.expanded) {
      await dispatch({ type: "backlinks.filter.begin" });
    } else if (str === "G" && propertyInspectorActive()) {
      await dispatch({ type: "property-inspector.group.cycle" });
    } else if (str === "s" && controller.state.backlinks.expanded) {
      await dispatch({ type: "backlinks.sort.cycle" });
    } else if (str === "." && controller.state.backlinks.expanded) {
      await dispatch({ type: "backlinks.source.toggle" });
    } else if (str === "p" && !dedicatedInspector) {
      await dispatch({ type: "property-inspector.disclosure.toggle" });
    } else if (
      dedicatedInspector &&
      isPageNavigationKey(key.name)
    ) {
      await dispatch({ type: "property-inspector.viewport.navigate", direction: key.name });
    } else if (
      dedicatedInspector &&
      str === "g"
    ) {
      await dispatch({ type: "property-inspector.viewport.navigate", direction: "home" });
    } else if (str === "o" && focusedPropertyOccurrence()) {
      await dispatch({
        type: "property-inspector.target.open",
        occurrenceId: focusedPropertyOccurrence()!,
        intent: "open",
      });
    } else if (str === "o" && !dedicatedInspector) {
      await dispatch({ type: "reference.follow" });
    } else if (isPageNavigationKey(key.name)) {
      await dispatch({ type: "preview.navigate", direction: key.name });
    } else if (str === "E" && !dedicatedInspector) {
      await dispatch({ type: "embed-background.toggle" });
    } else if (str === "e" && focusedPropertyOccurrence()) {
      await dispatch({ type: "property-inspector.edit.begin" });
    } else if (str === "e" && !dedicatedInspector) {
      await dispatch({ type: "edit.begin" });
    } else if (str === "f" && !dedicatedInspector) {
      await dispatch({ type: "view.file" });
    } else if (
      str === "b" &&
      !dedicatedInspector &&
      controller.state.mode === "annotation"
    ) {
      await dispatch({ type: "view.block" });
    } else if (str === "b" && !dedicatedInspector) {
      await dispatch({ type: "backlinks.toggle" });
    } else await dispatch({ type: "redraw" });
  }

  async function handleFileKey(str: string, key: TerminalKey): Promise<void> {
    const direction = historyNavigationDirection(key);
    if (direction) {
      await dispatch({ type: direction === "back" ? "navigation.back" : "navigation.forward" });
    } else if (str === "o") {
      await dispatch({ type: "reference.follow" });
    } else if (isPageNavigationKey(key.name)) {
      await dispatch({ type: "file.navigate", direction: key.name });
    } else if (str === "g") await dispatch({ type: "file.navigate", direction: "home" });
    else if (str === "G") await dispatch({ type: "file.navigate", direction: "end" });
    else if (str === "v") await dispatch({ type: "file.selection.toggle" });
    else if (str === "c") await dispatch({ type: "comment.begin" });
    else if (str === "b") await dispatch({ type: "view.block" });
    else await dispatch({ type: "redraw" });
  }


  handleKeypress = (async (str, key, inputAction) => {
    if (inputAction !== "suppress" && key.ctrl && key.name === "q") {
      stop();
      return;
    }
    if (controller.state.destinationChooser.active) {
      await controller.handleDestinationChooserKeypress(
        inputAction === "suppress" ? "" : str,
        inputAction === "suppress" ? { name: "input" } : key,
      );
      return;
    }
    if (inputAction === "suppress") return;
    const mode = controller.state.mode;
    const actionMode = detailActionMode(controller.state);
    const mapped = forcedActionId
      ? {
        actionId: forcedActionId,
        ...actionKeymap.defaultInput(forcedActionId)!,
        suppressed: false,
      }
      : actionKeymap.canonicalize("detail", actionMode, str, key);
    if (!forcedActionId && mapped.suppressed) return;
    if (!forcedActionId && mapped.actionId) {
      await invokeAction(mapped.actionId);
      return;
    }
    str = mapped.str;
    key = mapped.key;
    if (mapped.actionId === "detail.menu.open") {
      options.openActionMenu?.(
        actionKeymap.menuItems("detail", actionMode),
        invokeAction,
      );
      return;
    }
    if (mapped.actionId === "detail.property.close") {
      stop();
      return;
    }
    if (mapped.actionId === "detail.pane.right" || mapped.actionId === "detail.pane.below") {
      await dispatch({
        type: "pane.open",
        direction: mapped.actionId === "detail.pane.right" ? "right" : "down",
      });
      return;
    }
    if (mapped.actionId === "detail.keymap.reload") {
      const result = actionKeymap.reload();
      await dispatch({
        type: "status.set",
        message: result.ok ? "Outliner keymap reloaded" : `Keymap unchanged: ${result.error}`,
      });
      return;
    }
    if (mapped.actionId === "detail.split.focus") {
      options.focusDraftSplit?.();
      return;
    }
    if (mapped.actionId === "detail.split.link") {
      await dispatch({ type: "draft-preview.link.toggle" });
      return;
    }
    if (mapped.actionId === "detail.buffer.copy") {
      await dispatch({ type: "buffer.copy" });
      return;
    }
    const previewDirection = {
      "detail.preview.up": "up",
      "detail.preview.down": "down",
      "detail.preview.pageup": "pageup",
      "detail.preview.pagedown": "pagedown",
      "detail.preview.top": "top",
      "detail.preview.bottom": "bottom",
    }[mapped.actionId ?? ""] as
      | "up"
      | "down"
      | "pageup"
      | "pagedown"
      | "top"
      | "bottom"
      | undefined;
    if (
      previewDirection &&
      options.navigatePreview &&
      mode === "preview" &&
      controller.state.propertyInspector.presentation !== "dedicated"
    ) {
      options.navigatePreview(previewDirection);
      return;
    }
    if (controller.state.propertyInspector.edit) {
      await handlePropertyEditKey(str, key);
      return;
    }
    if (controller.isBufferMode() && (key.ctrl || key.meta) && key.name === "c") {
      await dispatch({ type: "buffer.copy" });
      return;
    }
    if (key.ctrl && key.name === "c") {
      await dispatch({ type: "focus.outliner" });
      return;
    }
    if (controller.isBufferMode()) {
      await handleBufferKey(str, key, inputAction === "modified-enter");
      return;
    }
    if (str === "P") {
      await dispatch({ type: "property-inspector.pane.open" });
      return;
    }
    if (
      str === "L" ||
      str === "i" ||
      ((key.ctrl || key.meta) && key.name === "l")
    ) {
      await dispatch({ type: "lock.toggle" });
      return;
    }
    if (str === "R") {
      const occurrenceId = focusedPropertyOccurrence();
      if (occurrenceId) {
        await dispatch({
          type: "property-inspector.target.open",
          occurrenceId,
          intent: "reveal",
        });
      } else {
        await dispatch(
          controller.state.backlinks.expanded &&
              visibleBacklinkSources(controller.state.backlinks).length > 0
            ? { type: "backlinks.reveal" }
            : { type: "reference.reveal" },
        );
      }
      return;
    }
    if (key.name === "q") {
      await dispatch({ type: "focus.outliner", announce: true });
      return;
    }
    if (str === "r" && controller.state.context.selected?.deletedAt) {
      await dispatch({ type: "trash.restore" });
      return;
    }
    if (controller.state.mode === "file" && controller.state.referencedFile) {
      await handleFileKey(str, key);
    } else {
      await handlePreviewKey(str, key);
    }
  }) as DetailKeyHandler;
  handleKeypress.invoke = invokeAction;
  return handleKeypress;
}
