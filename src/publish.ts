import { hostname } from "node:os";
import { Marked } from "marked";
import type { OutlinerClient, OutlinerWatcher } from "./client";
import type { FileContents } from "./files";
import { MAX_TEXT_FILE_BYTES } from "./files";
import { pageAddressReferences, tryNormalizePageAddress } from "./page-addresses";
import { getProperty, stripPropertyTokens } from "./properties";
import {
  canonicalPublishRoots,
  checkAttachment,
  type AttachmentPolicy,
} from "./publish-attachments";
import { blockReferenceOccurrences } from "./references";
import { embedMatches } from "./transclusions";
import type {
  BlockProperty,
  OutlinerServiceStatus,
  PageAddressResolution,
  ProjectedBlockCollection,
  ProjectedVisibleBlock,
} from "./types";

/**
 * Outline as server: a read-only HTTP publisher for blocks carrying
 * `[publish::…]`. It is a client of the service (blocks.query, files.read, the
 * content event feed) and never writes. See README "Publishing blocks".
 */

export const PUBLISH_PROPERTY = "publish";
export const PUBLISH_QUERY_LIMIT = 1000;
const INDEX_MAX_AGE_MS = 5_000;
const DISCONNECTED_MAX_AGE_MS = 1_000;
/** At most this many distinct `[[page]]` addresses are resolved for one page; the rest show their label. */
const PAGE_RESOLVE_LIMIT = 200;
/** `pages.resolve` requests in flight at once, so one large page never floods the shared service. */
const PAGE_RESOLVE_CONCURRENCY = 4;

export type PublishedEntryType = "html" | "markdown" | "text" | "block";

export interface PublishedEntry {
  blockId: string;
  title: string;
  /** URL path below the base path, e.g. `/p/moth-garden`. */
  path: string;
  slug: string;
  /** The slug the block asked for when another block holds it. */
  collision?: { requested: string; heldBy: string };
  type: PublishedEntryType;
  updatedAt: string;
  /**
   * Set when the block has `[file::…]`: the path as authored and why it is not
   * served, if not. Over HTTP only a refusal is shown, never the path.
   */
  attachment?: { source?: string; refused?: string };
}

export interface PublishedIndex {
  entries: PublishedEntry[];
  truncated: boolean;
  builtAt: string;
}

export interface PublisherOptions {
  client: OutlinerClient;
  /** Extra allowed attachment roots; the outline's workspace root is always one. */
  roots?: readonly string[];
  /** Leave the workspace root out of the allowlist (tests, or an outline rooted too broadly). */
  excludeWorkspaceRoot?: boolean;
  maxBytes?: number;
  /** Where a proxy mounts the publisher (`/pub`); links carry it and requests may too. */
  basePath?: string;
  /**
   * Host names requests may name besides loopback and `*.ts.net` (the tailnet
   * names `tailscale serve` forwards). Any other Host is refused, so a web page
   * that rebinds its own name to 127.0.0.1 cannot read what is published.
   */
  allowedHosts?: readonly string[];
  log?: (line: string) => void;
}

/** `true`/`yes` publish at the page address or block id; `false`/`no`/`off`/`0` or empty do not publish. */
export function publishIntent(value: string | undefined): "auto" | "off" | { slug: string } {
  const trimmed = value?.trim() ?? "";
  const lowered = trimmed.toLowerCase();
  if (!trimmed || lowered === "false" || lowered === "no" || lowered === "off" || lowered === "0") return "off";
  if (lowered === "true" || lowered === "yes") return "auto";
  const slug = slugify(trimmed);
  return slug ? { slug } : "auto";
}

/**
 * A URL path from authored text: NFKC, lower case, `/` separates folders,
 * anything but letters, digits, `.`, `_`, `~` and `-` becomes `-`. Segments
 * never start or end with `.` or `-`, so `.` and `..` cannot appear.
 */
export function slugify(value: string): string | null {
  const segments = value
    .normalize("NFKC")
    .toLowerCase()
    .split("/")
    .map((segment) => segment
      .trim()
      .replace(/[^\p{L}\p{N}._~-]+/gu, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, ""))
    .filter(Boolean);
  const slug = segments.join("/").slice(0, 200).replace(/[/.-]+$/, "");
  return slug || null;
}

