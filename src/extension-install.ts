import { chmod, cp, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { userExtensionsDirectory } from "./resource-extensions";

/**
 * `outliner ext add|ls` (wave A): install a built-in extension into the user
 * folder the service reads (`~/.config/pi-herdr-outliner/extensions/<id>`).
 * The repo's `extensions/` holds forkable built-ins; they are copied, never
 * run in place. A first install seeds `config.json` from an existing
 * `resource-extensions.json` entry, so a laptop that already reads Jira keeps
 * its email and keychain reference. Wave B adds the watcher, outline folders,
 * `doctor`, `migrate` and `rm`.
 */

const BUILT_INS = join(import.meta.dir, "..", "extensions");

function legacyRegistryPath(): string {
  return process.env.OUTLINER_RESOURCE_EXTENSIONS ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi-herdr-outliner", "resource-extensions.json");
}

async function legacyEntry(id: string): Promise<{ config: Record<string, unknown>; credentials: Record<string, unknown> } | null> {
  try {
    const registry = await Bun.file(legacyRegistryPath()).json() as { providers?: Record<string, { config?: Record<string, unknown>; credentials?: Record<string, unknown> }> };
    const entry = registry.providers?.[id];
    return entry ? { config: entry.config ?? {}, credentials: entry.credentials ?? {} } : null;
  } catch {
    return null;
  }
}

export async function addExtension(id: string, options: { from?: string } = {}): Promise<string[]> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error("ext add expects an extension name such as jira");
  const source = options.from ?? join(BUILT_INS, id);
  if (!existsSync(join(source, "extension.json"))) throw new Error(`No extension.json in ${source}`);
  const target = join(userExtensionsDirectory(), id);
  const lines: string[] = [];
  const updating = existsSync(join(target, "extension.json"));
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source)) {
    if (entry === "config.json") continue;
    const staged = join(target, `.${entry}.new`);
    await cp(join(source, entry), staged, { recursive: true });
    await rename(staged, join(target, entry));
  }
  lines.push(`${updating ? "updated" : "installed"} ${id} in ${target}`);
  const configPath = join(target, "config.json");
  if (existsSync(configPath)) {
    lines.push(`kept ${configPath}`);
  } else {
    const legacy = await legacyEntry(id);
    const example = existsSync(join(source, "config.example.json"))
      ? await Bun.file(join(source, "config.example.json")).json() as Record<string, unknown>
      : {};
    const config = legacy ? { config: legacy.config, secrets: legacy.credentials } : example;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await chmod(configPath, 0o600);
    lines.push(legacy
      ? `wrote ${configPath} from ${legacyRegistryPath()} (its config and credential references; no secret values)`
      : `wrote ${configPath} from the example: edit it (email, keychain or env token, sources) before the first fetch`);
  }
  lines.push("The service reads it on the next fetch; no restart is needed for code or config changes.");
  return lines;
}

export async function listExtensions(): Promise<string[]> {
  const root = userExtensionsDirectory();
  const names = existsSync(root) ? (await readdir(root)).filter((name) => existsSync(join(root, name, "extension.json"))) : [];
  const lines = names.length ? names.map((name) => `${name}\t${join(root, name)}`) : [`no extensions in ${root}`];
  if (existsSync(legacyRegistryPath())) lines.push(`legacy registry: ${legacyRegistryPath()} (used when no folder has the extension)`);
  return lines;
}

export async function runExtCommand(args: readonly string[]): Promise<number> {
  const [operation, name, ...rest] = args;
  try {
    if (operation === "add" && name) {
      const from = rest[0] === "--from" ? rest[1] : undefined;
      for (const line of await addExtension(name, from ? { from } : {})) console.log(line);
      return 0;
    }
    if (operation === "ls" || operation === "list") {
      for (const line of await listExtensions()) console.log(line);
      return 0;
    }
    console.log("usage: outliner ext add <name> [--from <folder>] | ext ls\n  Extensions are trusted code, not a sandbox: they run as the service user.");
    return operation === undefined || operation === "help" ? 0 : 1;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
