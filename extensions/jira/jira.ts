// Standalone installed extension (contract 2, extension.json): no imports from the Outliner application.
type UnknownRecord = Record<string, unknown>;
const MAX_ADF_DEPTH = 32,
  MAX_ADF_NODES = 20000;
class ExtensionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const providerError = (_message: string) =>
  new ExtensionError("invalid-response");
function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw providerError(label);
  return value as UnknownRecord;
}
function requiredString(
  value: unknown,
  label: string,
  maximum = 100_000,
): string {
  if (typeof value !== "string")
    throw providerError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw providerError(`${label} must be 1-${maximum} characters`);
  }
  return normalized;
}

function nullableString(
  value: unknown,
  label: string,
  maximum = 100_000,
): string | null {
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
  const normalized = value.map((entry) =>
    requiredString(entry, `${label} entry`, 1_000),
  );
  return [...new Set(normalized)].sort();
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
    normalized.startsWith("`") ||
    normalized.endsWith("`") ||
    ((normalized.startsWith(" ") || normalized.endsWith(" ")) &&
      !/^ +$/.test(normalized));
  const padding = needsPadding ? " " : "";
  return `${fence}${padding}${normalized}${padding}${fence}`;
}

interface AdfRenderState {
  nodes: number;
}

function adfChildren(node: UnknownRecord, label: string): readonly unknown[] {
  if (node.content === undefined) return [];
  if (!Array.isArray(node.content))
    throw providerError(`${label} content must be an array`);
  return node.content;
}

function renderAdfLiteralText(
  value: unknown,
  state: AdfRenderState,
  depth: number,
): string {
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

function renderAdfNode(
  value: unknown,
  state: AdfRenderState,
  depth: number,
): string {
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
      if (mark.type === "code")
        return markdownCode(node.text === undefined ? "" : String(node.text));
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
    return typeof attributes.text === "string"
      ? markdownText(attributes.text)
      : "";
  }
  if (type === "inlineCard") {
    const attributes = record(node.attrs, "Jira inline card attributes");
    const url = requiredString(attributes.url, "Jira inline card URL", 4_096);
    return `<${url}>`;
  }

  const children = adfChildren(node, "Jira description node");
  if (type === "bulletList" || type === "orderedList") {
    return (
      children
        .map((child, index) => {
          const rendered = renderAdfNode(child, state, depth + 1)
            .trim()
            .replaceAll("\n", "\n  ");
          return `${type === "orderedList" ? `${index + 1}.` : "-"} ${rendered}`;
        })
        .join("\n") + "\n\n"
    );
  }
  if (type === "listItem") {
    return children
      .map((child) => renderAdfNode(child, state, depth + 1))
      .join("")
      .trim();
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
    const level =
      typeof rawLevel === "number" && Number.isInteger(rawLevel)
        ? Math.min(6, Math.max(1, rawLevel))
        : 2;
    return `${"#".repeat(level)} ${renderedChildren.trim()}\n\n`;
  }
  if (type === "blockquote") {
    return (
      renderedChildren
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n") + "\n\n"
    );
  }
  if (type === "doc") return renderedChildren;
  return renderedChildren;
}

function jiraDescriptionMarkdown(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  return renderAdfNode(value, { nodes: 0 }, 0).trim();
}

