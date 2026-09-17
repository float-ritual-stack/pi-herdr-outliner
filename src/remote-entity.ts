import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Parse } from "typebox/value";
import {
  MAX_REMOTE_ENTITY_COMMENT_LENGTH,
  ResourceCatalogError,
  normalizeResourceProviderCommandInput,
  normalizeResourceRevisionRef,
  type RemoteEntityDocument,
  type RemoteEntityMetadata,
  type RemoteEntityProvider,
  type Resource,
  type ResourceProviderCommandDescriptor,
  type ResourceProviderCommandInput,
  type ResourceProviderCommandReceipt,
  type ResourceRepresentationAdapter,
  type ResourceRevisionRef,
  type ResourceSource,
} from "./resources";

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_ADF_DEPTH = 32;
const MAX_ADF_NODES = 20_000;
const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());
type UnknownRecord = Static<typeof UnknownRecordSchema>;

export type RemoteEntityResource = Extract<Resource, { provider: "jira" | "linear" }>;
export type RemoteEntitySource = Extract<ResourceSource, { provider: "jira" | "linear" }>;
export type RemoteEntityCredentialResolver = (
  credentialEnvironment: string,
) => string | null | undefined | Promise<string | null | undefined>;

export interface RemoteEntityProviderClientOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly resolveCredential: RemoteEntityCredentialResolver;
  readonly now?: () => string;
  readonly maximumResponseBytes?: number;
  readonly requestTimeoutMs?: number;
}

export interface RemoteEntityProviderClient {
  observe(
    resource: RemoteEntityResource,
    source: RemoteEntitySource,
  ): Promise<RemoteEntityDocument>;
  execute(
    resource: RemoteEntityResource,
    source: RemoteEntitySource,
    input: ResourceProviderCommandInput,
  ): Promise<ResourceProviderCommandReceipt>;
}

export const REMOTE_ENTITY_MARKDOWN_ADAPTER: ResourceRepresentationAdapter = {
  id: "remote-entity-markdown",
  version: 1,
};

const JIRA_COMMENT_CREATE_DESCRIPTOR: ResourceProviderCommandDescriptor = {
  provider: "jira",
  command: "comment.create",
  label: "Add comment",
  input: {
    body: {
      type: "string",
      required: true,
      maxLength: MAX_REMOTE_ENTITY_COMMENT_LENGTH,
    },
  },
};

const LINEAR_COMMENT_CREATE_DESCRIPTOR: ResourceProviderCommandDescriptor = {
  provider: "linear",
  command: "comment.create",
  label: "Add comment",
  input: {
    body: {
      type: "string",
      required: true,
      maxLength: MAX_REMOTE_ENTITY_COMMENT_LENGTH,
    },
  },
};

function providerError(message: string): ResourceCatalogError {
  return new ResourceCatalogError("source-unavailable", message);
}

function invalidProviderResponse(provider: RemoteEntityProvider, detail: string): never {
  throw providerError(`${provider} provider returned ${detail}`);
}

function record(value: unknown, label: string): UnknownRecord {
  try {
    return Parse(UnknownRecordSchema, value);
  } catch {
    throw providerError(`${label} must be an object`);
  }
}

function requiredString(value: unknown, label: string, maximum = 100_000): string {
  if (typeof value !== "string") throw providerError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw providerError(`${label} must be 1-${maximum} characters`);
  }
  return normalized;
}

function nullableString(value: unknown, label: string, maximum = 100_000): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, label, maximum);
}

