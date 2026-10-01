import { existsSync, readdirSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PRIMITIVE_TYPES, RENDER_TARGETS } from "./component-primitives";
import {
  ExtensionLoadError,
  readExtensionFolder,
  type ExtensionAction,
  type ExtensionHandler,
  type ExtensionOrigin,
  type ExtensionTile,
  type LoadedExtension,
} from "./extension-manifest";
import { userExtensionsDirectory, userExtensionsFolderInUse } from "./resource-extensions";

/**
 * The extensions an outline's service has, derived from folders (wave B of
 * the extension design, PIE-507).
 *
 * - **Folders are the install.** `<outline root>/extensions/<id>/` and
 *   `~/.config/pi-herdr-outliner/extensions/<id>/` (`OUTLINER_EXTENSIONS_DIR`).
 *   The outline's copy of an id wins; the other is listed as `shadowed`.
 * - **Derived, never patched.** Every reload builds the whole registry again
 *   from the folders and publishes it in one step (`generation` goes up and
 *   `onChange` fires), so removing a folder removes everything it declared.
 * - **A failed reload keeps the last good copy.** A folder that stops loading
 *   (bad JSON, a schema error) keeps serving the version that last loaded, and
 *   says why (`state: "failed"`, `error`). One with no good copy serves nothing.
 * - **Watched.** A recursive watch on each folder, 300 ms of quiet, then a
 *   reload; a folder that doesn't exist yet is watched for from its nearest
 *   parent. Code needs no reload at all: each call starts a fresh process.
 *
 * The repo's own `extensions/` folder holds the forkable built-ins: it is
 * never loaded in place, even when an outline's root is the repo.
 */

export interface ExtensionRoot {
  readonly path: string;
  readonly origin: ExtensionOrigin;
}

/** The repo's built-ins (`outliner ext add <name>` copies one out). */
export const BUILT_IN_EXTENSIONS = resolve(import.meta.dir, "..", "extensions");

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

/** The folders an outline's service reads, nearest first. */
export function extensionRoots(workspaceRoot: string | undefined): ExtensionRoot[] {
  const roots: ExtensionRoot[] = [];
  if (workspaceRoot) {
    const outline = join(workspaceRoot, "extensions");
    if (!samePath(outline, BUILT_IN_EXTENSIONS)) roots.push({ path: outline, origin: "outline" });
  }
  const user = userExtensionsDirectory();
  // One folder serving as both (a service whose user folder is its outline's) is read once, as the outline's.
  if (userExtensionsFolderInUse() && !roots.some((root) => samePath(root.path, user))) roots.push({ path: user, origin: "user" });
  return roots;
}

export type ExtensionState = "active" | "failed" | "disabled" | "shadowed";

/** One handler as clients see it. */
export interface ExtensionHandlerEntry {
  readonly key: string;
  readonly kind: ExtensionHandler["kind"];
  readonly effects: ExtensionHandler["effects"];
  readonly description?: string;
  readonly argument?: ExtensionHandler["argument"];
  readonly options: NonNullable<ExtensionHandler["options"]>;
  readonly staleAfter?: string;
}

/** One action as clients bind it: the door's `ActionDef` id is `ext.<extension>.<action>`. */
export interface ExtensionActionEntry extends ExtensionAction {
  /** `ext.<extension>.<action>`. */
  readonly name: string;
  /** Provided by the service for every output and component handler, not by the extension's code. */
  readonly builtIn?: true;
}

/**
 * A tile kind, in the form the door's open tile-kind registry consumes
 * (PIE-505): everything it needs to make, bind and save a tile of this kind.
 */
export interface ExtensionTileKind {
  /** `<extension>.<kind>`: unique across extensions; the door never switches on it. */
  readonly kind: string;
  readonly extension: string;
  readonly name: string;
  readonly description?: string;
  /** What to run in the tile's pty, and where. Only on `host`: a door elsewhere shows it as unavailable. */
  readonly command: readonly string[];
  readonly cwd: string;
  readonly host: string;
  /** Set for the program; the door adds its own `EP0CH_CONTROL`. */
  readonly env: Readonly<Record<string, string>>;
  readonly actions: readonly ExtensionActionEntry[];
  readonly policy: NonNullable<ExtensionTile["policy"]>;
  readonly accepts: readonly string[];
  readonly args: NonNullable<ExtensionTile["args"]>;
  /** A tile saves its kind and its args in a screen; nothing else. */
  readonly save: "args";
}

