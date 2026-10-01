import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { Type, IsSchema } from "typebox";
import { Parse } from "typebox/value";
import { Compile } from "typebox/compile";
import { ResourceCatalogError } from "./resources";
import {
  CredentialSchema,
  ExtensionLoadError,
  MAX_DEADLINE_MS,
  readExtensionFolder,
  type ExtensionHandler,
  type ExtensionOrigin,
  type LoadedExtension,
} from "./extension-manifest";

const Credential = CredentialSchema;
const Installation = Type.Object(
  {
    manifest: Type.String({ minLength: 1 }),
    enabled: Type.Boolean(),
    config: Type.Record(Type.String(), Type.Unknown()),
    credentials: Type.Record(Type.String(), Credential, { maxProperties: 16 }),
  },
  { additionalProperties: false },
);
const Registry = Type.Object(
  {
    version: Type.Literal(1),
    providers: Type.Record(Type.String(), Installation),
  },
  { additionalProperties: false },
);
export type { ExtensionHandler };
export interface ExtensionSourceConfig { readonly origin: string; readonly project: string }
/** What the service knows of an installed extension without running it. */
export interface ExtensionDescription {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly contract: 1 | 2;
  readonly directory: string;
  readonly handlers: readonly ExtensionHandler[];
  readonly sources: readonly ExtensionSourceConfig[];
  /** Which folder it came from (contract 2). */
  readonly origin?: ExtensionOrigin;
}
const Manifest = Type.Object(
  {
    contract: Type.Literal(1),
    id: Type.String({ pattern: "^[a-z0-9][a-z0-9.-]{0,99}$" }),
    version: Type.Integer({ minimum: 1 }),
    command: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 20,
    }),
    configSchema: Type.Unknown(),
  },
  { additionalProperties: false },
);
const MAX_CONFIG_BYTES = 64 * 1024,
  MAX_REQUEST_BYTES = 256 * 1024,
  MAX_RESULT_BYTES = 1024 * 1024;
const ERROR_MESSAGES: Record<string, string> = {
  "credentials-missing": "credentials are unavailable",
  unauthorized: "authentication failed (401)",
  forbidden:
    "access denied (403); check authentication mode and project access",
  "not-found": "item was not found",
  "outside-source": "item is outside the configured Source",
  "invalid-config": "configuration is invalid",
  "invalid-response": "provider returned an invalid response",
  network: "provider request failed",
  timeout: "provider request timed out",
  "invalid-query": "the provider refused the search (400)",
  "rate-limited": "the provider is limiting requests (429); fetching again later",
};
/** The user extensions folder on the service host (wave B also watches the outline's own). */
export function userExtensionsDirectory(): string {
  return process.env.OUTLINER_EXTENSIONS_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi-herdr-outliner", "extensions");
}
/**
 * Whether this process reads the user folder. A service pointed at another
 * legacy registry (a scratch or test service) reads it only when pointed at
 * a folder too, so it never picks up the owner's real extensions and secrets.
 */
export function userExtensionsFolderInUse(): boolean {
  return !(process.env.OUTLINER_RESOURCE_EXTENSIONS !== undefined && process.env.OUTLINER_EXTENSIONS_DIR === undefined);
}
function label(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
function failure(message: string): ResourceCatalogError {
  return new ResourceCatalogError(
    "source-unavailable",
    `Resource extension: ${message}`,
  );
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
async function boundedFile(path: string): Promise<string> {
  const file = Bun.file(path);
  if (file.size > MAX_CONFIG_BYTES)
    throw failure("configuration exceeds 64 KiB");
  return file.text();
}

/** Process isolation provides deadlines and fresh code, not a sandbox. Only trusted installs may run. */
async function runCommand(
  command: readonly string[],
  cwd: string,
  input: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  if (Buffer.byteLength(input) > MAX_REQUEST_BYTES)
    throw failure("request exceeds 256 KiB");
  if (signal?.aborted)
    throw failure(
      signal?.reason instanceof Error && signal.reason.name === "TimeoutError"
        ? "request timed out"
        : "request cancelled",
    );
  return new Promise((accept, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    const chunks: Buffer[] = [];
    let length = 0,
      settled = false;
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      kill();
      if (error) reject(error);
      else accept(Buffer.concat(chunks).toString("utf8"));
    };
    const abort = () =>
      finish(
        failure(
          signal?.reason instanceof Error &&
            signal.reason.name === "TimeoutError"
            ? "request timed out"
            : "request cancelled",
        ),
      );
    const timer = setTimeout(
      () => finish(failure("request timed out")),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () =>
      finish(failure("command could not start; check the installed manifest")),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_RESULT_BYTES) finish(failure("response exceeds 1 MiB"));
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : failure("command failed; check extension configuration"),
      ),
    );
    child.stdin.end(input);
  });
}