function namedValue(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  const input = record(value, label);
  return nullableString(input.name, `${label} name`, 1_000);
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw providerError(`${label} must be an array`);
  const normalized = value.map((entry) => requiredString(entry, `${label} entry`, 1_000));
  return [...new Set(normalized)].sort();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function markdownText(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function backtickFence(value: string, minimumLength: number): string {
  let fenceLength = minimumLength;
  for (const match of value.matchAll(/`+/g)) {
    fenceLength = Math.max(fenceLength, match[0].length + 1);
  }
  return "`".repeat(fenceLength);
}

function markdownCode(value: string): string {
  const normalized = value.replace(/\r\n?|\n/g, " ");
  const fence = backtickFence(normalized, 1);
  const needsPadding =
    (normalized.startsWith("`") || normalized.endsWith("`")) ||
    ((normalized.startsWith(" ") || normalized.endsWith(" ")) && !/^ +$/.test(normalized));
  const padding = needsPadding ? " " : "";
  return `${fence}${padding}${normalized}${padding}${fence}`;
}

interface AdfRenderState {
  nodes: number;
}

function adfChildren(node: UnknownRecord, label: string): readonly unknown[] {
  if (node.content === undefined) return [];
  if (!Array.isArray(node.content)) throw providerError(`${label} content must be an array`);
  return node.content;
}

function renderAdfLiteralText(value: unknown, state: AdfRenderState, depth: number): string {
  state.nodes += 1;
  if (state.nodes > MAX_ADF_NODES || depth > MAX_ADF_DEPTH) {
    throw providerError("Jira description exceeds structural limits");
  }
  const node = record(value, "Jira description node");
  const type = requiredString(node.type, "Jira description node type", 100);
  if (type === "text") return typeof node.text === "string" ? node.text : "";
  if (type === "hardBreak") return "\n";
  return adfChildren(node, "Jira description node")
    .map((child) => renderAdfLiteralText(child, state, depth + 1))
    .join("");
}

function renderAdfNode(value: unknown, state: AdfRenderState, depth: number): string {
  state.nodes += 1;
  if (state.nodes > MAX_ADF_NODES || depth > MAX_ADF_DEPTH) {
    throw providerError("Jira description exceeds structural limits");
  }
  const node = record(value, "Jira description node");
  const type = requiredString(node.type, "Jira description node type", 100);
  if (type === "text") {
    const text = typeof node.text === "string" ? markdownText(node.text) : "";
    if (!Array.isArray(node.marks)) return text;
    return node.marks.reduce((rendered, markValue) => {
      const mark = record(markValue, "Jira text mark");
      if (mark.type === "strong") return `**${rendered}**`;
      if (mark.type === "em") return `_${rendered}_`;
      if (mark.type === "code") return markdownCode(node.text === undefined ? "" : String(node.text));
      if (mark.type === "strike") return `~~${rendered}~~`;
      if (mark.type === "link") {
        const attributes = record(mark.attrs, "Jira link attributes");
        const href = requiredString(attributes.href, "Jira link URL", 4_096);
        return `[${rendered}](${href.replaceAll(")", "%29")})`;
      }
      return rendered;
    }, text);
  }
  if (type === "hardBreak") return "  \n";
  if (type === "rule") return "---\n\n";
  if (type === "emoji") {
    const attributes = record(node.attrs, "Jira emoji attributes");
    return typeof attributes.text === "string" ? attributes.text : "";
  }
  if (type === "mention") {
    const attributes = record(node.attrs, "Jira mention attributes");
    return typeof attributes.text === "string" ? markdownText(attributes.text) : "";
  }
  if (type === "inlineCard") {
    const attributes = record(node.attrs, "Jira inline card attributes");
    const url = requiredString(attributes.url, "Jira inline card URL", 4_096);
    return `<${url}>`;
  }

  const children = adfChildren(node, "Jira description node");
  if (type === "bulletList" || type === "orderedList") {
    return children.map((child, index) => {
      const rendered = renderAdfNode(child, state, depth + 1).trim().replaceAll("\n", "\n  ");
      return `${type === "orderedList" ? `${index + 1}.` : "-"} ${rendered}`;
    }).join("\n") + "\n\n";
  }
  if (type === "listItem") {
    return children.map((child) => renderAdfNode(child, state, depth + 1)).join("").trim();
  }
  if (type === "codeBlock") {
    const literal = children
      .map((child) => renderAdfLiteralText(child, state, depth + 1))
      .join("");
    const fence = backtickFence(literal, 3);
    return `${fence}\n${literal}${literal.endsWith("\n") ? "" : "\n"}${fence}\n\n`;
  }
  const renderedChildren = children
    .map((child) => renderAdfNode(child, state, depth + 1))
    .join("");
  if (type === "paragraph") return `${renderedChildren.trimEnd()}\n\n`;
  if (type === "heading") {
    const attributes = record(node.attrs, "Jira heading attributes");
    const rawLevel = attributes.level;
    const level = typeof rawLevel === "number" && Number.isInteger(rawLevel)
      ? Math.min(6, Math.max(1, rawLevel))
      : 2;
    return `${"#".repeat(level)} ${renderedChildren.trim()}\n\n`;
  }
  if (type === "blockquote") {
    return renderedChildren.trim().split("\n").map((line) => `> ${line}`).join("\n") + "\n\n";
  }
  if (type === "doc") return renderedChildren;
  return renderedChildren;
}

function jiraDescriptionMarkdown(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  return renderAdfNode(value, { nodes: 0 }, 0).trim();
}

function detailsMarkdown(entries: readonly (readonly [string, string | readonly string[] | null])[]): string {
  const lines = entries.flatMap(([label, value]) => {
    if (value === null) return [];
    if (typeof value !== "string" && value.length === 0) return [];
    const rendered = typeof value === "string"
      ? markdownCode(value)
      : value.map((entry) => markdownCode(entry)).join(", ");
    return [`- ${label}: ${rendered}`];
  });
  return lines.length === 0 ? "" : `\n\n## Details\n\n${lines.join("\n")}`;
}

function entityMarkdown(
  title: string,
  description: string,
  details: readonly (readonly [string, string | readonly string[] | null])[],
): string {
  const body = description.trim();
  return `# ${markdownText(title)}${body ? `\n\n${body}` : ""}${detailsMarkdown(details)}\n`;
}

function externalHttpUrl(value: unknown, label: string): string {
  const raw = requiredString(value, label, 4_096);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw providerError(`${label} must be an absolute URL`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw providerError(`${label} must be an HTTP URL without credentials`);
  }
  return url.href;
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}

interface JsonResponse {
  readonly value: unknown;
  readonly text: string;
}

async function readJsonResponse(
  response: Response,
  provider: RemoteEntityProvider,
  maximumBytes: number,
): Promise<JsonResponse> {
  if (!response.ok) {
    await cancelResponse(response);
    throw providerError(`${provider} provider returned HTTP ${response.status}`);
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json" && !mediaType?.endsWith("+json")) {
    await cancelResponse(response);
    throw new ResourceCatalogError(
      "invalid-input",
      `${provider} provider returned unsupported media type: ${mediaType || "unknown"}`,
    );
  }
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null) {
    const declaredLength = Number(declaredHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      await cancelResponse(response);
      throw new ResourceCatalogError(
        "invalid-input",
        `${provider} response exceeds ${maximumBytes} bytes`,
      );
    }
  }
  if (!response.body) invalidProviderResponse(provider, "an empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let received = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel();
        throw new ResourceCatalogError(
          "invalid-input",
          `${provider} response exceeds ${maximumBytes} bytes`,
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return { value: JSON.parse(text), text };
  } catch {
    invalidProviderResponse(provider, "invalid JSON");
  }
}

function commandDescriptors(provider: RemoteEntityProvider): readonly ResourceProviderCommandDescriptor[] {
  return provider === "jira"
    ? [JIRA_COMMENT_CREATE_DESCRIPTOR]
    : [LINEAR_COMMENT_CREATE_DESCRIPTOR];
}

function revision(
  resource: RemoteEntityResource,
  updatedAt: unknown,
): ResourceRevisionRef {
  return normalizeResourceRevisionRef({
    resourceId: resource.id,
    addressVersion: resource.addressVersion,
    revision: {
      kind: resource.provider,
      validator: { kind: "updated-at", value: updatedAt },
    },
  }, resource);
}

function sourceSnapshot(
  resource: RemoteEntityResource,
  locator: string,
  contentHash: string,
  revisionRef: ResourceRevisionRef,
  fetchedAt: string,
): RemoteEntityDocument["sourceSnapshot"] {
  return {
    provider: resource.provider,
    resourceId: resource.id,
    addressVersion: resource.addressVersion,
    entityId: resource.address.entityId,
    locator,
    contentHash,
    revision: revisionRef,
    fetchedAt,
  };
}

function representation(
  markdown: string,
  derivedAt: string,
): RemoteEntityDocument["representation"] {
  return {
    mediaType: "text/markdown",
    adapter: REMOTE_ENTITY_MARKDOWN_ADAPTER,
    contentHash: sha256(markdown),
    derivedAt,
  };
}

function providerPair(
  resource: RemoteEntityResource,
  source: RemoteEntitySource,
): void {
  if (resource.sourceId !== source.id || resource.provider !== source.provider) {
    throw new ResourceCatalogError(
      "provider-mismatch",
      "Remote entity Resource and source do not match",
    );
  }
}

function jiraDocument(
  resource: Extract<RemoteEntityResource, { provider: "jira" }>,
  source: Extract<RemoteEntitySource, { provider: "jira" }>,
  response: JsonResponse,
  observedAt: string,
): RemoteEntityDocument {
  const issue = record(response.value, "Jira issue");
  const entityId = requiredString(issue.id, "Jira issue ID", 255);
  if (entityId !== resource.address.entityId) {
    invalidProviderResponse("jira", "a different immutable issue ID");
  }
  const key = requiredString(issue.key, "Jira issue key", 255).toUpperCase();
  if (!key.startsWith(`${source.boundary.project}-`)) {
    throw new ResourceCatalogError("outside-source", "Jira issue is outside its source project");
  }
  const fields = record(issue.fields, "Jira issue fields");
  const title = requiredString(fields.summary, "Jira issue summary");
  const description = jiraDescriptionMarkdown(fields.description);
  const status = namedValue(fields.status, "Jira issue status");
  const issueType = namedValue(fields.issuetype, "Jira issue type");
  const priority = namedValue(fields.priority, "Jira issue priority");
  const assignee = fields.assignee === null || fields.assignee === undefined
    ? null
    : nullableString(record(fields.assignee, "Jira issue assignee").displayName, "Jira assignee name", 1_000);
  const labels = stringArray(fields.labels, "Jira issue labels");
  const metadata: RemoteEntityMetadata = {
    key,
    status,
    type: issueType,
    priority,
    assignee,
    labels,
  };
  const markdown = entityMarkdown(title, description, [
    ["Key", key],
    ["Status", status],
    ["Type", issueType],
    ["Priority", priority],
    ["Assignee", assignee],
    ["Labels", labels],
  ]);
  const revisionRef = revision(resource, fields.updated);
  return {
    title,
    metadata,
    markdown,
    externalUrl: new URL(`/browse/${encodeURIComponent(key)}`, source.boundary.origin).href,
    sourceSnapshot: sourceSnapshot(resource, key, sha256(response.text), revisionRef, observedAt),
    representation: representation(markdown, observedAt),
    commandDescriptors: commandDescriptors("jira"),
  };
}

function linearLabels(value: unknown): readonly string[] {
  if (value === null || value === undefined) return [];
  const labels = record(value, "Linear issue labels");
  if (!Array.isArray(labels.nodes)) throw providerError("Linear issue labels nodes must be an array");
  return [...new Set(labels.nodes.map((node) => {
    const label = record(node, "Linear issue label");
    return requiredString(label.name, "Linear issue label name", 1_000);
  }))].sort();
}

function validateLinearWorkspace(issue: UnknownRecord, source: Extract<RemoteEntitySource, { provider: "linear" }>): void {
  if (issue.team === null || issue.team === undefined) return;
  const team = record(issue.team, "Linear issue team");
  if (team.organization === null || team.organization === undefined) return;
  const organization = record(team.organization, "Linear issue workspace");
  const candidates = [organization.id, organization.urlKey, organization.name]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  if (candidates.length > 0 && !candidates.includes(source.boundary.workspace.toLowerCase())) {
    throw new ResourceCatalogError("outside-source", "Linear issue is outside its source workspace");
  }
}

function linearDocument(
  resource: Extract<RemoteEntityResource, { provider: "linear" }>,
  source: Extract<RemoteEntitySource, { provider: "linear" }>,
  response: JsonResponse,
  observedAt: string,
): RemoteEntityDocument {
  const envelope = record(response.value, "Linear response");
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
    invalidProviderResponse("linear", "GraphQL errors");
  }
  const data = record(envelope.data, "Linear response data");
  const issue = record(data.issue, "Linear issue");
  const entityId = requiredString(issue.id, "Linear issue ID", 255);
  if (entityId !== resource.address.entityId) {
    invalidProviderResponse("linear", "a different immutable issue ID");
  }
  validateLinearWorkspace(issue, source);
  const identifier = requiredString(issue.identifier, "Linear issue identifier", 255).toUpperCase();
  const title = requiredString(issue.title, "Linear issue title");
  const description = nullableString(issue.description, "Linear issue description") ?? "";
  const status = namedValue(issue.state, "Linear issue state");
  const priority = nullableString(issue.priorityLabel, "Linear issue priority", 1_000);
  const assignee = namedValue(issue.assignee, "Linear issue assignee");
  const labels = linearLabels(issue.labels);
  const team = issue.team === null || issue.team === undefined
    ? null
    : nullableString(record(issue.team, "Linear issue team").key, "Linear team key", 255);
  const metadata: RemoteEntityMetadata = {
    identifier,
    status,
    priority,
    assignee,
    labels,
    team,
  };
  const markdown = entityMarkdown(title, description, [
    ["Identifier", identifier],
    ["Status", status],
    ["Priority", priority],
    ["Assignee", assignee],
    ["Labels", labels],
    ["Team", team],
  ]);
  const revisionRef = revision(resource, issue.updatedAt);
  return {
    title,
    metadata,
    markdown,
    externalUrl: externalHttpUrl(issue.url, "Linear issue URL"),
    sourceSnapshot: sourceSnapshot(
      resource,
      identifier,
      sha256(response.text),
      revisionRef,
      observedAt,
    ),
    representation: representation(markdown, observedAt),
    commandDescriptors: commandDescriptors("linear"),
  };
}

function jiraCommentBody(body: string): UnknownRecord {
  return {
    body: {
      type: "doc",
      version: 1,
      content: body.split("\n").map((line) => ({
        type: "paragraph",
        content: line ? [{ type: "text", text: line }] : [],
      })),
    },
  };
}

const LINEAR_ISSUE_QUERY = `query RemoteEntityIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    url
    updatedAt
    priorityLabel
    state { name }
    assignee { name }
    labels { nodes { name } }
    team { key organization { id urlKey name } }
  }
}`;

const LINEAR_COMMENT_MUTATION = `mutation RemoteEntityCommentCreate($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id }
  }
}`;

export class DefaultRemoteEntityProviderClient implements RemoteEntityProviderClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly credentialResolver: RemoteEntityCredentialResolver;
  private readonly clock: () => string;
  private readonly maximumResponseBytes: number;
  private readonly requestTimeoutMs: number;

  constructor(options: RemoteEntityProviderClientOptions) {
    if (!Number.isSafeInteger(options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES) ||
      (options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES) < 1) {
      throw new ResourceCatalogError("invalid-input", "Maximum provider response bytes must be positive");
    }
    if (!Number.isSafeInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) ||
      (options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) < 1) {
      throw new ResourceCatalogError("invalid-input", "Provider request timeout must be positive");
    }
    this.fetcher = options.fetch;
    this.credentialResolver = options.resolveCredential;
    this.clock = options.now ?? (() => new Date().toISOString());
    this.maximumResponseBytes = options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private observedAt(): string {
    const timestamp = new Date(this.clock());
    if (!Number.isFinite(timestamp.getTime())) {
      throw new ResourceCatalogError("invalid-input", "Provider clock must return an ISO timestamp");
    }
    return timestamp.toISOString();
  }

  private async credential(source: RemoteEntitySource): Promise<string> {
    const resolved = await this.credentialResolver(source.boundary.credentialEnv);
    if (typeof resolved !== "string" || !resolved.trim()) {
      throw providerError(`${source.provider} credentials are unavailable`);
    }
    return resolved.trim();
  }

  private async request(
    provider: RemoteEntityProvider,
    url: string,
    init: RequestInit,
  ): Promise<JsonResponse> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw providerError(`${provider} provider request failed`);
    }
    return readJsonResponse(response, provider, this.maximumResponseBytes);
  }

  async observe(
    resource: RemoteEntityResource,
    source: RemoteEntitySource,
  ): Promise<RemoteEntityDocument> {
    providerPair(resource, source);
    const credential = await this.credential(source);
    const observedAt = this.observedAt();
    if (resource.provider === "jira" && source.provider === "jira") {
      const url = new URL(
        `/rest/api/3/issue/${encodeURIComponent(resource.address.entityId)}`,
        source.boundary.origin,
      );
      url.searchParams.set(
        "fields",
        "summary,description,status,issuetype,priority,assignee,labels,updated",
      );
      const response = await this.request("jira", url.href, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential}`,
        },
      });
      return jiraDocument(resource, source, response, observedAt);
    }
    if (resource.provider === "linear" && source.provider === "linear") {
      const response = await this.request("linear", new URL("/graphql", source.boundary.origin).href, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: credential,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: LINEAR_ISSUE_QUERY,
          variables: { id: resource.address.entityId },
        }),
      });
      return linearDocument(resource, source, response, observedAt);
    }
    throw new ResourceCatalogError("provider-mismatch", "Remote entity provider does not match source");
  }

  async execute(
    resource: RemoteEntityResource,
    source: RemoteEntitySource,
    input: ResourceProviderCommandInput,
  ): Promise<ResourceProviderCommandReceipt> {
    const command = normalizeResourceProviderCommandInput(input);
    providerPair(resource, source);
    if (command.provider !== resource.provider) {
      throw new ResourceCatalogError(
        "provider-mismatch",
        "Resource provider command does not match the Resource",
      );
    }
    const credential = await this.credential(source);
    let externalId: string | null;
    if (resource.provider === "jira" && source.provider === "jira" && command.provider === "jira") {
      const response = await this.request(
        "jira",
        new URL(
          `/rest/api/3/issue/${encodeURIComponent(resource.address.entityId)}/comment`,
          source.boundary.origin,
        ).href,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(jiraCommentBody(command.payload.body)),
        },
      );
      const comment = record(response.value, "Jira comment");
      externalId = nullableString(comment.id, "Jira comment ID", 255);
    } else if (
      resource.provider === "linear" &&
      source.provider === "linear" &&
      command.provider === "linear"
    ) {
      const response = await this.request("linear", new URL("/graphql", source.boundary.origin).href, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: credential,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: LINEAR_COMMENT_MUTATION,
          variables: {
            issueId: resource.address.entityId,
            body: command.payload.body,
          },
        }),
      });
      const envelope = record(response.value, "Linear response");
      if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
        invalidProviderResponse("linear", "GraphQL errors");
      }
      const data = record(envelope.data, "Linear response data");
      const result = record(data.commentCreate, "Linear comment result");
      if (result.success !== true) invalidProviderResponse("linear", "an unsuccessful comment result");
      const comment = result.comment === null || result.comment === undefined
        ? null
        : record(result.comment, "Linear comment");
      externalId = comment === null ? null : nullableString(comment.id, "Linear comment ID", 255);
    } else {
      throw new ResourceCatalogError("provider-mismatch", "Remote entity provider does not match command");
    }
    return {
      resourceId: resource.id,
      provider: resource.provider,
      command: "comment.create",
      entityId: resource.address.entityId,
      externalId,
      executedAt: this.observedAt(),
    };
  }
}
