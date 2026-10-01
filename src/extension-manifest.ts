import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { Type, IsSchema, type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";

/**
 * What an extension folder is (contract 2): `extension.json` plus an optional
 * `config.json` beside it. This module is the one parser of both; the
 * registry (`src/extension-registry.ts`) and the process runtime
 * (`src/resource-extensions.ts`) read folders through it, so a manifest means
 * the same thing to the watcher that lists it and the call that runs it.
 *
 * The four kinds of extension (docs/extensions/README.md) are declared here:
 *
 * - `handlers[].kind: "resource"` and `"data"`: a record put into a block, as
 *   if copied in (kind 1). `resource` is the Resource-backed path (Jira);
 *   `data` keeps only the record.
 * - `handlers[].kind: "output"`: markdown rendered under the line (kind 2).
 * - `handlers[].kind: "component"`: data plus a view composed from the shared
 *   primitives (`src/component-primitives.ts`), drawn by every client (kind 3).
 * - `tiles[]`: a whole tile kind for the door's tile-kind registry (kind 4).
 *
 * `actions[]` are what any of them can do (`act`), the same for a key, a
 * click and an agent.
 */

export const EXTENSION_ID_PATTERN = "^[a-z][a-z0-9-]{0,31}$";
const ID = Type.String({ pattern: EXTENSION_ID_PATTERN });
/** `30s`, `15m`, `24h`. */
const Duration = Type.String({ pattern: "^[1-9][0-9]{0,4}[smh]$" });

const Credential = Type.Union([
  Type.Object({ env: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }) }, { additionalProperties: false }),
  Type.Object(
    { keychainService: Type.String({ minLength: 1, maxLength: 200 }), account: Type.Optional(Type.String({ maxLength: 200 })) },
    { additionalProperties: false },
  ),
]);
const FileCredential = Type.Object({ file: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false });
export const CredentialSchema = Credential;
export type CredentialReference = Static<typeof Credential> | Static<typeof FileCredential>;

const OptionSpec = Type.Object(
  {
    type: Type.Union([Type.Literal("boolean"), Type.Literal("integer"), Type.Literal("string")]),
    /** `display`: never reaches the extension, so lines that differ only by it share one result. `fetch` (default): part of the call. */
    scope: Type.Optional(Type.Union([Type.Literal("display"), Type.Literal("fetch")])),
    default: Type.Optional(Type.Union([Type.Boolean(), Type.Integer(), Type.String({ maxLength: 200 })])),
    min: Type.Optional(Type.Integer()),
    max: Type.Optional(Type.Integer()),
    pattern: Type.Optional(Type.String({ maxLength: 200 })),
    description: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);
export type ExtensionOptionSpec = Static<typeof OptionSpec>;

const Handler = Type.Object(
  {
    key: ID,
    kind: Type.Union([Type.Literal("resource"), Type.Literal("data"), Type.Literal("output"), Type.Literal("component")]),
    effects: Type.Union([Type.Literal("read"), Type.Literal("spend"), Type.Literal("write")]),
    description: Type.Optional(Type.String({ maxLength: 300 })),
    /** The words after `key::` that aren't `--options`: what the call is about (`virgo`, a date, a ticket key). */
    argument: Type.Optional(Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 40 }),
        pattern: Type.Optional(Type.String({ maxLength: 200 })),
        required: Type.Optional(Type.Boolean()),
        description: Type.Optional(Type.String({ maxLength: 200 })),
      },
      { additionalProperties: false },
    )),
    /** A resource or data handler's key grammar, anchored. */
    keyPattern: Type.Optional(Type.String({ maxLength: 200 })),
    options: Type.Optional(Type.Record(Type.String({ pattern: EXTENSION_ID_PATTERN }), OptionSpec, { maxProperties: 16 })),
    /** A data handler's record fields a projection shows, in order. */
    fields: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,39}$" }), { maxItems: 8 })),
    staleAfter: Type.Optional(Duration),
    pollEvery: Type.Optional(Duration),
    record: Type.Optional(Type.Boolean()),
    deadline: Type.Optional(Duration),
  },
  { additionalProperties: false },
);
export type ExtensionHandler = Static<typeof Handler>;

