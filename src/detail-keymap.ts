import type {
  DetailBufferMoveDirection,
  DetailController,
  DetailIntent,
  DetailViewport,
} from "./detail-controller";
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
}

export type DetailKeyHandler = (
  str: string,
  key: TerminalKey,
  inputAction: TerminalInputAction,
) => Promise<void>;

type PageNavigationKey = "up" | "down" | "pageup" | "pagedown";

function isPageNavigationKey(name: string | undefined): name is PageNavigationKey {
  return name === "up" || name === "down" || name === "pageup" || name === "pagedown";
}

export function createDetailKeyHandler(options: DetailKeymapOptions): DetailKeyHandler {
  const { controller, stop, viewport } = options;

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

  function wordMotionDirection(key: TerminalKey): DetailBufferMoveDirection | null {
    if (!key.ctrl && !key.meta) return null;
    if (key.name === "left" || key.name === "b") return "word-left";
    if (key.name === "right" || key.name === "f") return "word-right";
    return null;
  }

  async function handleBufferKey(str: string, key: TerminalKey, modifiedEnter: boolean): Promise<void> {
    if ((key.ctrl || key.meta) && key.name === "z") {
      await dispatch({ type: key.shift ? "buffer.redo" : "buffer.undo" });
      return;
    }
    if (key.ctrl && key.name === "y") {
      await dispatch({ type: "buffer.redo" });
      return;
    }
    if (controller.state.completion) {
      await handleCompletionKey(key);
      return;
    }
    if (key.ctrl && key.name === "s") {
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
    if (key.name === "escape") {
      await cancelBuffer();
      return;
    }
    if ((key.meta && key.name === "a") || (key.ctrl && key.shift && key.name === "a")) {
      await dispatch({ type: "buffer.select-all" });
      return;
    }
    if (key.ctrl && key.name === "a") {
      await dispatch({ type: "buffer.move", direction: "home", extend: key.shift });
      return;
    }
    if (key.ctrl && key.name === "e") {
      await dispatch({ type: "buffer.move", direction: "end", extend: key.shift });
      return;
    }
    const wordDirection = wordMotionDirection(key);
    if (wordDirection) {
      await dispatch({ type: "buffer.move", direction: wordDirection, extend: key.shift });
      return;
    }
    if (key.name === "return" || modifiedEnter) await dispatch({ type: "buffer.newline" });
    else if (key.name === "backspace") await dispatch({ type: "buffer.backspace" });
    else if (key.name === "delete") await dispatch({ type: "buffer.delete" });
    else if (
      key.name === "left" ||
      key.name === "right" ||
      key.name === "up" ||
      key.name === "down" ||
      key.name === "home" ||
      key.name === "end"
    ) {
      await dispatch({ type: "buffer.move", direction: key.name, extend: key.shift });
    } else if (isPrintableInput(str, key)) await dispatch({ type: "buffer.insert", text: str });
    else await dispatch({ type: "redraw" });
  }

  async function handlePreviewKey(str: string, key: TerminalKey): Promise<void> {
    const direction = historyNavigationDirection(key);
    if (direction) {
      await dispatch({ type: direction === "back" ? "navigation.back" : "navigation.forward" });
    } else if (str === "o") {
      await dispatch({ type: "reference.follow" });
    } else if (isPageNavigationKey(key.name)) {
      await dispatch({ type: "preview.navigate", direction: key.name });
    } else if (key.name === "return" || str === "e") await dispatch({ type: "edit.begin" });
    else if (str === "f") await dispatch({ type: "view.file" });
    else if (str === "b" && controller.state.mode === "annotation") await dispatch({ type: "view.block" });
    else await dispatch({ type: "redraw" });
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

  async function handleRouteKey(key: TerminalKey): Promise<void> {
    if (key.name === "up") await dispatch({ type: "route.move", delta: -1 });
    else if (key.name === "down" || key.name === "tab") {
      await dispatch({ type: "route.move", delta: 1 });
    } else if (key.name === "return") await dispatch({ type: "route.accept" });
    else if (key.name === "escape") await dispatch({ type: "route.cancel" });
    else await dispatch({ type: "redraw" });
  }

  return async (str, key, inputAction) => {
    if (inputAction === "suppress") return;
    if (key.ctrl && key.name === "q") {
      stop();
      return;
    }
    if (key.ctrl && key.name === "c") {
      if (controller.isBufferMode()) await cancelBuffer();
      else await dispatch({ type: "focus.outliner" });
      return;
    }
    if (controller.isBufferMode()) {
      await handleBufferKey(str, key, inputAction === "modified-enter");
      return;
    }
    if (controller.state.mode === "route") {
      await handleRouteKey(key);
      return;
    }
    if (controller.state.peeking && key.name === "escape") {
      await dispatch({ type: "peek.close" });
      return;
    }
    if (str === "L") {
      await dispatch({ type: "route.open" });
      return;
    }
    if (str === "P" || str === "R") {
      await dispatch({ type: str === "P" ? "reference.peek" : "reference.reveal" });
      return;
    }
    if (key.name === "q") {
      await dispatch({ type: "focus.outliner", announce: true });
      return;
    }
    if (str === "i") {
      await dispatch({ type: "connection.toggle" });
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
  };
}