function scrubCredentials(
  value: unknown,
  secrets: readonly string[],
  depth = 0,
): unknown {
  if (depth > 64) throw failure("response exceeds nesting limit");
  if (typeof value === "string") {
    for (const secret of secrets)
      for (const token of [secret, Buffer.from(secret).toString("base64")])
        value = (value as string).split(token).join("[redacted]");
    return value;
  }
  if (Array.isArray(value))
    return value.map((item) => scrubCredentials(item, secrets, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        scrubCredentials(key, secrets, depth + 1),
        scrubCredentials(item, secrets, depth + 1),
      ]),
    );
  return value;
}

/** The old single-file registry (`resource-extensions.json`); `OUTLINER_RESOURCE_EXTENSIONS` moves it. */
export function defaultRegistryPath(): string {
  return process.env.OUTLINER_RESOURCE_EXTENSIONS ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi-herdr-outliner", "resource-extensions.json");
}

export interface ExtensionResult {
  readonly value: unknown;
  readonly adapter: { id: string; version: number };
  readonly manifestHash: string;
}
export class ResourceExtensionRuntime {
  constructor(
    readonly configPath = defaultRegistryPath(),
    readonly timeoutMs = 15_000,
    folders?: readonly string[],
  ) {
    const isolated = !userExtensionsFolderInUse();
    this.folders = folders ?? ((configPath === undefined || configPath === defaultRegistryPath()) && !isolated ? [userExtensionsDirectory()] : []);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw failure("deadline must be 1..60000 milliseconds");
  }
  /** Where contract 2 folders are looked up, nearest first (the outline's, then the user's). Empty: only the legacy registry. */
  folders: readonly string[];
  /**
   * Looks extensions up in these folders from now on, nearest first. The
   * service passes its registry's roots (`src/extension-registry.ts`), so a
   * folder in the outline's `extensions/` runs like one in the user folder.
   */
  useFolders(folders: readonly string[]): void {
    this.folders = [...folders];
  }
  private async folderInstallation(provider: string) {
    for (const root of this.folders) {
      const directory = join(root, provider);
      if (!(await Bun.file(join(directory, "extension.json")).exists())) continue;
      let loaded;
      try {
        loaded = await readExtensionFolder(directory, root === userExtensionsDirectory() ? "user" : "outline");
      } catch (error) {
        // The same words `outliner ext ls` and `extensions.list` show, naming the file and the field.
        throw failure(`${provider} extension in ${directory} is invalid: ${error instanceof ExtensionLoadError ? error.message : "it could not be read"}`);
      }
      if (!loaded.enabled) throw failure(`${loaded.name} is disabled in ${join(directory, "config.json")}`);
      if (!loaded.command) throw failure(`${loaded.name} runs no code (its extension.json has no run)`);
      return {
        install: { manifest: join(directory, "extension.json"), enabled: true, config: loaded.config, credentials: loaded.credentials },
        manifest: { contract: 2 as const, id: loaded.id, version: loaded.version, command: loaded.command, name: loaded.name },
        description: {
          id: loaded.id, name: loaded.name, version: loaded.version, contract: 2 as const, directory,
          handlers: loaded.manifest.handlers ?? [], sources: loaded.sources, origin: loaded.origin,
        } satisfies ExtensionDescription,
        directory,
        stamp: loaded.stamp,
        loaded,
      };
    }
    return null;
  }
  /** The installed extension for a provider key, without running it; null when none is installed. */
  async describe(provider: string): Promise<ExtensionDescription | null> {
    const folder = await this.folderInstallation(provider);
    if (folder) return folder.description;
    try {
      const legacy = await this.installation(provider);
      return {
        id: legacy.manifest.id, name: label(provider), version: legacy.manifest.version, contract: 1,
        directory: legacy.directory, handlers: [{ key: provider, kind: "resource", effects: "read" }], sources: [],
      };
    } catch {
      return null;
    }
  }
  private async installation(provider: string) {
    const folder = await this.folderInstallation(provider);
    if (folder) return folder;
    try {
      const raw = await boundedFile(this.configPath);
      const registry = Parse(Registry, JSON.parse(raw));
      const install = registry.providers[provider];
      if (!install || !install.enabled)
        throw failure(
          `no ${label(provider)} extension on this machine: ${provider} is not installed or is disabled (add ${join(userExtensionsDirectory(), provider)} or configure resource-extensions.json)`,
        );
      if (!isAbsolute(install.manifest))
        throw failure("manifest path must be absolute");
      const manifestRaw = await boundedFile(install.manifest);
      const manifest = Parse(Manifest, JSON.parse(manifestRaw));
      if (
        !IsSchema(manifest.configSchema) ||
        !Compile(manifest.configSchema).Check(install.config)
      )
        throw failure("extension configuration does not match its schema");
      return {
        install,
        manifest: { ...manifest, name: label(provider) },
        directory: dirname(install.manifest),
        stamp: hash(JSON.stringify(install) + manifestRaw),
      };
    } catch (error) {
      if (error instanceof ResourceCatalogError) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        throw failure(`no ${label(provider)} extension on this machine (add ${join(userExtensionsDirectory(), provider)})`);
      throw failure(
        `${provider} installation is unavailable or invalid; check manifest contract 1 and configuration`,
      );
    }
  }
  /**
   * One call: one process, one JSON request on stdin, one response on stdout.
   * `resolve`, `read` and `changed` are the Resource operations (contract 1);
   * `run` (an output or component handler) and `act` (an action) are contract
   * 2's. `deadlineMs` is the manifest's (at most 5 minutes); the runtime's own
   * deadline otherwise.
   */
  async invoke(
    provider: string,
    operation: "resolve" | "read" | "changed" | "run" | "act",
    input: unknown,
    signal?: AbortSignal,
    deadlineMs?: number,
  ): Promise<ExtensionResult> {
    return this.invokeInstalled(provider, await this.installation(provider), operation, input, signal, deadlineMs, true);
  }