/**
 * A block's publish intent from all its `[publish::…]` tokens: when any says
 * false/no/off/0 the block is not published, whatever the others say.
 */
export function blockPublishIntent(properties: readonly BlockProperty[]): ReturnType<typeof publishIntent> | undefined {
  const values = properties.filter((property) => property.key === PUBLISH_PROPERTY).map((property) => publishIntent(property.value));
  if (!values.length) return undefined;
  return values.includes("off") ? "off" : values[0];
}

function requestedSlug(block: { id: string; properties?: BlockProperty[] }): string | null {
  const intent = blockPublishIntent(block.properties ?? []) ?? "off";
  if (intent === "off") return null;
  if (intent !== "auto") return intent.slug;
  const page = getProperty(block.properties ?? [], "page");
  const address = page ? tryNormalizePageAddress(page) : null;
  return (address && slugify(address.displayAddress)) || block.id;
}

/**
 * Assigns each published block its path. When blocks ask for the same slug the
 * oldest (created first, then lowest id) keeps it; each other gets
 * `<slug>~<first 8 of its id>` and the index shows the collision.
 */
export function assignPaths(blocks: readonly ProjectedVisibleBlock[]): Array<{ block: ProjectedVisibleBlock; slug: string; collision?: PublishedEntry["collision"] }> {
  const wanted = blocks
    .map((block) => ({ block, slug: requestedSlug(block) }))
    .filter((entry): entry is { block: ProjectedVisibleBlock; slug: string } => entry.slug !== null)
    .sort((left, right) =>
      (left.block.createdAt ?? "").localeCompare(right.block.createdAt ?? "") || left.block.id.localeCompare(right.block.id));
  const holders = new Map<string, string>();
  return wanted.map(({ block, slug }) => {
    const holder = holders.get(slug);
    if (holder === undefined) {
      holders.set(slug, block.id);
      return { block, slug };
    }
    const alternate = `${slug}~${block.id.slice(0, 8)}`;
    holders.set(alternate, block.id);
    return { block, slug: alternate, collision: { requested: slug, heldBy: holder } };
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

const SAFE_HREF = /^(?:https?:|mailto:|\/|#|\.{0,2}\/|[^:]*$)/i;

/** Markdown to HTML with authored raw HTML shown as text and only safe link schemes. */
const markdownRenderer = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!SAFE_HREF.test(href)) return label;
      return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${label}</a>`;
    },
    image({ href, title, text }) {
      if (!SAFE_HREF.test(href)) return escapeHtml(text);
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ""}>`;
    },
  },
});

export function renderMarkdownHtml(markdown: string): string {
  return markdownRenderer.parse(markdown, { async: false }) as string;
}

const PAGE_STYLE = `
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1d1d1b;--dim:#6b6a64;--rule:#dcd9cf;--link:#1a55a8}
@media (prefers-color-scheme:dark){:root{--bg:#111110;--fg:#e8e6df;--dim:#9a988f;--rule:#34332f;--link:#8fb8ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 ui-serif,Georgia,serif}
main{max-width:46rem;margin:0 auto;padding:2rem 1rem 4rem}
a{color:var(--link)}
header.bar,footer{font:13px/1.5 ui-monospace,Menlo,monospace;color:var(--dim)}
header.bar{border-bottom:1px solid var(--rule);padding-bottom:.5rem;margin-bottom:1.5rem}
footer{border-top:1px solid var(--rule);margin-top:3rem;padding-top:.5rem}
pre,code{font:14px/1.45 ui-monospace,Menlo,monospace}
pre{overflow-x:auto;padding:.75rem;border:1px solid var(--rule)}
table{border-collapse:collapse;width:100%;font:14px/1.5 ui-monospace,Menlo,monospace}
th,td{text-align:left;padding:.25rem .75rem .25rem 0;border-bottom:1px solid var(--rule);vertical-align:top}
th{color:var(--dim);font-weight:normal}
.dim{color:var(--dim)}
img{max-width:100%}
`;

