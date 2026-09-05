import {
  DEFAULT_OUTLINER_ACTION_KEYMAP,
  type OutlinerActionKeymap,
  type OutlinerActionMenuItem,
} from "./outliner-actions";
import {
  type DetailController,
  type DetailIntent,
  type DetailState,
  type DetailViewport,
} from "./detail-controller";
import { textBufferEditorCommand } from "./text-buffer-editor";
import {
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
  previewFocused?(): boolean;
}

export interface DetailKeyHandler {
  (
    str: string,
    key: TerminalKey,
    inputAction: TerminalInputAction,
  ): Promise<void>;
  invoke(actionId: string): Promise<void>;
}

type ContentNavigationDirection = "up" | "down" | "pageup" | "pagedown" | "top" | "bottom";

function focusedPropertyOccurrence(state: Pick<DetailState, "previewRegions">): string | null {
  const region = state.previewRegions.regions.find(
    (candidate) => candidate.id === state.previewRegions.focusedRegionId,
  );
  return region?.kind === "property-entry" ? region.id : null;
}

export function detailActionScopes(
  state: Pick<
    DetailState,
    | "backlinks"
    | "completion"
    | "context"
    | "destinationChooser"
    | "mode"
    | "previewRegions"
    | "propertyInspector"
  >,
  options: { bufferMode?: boolean; previewFocused?: boolean } = {},
): readonly string[] {
  if (state.destinationChooser.active) return ["destination"];
  if (state.propertyInspector.edit) return ["property-edit"];
  if (state.propertyInspector.filterDraft !== null) return ["property-filter"];
  if (state.backlinks.filterDraft !== null) return ["backlinks-filter"];
  if (state.completion) return ["completion"];
  if (options.previewFocused) return ["draft-preview", state.mode];
  if (options.bufferMode ?? (state.mode === "edit" || state.mode === "comment")) {
    return [state.mode];
  }

  const scopes: string[] = [];
  const propertyOccurrence = focusedPropertyOccurrence(state);
  const dedicatedProperty = state.propertyInspector.presentation === "dedicated";
  if (state.context.selected?.deletedAt) scopes.push("trash");
  if (propertyOccurrence) scopes.push("property-focused");
  if (dedicatedProperty) {
    scopes.push("property-inspector", "property");
    return scopes;
  }
  if (state.backlinks.expanded && !propertyOccurrence) scopes.push("backlinks");
  if (state.propertyInspector.expanded) scopes.push("property-inspector");
  if (state.backlinks.expanded && propertyOccurrence) scopes.push("backlinks");
  scopes.push(state.mode);
  return scopes;
}

