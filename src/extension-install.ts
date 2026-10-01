import { chmod, cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ExtensionLoadError, readExtensionFolder } from "./extension-manifest";
import { BUILT_IN_EXTENSIONS, extensionRoots, type ExtensionsListResult } from "./extension-registry";
import { defaultRegistryPath, userExtensionsDirectory, userExtensionsFolderInUse } from "./resource-extensions";

/**
 * `outliner ext ls|add|remove|act`: extension folders from a shell. They are
 * conveniences: copying a folder in or deleting it does the same, because the
 * service watches both folders and reloads (src/extension-registry.ts).
 *
 * - `add <name>` copies a built-in from the repo's `extensions/` (forkable
 *   source, never run in place); `add <path>` copies any folder. Into the user
 *   folder (`~/.config/pi-herdr-outliner/extensions/<id>`) by default, or the
 *   outline's own `extensions/` with `--outline-folder`. A first install seeds
 *   `config.json` (from `config.example.json`, or an old
 *   `resource-extensions.json` entry: references only, never a secret).
 * - `remove <name>` deletes the folder (the user's, or with `--outline-folder`
 *   the outline's). Its records stay as blocks; its lines say no extension
 *   handles them.
 * - `ls` asks the running service (`extensions.list`): each folder's state and
 *   its error; without a service it reads the folders itself.
 * - `act <name> <action> [--block <id>] [--line N] [--arg k=v]…` runs an
 *   action, attributed to the extension.
 */

const BUILT_INS = BUILT_IN_EXTENSIONS;

async function legacyEntry(id: string): Promise<{ config: Record<string, unknown>; credentials: Record<string, unknown> } | null> {
  try {
    const registry = await Bun.file(defaultRegistryPath()).json() as { providers?: Record<string, { config?: Record<string, unknown>; credentials?: Record<string, unknown> }> };
    const entry = registry.providers?.[id];
    return entry ? { config: entry.config ?? {}, credentials: credentialReferences(entry.credentials ?? {}) } : null;
  } catch {
    return null;
  }
}

/**
 * Only references to a secret (`env`, `keychainService` with its `account`,
 * `file`) are copied; anything else, such as a literal value someone put in
 * the old registry, is left out, so `ext add` never writes a secret.
 */
function credentialReferences(credentials: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, reference] of Object.entries(credentials)) {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) continue;
    const fields = reference as Record<string, unknown>;
    const keys = Object.keys(fields).sort().join(",");
    const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 4096;
    if (keys === "env" && typeof fields.env === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(fields.env)) out[name] = { env: fields.env };
    else if ((keys === "keychainService" || keys === "account,keychainService") && text(fields.keychainService) &&
      (fields.account === undefined || typeof fields.account === "string")) out[name] = { ...fields };
    else if (keys === "file" && text(fields.file)) out[name] = { file: fields.file };
  }
  return out;
}

/** Where `add` and `remove` work: the user folder, or the outline's own `extensions/`. */
function targetRoot(outlineFolder: string | undefined): string {
  if (outlineFolder) return join(outlineFolder, "extensions");
  // A scratch or test environment (pointed at another legacy registry, with no folder of its own) never
  // installs into or deletes from the owner's real folder.
  if (!userExtensionsFolderInUse()) {
    throw new Error("This environment reads no user extensions folder (OUTLINER_RESOURCE_EXTENSIONS is set without OUTLINER_EXTENSIONS_DIR): set OUTLINER_EXTENSIONS_DIR or pass --outline-folder");
  }
  return userExtensionsDirectory();
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.startsWith(".") || value.startsWith("~") || (existsSync(value) && statSync(value).isDirectory());
}

/**
 * Copies an extension folder in. `nameOrPath` is a built-in's name or a
 * folder; the folder is checked first, so a broken one is refused with the
 * reason instead of installed.
 */