export interface ExtensionEntry {
  readonly id: string;
  readonly name?: string;
  readonly version?: number;
  readonly description?: string;
  readonly origin: ExtensionOrigin;
  readonly directory: string;
  readonly state: ExtensionState;
  /** Why it didn't load (a failed copy keeps serving its last good version). */
  readonly error?: string;
  /** When the version it serves was loaded. */
  readonly loadedAt?: string;
  readonly runsCode: boolean;
  readonly handlers: readonly ExtensionHandlerEntry[];
  readonly actions: readonly ExtensionActionEntry[];
  readonly tiles: readonly ExtensionTileKind[];
}

export interface ExtensionsListResult {
  /** Goes up with every reload that changed anything. */
  readonly generation: number;
  readonly roots: readonly (ExtensionRoot & { readonly exists: boolean })[];
  readonly extensions: readonly ExtensionEntry[];
  /** Every active tile kind, for the door's registry. */
  readonly tileKinds: readonly ExtensionTileKind[];
  /** The shared component primitives every client draws (src/component-primitives.ts). */
  readonly primitives: readonly string[];
  /** The render targets a component can be asked for. */
  readonly targets: readonly string[];
  /** "Trusted code, not a sandbox": extensions run as the service user. */
  readonly trust: string;
}

/** A handler key bound to the extension that serves it. */
export interface BoundHandler {
  readonly extension: LoadedExtension;
  readonly handler: ExtensionHandler;
}

interface Slot {
  readonly id: string;
  readonly origin: ExtensionOrigin;
  readonly directory: string;
  readonly state: ExtensionState;
  readonly error?: string;
  /** The version served: the one just read, or the last good one when this read failed. */
  readonly serving?: LoadedExtension;
  readonly loadedAt?: string;
}

const QUIET_MS = 300;
const TRUST = "Extensions are trusted code, not a sandbox: they run as the service user.";

/** Built-in actions every output and component handler has. */
function builtInActions(extension: LoadedExtension): ExtensionActionEntry[] {
  return (extension.manifest.handlers ?? [])
    .filter((handler) => handler.kind === "output" || handler.kind === "component")
    .map((handler) => ({
      id: "keep", name: `ext.${extension.id}.keep`, label: "Keep as blocks", on: `handler:${handler.key}`,
      description: "Writes this output under the block as real blocks, attributed to the extension", effects: "write" as const,
      builtIn: true as const,
    }))
    .filter((action, index, all) => all.findIndex((other) => other.id === action.id) === index);
}

export interface ExtensionRegistryOptions {
  readonly roots: readonly ExtensionRoot[];
  /** Called after a reload that changed what the registry serves. */
  readonly onChange?: (generation: number) => void;
  /** The outline's name, given to tile programs so the outliner CLI reaches the right outline. */
  readonly outlineName?: () => string | undefined;
  /** The socket a tile program reaches the service on. */
  readonly socketPath?: () => string | undefined;
  readonly quietMs?: number;
}

export class ExtensionRegistry {
  private slots: Slot[] = [];
  private lastGood = new Map<string, { extension: LoadedExtension; loadedAt: string }>();
  private bound = new Map<string, BoundHandler>();
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loading: Promise<void> | null = null;
  private again = false;
  private signature = "";
  private watching = false;
  generation = 0;

  constructor(private readonly options: ExtensionRegistryOptions) {}

  get roots(): readonly ExtensionRoot[] {
    return this.options.roots;
  }