function htmlPage(title: string, body: string, nav: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>
<body><main><header class="bar">${nav}</header>
${body}
</main></body></html>
`;
}

const COMMON_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
/** Pages the publisher renders itself run no script and embed nothing but images. */
const RENDERED_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src * data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/**
 * An attached `.html` file runs as authored, but in a sandbox without
 * `allow-same-origin`: its scripts get an opaque origin, so they cannot read
 * other pages on the same host (the tailnet name also serves other mounts) or
 * this publisher's index with the viewer's credentials.
 */
const ATTACHED_HTML_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads";

function respond(body: string, contentType: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...COMMON_HEADERS, "content-type": contentType, ...extra } });
}

function renderedHtml(body: string, status = 200): Response {
  return respond(body, "text/html; charset=utf-8", status, { "content-security-policy": RENDERED_CSP });
}

function notFound(): Response {
  return respond("Not published\n", "text/plain; charset=utf-8", 404);
}

export class Publisher {
  private readonly client: OutlinerClient;
  readonly basePath: string;
  private readonly maxBytes: number;
  private readonly log: (line: string) => void;
  private readonly allowedHosts: ReadonlySet<string>;
  private policy: AttachmentPolicy | null = null;
  private index: { value: PublishedIndex; at: number } | null = null;
  private building: Promise<PublishedIndex> | null = null;
  private watcher: OutlinerWatcher | null = null;
  private connected = false;
  /** Advanced by every content change; an index built across a change is not cached. */
  private generation = 0;

  constructor(private readonly options: PublisherOptions) {
    this.client = options.client;
    this.basePath = normalizeBasePath(options.basePath);
    this.maxBytes = Math.min(options.maxBytes ?? MAX_TEXT_FILE_BYTES, MAX_TEXT_FILE_BYTES);
    this.log = options.log ?? (() => {});
    this.allowedHosts = new Set((options.allowedHosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean));
  }

  /** Loopback, a tailnet name, or a host the operator allowed; the port is ignored. */
  private hostAllowed(header: string | null): boolean {
    if (!header) return false;
    let host: string;
    try {
      host = new URL(`http://${header}`).hostname.toLowerCase();
    } catch {
      return false;
    }
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" ||
      host.endsWith(".ts.net") || this.allowedHosts.has(host);
  }

  /**
   * Learns the outline's workspace root from `ping` and subscribes to the
   * content feed as an observer: any committed change drops the cached index,
   * so unpublishing takes effect on the next request.
   */
  async start(): Promise<OutlinerServiceStatus> {
    const status = await this.client.requireCompatibleService();
    const roots = [...(this.options.roots ?? [])];
    const location = status.location;
    // Attachments are checked on this machine's filesystem and read by the service from its own:
    // the check means nothing unless both are the same machine.
    const local = location !== undefined && location.hostname === hostname();
    if (local && !this.options.excludeWorkspaceRoot) roots.unshift(location.workspaceRoot);
    if (!local) this.log(`publish: the service runs on ${location?.hostname ?? "an unknown machine"}, not here; attachments are not served`);
    const canonical = canonicalPublishRoots(roots);
    for (const problem of canonical.problems) this.log(`publish: ${problem}`);
    this.policy = {
      roots: canonical.roots,
      workspaceRoot: local ? location.workspaceRoot : process.cwd(),
      maxBytes: this.maxBytes,
      ...(local ? {} : { remoteService: true }),
    };
    const connected = Promise.withResolvers<void>();
    this.watcher = this.client.watch({
      client: { clientId: `publish-${crypto.randomUUID()}`, role: "observer", contextId: "publish" },
      onConnect: () => {
        this.connected = true;
        this.invalidate();
        connected.resolve();
      },
      onDisconnect: () => {
        this.connected = false;
      },
      onEvent: (event) => {
        if (event.domain === "content") this.invalidate();
      },
      onError: (error) => this.log(`publish: change feed: ${error.message}`),
    });
    await Promise.race([connected.promise, Bun.sleep(3_000)]);
    return status;
  }

  private invalidate(): void {
    this.generation += 1;
    this.index = null;
  }

  async stop(): Promise<void> {
    await this.watcher?.stop();
    this.watcher = null;
  }

  get roots(): readonly string[] {
    return this.policy?.roots ?? [];
  }

  private requirePolicy(): AttachmentPolicy {
    if (!this.policy) throw new Error("Publisher has not started");
    return this.policy;
  }

  /** The published set, rebuilt after any content change (or after a few seconds, for attachment files). */
  async readIndex(): Promise<PublishedIndex> {
    const maxAge = this.connected ? INDEX_MAX_AGE_MS : DISCONNECTED_MAX_AGE_MS;
    if (this.index && Date.now() - this.index.at < maxAge) return this.index.value;
    this.building ??= this.buildIndex().finally(() => { this.building = null; });
    return this.building;
  }

  private async buildIndex(): Promise<PublishedIndex> {
    const started = Date.now();
    const generation = this.generation;
    const collection = await this.client.request<ProjectedBlockCollection>({
      action: "blocks.query",
      query: { filters: [{ key: PUBLISH_PROPERTY }], propertyScope: "block", limit: PUBLISH_QUERY_LIMIT },
      fields: ["title", "properties", "timestamps"],
    });
    const policy = this.requirePolicy();
    const assigned = assignPaths(collection.blocks);
    const rawTitles = new Map(assigned.map(({ block }) => [block.id, block.title ?? ""]));
    const entries = assigned.map(({ block, slug, collision }): PublishedEntry => {
      const source = getProperty(block.properties ?? [], "file");
      const check = source === undefined ? undefined : checkAttachment(source, policy);
      const served = check?.ok ? check : undefined;
      return {
        blockId: block.id,
        title: publishedTitle(block.title ?? "", rawTitles) || block.id,
        path: `/p/${slug}`,
        slug,
        ...(collision ? { collision } : {}),
        type: served ? served.type : "block",
        updatedAt: served && served.updatedAt > (block.updatedAt ?? "") ? served.updatedAt : block.updatedAt ?? "",
        ...(source === undefined ? {} : { attachment: { source, ...(check && !check.ok ? { refused: check.reason } : {}) } }),
      };
    }).sort((left, right) => left.path.localeCompare(right.path));
    const value = { entries, truncated: collection.completeness.kind === "truncated", builtAt: new Date().toISOString() };
    // A change during the build leaves the index uncached, so the next request sees it.
    if (generation === this.generation) this.index = { value, at: started };
    return value;
  }

  /** Answers one HTTP request. Only GET and HEAD; only the index and published entries. */
  async handle(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return respond("Read-only\n", "text/plain; charset=utf-8", 405, { allow: "GET, HEAD" });
    }
    if (!this.hostAllowed(request.headers.get("host") ?? new URL(request.url).host)) {
      return respond("Host not allowed\n", "text/plain; charset=utf-8", 421);
    }
    const url = new URL(request.url);
    let path = url.pathname;
    if (this.basePath && (path === this.basePath || path.startsWith(`${this.basePath}/`))) {
      path = path.slice(this.basePath.length) || "/";
    }
    try {
      if (path === "/" || path === "" || path === "/index" || path === "/index.html") {
        const accept = request.headers.get("accept") ?? "";
        if (path !== "/index.html" && accept.includes("text/plain") && !accept.includes("text/html")) {
          return respond(renderIndexText(await this.readIndex(), this.basePath), "text/plain; charset=utf-8");
        }
        return renderedHtml(renderIndexHtml(await this.readIndex(), this.basePath));
      }
      if (path === "/index.txt") return respond(renderIndexText(await this.readIndex(), this.basePath), "text/plain; charset=utf-8");
      if (path === "/index.json") return respond(`${JSON.stringify(readerIndex(await this.readIndex()), null, 2)}\n`, "application/json; charset=utf-8");
      if (!path.startsWith("/p/")) return notFound();
      let slug: string;
      try {
        slug = decodeURIComponent(path.slice(3)).replace(/\/+$/, "");
      } catch {
        return notFound();
      }
      const index = await this.readIndex();
      const entry = index.entries.find((candidate) => candidate.slug === slug) ??
        index.entries.find((candidate) => candidate.blockId === slug);
      if (!entry) return notFound();
      return await this.serveEntry(entry, index, url.searchParams.get("view") === "html");
    } catch (error) {
      this.log(`publish: ${request.method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return respond("The outline could not be read\n", "text/plain; charset=utf-8", 502);
    }
  }

  private async serveEntry(entry: PublishedEntry, index: PublishedIndex, asHtml: boolean): Promise<Response> {
    if (entry.type !== "block" && entry.attachment?.source !== undefined) {
      // Check again at request time: the file or a link in its path may have changed since the index.
      const check = checkAttachment(entry.attachment.source, this.requirePolicy());
      if (!check.ok) return respond("Attachment not served\n", "text/plain; charset=utf-8", 403);
      const contents = await this.client.request<FileContents>({ action: "files.read", path: check.path });
      if (contents.absolutePath !== check.path || contents.revision.size !== String(check.size) ||
        contents.revision.mtimeNs !== check.mtimeNs) {
        return respond("Attachment changed while it was read; try again\n", "text/plain; charset=utf-8", 409);
      }
      if (check.type === "html") {
        return respond(contents.text, "text/html; charset=utf-8", 200, { "content-security-policy": ATTACHED_HTML_CSP });
      }
      if (check.type === "markdown") {
        if (asHtml) return renderedHtml(this.page(entry, renderMarkdownHtml(contents.text)));
        return respond(contents.text, "text/markdown; charset=utf-8", 200, { "content-disposition": "inline" });
      }
      return respond(contents.text, "text/plain; charset=utf-8");
    }
    const markdown = await this.blockMarkdown(entry, index);
    if (asHtml) return renderedHtml(this.page(entry, renderMarkdownHtml(markdown)));
    return respond(markdown, "text/markdown; charset=utf-8", 200, { "content-disposition": "inline" });
  }

  private page(entry: PublishedEntry, body: string): string {
    const href = (path: string) => escapeHtml(`${this.basePath}${path}`);
    return htmlPage(entry.title, `<article>\n${body}</article>\n<footer>updated ${escapeHtml(entry.updatedAt)} · <a href="${href(entry.path)}">raw</a></footer>`,
      `<a href="${href("/index")}">index</a> / ${escapeHtml(entry.slug)}`);
  }

  /** The block and its subtree as markdown; `[[page]]` links resolve through the service's page registry. */
  private async blockMarkdown(entry: PublishedEntry, index: PublishedIndex): Promise<string> {
    const subtree = await this.client.request<ProjectedBlockCollection>({
      action: "blocks.query",
      query: { subtreeRootId: entry.blockId, limit: PUBLISH_QUERY_LIMIT },
      fields: ["text", "parent", "properties"],
    });
    const addresses = [...new Set(subtree.blocks.flatMap((block) =>
      pageAddressReferences(block.text ?? "").map((reference) => reference.normalizedAddress)))].slice(0, PAGE_RESOLVE_LIMIT);
    const pages = new Map<string, string>();
    // A few at a time: a large page must not open hundreds of connections to the shared service.
    // A link that cannot be resolved shows its label, as an unpublished one does.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(PAGE_RESOLVE_CONCURRENCY, addresses.length) }, async () => {
      while (next < addresses.length) {
        const address = addresses[next++]!;
        try {
          const resolution = await this.client.request<PageAddressResolution>({ action: "pages.resolve", address });
          if (resolution.status === "resolved" && resolution.block) pages.set(address, resolution.block.id);
        } catch (error) {
          this.log(`publish: pages.resolve: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }));
    return renderSubtreeMarkdown(subtree, index, this.basePath, pages);
  }
}

