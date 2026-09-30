import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { Type, IsSchema } from "typebox";
import { Parse } from "typebox/value";
import { Compile } from "typebox/compile";
import { ResourceCatalogError } from "./resources";

const Credential = Type.Union([
  Type.Object(
    { env: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      keychainService: Type.String({ minLength: 1, maxLength: 200 }),
      account: Type.Optional(Type.String({ maxLength: 200 })),
    },
    { additionalProperties: false },
  ),
]);
const FileCredential = Type.Object(
  { file: Type.String({ minLength: 1, maxLength: 4096 }) },
  { additionalProperties: false },
);
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
/**
 * Contract 2 (wave A of the extension design): a folder with `extension.json`
 * and a `config.json` beside it. The process wire is contract 1's, with the
 * operations the manifest's handlers need. Wave B adds folder discovery with a
 * watcher, outline folders, renderers, actions and tiles; until then the
 * fields it will read are allowed and ignored.
 */
const Handler = Type.Object(
  {
    key: Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" }),
    kind: Type.Literal("resource"),
    effects: Type.Union([Type.Literal("read"), Type.Literal("spend"), Type.Literal("write")]),
    keyPattern: Type.Optional(Type.String({ maxLength: 200 })),
    staleAfter: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,3}m$" })),
    pollEvery: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,3}m$" })),
    record: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
const ManifestV2 = Type.Object(
  {
    contract: Type.Literal(2),
    id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" }),
    version: Type.Integer({ minimum: 1 }),
    name: Type.String({ minLength: 1, maxLength: 60 }),
    run: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 }),
    configSchema: Type.Optional(Type.Unknown()),
    secrets: Type.Optional(Type.Record(Type.String({ pattern: "^[a-z][a-zA-Z0-9]{0,31}$" }), Type.String({ maxLength: 200 }), { maxProperties: 16 })),
    handlers: Type.Array(Handler, { minItems: 1, maxItems: 16 }),
  },
  { additionalProperties: true },
);
const FolderConfig = Type.Object(
  {
    config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    secrets: Type.Optional(Type.Record(Type.String(), Type.Union([Credential, FileCredential]), { maxProperties: 16 })),
    sources: Type.Optional(Type.Array(
      Type.Object({ origin: Type.String({ minLength: 1, maxLength: 2048 }), project: Type.String({ pattern: "^[A-Z][A-Z0-9_]*$" }) },
        { additionalProperties: false }),
      { maxItems: 32 },
    )),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ExtensionHandler = import("typebox").Static<typeof Handler>;
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

function defaultRegistryPath(): string {
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
    // A service pointed at another registry (a scratch or test service) reads the user folder only when
    // it is pointed at one too, so it never picks up the owner's real extension and its secrets.
    const isolated = process.env.OUTLINER_RESOURCE_EXTENSIONS !== undefined && process.env.OUTLINER_EXTENSIONS_DIR === undefined;
    this.folders = folders ?? ((configPath === undefined || configPath === defaultRegistryPath()) && !isolated ? [userExtensionsDirectory()] : []);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw failure("deadline must be 1..60000 milliseconds");
  }
  /** Where contract 2 folders are looked up, nearest first. Empty: only the legacy registry. */
  readonly folders: readonly string[];
  private async folderInstallation(provider: string) {
    for (const root of this.folders) {
      const directory = join(root, provider);
      const manifestPath = join(directory, "extension.json");
      if (!(await Bun.file(manifestPath).exists())) continue;
      const name = label(provider);
      try {
        const manifestRaw = await boundedFile(manifestPath);
        const manifest = Parse(ManifestV2, JSON.parse(manifestRaw));
        const configPath = join(directory, "config.json");
        const configRaw = (await Bun.file(configPath).exists()) ? await boundedFile(configPath) : "{}";
        const folder = Parse(FolderConfig, JSON.parse(configRaw));
        if (folder.enabled === false) throw failure(`${manifest.name} is disabled in ${configPath}`);
        const config = folder.config ?? {};
        if (manifest.configSchema !== undefined &&
          (!IsSchema(manifest.configSchema) || !Compile(manifest.configSchema).Check(config)))
          throw failure(`${manifest.name} configuration does not match its schema; check ${configPath}`);
        const run = [...manifest.run];
        // The service's own Bun runs a folder's TypeScript unless run[0] is a path.
        if (run[0] === "bun") run[0] = process.execPath;
        return {
          install: { manifest: manifestPath, enabled: true, config, credentials: folder.secrets ?? {} },
          manifest: { contract: 2 as const, id: manifest.id, version: manifest.version, command: run, name: manifest.name },
          description: {
            id: manifest.id, name: manifest.name, version: manifest.version, contract: 2 as const, directory,
            handlers: manifest.handlers, sources: folder.sources ?? [],
          } satisfies ExtensionDescription,
          directory,
          stamp: hash(manifestRaw + configRaw),
        };
      } catch (error) {
        if (error instanceof ResourceCatalogError) throw error;
        throw failure(`${name} extension in ${directory} is invalid; check extension.json (contract 2) and config.json`);
      }
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
  async invoke(
    provider: string,
    operation: "resolve" | "read" | "changed",
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ExtensionResult> {
    signal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(this.timeoutMs),
    ]);
    const loaded = await this.installation(provider);
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
      this.timeoutMs,
      signal,
    );
    // Disable/config changes during a call invalidate its result before the catalog can commit it.
    if ((await this.installation(provider)).stamp !== loaded.stamp)
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