function detailsMarkdown(
  entries: readonly (readonly [string, string | readonly string[] | null])[],
): string {
  const lines = entries.flatMap(([label, value]) => {
    if (value === null) return [];
    if (typeof value !== "string" && value.length === 0) return [];
    const rendered =
      typeof value === "string"
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

/** A Jira field that holds sprints (Jira Cloud's is a custom field); the active one, else the latest. */
function sprintName(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const sprints = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const sprint = entry as UnknownRecord;
    return typeof sprint.name === "string" ? [{ name: sprint.name, state: String(sprint.state ?? "") }] : [];
  });
  return (sprints.find((sprint) => sprint.state === "active") ?? sprints.at(-1))?.name ?? null;
}

function person(value: unknown, label: string): string | null {
  if (!value) return null;
  return nullableString(record(value, label).displayName, label, 1000);
}

function authHeader(config: UnknownRecord, email: unknown, token: string): string {
  return config.authMode === "basic"
    ? "Basic " + Buffer.from(String(email) + ":" + token).toString("base64")
    : "Bearer " + token;
}

async function jiraJson(url: URL, authorization: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        accept: "application/json",
        authorization,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    throw new ExtensionError(
      error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ExtensionError(
      ({ 400: "invalid-query", 401: "unauthorized", 403: "forbidden", 404: "not-found", 429: "rate-limited" } as Record<number, string>)[response.status] ?? "network",
    );
  }
  const text = await response.text();
  if (text.length > 900000) throw new ExtensionError("invalid-response");
  try {
    return JSON.parse(text);
  } catch {
    throw new ExtensionError("invalid-response");
  }
}

/** The latest comments, oldest first (the host shows the newest `--comments=N`). */
async function latestComments(origin: URL, entityId: string, authorization: string) {
  const url = new URL(`/rest/api/3/issue/${encodeURIComponent(entityId)}/comment`, origin);
  url.searchParams.set("orderBy", "-created");
  url.searchParams.set("maxResults", "20");
  const page = record(await jiraJson(url, authorization), "comments");
  const comments = Array.isArray(page.comments) ? page.comments : [];
  return comments.slice(0, 20).map((value) => {
    const comment = record(value, "comment");
    return {
      id: requiredString(comment.id, "comment id", 255),
      author: person(comment.author, "comment author") ?? "Unknown",
      createdAt: requiredString(comment.created, "comment created", 100),
      body: jiraDescriptionMarkdown(comment.body),
    };
  }).reverse();
}

/**
 * Which of these keys changed in the last `sinceMinutes`: one JQL search per
 * 50 keys (`key in (…) AND updated >= -Nm`, 100 results a page, so a batch is
 * one page). Jira refuses a whole `key in` search when one key no longer
 * exists, so a refused batch is answered from one project search instead
 * (made once per call, at most 10 pages), kept to the batch's keys.
 */
async function changedKeys(origin: URL, project: string, locators: readonly string[], sinceMinutes: number, authorization: string) {
  const keys = [...new Set(locators.map((key) => key.trim().toUpperCase()))]
    .filter((key) => /^[A-Z][A-Z0-9_]*-\d+$/.test(key) && key.startsWith(project + "-"));
  const found: { entityId: string; locator: string }[] = [];
  let byProject: Promise<{ entityId: string; locator: string }[]> | null = null;
  const search = async (jql: string, wanted: ReadonlySet<string> | null) => {
    const hits: { entityId: string; locator: string }[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = record(await jiraJson(new URL("/rest/api/3/search/jql", origin), authorization, {
        method: "POST",
        body: { jql, fields: ["updated"], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) },
      }), "search");
      for (const value of Array.isArray(result.issues) ? result.issues : []) {
        const issue = record(value, "issue");
        const locator = requiredString(issue.key, "key", 255).toUpperCase();
        if (!wanted || wanted.has(locator)) hits.push({ entityId: requiredString(issue.id, "id", 255), locator });
      }
      nextPageToken = typeof result.nextPageToken === "string" ? result.nextPageToken : undefined;
      if (!nextPageToken || result.isLast === true) break;
    }
    return hits;
  };
  for (let index = 0; index < keys.length; index += 50) {
    const batch = keys.slice(index, index + 50);
    const since = `updated >= -${Math.max(1, Math.ceil(sinceMinutes))}m`;
    try {
      found.push(...await search(`key in (${batch.join(",")}) AND ${since}`, new Set(batch)));
    } catch (error) {
      if (!(error instanceof ExtensionError) || error.code !== "invalid-query") throw error;
      byProject ??= search(`project = "${project}" AND ${since} ORDER BY updated DESC`, null);
      const wanted = new Set(batch);
      found.push(...(await byProject).filter((item) => wanted.has(item.locator)));
    }
  }
  return { items: found };
}