  /** Reads every folder again and publishes the result in one step. Concurrent calls share a pass. */
  reload(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = (async () => {
      do {
        this.again = false;
        await this.loadOnce();
      } while (this.again);
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async loadOnce(): Promise<void> {
    const slots: Slot[] = [];
    const seen = new Set<string>();
    const now = new Date().toISOString();
    for (const root of this.options.roots) {
      let names: string[] = [];
      try {
        names = readdirSync(root.path).filter((name) => !name.startsWith(".")).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const directory = join(root.path, name);
        try {
          if (!statSync(directory).isDirectory()) continue;
        } catch {
          continue;
        }
        if (!existsSync(join(directory, "extension.json"))) continue;
        if (seen.has(name)) {
          slots.push({ id: name, origin: root.origin, directory, state: "shadowed",
            error: `the outline's own ${name} is used instead` });
          continue;
        }
        seen.add(name);
        const key = `${name}\0${directory}`;
        try {
          const extension = await readExtensionFolder(directory, root.origin);
          const previous = this.lastGood.get(key);
          const loadedAt = previous && previous.extension.stamp === extension.stamp ? previous.loadedAt : now;
          this.lastGood.set(key, { extension, loadedAt });
          slots.push({ id: name, origin: root.origin, directory, state: extension.enabled ? "active" : "disabled", serving: extension, loadedAt });
        } catch (error) {
          const message = error instanceof ExtensionLoadError ? error.message : `the folder could not be read (${error instanceof Error ? error.message : String(error)})`;
          const previous = this.lastGood.get(key);
          slots.push({
            id: name, origin: root.origin, directory, state: "failed",
            error: previous ? `${message}; still serving version ${previous.extension.version} loaded ${previous.loadedAt}` : message,
            ...(previous ? { serving: previous.extension, loadedAt: previous.loadedAt } : {}),
          });
        }
      }
    }
    // A folder that is gone takes its last good copy with it.
    const present = new Set(slots.map((slot) => `${slot.id}\0${slot.directory}`));
    for (const key of [...this.lastGood.keys()]) if (!present.has(key)) this.lastGood.delete(key);
    // Handler keys: the outline's extensions first, then by id; a key taken twice is the second one's error.
    const bound = new Map<string, BoundHandler>();
    const conflicts = new Map<string, string>();
    for (const slot of slots) {
      const extension = slot.serving;
      if (!extension || (slot.state !== "active" && slot.state !== "failed")) continue;
      for (const handler of extension.manifest.handlers ?? []) {
        const taken = bound.get(handler.key);
        if (taken) {
          conflicts.set(slot.id, `handler ${handler.key}:: is already served by ${taken.extension.id} (${taken.extension.directory})`);
          continue;
        }
        bound.set(handler.key, { extension, handler });
      }
    }
    const resolved = slots.map((slot) => {
      const conflict = conflicts.get(slot.id);
      return conflict ? { ...slot, error: slot.error ? `${slot.error}; ${conflict}` : conflict } : slot;
    });
    const signature = JSON.stringify(resolved.map((slot) => [slot.id, slot.directory, slot.state, slot.error ?? "", slot.serving?.stamp ?? ""]));
    this.slots = resolved;
    this.bound = bound;
    if (signature !== this.signature) {
      this.signature = signature;
      this.generation += 1;
      this.options.onChange?.(this.generation);
    }
    if (this.watching) this.arm();
  }

  /** The handler a `key::` line names, when an active extension serves it (resource handlers excepted: Jira's own path). */
  handler(key: string): BoundHandler | undefined {
    return this.bound.get(key);
  }

  /** Every bound handler key. */
  handlerKeys(): ReadonlySet<string> {
    return new Set(this.bound.keys());
  }

  /** The active (or last good) copy of an extension. */
  extension(id: string): LoadedExtension | undefined {
    const slot = this.slots.find((candidate) => candidate.id === id && candidate.state !== "shadowed");
    return slot && (slot.state === "active" || slot.state === "failed") ? slot.serving : undefined;
  }

  /** An action an extension declares, or the built-in `keep` of its output and component handlers. */
  action(extensionId: string, actionId: string): ExtensionActionEntry | undefined {
    const extension = this.extension(extensionId);
    if (!extension) return undefined;
    return this.actionsOf(extension).find((action) => action.id === actionId);
  }

  private actionsOf(extension: LoadedExtension): ExtensionActionEntry[] {
    const declared = (extension.manifest.actions ?? []).map((action) => ({ ...action, name: `ext.${extension.id}.${action.id}` }));
    return [...declared, ...builtInActions(extension).filter((action) => !declared.some((own) => own.id === action.id))];
  }

  private tilesOf(extension: LoadedExtension): ExtensionTileKind[] {
    const actions = this.actionsOf(extension);
    const outline = this.options.outlineName?.();
    const socket = this.options.socketPath?.();
    return (extension.manifest.tiles ?? []).map((tile) => ({
      kind: `${extension.id}.${tile.kind}`,
      extension: extension.id,
      name: tile.name,
      ...(tile.description ? { description: tile.description } : {}),
      command: tile.run[0] === "bun" ? [process.execPath, ...tile.run.slice(1)] : [...tile.run],
      cwd: extension.directory,
      host: hostname(),
      env: {
        OUTLINER_EXTENSION: extension.id,
        ...(outline ? { OUTLINER_OUTLINE: outline } : {}),
        ...(socket ? { OUTLINER_SOCKET_PATH: socket } : {}),
      },
      actions: (tile.actions ?? []).flatMap((id) => actions.filter((action) => action.id === id)),
      policy: tile.policy ?? {},
      accepts: tile.accepts ?? [],
      args: tile.args ?? {},
      save: "args" as const,
    }));
  }

  /** `extensions.list`: every folder, its state and error, and what it serves. */
  list(): ExtensionsListResult {
    const extensions = this.slots.map((slot): ExtensionEntry => {
      const extension = slot.serving;
      const serving = extension && (slot.state === "active" || slot.state === "failed");
      return {
        id: slot.id,
        ...(extension ? { name: extension.name, version: extension.version } : {}),
        ...(extension?.description ? { description: extension.description } : {}),
        origin: slot.origin,
        directory: slot.directory,
        state: slot.state,
        ...(slot.error ? { error: slot.error } : {}),
        ...(slot.loadedAt ? { loadedAt: slot.loadedAt } : {}),
        runsCode: !!extension?.command || !!extension?.manifest.tiles?.length,
        handlers: serving ? (extension.manifest.handlers ?? [])
          .filter((handler) => this.bound.get(handler.key)?.extension === extension)
          .map((handler) => ({
            key: handler.key, kind: handler.kind, effects: handler.effects,
            ...(handler.description ? { description: handler.description } : {}),
            ...(handler.argument ? { argument: handler.argument } : {}),
            options: handler.options ?? {},
            ...(handler.staleAfter ? { staleAfter: handler.staleAfter } : {}),
          })) : [],
        actions: serving ? this.actionsOf(extension) : [],
        tiles: serving ? this.tilesOf(extension) : [],
      };
    });
    return {
      generation: this.generation,
      roots: this.options.roots.map((root) => ({ ...root, exists: existsSync(root.path) })),
      extensions,
      tileKinds: extensions.flatMap((entry) => entry.tiles),
      primitives: PRIMITIVE_TYPES,
      targets: RENDER_TARGETS,
      trust: TRUST,
    };
  }

  /** Loads now and reloads whenever a folder changes, after `quietMs` of quiet. */
  async watch(): Promise<void> {
    this.watching = true;
    await this.reload();
    this.arm();
  }

  stop(): void {
    this.watching = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  private schedule(): void {
    if (!this.watching) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reload().catch(() => {});
    }, this.options.quietMs ?? QUIET_MS);
    this.timer.unref?.();
  }

  /** Watches each root recursively, or its nearest existing parent until it exists. Re-armed after every reload. */
  private arm(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    for (const root of this.options.roots) {
      let target = root.path;
      let recursive = true;
      while (!existsSync(target)) {
        const parent = dirname(target);
        if (parent === target) break;
        target = parent;
        recursive = false;
      }
      try {
        const watcher = watch(target, { recursive, persistent: false }, () => this.schedule());
        watcher.on("error", () => this.schedule());
        this.watchers.push(watcher);
      } catch {
        // A folder we can't watch is still read on the next reload another root triggers.
      }
    }
  }
}