  /**
   * One call to the version the registry serves (`src/extension-registry.ts`):
   * a folder whose manifest broke since keeps running its last good manifest
   * and config, as `extensions.list` says. Code is still read fresh.
   */
  async invokeLoaded(
    extension: LoadedExtension,
    operation: "read" | "run" | "act" | "respond",
    input: unknown,
    deadlineMs?: number,
  ): Promise<ExtensionResult> {
    if (!extension.command) throw failure(`${extension.name} runs no code (its extension.json has no run)`);
    if (!extension.enabled) throw failure(`${extension.name} is disabled in ${join(extension.directory, "config.json")}`);
    return this.invokeInstalled(extension.id, {
      install: { manifest: join(extension.directory, "extension.json"), enabled: true, config: extension.config, credentials: extension.credentials },
      manifest: { contract: 2 as const, id: extension.id, version: extension.version, command: extension.command, name: extension.name },
      directory: extension.directory,
      stamp: extension.stamp,
    }, operation, input, undefined, deadlineMs, false);
  }

  private async invokeInstalled(
    provider: string,
    loaded: {
      install: { manifest: string; enabled: boolean; config: Record<string, unknown>; credentials: Record<string, import("typebox").Static<typeof Credential> | { file: string }> };
      manifest: { contract: 1 | 2; id: string; version: number; command: readonly string[]; name: string };
      directory: string;
      stamp: string;
    },
    operation: "resolve" | "read" | "changed" | "run" | "act" | "respond",
    input: unknown,
    signal: AbortSignal | undefined,
    deadlineMs: number | undefined,
    recheck: boolean,
  ): Promise<ExtensionResult> {
    const deadline = Math.min(MAX_DEADLINE_MS, deadlineMs ?? this.timeoutMs);
    signal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(deadline),
    ]);
    const secrets: Record<string, string> = {};
    for (const [name, reference] of Object.entries(
      loaded.install.credentials,
    )) {
      let value: string | undefined;
      if ("env" in reference) value = process.env[reference.env];
      else if ("file" in reference) {
        try {
          const file = Bun.file(reference.file.replace(/^~(?=\/)/, homedir()));
          const mode = (await file.stat()).mode & 0o077;
          if (mode === 0 && file.size <= 16 * 1024) value = (await file.text()).trim();
        } catch {}
      }
      else if (process.platform === "darwin") {
        const command = [
          "/usr/bin/security",
          "find-generic-password",
          "-s",
          reference.keychainService,
          ...(reference.account ? ["-a", reference.account] : []),
          "-w",
        ];
        try {
          value = (
            await runCommand(
              command,
              loaded.directory,
              "",
              Math.min(this.timeoutMs, 3000),
              signal,
            )
          ).trim();
        } catch {
          throw failure(`no ${loaded.manifest.name} credentials on this machine (${provider} credentials are unavailable)`);
        }
      }
      if (!value?.trim())
        throw failure(`no ${loaded.manifest.name} credentials on this machine (${provider} credentials are unavailable)`);
      secrets[name] = value;
    }
    const request = JSON.stringify({
      contract: loaded.manifest.contract,
      operation,
      input,
      config: loaded.install.config,
      credentials: secrets,
    });
    const output = await runCommand(
      loaded.manifest.command,
      loaded.directory,
      request,
      deadline,
      signal,
    );
    // Disable/config changes during a call invalidate its result before the catalog can commit it.
    if (recheck && (await this.installation(provider)).stamp !== loaded.stamp)
      throw failure("configuration changed during request; refresh to retry");
    let envelope: unknown;
    try {
      envelope = JSON.parse(output);
    } catch {
      throw failure("command returned invalid JSON");
    }
    let parsed;
    try {
      parsed = Parse(
        Type.Union([
          Type.Object(
            { ok: Type.Literal(true), value: Type.Unknown() },
            { additionalProperties: false },
          ),
          Type.Object(
            { ok: Type.Literal(false), code: Type.String() },
            { additionalProperties: false },
          ),
        ]),
        envelope,
      );
    } catch {
      throw failure("command returned an invalid response envelope");
    }
    if (!parsed.ok)
      throw failure(parsed.code === "credentials-missing"
        ? `no ${loaded.manifest.name} credentials on this machine`
        : ERROR_MESSAGES[parsed.code] ?? "provider operation failed");
    return {
      value: scrubCredentials(parsed.value, Object.values(secrets)),
      adapter: { id: loaded.manifest.id, version: loaded.manifest.version },
      manifestHash: loaded.stamp,
    };
  }
}