export async function addExtension(nameOrPath: string, options: { from?: string; outlineFolder?: string } = {}): Promise<string[]> {
  const source = options.from ?? (looksLikePath(nameOrPath) ? resolve(nameOrPath.replace(/^~(?=\/)/, homedir())) : join(BUILT_INS, nameOrPath));
  if (!existsSync(join(source, "extension.json"))) {
    throw new Error(looksLikePath(nameOrPath) || options.from
      ? `No extension.json in ${source}`
      : `No built-in extension ${nameOrPath} (built-ins: ${(await builtIns()).join(", ")}); pass a folder to add your own`);
  }
  let id: string;
  try {
    // The copy keeps the folder's name as its id: check it under that name.
    id = (await readExtensionFolder(source, "user", { checkConfig: false })).id;
  } catch (error) {
    if (error instanceof ExtensionLoadError && /must match the folder's name/.test(error.message)) {
      id = JSON.parse(await Bun.file(join(source, "extension.json")).text()).id;
    } else {
      throw new Error(`${source} isn't an extension the service can load: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error("ext add expects an extension whose id is a name such as jira");
  const root = targetRoot(options.outlineFolder);
  const target = join(root, id);
  if (resolve(source) === resolve(target)) throw new Error(`${source} is already installed there`);
  const lines: string[] = [];
  const updating = existsSync(join(target, "extension.json"));
  await mkdir(target, { recursive: true });
  const entries = (await readdir(source)).filter((entry) => entry !== "config.json" && entry !== "node_modules");
  // An update matches the source: a file the new version no longer has goes (config.json stays).
  // Your own files in an install (dotfiles such as .env or .git, config.json, node_modules) always stay.
  const removed: string[] = [];
  if (updating) {
    for (const entry of await readdir(target)) {
      if (entry.startsWith(".") || entry === "config.json" || entry === "node_modules" || entries.includes(entry)) continue;
      await rm(join(target, entry), { recursive: true, force: true });
      removed.push(entry);
    }
  }
  for (const entry of entries) {
    const staged = join(target, `.${entry}.new`);
    // A stale staged copy from an interrupted run, and a folder in the way of the rename, go first.
    await rm(staged, { recursive: true, force: true });
    await cp(join(source, entry), staged, { recursive: true });
    await rm(join(target, entry), { recursive: true, force: true });
    await rename(staged, join(target, entry));
  }
  lines.push(`${updating ? "updated" : "installed"} ${id} in ${target}`);
  if (removed.length) lines.push(`removed what the new version no longer has: ${removed.join(", ")}`);
  const configPath = join(target, "config.json");
  if (existsSync(configPath)) {
    lines.push(`kept ${configPath}`);
  } else {
    const legacy = await legacyEntry(id);
    const example = existsSync(join(source, "config.example.json"))
      ? await Bun.file(join(source, "config.example.json")).json() as Record<string, unknown>
      : null;
    if (legacy || example) {
      const config = legacy ? { config: legacy.config, secrets: legacy.credentials } : example;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      await chmod(configPath, 0o600);
      lines.push(legacy
        ? `wrote ${configPath} from ${defaultRegistryPath()} (its config and credential references; no secret values)`
        : `wrote ${configPath} from the example: edit it (email, keychain or env token, sources) before the first fetch`);
    }
  }
  lines.push("The service watches the folder: it loads now, with no restart; code changes apply on the next call.");
  return lines;
}

/** Deletes an installed extension's folder. Its records stay as blocks; the service drops what it declared. */
export async function removeExtension(id: string, options: { outlineFolder?: string } = {}): Promise<string[]> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error("ext remove expects an extension name such as horoscope");
  const root = targetRoot(options.outlineFolder);
  const target = join(root, id);
  if (!existsSync(join(target, "extension.json"))) {
    throw new Error(`No extension ${id} in ${root}${options.outlineFolder ? "" : " (an outline's own: --outline-folder <root>)"}`);
  }
  if (existsSync(BUILT_INS) && realpathSync(target).startsWith(`${realpathSync(BUILT_INS)}/`)) throw new Error("That is the repo's built-in source, not an install");
  await rm(target, { recursive: true, force: true });
  return [
    `removed ${target}`,
    "The service drops its handlers, actions and tiles now. Records it wrote stay as blocks; lines that used it say no extension handles them.",
  ];
}

async function builtIns(): Promise<string[]> {
  return existsSync(BUILT_INS) ? (await readdir(BUILT_INS)).filter((name) => existsSync(join(BUILT_INS, name, "extension.json"))).sort() : [];
}

/** `ext ls` from the service's own registry: states, errors and what each serves. */
export function formatExtensionsList(list: ExtensionsListResult): string[] {
  const lines: string[] = [];
  for (const root of list.roots) lines.push(`${root.origin} folder: ${root.path}${root.exists ? "" : " (not created yet)"}`);
  if (!list.extensions.length) lines.push("no extensions installed");
  for (const entry of list.extensions) {
    const what = [
      ...entry.handlers.map((handler) => `${handler.key}:: (${handler.kind}, ${handler.effects})`),
      ...entry.tiles.map((tile) => `tile ${tile.kind}`),
      ...entry.actions.filter((action) => !action.builtIn).map((action) => `action ${action.name}`),
    ];
    lines.push(`${entry.id}\t${entry.state}\t${entry.origin}${entry.version !== undefined ? `\tv${entry.version}` : ""}\t${entry.directory}`);
    if (what.length) lines.push(`  serves ${what.join(", ")}`);
    if (entry.error) lines.push(`  ${entry.state === "shadowed" ? "note" : "error"}: ${entry.error}`);
  }
  lines.push(list.trust);
  return lines;
}

/** `ext ls` without a service: each folder read and checked here. */
export async function listExtensions(): Promise<string[]> {
  const lines: string[] = [];
  for (const root of extensionRoots(undefined)) {
    const names = existsSync(root.path) ? (await readdir(root.path)).filter((name) => existsSync(join(root.path, name, "extension.json"))).sort() : [];
    lines.push(`${root.origin} folder: ${root.path}${existsSync(root.path) ? "" : " (not created yet)"}`);
    if (!names.length) lines.push("no extensions installed");
    for (const name of names) {
      try {
        const loaded = await readExtensionFolder(join(root.path, name), root.origin);
        lines.push(`${name}\t${loaded.enabled ? "ok" : "disabled"}\tv${loaded.version}\t${join(root.path, name)}`);
      } catch (error) {
        lines.push(`${name}\tfailed\t${join(root.path, name)}`, `  error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (existsSync(defaultRegistryPath())) lines.push(`legacy registry: ${defaultRegistryPath()} (used when no folder has the extension)`);
  lines.push(`built-ins (outliner ext add <name>): ${(await builtIns()).join(", ")}`);
  lines.push("Extensions are trusted code, not a sandbox: they run as the service user.");
  return lines;
}

const USAGE = `usage: outliner ext ls
       outliner ext add <name|path> [--outline-folder <outline root>]
       outliner ext remove <name> [--outline-folder <outline root>]
       outliner ext act <name> <action> [--block <id>] [--line N] [--arg key=value]…
  Folders are watched: add and remove apply without a restart.
  Extensions are trusted code, not a sandbox: they run as the service user.`;

interface ExtClient { request<T>(input: Record<string, unknown>): Promise<T> }

/** The running service for this folder or `OUTLINER_OUTLINE`, or null when none answers. */
async function serviceClient(): Promise<ExtClient | null> {
  try {
    const { resolveClientPaths } = await import("./paths");
    const { createOutlinerClient } = await import("./client");
    const client = createOutlinerClient(resolveClientPaths());
    const status = await client.request<{ capabilities?: string[] }>({ action: "ping" });
    // An older service has no extension registry: read the folders here instead.
    if (!status.capabilities?.includes("extensions.list")) return null;
    return client as unknown as ExtClient;
  } catch {
    return null;
  }
}

export async function runExtCommand(args: readonly string[], connect: () => Promise<ExtClient | null> = serviceClient): Promise<number> {
  const [operation, ...rest] = args;
  try {
    if (operation === "add" || operation === "remove" || operation === "rm") {
      const { values, positionals } = parseArgs({
        args: [...rest], allowPositionals: true, strict: true,
        options: { from: { type: "string" }, "outline-folder": { type: "string" } },
      });
      const [name, ...extra] = positionals;
      if (!name || extra.length) throw new Error(USAGE);
      const outlineFolder = values["outline-folder"] ? resolve(values["outline-folder"]) : undefined;
      const lines = operation === "add"
        ? await addExtension(name, { ...(values.from ? { from: values.from } : {}), ...(outlineFolder ? { outlineFolder } : {}) })
        : await removeExtension(name, outlineFolder ? { outlineFolder } : {});
      for (const line of lines) console.log(line);
      // Say what the service made of it when one is running here.
      const client = await connect();
      if (client) {
        const list = await client.request<ExtensionsListResult>({ action: "extensions.list", reload: true });
        const id = operation === "add" ? lines[0]!.split(" ")[1]! : name;
        const entry = list.extensions.find((candidate) => candidate.id === id && candidate.state !== "shadowed");
        if (operation === "add") console.log(entry ? `service: ${id} is ${entry.state}${entry.error ? `: ${entry.error}` : ""}` : `service: ${id} isn't in a folder this outline reads (${list.roots.map((root) => root.path).join(", ")})`);
        else console.log(entry ? `service: still has ${id} (${entry.directory})` : `service: ${id} is gone`);
      }
      return 0;
    }
    if (operation === "ls" || operation === "list") {
      const client = await connect();
      const lines = client ? formatExtensionsList(await client.request<ExtensionsListResult>({ action: "extensions.list", reload: true })) : await listExtensions();
      for (const line of lines) console.log(line);
      return 0;
    }
    if (operation === "act") {
      const { values, positionals } = parseArgs({
        args: [...rest], allowPositionals: true, strict: true,
        options: { block: { type: "string" }, line: { type: "string" }, arg: { type: "string", multiple: true }, json: { type: "boolean" } },
      });
      const [extension, action, ...extra] = positionals;
      if (!extension || !action || extra.length) throw new Error(USAGE);
      const client = await connect();
      if (!client) throw new Error("No outline service answers here (start it, or name one with OUTLINER_OUTLINE)");
      const argsMap = Object.fromEntries((values.arg ?? []).map((pair) => {
        const at = pair.indexOf("=");
        if (at < 1) throw new Error(`--arg takes key=value, not ${pair}`);
        return [pair.slice(0, at), pair.slice(at + 1)];
      }));
      const result = await client.request<{ message?: string; written: string[] }>({
        action: "extensions.act", extension, extensionAction: action,
        ...(values.block ? { blockId: values.block } : {}),
        ...(values.line !== undefined ? { line: Number(values.line) } : {}),
        ...(Object.keys(argsMap).length ? { args: argsMap } : {}),
      });
      if (values.json) console.log(JSON.stringify(result));
      else {
        if (result.message) console.log(result.message);
        for (const id of result.written) console.log(`wrote ${id}`);
      }
      return 0;
    }
    console.log(USAGE);
    return operation === undefined || operation === "help" ? 0 : 1;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