const Action = Type.Object(
  {
    id: ID,
    label: Type.String({ minLength: 1, maxLength: 60 }),
    description: Type.Optional(Type.String({ maxLength: 300 })),
    /** What it acts on: `block` (any block), `handler:<key>` (a line of that handler), `tile:<kind>`. Default `block`. */
    on: Type.Optional(Type.String({ pattern: "^(block|handler:[a-z][a-z0-9-]{0,31}|tile:[a-z][a-z0-9-]{0,31})$" })),
    /** A suggested key for clients that bind one (the door's `ActionDef`). */
    key: Type.Optional(Type.String({ minLength: 1, maxLength: 12 })),
    /** `write`: it may return writes. `read` (default): it only answers. */
    effects: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")])),
  },
  { additionalProperties: false },
);
export type ExtensionAction = Static<typeof Action>;

const Tile = Type.Object(
  {
    kind: ID,
    name: Type.String({ minLength: 1, maxLength: 60 }),
    description: Type.Optional(Type.String({ maxLength: 300 })),
    /** The terminal program the tile runs, from the extension's folder. `bun` means the service's own Bun. */
    run: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 }),
    /** Action ids (from `actions[]`) the tile offers; the door binds them like its own. */
    actions: Type.Optional(Type.Array(ID, { maxItems: 16 })),
    /** The container policy a tile of this kind starts with (the layout design's per-node settings). */
    policy: Type.Optional(Type.Object(
      {
        draggable: Type.Optional(Type.Boolean()),
        droppable: Type.Optional(Type.Boolean()),
        resizable: Type.Optional(Type.Boolean()),
        collapsible: Type.Optional(Type.Boolean()),
        overlay: Type.Optional(Type.Boolean()),
        locked: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    )),
    /** Tile kinds it takes as drops (a container tile); empty or absent: none. */
    accepts: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 })),
    /** The arguments a tile is opened with and saved with in a screen. */
    args: Type.Optional(Type.Record(
      Type.String({ pattern: EXTENSION_ID_PATTERN }),
      Type.Object({ type: Type.Union([Type.Literal("string"), Type.Literal("block")]), description: Type.Optional(Type.String({ maxLength: 200 })) },
        { additionalProperties: false }),
      { maxProperties: 8 },
    )),
  },
  { additionalProperties: false },
);
export type ExtensionTile = Static<typeof Tile>;

const ManifestV2 = Type.Object(
  {
    contract: Type.Literal(2),
    id: ID,
    version: Type.Integer({ minimum: 1 }),
    name: Type.String({ minLength: 1, maxLength: 60 }),
    description: Type.Optional(Type.String({ maxLength: 500 })),
    /** The program each call runs (one JSON request on stdin, one response on stdout). Needed by handlers and actions. */
    run: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 })),
    /** How long one call may take: default 15s, at most 5m. A handler may set its own. */
    deadline: Type.Optional(Duration),
    configSchema: Type.Optional(Type.Unknown()),
    secrets: Type.Optional(Type.Record(Type.String({ pattern: "^[a-z][a-zA-Z0-9]{0,31}$" }), Type.String({ maxLength: 200 }), { maxProperties: 16 })),
    handlers: Type.Optional(Type.Array(Handler, { maxItems: 16 })),
    actions: Type.Optional(Type.Array(Action, { maxItems: 32 })),
    tiles: Type.Optional(Type.Array(Tile, { maxItems: 8 })),
  },
  { additionalProperties: false },
);
export type ExtensionManifest = Static<typeof ManifestV2>;

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
export type ExtensionFolderConfig = Static<typeof FolderConfig>;

const MAX_FILE_BYTES = 64 * 1024;
export const MAX_DEADLINE_MS = 5 * 60_000;
export const DEFAULT_DEADLINE_MS = 15_000;

/** Property keys the core already gives a meaning; a handler can't take them. */
export const RESERVED_HANDLER_KEYS: ReadonlySet<string> = new Set([
  "page", "type", "query", "file", "web", "app", "view", "publish", "raw-capture", "before-rewrite", "status",
  "project", "work-id", "work-stage", "priority", "related-to", "parent", "author",
]);

/** `15m` → 900000. Undefined for anything else. */
export function durationMs(value: string | undefined): number | undefined {
  const match = value ? /^([1-9][0-9]{0,4})([smh])$/.exec(value) : null;
  if (!match) return undefined;
  return Number(match[1]) * (match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000);
}

/** Where a folder was found. The outline's copy wins over the user's. */
export type ExtensionOrigin = "outline" | "user";

/** A folder read and checked, ready to list or run. */
export interface LoadedExtension {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly description?: string;
  readonly origin: ExtensionOrigin;
  readonly directory: string;
  readonly manifest: ExtensionManifest;
  readonly config: Record<string, unknown>;
  readonly credentials: Record<string, CredentialReference>;
  readonly sources: readonly { readonly origin: string; readonly project: string }[];
  readonly enabled: boolean;
  /** The argv a call runs, `bun` resolved to the service's own Bun. Null when the extension runs no code. */
  readonly command: readonly string[] | null;
  /** Changes when either file changes; a call whose stamp moved under it is discarded. */
  readonly stamp: string;
}