function normalizeBasePath(value: string | undefined): string {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(trimmed) || trimmed.split("/").some((segment) => segment === "..")) {
    throw new Error(`--base-path must be a URL path such as /pub: ${value}`);
  }
  return trimmed;
}

/**
 * Block text for publication: property tokens removed; a `((block))` or
 * `[[page]]` link becomes a link when its target is published, and otherwise
 * only its authored label (never the unpublished block's text).
 */
function publishedText(text: string, index: PublishedIndex, basePath: string, pages: ReadonlyMap<string, string>): string {
  let body = stripPropertyTokens(text).split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n");
  const byId = new Map(index.entries.map((entry) => [entry.blockId, entry]));
  const link = (label: string, target: PublishedEntry | undefined) =>
    target ? `[${label}](${basePath}${target.path})` : label;
  // An embed `!((id))` is published as a link to its target, never as the target's text
  // (and never as `![…](…)`, which markdown reads as an image).
  const embedStarts = new Set(embedMatches(body).map((match) => match.index));
  for (const occurrence of [...blockReferenceOccurrences(body)].reverse()) {
    const target = byId.get(occurrence.blockId);
    const replacement = link(occurrence.label?.trim() || target?.title || "unpublished note", target);
    const start = embedStarts.has(occurrence.start - 1) ? occurrence.start - 1 : occurrence.start;
    body = body.slice(0, start) + replacement + body.slice(occurrence.end);
  }
  for (const reference of [...pageAddressReferences(body)].reverse()) {
    const blockId = pages.get(reference.normalizedAddress);
    const replacement = link(reference.label ?? reference.displayAddress, blockId ? byId.get(blockId) : undefined);
    body = body.slice(0, reference.start) + replacement + body.slice(reference.end);
  }
  return body.replace(/^\n+|\n+$/g, "");
}