export function createDetailKeyHandler(options: DetailKeymapOptions): DetailKeyHandler {
  const { controller, stop, viewport } = options;
  const actionKeymap = options.actionKeymap ?? DEFAULT_OUTLINER_ACTION_KEYMAP;
  let handleKeypress: DetailKeyHandler;

  async function dispatch(intent: DetailIntent): Promise<void> {
    await controller.dispatch(intent, viewport());
  }

  async function setStatus(message: string): Promise<void> {
    await dispatch({ type: "status.set", message });
  }

  function previewFocused(): boolean {
    return options.previewFocused?.() ?? false;
  }

  function activeScopes(): readonly string[] {
    return detailActionScopes(controller.state, {
      bufferMode: controller.isBufferMode(),
      previewFocused: previewFocused(),
    });
  }

  async function cancelBuffer(): Promise<void> {
    await dispatch({ type: "buffer.cancel" });
    if (controller.state.refreshPending) await controller.refreshPendingSelection();
  }

  function contentNavigationDirection(actionId: string): ContentNavigationDirection | null {
    switch (actionId) {
      case "detail.preview.up":
        return "up";
      case "detail.preview.down":
        return "down";
      case "detail.preview.pageup":
        return "pageup";
      case "detail.preview.pagedown":
        return "pagedown";
      case "detail.preview.top":
        return "top";
      case "detail.preview.bottom":
        return "bottom";
      default:
        return null;
    }
  }

  function propertyNavigationDirection(actionId: string): ContentNavigationDirection | null {
    switch (actionId) {
      case "detail.property.viewport.up":
        return "up";
      case "detail.property.viewport.down":
        return "down";
      case "detail.property.viewport.pageup":
        return "pageup";
      case "detail.property.viewport.pagedown":
        return "pagedown";
      case "detail.property.viewport.top":
        return "top";
      case "detail.property.viewport.bottom":
        return "bottom";
      default:
        return null;
    }
  }

  async function executeAction(actionId: string): Promise<boolean> {
    const contentDirection = contentNavigationDirection(actionId);
    if (contentDirection) {
      if (controller.state.mode === "file" && controller.state.referencedFile) {
        await dispatch({
          type: "file.navigate",
          direction: contentDirection === "top"
            ? "home"
            : contentDirection === "bottom"
            ? "end"
            : contentDirection,
        });
      } else if (
        options.navigatePreview &&
        (controller.state.mode === "preview" || previewFocused())
      ) {
        options.navigatePreview(contentDirection);
      } else {
        await dispatch({ type: "preview.navigate", direction: contentDirection });
      }
      return true;
    }

    const propertyDirection = propertyNavigationDirection(actionId);
    if (propertyDirection) {
      await dispatch({
        type: "property-inspector.viewport.navigate",
        direction: propertyDirection === "top"
          ? "home"
          : propertyDirection === "bottom"
          ? "end"
          : propertyDirection,
      });
      return true;
    }

    switch (actionId) {
      case "detail.close":
      case "detail.property.close":
        stop();
        return true;
      case "detail.cancel":
        await cancelBuffer();
        return true;
      case "detail.menu.open":
        options.openActionMenu?.(
          actionKeymap.menuItems("detail", activeScopes()),
          invokeAction,
        );
        return true;
      case "detail.keymap.reload": {
        const result = actionKeymap.reload();
        await setStatus(result.ok ? "Outliner keymap reloaded" : `Keymap unchanged: ${result.error}`);
        return true;
      }
      case "detail.focus.tree":
      case "detail.property.focus.tree":
        await dispatch({ type: "focus.outliner", announce: true });
        return true;
      case "detail.lock.toggle":
        await dispatch({ type: "lock.toggle" });
        return true;
      case "detail.property.toggle":
        await dispatch({ type: "property-inspector.disclosure.toggle" });
        return true;
      case "detail.property.pane":
        await dispatch({ type: "property-inspector.pane.open" });
        return true;
      case "detail.reference.open":
        await dispatch({ type: "reference.follow" });
        return true;
      case "detail.current.reveal":
        await dispatch({ type: "current.reveal" });
        return true;
      case "detail.navigation.back":
        await dispatch({ type: "navigation.back" });
        return true;
      case "detail.navigation.forward":
        await dispatch({ type: "navigation.forward" });
        return true;
      case "detail.edit.begin":
        await dispatch({ type: "edit.begin" });
        return true;
      case "detail.annotation.select":
        await dispatch({ type: "annotation.selection.begin" });
        return true;
      case "detail.annotation.reveal":
        await dispatch({ type: "annotation.reveal" });
        return true;
      case "detail.file.view":
        await dispatch({ type: "view.file" });
        return true;
      case "detail.block.view":
        await dispatch({ type: "view.block" });
        return true;
      case "detail.backlinks.toggle":
        await dispatch({ type: "backlinks.toggle" });
        return true;
      case "detail.preview.focus.next":
        await dispatch({ type: "preview.focus.move", delta: 1 });
        return true;
      case "detail.preview.focus.previous":
        await dispatch({ type: "preview.focus.move", delta: -1 });
        return true;
      case "detail.preview.activate":
        await dispatch({ type: "preview.activate" });
        return true;
      case "detail.property.edit.begin":
        await dispatch({ type: "property-inspector.edit.begin" });
        return true;
      case "detail.property.target.open": {
        const occurrenceId = focusedPropertyOccurrence(controller.state);
        if (!occurrenceId) return false;
        await dispatch({
          type: "property-inspector.target.open",
          occurrenceId,
          intent: "open",
        });
        return true;
      }
      case "detail.property.filter":
        await dispatch({ type: "property-inspector.filter.begin" });
        return true;
      case "detail.property.group":
        await dispatch({ type: "property-inspector.group.cycle" });
        return true;
      case "detail.backlinks.filter":
        await dispatch({ type: "backlinks.filter.begin" });
        return true;
      case "detail.backlinks.sort":
        await dispatch({ type: "backlinks.sort.cycle" });
        return true;
      case "detail.backlinks.source":
        await dispatch({ type: "backlinks.source.toggle" });
        return true;
      case "detail.embed.toggle":
        await dispatch({ type: "embed-background.toggle" });
        return true;
      case "detail.file.selection":
        await dispatch({ type: "file.selection.toggle" });
        return true;
      case "detail.comment.begin":
        await dispatch({ type: "comment.begin" });
        return true;
      case "detail.trash.restore":
        await dispatch({ type: "trash.restore" });
        return true;
      case "detail.buffer.save":
        await dispatch({ type: "buffer.save" });
        return true;
      case "detail.buffer.copy":
        await dispatch({ type: "buffer.copy" });
        return true;
      case "detail.completion.open":
        await dispatch({ type: "completion.open" });
        return true;
      case "detail.buffer.undo":
        await dispatch({ type: "buffer.undo" });
        return true;
      case "detail.buffer.redo":
        await dispatch({ type: "buffer.redo" });
        return true;
      case "detail.pane.right":
      case "detail.pane.below":
        await dispatch({
          type: "pane.open",
          direction: actionId === "detail.pane.right" ? "right" : "down",
        });
        return true;
      case "detail.split.focus":
        options.focusDraftSplit?.();
        return true;
      case "detail.split.link":
        await dispatch({ type: "draft-preview.link.toggle" });
        return true;
      default:
        return false;
    }
  }

  async function invokeAction(actionId: string): Promise<void> {
    let label: string;
    try {
      label = actionKeymap.action(actionId).label;
    } catch {
      await setStatus(`Unknown Detail action: ${actionId}`);
      return;
    }
    if (!actionKeymap.isAvailable(actionId, "detail", activeScopes())) {
      await setStatus(`${label} is unavailable here`);
      return;
    }
    if (!await executeAction(actionId)) {
      await setStatus(`${label} has no Detail executor`);
    }
  }

  async function handleCompletionKey(key: TerminalKey): Promise<void> {
    if (key.name === "up") await dispatch({ type: "completion.move", delta: -1 });
    else if (key.name === "down") await dispatch({ type: "completion.move", delta: 1 });
    else if (key.name === "return" || key.name === "tab") {
      await dispatch({ type: "completion.accept" });
    } else if (key.name === "escape") await dispatch({ type: "completion.dismiss" });
    else await dispatch({ type: "redraw" });
  }

  async function handleBufferKey(
    str: string,
    key: TerminalKey,
    modifiedEnter: boolean,
  ): Promise<void> {
    const command = textBufferEditorCommand(str, key, modifiedEnter);
    if (command.type === "undo" || command.type === "redo") {
      await executeAction(command.type === "undo" ? "detail.buffer.undo" : "detail.buffer.redo");
      return;
    }
    if (controller.state.completion) {
      await handleCompletionKey(key);
      return;
    }
    if (command.type === "save") {
      await executeAction("detail.buffer.save");
      return;
    }
    if (
      (key.name === "tab" || (key.ctrl && key.name === "space")) &&
      controller.state.mode === "edit"
    ) {
      await executeAction("detail.completion.open");
      return;
    }
    if (command.type === "cancel") {
      await executeAction("detail.cancel");
      return;
    }
    if (
      controller.state.mode === "select" &&
      (command.type === "insert" || command.type === "newline" ||
        command.type === "backspace" || command.type === "delete")
    ) {
      await setStatus("Source selection is read-only");
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

  async function handleFilterKey(
    kind: "property-inspector" | "backlinks",
    str: string,
    key: TerminalKey,
  ): Promise<void> {
    if (key.name === "return") await dispatch({ type: `${kind}.filter.commit` });
    else if (key.name === "escape") await dispatch({ type: `${kind}.filter.cancel` });
    else if (key.name === "backspace") await dispatch({ type: `${kind}.filter.backspace` });
    else if (isPrintableInput(str, key)) {
      await dispatch({ type: `${kind}.filter.input`, text: str });
    } else await dispatch({ type: "redraw" });
  }

  handleKeypress = (async (str, key, inputAction) => {
    if (controller.state.destinationChooser.active) {
      if (inputAction !== "suppress") {
        const resolved = actionKeymap.resolve("detail", ["destination"], str, key);
        if (resolved.suppressed) return;
        if (resolved.actionId === "detail.close") {
          await invokeAction(resolved.actionId);
          return;
        }
      }
      await controller.handleDestinationChooserKeypress(
        inputAction === "suppress" ? "" : str,
        inputAction === "suppress" ? { name: "input" } : key,
      );
      return;
    }
    if (inputAction === "suppress") return;

    const resolved = actionKeymap.resolve("detail", activeScopes(), str, key);
    if (resolved.suppressed) return;
    if (resolved.actionId) {
      await invokeAction(resolved.actionId);
      return;
    }

    if (controller.state.propertyInspector.edit) {
      await handlePropertyEditKey(str, key);
    } else if (controller.state.propertyInspector.filterDraft !== null) {
      await handleFilterKey("property-inspector", str, key);
    } else if (controller.state.backlinks.filterDraft !== null) {
      await handleFilterKey("backlinks", str, key);
    } else if (controller.isBufferMode() && !previewFocused()) {
      await handleBufferKey(str, key, inputAction === "modified-enter");
    } else {
      await dispatch({ type: "redraw" });
    }
  }) as DetailKeyHandler;
  handleKeypress.invoke = invokeAction;
  return handleKeypress;
}
