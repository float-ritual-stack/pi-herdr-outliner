import {
  DEFAULT_OUTLINER_ACTION_KEYMAP,
  displayActionChord,
  type OutlinerActionKeymap,
} from "./outliner-actions";
import type { TerminalKey } from "./terminal";

export const DEFAULT_OPEN_DESTINATION_TIMEOUT_MS = 7_500;
const MIN_OPEN_DESTINATION_TIMEOUT_MS = 1_000;
const MAX_OPEN_DESTINATION_TIMEOUT_MS = 60_000;

export type OpenDestination =
  | "default"
  | "replace"
  | "first-unlocked"
  | "split-right"
  | "split-down";

export interface OpenDestinationTarget {
  blockId: string;
  title: string;
  fragmentId?: string;
}

export interface OpenDestinationChooserState {
  active: boolean;
  loading: boolean;
  target: OpenDestinationTarget | null;
  status: string;
}

export interface OpenDestinationChooserEffects {
  beforeOpen?(target: OpenDestinationTarget, destination: OpenDestination): void | Promise<void>;
  replace(target: OpenDestinationTarget): void | Promise<void>;
  openFirstUnlocked(target: OpenDestinationTarget): boolean | Promise<boolean>;
  openNewDetail(
    target: OpenDestinationTarget,
    direction: "right" | "down",
  ): void | Promise<void>;
  opened?(target: OpenDestinationTarget, destination: OpenDestination): void | Promise<void>;
  invalidate(): void;
}

export interface OpenDestinationScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface OpenDestinationChooserOptions {
  timeoutMs?: number;
  scheduler?: OpenDestinationScheduler;
  state?: OpenDestinationChooserState;
  actionKeymap?: OutlinerActionKeymap;
}

const defaultScheduler: OpenDestinationScheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function openDestinationTimeoutFromEnvironment(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_OPEN_DESTINATION_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) &&
      parsed >= MIN_OPEN_DESTINATION_TIMEOUT_MS &&
      parsed <= MAX_OPEN_DESTINATION_TIMEOUT_MS
    ? parsed
    : DEFAULT_OPEN_DESTINATION_TIMEOUT_MS;
}

export function createOpenDestinationChooserState(): OpenDestinationChooserState {
  return { active: false, loading: false, target: null, status: "" };
}

export function openDestinationChooserHelp(
  actionKeymap: OutlinerActionKeymap = DEFAULT_OUTLINER_ACTION_KEYMAP,
): string {
  const right = displayActionChord(actionKeymap.primaryBinding("detail.pane.right"));
  const down = displayActionChord(actionKeymap.primaryBinding("detail.pane.below"));
  return `⇧R replace here  f first unlocked  ${right}/r split right  ${down}/d split down  Esc close  Enter default`;
}

export class OpenDestinationChooser {
  readonly state: OpenDestinationChooserState;
  private readonly timeoutMs: number;
  private readonly scheduler: OpenDestinationScheduler;
  private readonly actionKeymap: OutlinerActionKeymap;
  private timer: unknown;
  private targetGeneration = 0;
  private timerGeneration = 0;

  constructor(
    private readonly effects: OpenDestinationChooserEffects,
    options: OpenDestinationChooserOptions = {},
  ) {
    this.state = options.state ?? createOpenDestinationChooserState();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OPEN_DESTINATION_TIMEOUT_MS;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.actionKeymap = options.actionKeymap ?? DEFAULT_OUTLINER_ACTION_KEYMAP;
  }

  open(target: OpenDestinationTarget): void {
    this.clearTimer();
    this.targetGeneration += 1;
    this.state.active = true;
    this.state.loading = false;
    this.state.target = target;
    this.state.status = "Choose destination · default: first unlocked, otherwise split right";
    this.scheduleDismissal();
    this.effects.invalidate();
  }
  helpText(): string {
    return openDestinationChooserHelp(this.actionKeymap);
  }