/** Why a folder didn't load, in words that name the file and the field. */
export class ExtensionLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionLoadError";
  }
}

async function boundedText(path: string): Promise<string> {
  const file = Bun.file(path);
  if (file.size > MAX_FILE_BYTES) throw new ExtensionLoadError(`${basename(path)} is larger than 64 KiB`);
  return file.text();
}

function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/^JSON Parse error: /, "") : String(error);
    throw new ExtensionLoadError(`${file} is not valid JSON (${detail})`);
  }
}

/**
 * The first problem a schema finds, as a person would say it:
 * `handlers/0/kind must be one of resource, data, output, component`.
 */
export function schemaProblem(schema: TSchema, value: unknown): string | null {
  const errors = [...Compile(schema).Errors(value)] as Array<{ keyword: string; instancePath: string; message: string; params: Record<string, unknown> }>;
  if (!errors.length) return null;
  const where = (path: string) => path.replace(/^\//, "") || "the file";
  const unions = errors.find((error) => error.keyword === "anyOf");
  if (unions) {
    const allowed = errors
      .filter((error) => error.keyword === "const" && error.instancePath === unions.instancePath)
      .map((error) => String(error.params.allowedValue));
    if (allowed.length) return `${where(unions.instancePath)} must be one of ${allowed.join(", ")}`;
  }
  const first = errors.find((error) => error.keyword !== "anyOf") ?? errors[0]!;
  if (first.keyword === "additionalProperties") {
    const extra = first.params.additionalProperties ?? first.params.additionalProperty;
    return `${where(first.instancePath)} has a field it doesn't know: ${Array.isArray(extra) ? extra.join(", ") : String(extra)}`;
  }
  if (first.keyword === "required") return `${where(first.instancePath)} needs ${String(first.params.requiredProperty)}`;
  if (first.keyword === "pattern") return `${where(first.instancePath)} doesn't match ${String(first.params.pattern)}`;
  return `${where(first.instancePath)} ${first.message}`;
}

function checkPattern(pattern: string | undefined, where: string): void {
  if (pattern === undefined) return;
  try {
    new RegExp(pattern);
  } catch {
    throw new ExtensionLoadError(`extension.json: ${where} is not a valid regular expression`);
  }
}

/** The manifest's own rules beyond its schema: what needs a `run`, which keys are free, which patterns compile. */
function checkManifest(manifest: ExtensionManifest): void {
  const keys = new Set<string>();
  for (const [index, handler] of (manifest.handlers ?? []).entries()) {
    if (keys.has(handler.key)) throw new ExtensionLoadError(`extension.json: handlers/${index}/key ${handler.key} is declared twice`);
    keys.add(handler.key);
    if (RESERVED_HANDLER_KEYS.has(handler.key)) {
      throw new ExtensionLoadError(`extension.json: handlers/${index}/key ${handler.key} is a property the outline already uses; pick another key`);
    }
    if (handler.kind === "resource" && handler.key !== "jira") {
      throw new ExtensionLoadError(`extension.json: handlers/${index} is a resource handler; only jira has one yet. Use kind "data" for a record put into a block`);
    }
    checkPattern(handler.keyPattern, `handlers/${index}/keyPattern`);
    checkPattern(handler.argument?.pattern, `handlers/${index}/argument/pattern`);
    for (const [name, option] of Object.entries(handler.options ?? {})) checkPattern(option.pattern, `handlers/${index}/options/${name}/pattern`);
    const deadline = durationMs(handler.deadline);
    if (deadline !== undefined && deadline > MAX_DEADLINE_MS) throw new ExtensionLoadError(`extension.json: handlers/${index}/deadline is longer than 5m`);
  }
  const deadline = durationMs(manifest.deadline);
  if (deadline !== undefined && deadline > MAX_DEADLINE_MS) throw new ExtensionLoadError("extension.json: deadline is longer than 5m");
  const actionIds = new Set<string>();
  for (const [index, action] of (manifest.actions ?? []).entries()) {
    if (actionIds.has(action.id)) throw new ExtensionLoadError(`extension.json: actions/${index}/id ${action.id} is declared twice`);
    actionIds.add(action.id);
    if (action.on?.startsWith("handler:") && !keys.has(action.on.slice(8))) {
      throw new ExtensionLoadError(`extension.json: actions/${index}/on names handler ${action.on.slice(8)}, which this extension doesn't declare`);
    }
  }
  const tileKinds = new Set<string>();
  for (const [index, tile] of (manifest.tiles ?? []).entries()) {
    if (tileKinds.has(tile.kind)) throw new ExtensionLoadError(`extension.json: tiles/${index}/kind ${tile.kind} is declared twice`);
    tileKinds.add(tile.kind);
    for (const id of tile.actions ?? []) {
      if (!actionIds.has(id)) throw new ExtensionLoadError(`extension.json: tiles/${index}/actions names ${id}, which actions[] doesn't declare`);
    }
  }
  for (const [index, action] of (manifest.actions ?? []).entries()) {
    if (action.on?.startsWith("tile:") && !tileKinds.has(action.on.slice(5))) {
      throw new ExtensionLoadError(`extension.json: actions/${index}/on names tile ${action.on.slice(5)}, which this extension doesn't declare`);
    }
  }
  const needsRun = (manifest.handlers ?? []).length > 0 || (manifest.actions ?? []).length > 0;
  if (needsRun && !manifest.run) throw new ExtensionLoadError("extension.json: handlers and actions need run (the program each call starts)");
  if (!needsRun && !(manifest.tiles ?? []).length) throw new ExtensionLoadError("extension.json declares nothing: add handlers, actions or tiles");
}

/** `bun` in an argv means the service's own Bun, so a folder works wherever the service runs. */
export function resolveArgv(argv: readonly string[]): string[] {
  const run = [...argv];
  if (run[0] === "bun") run[0] = process.execPath;
  return run;
}

/**
 * Reads one extension folder. Throws an `ExtensionLoadError` that names the
 * file and what is wrong with it; never a secret value (none are read here).
 */
export async function readExtensionFolder(
  directory: string,
  origin: ExtensionOrigin,
  options: { checkConfig?: boolean } = {},
): Promise<LoadedExtension> {
  const manifestPath = join(directory, "extension.json");
  if (!(await Bun.file(manifestPath).exists())) throw new ExtensionLoadError("no extension.json in the folder");
  const manifestRaw = await boundedText(manifestPath);
  const json = parseJson(manifestRaw, "extension.json");
  if (json && typeof json === "object" && (json as { contract?: unknown }).contract === 1) {
    throw new ExtensionLoadError("extension.json is contract 1; contract 2 is a folder like extensions/horoscope (see docs/extensions/README.md)");
  }
  const problem = schemaProblem(ManifestV2, json);
  if (problem) throw new ExtensionLoadError(`extension.json: ${problem}`);
  const manifest = json as ExtensionManifest;
  checkManifest(manifest);
  if (manifest.id !== basename(directory)) {
    throw new ExtensionLoadError(`extension.json: id ${manifest.id} must match the folder's name (${basename(directory)})`);
  }
  const configPath = join(directory, "config.json");
  const configRaw = (await Bun.file(configPath).exists()) ? await boundedText(configPath) : "{}";
  const folderJson = parseJson(configRaw, "config.json");
  const folderProblem = schemaProblem(FolderConfig, folderJson);
  if (folderProblem) throw new ExtensionLoadError(`config.json: ${folderProblem}`);
  const folder = folderJson as ExtensionFolderConfig;
  const config = folder.config ?? {};
  if (manifest.configSchema !== undefined) {
    if (!IsSchema(manifest.configSchema)) throw new ExtensionLoadError("extension.json: configSchema is not a JSON schema");
  }
  // A source folder (`ext add`) has no config yet; an install's config must match.
  if (manifest.configSchema !== undefined && options.checkConfig !== false) {
    const configProblem = schemaProblem(manifest.configSchema as TSchema, config);
    if (configProblem) throw new ExtensionLoadError(`config.json: config doesn't match the config schema in extension.json (${configProblem.replace(/^the file /, "")})`);
  }
  for (const name of Object.keys(folder.secrets ?? {})) {
    if (!manifest.secrets?.[name]) throw new ExtensionLoadError(`config.json: secrets/${name} isn't a secret extension.json declares`);
  }
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description ? { description: manifest.description } : {}),
    origin,
    directory,
    manifest,
    config,
    credentials: folder.secrets ?? {},
    sources: folder.sources ?? [],
    enabled: folder.enabled !== false,
    command: manifest.run ? resolveArgv(manifest.run) : null,
    stamp: createHash("sha256").update(manifestRaw).update("\0").update(configRaw).digest("hex"),
  };
}
