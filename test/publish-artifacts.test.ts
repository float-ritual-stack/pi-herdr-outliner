import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutlinerClient } from "../src/client";
import { resolvePaths } from "../src/paths";
import { Publisher } from "../src/publish";
import { artifactPackageFor, inlineScript, MERMAID_MODULE, TAILWIND_PLAY_CDN } from "../src/publish-artifacts";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";

// Artifacts as claude.ai downloads them, attached to published blocks. Every
// test uses a throwaway service; the package cache is shared by this file so
// the pinned packages are fetched once.

const packageCache = mkdtempSync(join(tmpdir(), "outliner-artifact-cache-"));
afterAll(() => rmSync(packageCache, { recursive: true, force: true }));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const COMPILE_TIMEOUT = 180_000;
const SANDBOX = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads";

async function setup(options: { artifactCacheDirectory?: string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "outliner-publish-artifacts-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "garden");
  mkdirSync(workspace);
  const paths = resolvePaths({ OUTLINER_STATE_DIR: join(root, "state"), OUTLINER_WORKSPACE_ROOT: workspace });
  const store = new OutlinerStore(paths.database, { workspaceRoot: workspace });
  const server = new OutlinerServer(store, paths.socket);
  await server.start();
  const client = new OutlinerClient(paths.socket);
  const cache = options.artifactCacheDirectory === undefined ? packageCache : options.artifactCacheDirectory;
  const publisher = new Publisher({ client, ...(cache ? { artifactCacheDirectory: cache } : {}) });
  cleanups.push(async () => {
    await publisher.stop();
    await server.close();
    store.close();
  });
  await publisher.start();
  const get = (path: string) => publisher.handle(new Request(`http://127.0.0.1${path}`));
  const write = (relative: string, text: string) => {
    const file = join(workspace, relative);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  return { root, workspace, store, get, write };
}

const HTML_WITH_CDN = `<!doctype html>
<html><head><title>Moth phases</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.21/lodash.min.js"></script></head>
<body><ul id="phases"></ul>
<script>_.forEach(["egg", "caterpillar", "pupa", "moth"], (phase) => {
  const li = document.createElement("li"); li.textContent = phase; document.getElementById("phases").appendChild(li);
});</script></body></html>
`;

const REACT_COUNTER = `import React, { useState } from "react";
import { Plus, Minus, Moon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function MothCounter() {
  const [count, setCount] = useState(0);
  return (
    <Card className="max-w-sm mx-auto mt-8">
      <CardHeader><CardTitle className="flex items-center gap-2"><Moon className="w-5 h-5" /> Moths at the lamp</CardTitle></CardHeader>
      <CardContent className="flex items-center gap-4">
        <Button variant="outline" onClick={() => setCount(count - 1)}><Minus /></Button>
        <span className="text-3xl font-bold" data-testid="count">{count}</span>
        <Button onClick={() => setCount(count + 1)}><Plus /></Button>
      </CardContent>
    </Card>
  );
}
`;

const RECHARTS_CHART = `import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

type Night = { night: string; moths: number };
const nights: Night[] = [
  { night: "Mon", moths: 12 }, { night: "Tue", moths: 19 }, { night: "Wed", moths: 7 },
];

export default function MothChart() {
  return (
    <div className="p-6 h-80">
      <h1 className="text-xl font-semibold mb-4">Moth census</h1>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={nights}><XAxis dataKey="night" /><YAxis /><Tooltip /><Bar dataKey="moths" fill="#8884d8" /></BarChart>
      </ResponsiveContainer>
    </div>
  );
}
`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Luna moth</title><circle cx="50" cy="50" r="30" fill="#9c6"/></svg>
`;

const MERMAID = `flowchart LR
  egg --> caterpillar --> pupa --> moth
  moth -->|"lays <eggs>"| egg
`;

test("an html artifact with a cdnjs script is served as authored, in the opaque-origin sandbox", async () => {
  const { store, get, write } = await setup();
  write("artifacts/moth-phases.html", HTML_WITH_CDN);
  store.create("Moth phases [publish::moth-phases] [file::artifacts/moth-phases.html]");
  const response = await get("/p/moth-phases");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("content-security-policy")).toBe(SANDBOX);
  expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
  expect(await response.text()).toBe(HTML_WITH_CDN);
});

test("a React artifact (.jsx) with lucide-react, shadcn/ui and Tailwind compiles to a sandboxed page", async () => {
  const { store, get, write } = await setup();
  write("artifacts/moth-counter.jsx", REACT_COUNTER);
  store.create("Moth counter [publish::moth-counter] [file::artifacts/moth-counter.jsx]");
  const response = await get("/p/moth-counter");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("content-security-policy")).toBe(SANDBOX);
  const page = await response.text();
  expect(page).toContain(`<script src="${TAILWIND_PLAY_CDN}"></script>`);
  expect(page).toContain("<title>Moth counter</title>");
  expect(page).toContain("Moths at the lamp");
  expect(page).toContain('<div id="root"></div>');
  // The bundle carries React itself; nothing is imported at run time.
  const module = page.slice(page.indexOf('<script type="module">'));
  expect(module).not.toMatch(/from\s*["']react["']/);
  expect(module).not.toMatch(/^<script type="module">\s*import\b/);
  expect(module.match(/<\/script/gi)).toHaveLength(1);

  // The source is one request away, and the compiled bundle is cached by content.
  expect(await (await get("/p/moth-counter?view=source")).text()).toBe(REACT_COUNTER);
  const builds = readdirSync(join(packageCache, "builds")).length;
  expect(await (await get("/p/moth-counter")).text()).toBe(page);
  expect(readdirSync(join(packageCache, "builds")).length).toBe(builds);

  // Editing the file compiles the new source.
  write("artifacts/moth-counter.jsx", REACT_COUNTER.replace("Moths at the lamp", "Moths at the sheet"));
  const edited = await (await get("/p/moth-counter")).text();
  expect(edited).toContain("Moths at the sheet");
  expect(edited).not.toContain("Moths at the lamp");
}, COMPILE_TIMEOUT);

test("a recharts chart in a .tsx artifact compiles", async () => {
  const { store, get, write } = await setup();
  write("artifacts/moth-chart.tsx", RECHARTS_CHART);
  store.create("Moth census chart [publish::moth-chart] [file::artifacts/moth-chart.tsx]");
  const response = await get("/p/moth-chart");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toBe(SANDBOX);
  expect(await response.text()).toContain("Moth census");
}, COMPILE_TIMEOUT);

test("a compile error is a readable page naming the line, with no paths from this machine", async () => {
  const { root, store, get, write } = await setup();
  write("artifacts/broken.jsx", "import { useState } from \"react\";\nexport default function Broken( {\n  return <p>half a moth</p>;\n}\n");
  store.create("Broken artifact [publish::broken] [file::artifacts/broken.jsx]");
  const response = await get("/p/broken");
  expect(response.status).toBe(422);
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  const page = await response.text();
  expect(page).toContain("This artifact does not compile");
  expect(page).toContain("line 3");
  for (const secret of [packageCache, root, tmpdir(), "node_modules", "at "]) expect(page).not.toContain(secret);

  write("artifacts/unknown-icon.jsx", "import { NotAMothIcon } from \"lucide-react\";\nexport default () => <NotAMothIcon />;\n");
  store.create("Unknown icon [publish::unknown-icon] [file::artifacts/unknown-icon.jsx]");
  const unknown = await (await get("/p/unknown-icon")).text();
  expect(unknown).toContain("NotAMothIcon");
  expect(unknown).not.toContain(packageCache);
}, COMPILE_TIMEOUT);

test("an artifact may import only the pinned packages and shadcn/ui: files, paths and URLs are refused", async () => {
  const { store, get, write } = await setup();
  write("artifacts/secret.txt", "the neighbour's gate code");
  const cases: Record<string, string> = {
    "left-pad": "import pad from \"left-pad\";\nexport default () => <p>{pad(\"moth\", 8)}</p>;\n",
    relative: "import gate from \"./secret.txt\" with { type: \"text\" };\nexport default () => <p>{gate}</p>;\n",
    absolute: "import hosts from \"/etc/hosts\" with { type: \"text\" };\nexport default () => <p>{hosts}</p>;\n",
    url: "import confetti from \"https://esm.sh/canvas-confetti\";\nexport default () => <p>{String(confetti)}</p>;\n",
    escape: "import x from \"react/../../package.json\";\nexport default () => <p>{String(x)}</p>;\n",
  };
  for (const [name, source] of Object.entries(cases)) {
    write(`artifacts/${name}.jsx`, source);
    store.create(`Refused ${name} [publish::refused-${name}] [file::artifacts/${name}.jsx]`);
    const response = await get(`/p/refused-${name}`);
    expect(response.status).toBe(422);
    const page = await response.text();
    expect(page).toContain("is not available");
    expect(page).not.toContain("gate code");
  }
  expect(artifactPackageFor("recharts")).toBe("recharts");
  expect(artifactPackageFor("lodash/debounce")).toBe("lodash");
  expect(artifactPackageFor("plotly")).toBe("plotly.js-dist-min");
  expect(artifactPackageFor("d3-scale")).toBe("d3");
  expect(artifactPackageFor("@/components/ui/card")).toBeNull();
  expect(artifactPackageFor("react/../x")).toBeNull();
}, COMPILE_TIMEOUT);

test("compiling never runs the artifact's code: a macro import is refused, not executed", async () => {
  const { root, store, get, write } = await setup();
  const marker = join(root, "macro-ran");
  const macro = write("artifacts/lamp.ts", `export function lamp() { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); return "on"; }\n`);
  write("artifacts/macro.jsx", `import { lamp } from ${JSON.stringify(macro)} with { type: "macro" };\nexport default () => <p>{lamp()}</p>;\n`);
  store.create("Macro [publish::macro] [file::artifacts/macro.jsx]");
  const response = await get("/p/macro");
  expect(response.status).toBe(422);
  expect(existsSync(marker)).toBe(false);
}, COMPILE_TIMEOUT);

test("an svg artifact is served as svg in the sandbox; a mermaid artifact gets a page that draws it", async () => {
  const { store, get, write } = await setup();
  write("artifacts/luna.svg", SVG);
  write("artifacts/life-cycle.mermaid", MERMAID);
  write("artifacts/life-cycle-short.mmd", MERMAID);
  store.create("Luna moth [publish::luna] [file::artifacts/luna.svg]");
  store.create("Life cycle [publish::life-cycle] [file::artifacts/life-cycle.mermaid]");
  store.create("Life cycle, short [publish::life-cycle-short] [file::artifacts/life-cycle-short.mmd]");

  const svg = await get("/p/luna");
  expect(svg.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
  expect(svg.headers.get("content-security-policy")).toBe(SANDBOX);
  expect(await svg.text()).toBe(SVG);

  for (const slug of ["life-cycle", "life-cycle-short"]) {
    const response = await get(`/p/${slug}`);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(SANDBOX);
    const page = await response.text();
    expect(page).toContain(MERMAID_MODULE);
    // The diagram is text in the page, never markup.
    expect(page).toContain("moth --&gt;|&quot;lays &lt;eggs&gt;&quot;| egg");
    expect(page).not.toContain("<eggs>");
  }
  expect(await (await get("/p/life-cycle?view=source")).text()).toBe(MERMAID);
});

test("a code artifact is plain text; the index says what each artifact is", async () => {
  const { store, get, write } = await setup({ artifactCacheDirectory: null });
  write("artifacts/count_moths.py", "print(sum([12, 19, 7]))\n");
  write("artifacts/moth-counter.jsx", REACT_COUNTER);
  write("artifacts/luna.svg", SVG);
  store.create("Count moths [publish::count-moths] [file::artifacts/count_moths.py]");
  store.create("Moth counter [publish::moth-counter] [file::artifacts/moth-counter.jsx]");
  store.create("Luna moth [publish::luna] [file::artifacts/luna.svg]");
  const code = await get("/p/count-moths");
  expect(code.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await code.text()).toBe("print(sum([12, 19, 7]))\n");
  const index = await (await get("/index.txt")).text();
  expect(index).toMatch(/react\s+\S+ \S+\s+\/p\/moth-counter/);
  expect(index).toMatch(/svg\s+\S+ \S+\s+\/p\/luna/);
  // A publisher without a package cache says so instead of compiling.
  const uncompiled = await get("/p/moth-counter");
  expect(uncompiled.status).toBe(503);
  expect(await uncompiled.text()).toContain("not compiled");
});

test("a bundle inlined in the page cannot close its script element", () => {
  expect(inlineScript('const tag = "</script><script>alert(1)</script>"; /<!--x/;'))
    .toBe('const tag = "<\\/script><script>alert(1)<\\/script>"; /<\\x21--x/;');
});