  async handleKeypress(str: string, key: TerminalKey): Promise<boolean> {
    if (!this.state.active) return false;
    if (key.name === "escape") {
      this.dismiss();
      return true;
    }
    if (this.state.loading) return true;
    this.scheduleDismissal();
    if (key.name === "return") {
      await this.openDestination("default");
      return true;
    }
    const mapped = this.actionKeymap.canonicalize("detail", "destination", str, key);
    const destination = mapped.actionId === "detail.pane.right"
      ? "split-right"
      : mapped.actionId === "detail.pane.below"
      ? "split-down"
      : str === "R"
      ? "replace"
      : str.toLowerCase() === "f"
      ? "first-unlocked"
      : str.toLowerCase() === "r"
      ? "split-right"
      : str.toLowerCase() === "d"
      ? "split-down"
      : null;
    if (destination) await this.openDestination(destination);
    return true;
  }

  dismiss(): void {
    if (!this.state.active && !this.state.target) return;
    this.clearTimer();
    this.targetGeneration += 1;
    this.state.active = false;
    this.state.loading = false;
    this.state.target = null;
    this.state.status = "";
    this.effects.invalidate();
  }

  dispose(): void {
    this.clearTimer();
    this.targetGeneration += 1;
    this.state.active = false;
    this.state.loading = false;
    this.state.target = null;
    this.state.status = "";
  }

  private async openDestination(destination: OpenDestination): Promise<void> {
    const target = this.state.target;
    if (!target) return;
    this.clearTimer();
    const operationGeneration = this.targetGeneration;
    const isCurrent = (): boolean =>
      operationGeneration === this.targetGeneration &&
      this.state.active &&
      this.state.target === target;
    this.state.loading = true;
    this.state.status = destination === "replace"
      ? `Replacing this Detail with ${target.title}…`
      : destination === "first-unlocked"
      ? `Opening ${target.title} in the first unlocked Detail…`
      : destination === "split-down"
      ? `Opening ${target.title} below…`
      : destination === "split-right"
      ? `Opening ${target.title} to the right…`
      : `Opening ${target.title}…`;
    this.effects.invalidate();
    try {
      await this.effects.beforeOpen?.(target, destination);
      if (!isCurrent()) {
        this.effects.invalidate();
        return;
      }
      if (destination === "replace") {
        await this.effects.replace(target);
      } else if (destination === "first-unlocked") {
        const opened = await this.effects.openFirstUnlocked(target);
        if (!isCurrent()) {
          this.effects.invalidate();
          return;
        }
        if (!opened) {
          this.state.loading = false;
          this.state.status = "No unlocked Detail is available · choose replace or a split direction";
          this.scheduleDismissal();
          this.effects.invalidate();
          return;
        }
      } else if (destination === "split-down") {
        await this.effects.openNewDetail(target, "down");
      } else if (destination === "split-right") {
        await this.effects.openNewDetail(target, "right");
      } else {
        const opened = await this.effects.openFirstUnlocked(target);
        if (!isCurrent()) {
          this.effects.invalidate();
          return;
        }
        if (!opened) await this.effects.openNewDetail(target, "right");
      }
      if (!isCurrent()) {
        this.effects.invalidate();
        return;
      }
      await this.effects.opened?.(target, destination);
      if (isCurrent()) this.dismiss();
    } catch (error) {
      if (!isCurrent()) {
        this.effects.invalidate();
        return;
      }
      this.state.loading = false;
      this.state.status = `Open failed: ${error instanceof Error ? error.message : String(error)}`;
      this.scheduleDismissal();
      this.effects.invalidate();
    }
  }

  private scheduleDismissal(): void {
    this.clearTimer();
    if (!this.state.active) return;
    const generation = ++this.timerGeneration;
    this.timer = this.scheduler.set(() => {
      if (generation !== this.timerGeneration || !this.state.active) return;
      this.timer = undefined;
      this.targetGeneration += 1;
      this.state.active = false;
      this.state.loading = false;
      this.state.target = null;
      this.state.status = "";
      this.effects.invalidate();
    }, this.timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.scheduler.clear(this.timer);
    this.timerGeneration += 1;
    this.timer = undefined;
  }
}