/**
 * A published block's title as readers see it: a `((ref))` shows its authored
 * label, else a published target's title, else "unpublished note" — never an
 * unpublished block's id or text. `[[page]]` links keep their authored text.
 */
function publishedTitle(rawTitle: string, publishedTitles: ReadonlyMap<string, string>, depth = 0): string {
  let title = rawTitle;
  for (const occurrence of [...blockReferenceOccurrences(title)].reverse()) {
    const target = publishedTitles.get(occurrence.blockId);
    const replacement = occurrence.label?.trim() ||
      (target !== undefined && depth < 1 ? publishedTitle(target, publishedTitles, depth + 1) : target !== undefined ? "note" : "unpublished note");
    const start = title[occurrence.start - 1] === "!" ? occurrence.start - 1 : occurrence.start;
    title = title.slice(0, start) + replacement + title.slice(occurrence.end);
  }
  return title.replace(/\s{2,}/g, " ").trim();
}

/** The index as served over HTTP: without the authored attachment paths, which say where files live. */
function readerIndex(index: PublishedIndex): PublishedIndex {
  return {
    ...index,
    entries: index.entries.map(({ attachment, ...entry }) =>
      attachment?.refused ? { ...entry, attachment: { refused: attachment.refused } } : entry),
  };
}

/**
 * Publishing covers the block and its subtree. The block's own text comes
 * first (its first line as the heading); descendants follow as a nested list,
 * as they sit in the outline. A descendant marked `[publish::false]` (or
 * no/off/0) is left out with its own subtree; Trash is never included.
 */