async function main() {
  const request = record(await Bun.stdin.json(), "request");
  if (
    (request.contract !== 1 && request.contract !== 2) ||
    !["resolve", "read", "changed"].includes(String(request.operation))
  )
    throw new ExtensionError("invalid-config");
  const input = record(request.input, "input");
  const source = record(input.source, "source");
  const config = record(request.config, "config");
  const credentials = record(request.credentials, "credentials");
  if (!["basic", "bearer"].includes(String(config.authMode)))
    throw new ExtensionError("invalid-config");
  const token = credentials.token;
  if (typeof token !== "string" || !token.trim())
    throw new ExtensionError("credentials-missing");
  const email = config.email;
  if (
    config.authMode === "basic" &&
    (typeof email !== "string" || !email.trim() || email.includes(":"))
  )
    throw new ExtensionError("invalid-config");
  const origin = new URL(String(source.origin));
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new ExtensionError("invalid-config");
  // Plain HTTP is useful only for a local test server. Never send real credentials over it.
  if (
    origin.protocol === "http:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
  )
    throw new ExtensionError("invalid-config");
  const project = source.project;
  if (typeof project !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(project))
    throw new ExtensionError("invalid-config");
  const authorization = authHeader(config, email, token);
  if (request.operation === "changed") {
    const locators = Array.isArray(input.locators) ? input.locators.map(String) : [];
    const sinceMinutes = Number(input.sinceMinutes);
    if (!Number.isFinite(sinceMinutes) || sinceMinutes < 1) throw new ExtensionError("invalid-config");
    return changedKeys(origin, project, locators, sinceMinutes, authorization);
  }
  const sprintField = typeof config.sprintField === "string" && /^[a-z0-9_]{1,64}$/.test(config.sprintField)
    ? config.sprintField
    : "customfield_10020";
  const target =
    request.operation === "resolve"
      ? String(input.locator).trim().toUpperCase()
      : String(input.entityId);
  if (
    request.operation === "resolve" &&
    (!target.startsWith(project + "-") || !/^[A-Z][A-Z0-9_]*-\d+$/.test(target))
  )
    throw new ExtensionError("outside-source");
  if (request.operation === "read" && !/^\d+$/.test(target))
    throw new ExtensionError("invalid-config");
  const url = new URL(
    "/rest/api/3/issue/" + encodeURIComponent(target),
    origin,
  );
  url.searchParams.set(
    "fields",
    request.operation === "resolve"
      ? "summary"
      : `summary,description,status,issuetype,priority,assignee,reporter,labels,updated,${sprintField}`,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        accept: "application/json",
        authorization,
      },
    });
  } catch (error) {
    throw new ExtensionError(
      error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : "network",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ExtensionError(
      (
        { 401: "unauthorized", 403: "forbidden", 404: "not-found", 429: "rate-limited" } as Record<
          number,
          string
        >
      )[response.status] ?? "network",
    );
  }
  if (!response.body) throw new ExtensionError("invalid-response");
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 350000) {
        await reader.cancel();
        throw new ExtensionError("invalid-response");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const sourceContent = Buffer.concat(chunks).toString("utf8");
  const issue = record(JSON.parse(sourceContent), "issue");
  const entityId = requiredString(issue.id, "id", 255),
    locator = requiredString(issue.key, "key", 255).toUpperCase();
  if (!/^\d+$/.test(entityId) || !/^[A-Z][A-Z0-9_]*-\d+$/.test(locator))
    throw new ExtensionError("invalid-response");
  if (!locator.startsWith(project + "-"))
    throw new ExtensionError("outside-source");
  if (request.operation === "read" && entityId !== target)
    throw new ExtensionError("invalid-response");
  if (request.operation === "resolve") return { entityId, locator };
  const fields = record(issue.fields, "fields");
  const title = requiredString(fields.summary, "summary", 4000);
  const metadata = {
    key: locator,
    status: namedValue(fields.status, "status"),
    type: namedValue(fields.issuetype, "type"),
    priority: namedValue(fields.priority, "priority"),
    assignee: fields.assignee
      ? nullableString(
          record(fields.assignee, "assignee").displayName,
          "assignee",
          1000,
        )
      : null,
    labels: stringArray(fields.labels, "labels"),
  };
  const description = jiraDescriptionMarkdown(fields.description);
  const markdown = entityMarkdown(
    title,
    description,
    Object.entries(metadata),
  );
  const updatedAt = requiredString(fields.updated, "updated", 100);
  if (!Number.isFinite(Date.parse(updatedAt)))
    throw new ExtensionError("invalid-response");
  // A ticket that reads but whose comments don't (a permission, a hiccup) keeps its last comments.
  const comments = config.comments === false
    ? undefined
    : await latestComments(origin, entityId, authorization).catch(() => undefined);
  return {
    entityId,
    locator,
    title,
    sourceContent,
    markdown,
    metadata,
    updatedAt,
    externalUrl: new URL("/browse/" + encodeURIComponent(locator), origin).href,
    // Contract 2: what the service keeps as the ticket's block, its fields as
    // `jira.<key>` properties (src/extension-records.ts in the service).
    record: {
      title,
      fields: [
        { key: "status", value: metadata.status },
        { key: "assignee", value: metadata.assignee },
        { key: "type", value: metadata.type },
        { key: "priority", value: metadata.priority },
        { key: "sprint", value: sprintName(fields[sprintField]) },
        { key: "reporter", value: person(fields.reporter, "reporter") },
        { key: "label", value: [...metadata.labels] },
        { key: "updated", value: updatedAt },
      ],
      body: description,
      ...(comments ? { comments } : {}),
    },
  };
}
try {
  console.log(JSON.stringify({ ok: true, value: await main() }));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      code:
        error instanceof ExtensionError
          ? error.code
          : error instanceof Error && error.name === "TimeoutError"
            ? "timeout"
            : "invalid-response",
    }),
  );
}
