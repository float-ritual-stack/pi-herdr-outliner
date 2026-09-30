// A loopback stand-in for enough of Jira Cloud's REST API for the Jira
// extension (extensions/jira): issue reads, comments and the JQL search. Every
// ticket, name and site here is made up. Tests change `issues` and read
// `requests` to see what the extension asked for.
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FakeIssue {
  id: string;
  key: string;
  summary: string;
  description?: string;
  status?: string;
  assignee?: string;
  reporter?: string;
  type?: string;
  priority?: string;
  labels?: string[];
  sprint?: string;
  updated: string;
  comments?: { id: string; author: string; created: string; body: string }[];
}

const adf = (text: string) => ({
  type: "doc",
  version: 1,
  content: text.split("\n\n").map((paragraph) => ({ type: "paragraph", content: [{ type: "text", text: paragraph }] })),
});

export interface FakeJira {
  readonly origin: string;
  readonly issues: Map<string, FakeIssue>;
  readonly requests: string[];
  /** Answer every request after this many milliseconds (to prove a save doesn't wait). */
  delayMs: number;
  /** When set, every request answers with this HTTP status. */
  status: number | null;
  stop(): void;
}

export const FAKE_TOKEN = "made-up-token-for-a-loopback-jira";
export const FAKE_EMAIL = "reader@example.test";

export function startFakeJira(issues: FakeIssue[]): FakeJira {
  const fake: FakeJira = {
    origin: "",
    issues: new Map(issues.map((issue) => [issue.key, issue])),
    requests: [],
    delayMs: 0,
    status: null,
    stop: () => server.stop(true),
  };
  const byIdOrKey = (value: string) => [...fake.issues.values()].find((issue) => issue.id === value || issue.key === value);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      fake.requests.push(`${request.method} ${url.pathname}${url.search}`);
      if (fake.delayMs) await Bun.sleep(fake.delayMs);
      const expected = "Basic " + Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString("base64");
      if (request.headers.get("authorization") !== expected) return new Response("", { status: 401 });
      if (fake.status) return new Response("private error text", { status: fake.status });
      const comment = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(url.pathname);
      if (comment) {
        const issue = byIdOrKey(decodeURIComponent(comment[1]!));
        if (!issue) return new Response("", { status: 404 });
        const newest = [...issue.comments ?? []].sort((a, b) => b.created.localeCompare(a.created));
        return Response.json({
          comments: newest.slice(0, Number(url.searchParams.get("maxResults") ?? 50)).map((entry) => ({
            id: entry.id, author: { displayName: entry.author }, created: entry.created, body: adf(entry.body),
          })),
        });
      }
      const read = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(url.pathname);
      if (read) {
        const issue = byIdOrKey(decodeURIComponent(read[1]!));
        if (!issue) return new Response("", { status: 404 });
        return Response.json({
          id: issue.id,
          key: issue.key,
          fields: {
            summary: issue.summary,
            updated: issue.updated,
            description: issue.description ? adf(issue.description) : null,
            status: issue.status ? { name: issue.status } : null,
            issuetype: issue.type ? { name: issue.type } : null,
            priority: issue.priority ? { name: issue.priority } : null,
            assignee: issue.assignee ? { displayName: issue.assignee } : null,
            reporter: issue.reporter ? { displayName: issue.reporter } : null,
            labels: issue.labels ?? [],
            customfield_10020: issue.sprint ? [{ id: 1, name: issue.sprint, state: "active" }] : null,
          },
        });
      }
      if (url.pathname === "/rest/api/3/search/jql" && request.method === "POST") {
        const body = await request.json() as { jql: string };
        fake.requests.push(`JQL ${body.jql}`);
        const keys = /key in \(([^)]*)\)/.exec(body.jql)?.[1]?.split(",").map((key) => key.trim()) ?? [];
        const minutes = Number(/updated >= -(\d+)m/.exec(body.jql)?.[1] ?? 0);
        if (keys.some((key) => !fake.issues.has(key))) return new Response("", { status: 400 });
        const since = Date.now() - minutes * 60_000;
        const found = [...fake.issues.values()].filter((issue) =>
          (keys.length === 0 || keys.includes(issue.key)) && Date.parse(issue.updated) >= since);
        return Response.json({ issues: found.map((issue) => ({ id: issue.id, key: issue.key, fields: { updated: issue.updated } })), isLast: true });
      }
      return new Response("", { status: 404 });
    },
  });
  (fake as { origin: string }).origin = `http://127.0.0.1:${server.port}`;
  return fake;
}

/**
 * Installs the repo's Jira extension (contract 2) into `extensionsDir/jira`
 * with a config.json for the fake: basic auth, the token from an environment
 * variable the service resolves, and a Source for project PC.
 */
export async function installJira(extensionsDir: string, origin: string, tokenEnv: string): Promise<string> {
  const dir = join(extensionsDir, "jira");
  await mkdir(extensionsDir, { recursive: true });
  await cp(join(import.meta.dir, "../extensions/jira"), dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify({
    config: { authMode: "basic", email: FAKE_EMAIL },
    secrets: { token: { env: tokenEnv } },
    sources: [{ origin, project: "PC" }],
  }));
  return dir;
}