export function renderSubtreeMarkdown(
  subtree: ProjectedBlockCollection,
  index: PublishedIndex,
  basePath = "",
  pages: ReadonlyMap<string, string> = new Map(),
): string {
  const [root, ...descendants] = subtree.blocks;
  if (!root) return "";
  const rootText = publishedText(root.text ?? "", index, basePath, pages);
  const [first = "", ...rest] = rootText.split("\n");
  const lines = [/^#{1,6}\s/.test(first) ? first : `# ${first.trim() || root.id}`, ...rest];
  // A block is left out when it or any ancestor below the root says `[publish::false]`, or when
  // its chain to the root is not in the result. Decided per block, not by result order.
  const byId = new Map(subtree.blocks.map((block) => [block.id, block]));
  const decided = new Map<string, boolean>([[root.id, true]]);
  const shown = (block: ProjectedVisibleBlock): boolean => {
    const known = decided.get(block.id);
    if (known !== undefined) return known;
    decided.set(block.id, false); // a cycle is never shown
    const parent = block.parentId ? byId.get(block.parentId) : undefined;
    const value = parent !== undefined &&
      blockPublishIntent(block.properties ?? []) !== "off" &&
      shown(parent);
    decided.set(block.id, value);
    return value;
  };
  const listed: string[] = [];
  for (const block of descendants) {
    if (!shown(block)) continue;
    const text = publishedText(block.text ?? "", index, basePath, pages);
    const indent = "  ".repeat(Math.max(0, block.depth - root.depth - 1));
    const [head = "", ...tail] = text.split("\n");
    listed.push(`${indent}- ${head}`);
    for (const line of tail) listed.push(line ? `${indent}  ${line}` : "");
  }
  const parts = [lines.join("\n").replace(/\n+$/, "")];
  if (listed.length) parts.push(listed.join("\n"));
  if (subtree.completeness.kind === "truncated") parts.push(`*(Only the first ${PUBLISH_QUERY_LIMIT} blocks are published.)*`);
  return `${parts.join("\n\n")}\n`;
}

function entryHref(entry: PublishedEntry, basePath: string): string {
  const view = entry.type === "markdown" || entry.type === "block" ? "?view=html" : "";
  return `${basePath}${entry.path}${view}`;
}

export function renderIndexText(index: PublishedIndex, basePath = ""): string {
  const header = ["TYPE", "UPDATED", "URL", "TITLE"];
  const rows = index.entries.map((entry) => [
    entry.type,
    entry.updatedAt.replace("T", " ").replace(/\.\d+Z$/, "Z"),
    `${basePath}${entry.path}`,
    entry.title +
      (entry.collision ? `  (collision: ${entry.collision.requested} is held by ${entry.collision.heldBy})` : "") +
      (entry.attachment?.refused ? `  (attachment not served: ${entry.attachment.refused})` : ""),
  ]);
  const widths = header.map((_, column) => Math.max(header[column]!.length, ...rows.map((row) => row[column]!.length)));
  const format = (row: string[]) => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ");
  const lines = [format(header), ...rows.map(format)];
  if (!rows.length) lines.push("(nothing is published; add [publish::true] to a block)");
  if (index.truncated) lines.push(`(only the first ${PUBLISH_QUERY_LIMIT} published blocks are listed)`);
  return `${lines.join("\n")}\n`;
}

export function renderIndexHtml(index: PublishedIndex, basePath = ""): string {
  const rows = index.entries.map((entry) => {
    const notes = [
      entry.collision ? `collision: “${escapeHtml(entry.collision.requested)}” is held by ${escapeHtml(entry.collision.heldBy)}` : "",
      entry.attachment?.refused ? `attachment not served: ${escapeHtml(entry.attachment.refused)}` : "",
    ].filter(Boolean).map((note) => `<div class="dim">${note}</div>`).join("");
    const raw = entry.type === "markdown" || entry.type === "block"
      ? ` <a class="dim" href="${escapeHtml(`${basePath}${entry.path}`)}">md</a>` : "";
    return `<tr><td><a href="${escapeHtml(entryHref(entry, basePath))}">${escapeHtml(entry.title)}</a>${notes}</td>` +
      `<td>${escapeHtml(`${basePath}${entry.path}`)}${raw}</td><td>${escapeHtml(entry.type)}</td>` +
      `<td>${escapeHtml(entry.updatedAt.slice(0, 16).replace("T", " "))}</td></tr>`;
  }).join("\n");
  const body = index.entries.length
    ? `<table><thead><tr><th>title</th><th>url</th><th>type</th><th>updated</th></tr></thead><tbody>\n${rows}\n</tbody></table>`
    : `<p class="dim">Nothing is published yet. Add <code>[publish::true]</code> to a block.</p>`;
  const truncated = index.truncated ? `<p class="dim">Only the first ${PUBLISH_QUERY_LIMIT} published blocks are listed.</p>` : "";
  return htmlPage("Published", `${body}${truncated}\n<footer><a href="${escapeHtml(`${basePath}/index.txt`)}">index.txt</a> · <a href="${escapeHtml(`${basePath}/index.json`)}">index.json</a></footer>`, "published");
}

/** Serves a publisher on 127.0.0.1 only; exposure beyond the machine is a proxy's job (tailscale serve). */
export function servePublisher(publisher: Publisher, port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({ hostname: "127.0.0.1", port, fetch: (request) => publisher.handle(request) });
}
