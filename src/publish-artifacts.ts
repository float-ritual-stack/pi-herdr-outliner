import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Artifacts as claude.ai runs them, for the publisher (README "Publishing
 * blocks"). A React artifact (`.jsx`/`.tsx`, one file with a default-exported
 * component) is bundled here with `Bun.build` into one script and wrapped in a
 * page that mounts it; a mermaid diagram gets a page that renders it from a
 * CDN. The page itself is served sandboxed, like an attached `.html` file.
 *
 * The bundler only reads and rewrites code; it never runs it. Macros (the one
 * way `Bun.build` executes code while bundling) are turned off, and a plugin
 * decides every import the artifact makes: a package from the pinned set
 * below (fetched on first use into the dependency cache, with install scripts
 * off), a shadcn/ui component from the publisher's own shims, or nothing.
 * Relative paths, absolute paths, URLs and anything else are refused, so the
 * build reads no file but the artifact (handed over in memory) and the cache.
 */

/**
 * Packages a React artifact may import, pinned. The set is claude.ai's: React
 * 18, lucide-react, recharts, lodash, mathjs, papaparse, d3, three (r128),
 * SheetJS, Chart.js, Plotly, Tone, mammoth and TensorFlow.js.
 */
export const ARTIFACT_PACKAGES: Readonly<Record<string, string>> = {
  react: "18.3.1",
  "react-dom": "18.3.1",
  "lucide-react": "0.577.0",
  recharts: "2.15.4",
  lodash: "4.17.21",
  mathjs: "15.2.0",
  papaparse: "5.5.3",
  d3: "7.9.0",
  three: "0.128.0",
  xlsx: "0.18.5",
  "chart.js": "4.5.1",
  "plotly.js-dist-min": "2.35.3",
  tone: "15.1.22",
  mammoth: "1.13.0",
  "@tensorflow/tfjs": "4.22.0",
};

/** Import names claude.ai uses for a package published under another name. */
const PACKAGE_ALIASES: Readonly<Record<string, string>> = {
  plotly: "plotly.js-dist-min",
  "plotly.js": "plotly.js-dist-min",
};

/** Tailwind's Play CDN, pinned: it builds the utility classes the page uses, in the browser. */
export const TAILWIND_PLAY_CDN = "https://cdn.tailwindcss.com/3.4.17";
export const MERMAID_MODULE = "https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.esm.min.mjs";

/** Changes to the build (options, entry) change this, so old cached bundles are not reused. */
const COMPILER_REVISION = "2";
/** A bundle larger than this is refused rather than served. */
export const MAX_ARTIFACT_BUNDLE_BYTES = 16 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 180_000;
const MEMORY_CACHE_ENTRIES = 24;
/** Bundles kept in memory, in bytes: each can be up to 16 MiB. */
const MEMORY_CACHE_BYTES = 64 * 1024 * 1024;
const DISK_CACHE_ENTRIES = 200;
/** Bundles kept in `builds/`, in bytes, so the cache cannot fill the disk. */
const DISK_CACHE_BYTES = 256 * 1024 * 1024;
/** A fetch or build that failed for a passing reason is not tried again for this long. */
const TRANSIENT_RETRY_MS = 30_000;

/**
 * Where the bundle would otherwise say where it was built: `__dirname`,
 * `import.meta.dir`, `module.id` and the rest are replaced by fixed values, in
 * the artifact and in the packages alike, so no path on this machine reaches a
 * reader.
 */
const PATH_FREE_DEFINES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries({
  __dirname: "/",
  __filename: "/artifact.js",
  "import.meta.dir": "/",
  "import.meta.dirname": "/",
  "import.meta.path": "/artifact.js",
  "import.meta.filename": "/artifact.js",
  "import.meta.file": "artifact.js",
  "import.meta.url": "file:///artifact.js",
  "module.filename": "/artifact.js",
  "module.path": "/",
}).map(([name, value]) => [name, JSON.stringify(value)]));

const SHIMS_SOURCE = join(import.meta.dir, "publish-artifact-ui.jsx");

type Remembered = { build: ArtifactBuild; until?: number };

export type ArtifactBuild =
  | { ok: true; script: string; cached: "memory" | "disk" | "built" }
  | { ok: false; problems: string[]; transient?: boolean };

export interface ArtifactCompilerOptions {
  /** Holds `node_modules` for the pinned packages and `builds/<hash>.js`. */
  cacheDirectory: string;
  log?: (line: string) => void;
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** The pinned package an import needs, or null when the artifact may not import it. */
export function artifactPackageFor(specifier: string): string | null {
  if (!specifier || specifier.includes("\0") || specifier.includes("\\") || specifier.includes(":")) return null;
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) return null;
  if (specifier.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) return null;
  const name = PACKAGE_ALIASES[packageName(specifier)] ?? packageName(specifier);
  if (ARTIFACT_PACKAGES[name]) return name;
  // d3's own modules (d3-scale, d3-shape, …) come with d3.
  if (/^d3-[a-z-]+$/.test(name)) return "d3";
  return null;
}

/**
 * A readable reason with no file system paths: the cache's and the
 * publisher's own folders become names, and any other absolute path becomes
 * its last segment.
 */
function scrub(text: string, cacheDirectory: string): string {
  return text
    .split(join(cacheDirectory, "node_modules") + "/").join("")
    .split(cacheDirectory + "/").join("")
    .replace(/(?:\.\.?\/)+/g, "")
    .replace(/(^|[\s"'(])node_modules\//g, "$1")
    .replace(/(^|[\s"'(])(?:\/[\w.@~+-]+)+\/([\w.@~+-]+)/g, "$1$2");
}

/**
 * `module.id` is written into the bundle as the file's path from the working
 * directory, which no `define` replaces; the cache's own folder is taken out of
 * it (both spellings), so it names only `artifact/…` or a package's file.
 */
function withoutCachePaths(script: string, cacheDirectory: string): string {
  const fromHere = relative(process.cwd(), cacheDirectory);
  const spellings = [...new Set([cacheDirectory, cacheDirectory.replace(/^\/+/, ""), fromHere].filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  let result = script;
  for (const spelling of spellings) result = result.split(`${spelling}/`).join("");
  return result;
}

/** Escapes a bundle so it can sit inside `<script>` without ending it early. */
export function inlineScript(script: string): string {
  return script.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\x21--");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** Mounts the artifact's default export (or its only exported component) under an error boundary. */
const ENTRY_SOURCE = `
import * as Artifact from "./artifact";
import { Component, createElement } from "react";
import { createRoot } from "react-dom/client";
const App = typeof Artifact.default === "function" || (Artifact.default && typeof Artifact.default === "object")
  ? Artifact.default
  : Object.values(Artifact).find((value) => typeof value === "function");
class Boundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return createElement("pre", { className: "artifact-error" },
      "This artifact failed while running:\\n\\n" + String(this.state.error && this.state.error.message || this.state.error));
  }
}
const root = createRoot(document.getElementById("root"));
root.render(App
  ? createElement(Boundary, null, createElement(App))
  : createElement("pre", { className: "artifact-error" }, "This artifact has no default export to show."));
`;

export class ArtifactCompiler {
  readonly cacheDirectory: string;
  private readonly log: (line: string) => void;
  private readonly memory = new Map<string, Remembered>();
  private readonly shims = readFileSync(SHIMS_SOURCE, "utf8");
  private readonly inFlight = new Map<string, Promise<ArtifactBuild>>();
  /** One build or install at a time: the host is shared with the outline. */
  private queue: Promise<unknown> = Promise.resolve();
  /** A build that ran past its time and is still going; the queue waits for it. */
  private lingering: Promise<unknown> = Promise.resolve();

  constructor(options: ArtifactCompilerOptions) {
    this.cacheDirectory = options.cacheDirectory;
    this.log = options.log ?? (() => {});
  }

  /** Compiles a React artifact, from cache when this exact source was built before. */
  compile(source: string, extension: ".jsx" | ".tsx"): Promise<ArtifactBuild> {
    // The shims and the bundler's version are part of the key, so a new publisher never serves an old bundle.
    const key = sha256(`${COMPILER_REVISION}\0${Bun.version}\0${sha256(this.shims)}\0${JSON.stringify(ARTIFACT_PACKAGES)}\0${extension}\0${source}`);
    const remembered = this.memory.get(key);
    if (remembered && (remembered.until === undefined || remembered.until > Date.now())) {
      this.remember(key, remembered.build, remembered.until);
      const build = remembered.build;
      return Promise.resolve(build.ok ? { ...build, cached: "memory" } : build);
    }
    if (remembered) this.memory.delete(key);
    const onDisk = join(this.cacheDirectory, "builds", `${key}.js`);
    if (existsSync(onDisk)) {
      const build: ArtifactBuild = { ok: true, script: readFileSync(onDisk, "utf8"), cached: "disk" };
      this.remember(key, build);
      return Promise.resolve(build);
    }
    const running = this.inFlight.get(key);
    if (running) return running;
    const job = this.enqueue(() => this.build(source, extension))
      .catch((error): ArtifactBuild => {
        this.log(`publish: artifact build: ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, problems: ["The publisher could not build this artifact."], transient: true };
      })
      .then((build) => {
        if (build.ok) this.store(key, build.script);
        // A compile error stays until the source changes; a failed fetch is tried again after a pause,
        // so reloads while offline do not start one `bun add` after another.
        this.remember(key, build, !build.ok && build.transient ? Date.now() + TRANSIENT_RETRY_MS : undefined);
        return build;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {}).then(() => this.lingering);
    return next;
  }

  private remember(key: string, build: ArtifactBuild, until?: number): void {
    this.memory.delete(key);
    this.memory.set(key, until === undefined ? { build } : { build, until });
    const size = () => [...this.memory.values()].reduce((total, entry) => total + (entry.build.ok ? entry.build.script.length : 0), 0);
    while (this.memory.size > 1 && (this.memory.size > MEMORY_CACHE_ENTRIES || size() > MEMORY_CACHE_BYTES)) {
      this.memory.delete(this.memory.keys().next().value!);
    }
  }

  private store(key: string, script: string): void {
    const builds = join(this.cacheDirectory, "builds");
    try {
      mkdirSync(builds, { recursive: true });
      const temporary = join(builds, `.${key}.${process.pid}.tmp`);
      writeFileSync(temporary, script);
      renameSync(temporary, join(builds, `${key}.js`));
      const files = readdirSync(builds).filter((name) => name.endsWith(".js") || name.endsWith(".tmp"))
        .map((name) => { const stat = statSync(join(builds, name)); return { name, at: stat.mtimeMs, size: stat.size }; })
        .sort((left, right) => right.at - left.at);
      let kept = 0;
      let bytes = 0;
      for (const file of files) {
        // A temporary file is from a write that failed; the newest bundle is always kept.
        const keep = file.name.endsWith(".js") && (kept === 0 || (kept < DISK_CACHE_ENTRIES && bytes + file.size <= DISK_CACHE_BYTES));
        if (keep) {
          kept += 1;
          bytes += file.size;
        } else if (file.name !== `.${key}.${process.pid}.tmp`) unlinkSync(join(builds, file.name));
      }
    } catch (error) {
      this.log(`publish: artifact cache: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private installedVersion(name: string): string | null {
    try {
      const manifest = JSON.parse(readFileSync(join(this.cacheDirectory, "node_modules", name, "package.json"), "utf8")) as { version?: string };
      return manifest.version ?? null;
    } catch {
      return null;
    }
  }

  /** Installs pinned packages into the cache with `bun add`, never running their install scripts. */
  private async install(names: readonly string[]): Promise<string | null> {
    mkdirSync(this.cacheDirectory, { recursive: true });
    const manifest = join(this.cacheDirectory, "package.json");
    if (!existsSync(manifest)) writeFileSync(manifest, `${JSON.stringify({ name: "outliner-artifact-packages", private: true }, null, 2)}\n`);
    const specs = names.map((name) => `${name}@${ARTIFACT_PACKAGES[name]}`);
    this.log(`publish: fetching artifact packages ${specs.join(" ")}`);
    const child = Bun.spawn([process.execPath, "add", "--exact", "--ignore-scripts", "--no-progress", ...specs], {
      cwd: this.cacheDirectory,
      env: { ...process.env, NO_COLOR: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: INSTALL_TIMEOUT_MS,
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code === 0) return null;
    this.log(`publish: bun add failed (${code}): ${stderr.trim().split("\n").slice(-3).join(" / ")}`);
    return `The packages ${names.join(", ")} could not be fetched; try again later.`;
  }

  private async build(source: string, extension: ".jsx" | ".tsx"): Promise<ArtifactBuild> {
    const needed = new Set<string>(["react", "react-dom"]);
    let attempt = await this.bundle(source, extension, needed);
    const missing = [...needed].filter((name) => this.installedVersion(name) !== ARTIFACT_PACKAGES[name]);
    if (missing.length) {
      const failure = await this.install(missing);
      if (failure) return { ok: false, problems: [failure], transient: true };
      attempt = await this.bundle(source, extension, needed);
    }
    return attempt;
  }

  private async bundle(source: string, extension: ".jsx" | ".tsx", needed: Set<string>): Promise<ArtifactBuild> {
    mkdirSync(join(this.cacheDirectory, "artifact"), { recursive: true });
    // The bundler names every file by its real path (macOS's /tmp and /var are links to /private/…), so the
    // cache is named that way too: otherwise no import from a pinned package looks like it comes from the cache.
    const cache = realpathSync(this.cacheDirectory);
    const workspace = join(cache, "artifact");
    const entry = join(workspace, "entry.jsx");
    const artifact = join(workspace, `artifact${extension}`);
    const shims = join(workspace, "ui.jsx");
    const modules = join(cache, "node_modules") + "/";
    const refused: string[] = [];
    const absent = new Set<string>();
    const guard: Bun.BunPlugin = {
      name: "artifact-imports",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (args.path === entry || args.path === artifact || args.path === shims) return { path: args.path };
          const importer = args.importer;
          // The pinned packages import each other and their own files as they were published.
          if (importer.startsWith(modules)) return undefined;
          if (importer === entry && args.path === "./artifact") return { path: artifact };
          if (importer !== entry && importer !== artifact && importer !== shims) {
            refused.push(args.path);
            return { path: args.path, namespace: "refused" };
          }
          if (/^@\/components\/ui\/[a-z0-9-]+$/.test(args.path) || args.path === "@/lib/utils") return { path: shims };
          const name = artifactPackageFor(args.path);
          if (!name) {
            refused.push(args.path);
            return { path: args.path, namespace: "refused" };
          }
          needed.add(name);
          if (!existsSync(join(cache, "node_modules", name, "package.json"))) {
            absent.add(name);
            return { path: args.path, namespace: "absent" };
          }
          const alias = PACKAGE_ALIASES[packageName(args.path)];
          if (alias) return { path: Bun.resolveSync(alias + args.path.slice(packageName(args.path).length), cache) };
          // The package the import names must be in the cache itself (a `d3-*` module comes with d3):
          // otherwise the resolver would look in node_modules folders above the cache.
          if (!existsSync(join(cache, "node_modules", packageName(args.path), "package.json"))) {
            refused.push(args.path);
            return { path: args.path, namespace: "refused" };
          }
          return undefined;
        });
        builder.onLoad({ filter: /.*/, namespace: "refused" }, () => ({ contents: "export default undefined;", loader: "js" }));
        builder.onLoad({ filter: /.*/, namespace: "absent" }, () => ({ contents: "export default undefined;", loader: "js" }));
      },
    };
    const build = Bun.build({
      entrypoints: [entry],
      files: { [entry]: ENTRY_SOURCE, [artifact]: source, [shims]: this.shims },
      target: "browser",
      format: "esm",
      minify: true,
      splitting: false,
      throw: false,
      env: "disable",
      // Bun.build runs a `with { type: "macro" }` import at bundle time; this turns that off.
      macros: false,
      jsx: { runtime: "automatic", importSource: "react" },
      define: { ...PATH_FREE_DEFINES, "process.env.NODE_ENV": "\"production\"" },
      plugins: [guard],
    } as Bun.BuildConfig);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), BUILD_TIMEOUT_MS); });
    const result = await Promise.race([build, timeout]).finally(() => clearTimeout(timer));
    if (!result) {
      // Bun.build cannot be stopped: the next build or fetch waits until this one ends, so a slow
      // artifact never has two builds running. The failure stays until the source changes.
      this.lingering = build.catch(() => {});
      return { ok: false, problems: [`Compiling took longer than ${BUILD_TIMEOUT_MS / 1000} seconds.`] };
    }
    if (refused.length) {
      const allowed = [...Object.keys(ARTIFACT_PACKAGES), ...Object.keys(PACKAGE_ALIASES), "@/components/ui/*"].join(", ");
      return {
        ok: false,
        problems: [...new Set(refused)].map((path) => `Import "${scrub(path, cache)}" is not available. An artifact may import: ${allowed}.`),
      };
    }
    if (absent.size) return { ok: false, problems: ["Packages are still being fetched."], transient: true };
    if (!result.success) {
      const problems = result.logs.filter((log) => log.level === "error").map((log) => {
        const position = log.position;
        const where = position && position.file === artifact
          ? `line ${position.line}, column ${position.column + 1}: ` : "";
        const line = position && position.file === artifact && position.lineText ? `\n    ${position.lineText.trim()}` : "";
        const message = log.message.split(artifact).join(`artifact${extension}`).split(shims).join("@/components/ui");
        return `${where}${scrub(message, cache)}${line}`;
      });
      // A syntax error cascades; the first few say what is wrong.
      return { ok: false, problems: problems.length ? problems.slice(0, 5) : ["The artifact could not be compiled."] };
    }
    const output = result.outputs.find((file) => file.kind === "entry-point") ?? result.outputs[0];
    if (!output) return { ok: false, problems: ["The artifact compiled to nothing."] };
    if (output.size > MAX_ARTIFACT_BUNDLE_BYTES) {
      return { ok: false, problems: [`The compiled artifact is larger than ${MAX_ARTIFACT_BUNDLE_BYTES} bytes.`] };
    }
    return { ok: true, script: withoutCachePaths(await output.text(), cache), cached: "built" };
  }
}

/** The page that runs a compiled React artifact: Tailwind from its Play CDN, the bundle inline. */
export function reactArtifactPage(title: string, script: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<script src="${TAILWIND_PLAY_CDN}"></script>
<style>.artifact-error{margin:1rem;padding:1rem;border:1px solid #c33;color:#900;background:#fff5f5;white-space:pre-wrap;font:14px/1.45 ui-monospace,Menlo,monospace}</style>
</head><body>
<div id="root"></div>
<script>addEventListener("error",function(e){var p=document.createElement("pre");p.className="artifact-error";p.textContent="This artifact failed while running:\\n\\n"+(e.message||e.error);document.body.appendChild(p)});</script>
<script type="module">${inlineScript(script)}</script>
</body></html>
`;
}

/** A page that renders a mermaid diagram with mermaid from its CDN; the diagram source is text, not markup. */
export function mermaidArtifactPage(title: string, diagram: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;padding:1.5rem;font:15px/1.5 system-ui,sans-serif}
.mermaid{display:flex;justify-content:center}.artifact-error{padding:1rem;border:1px solid #c33;white-space:pre-wrap;font:14px/1.45 ui-monospace,Menlo,monospace}</style>
</head><body>
<pre class="mermaid">${escapeHtml(diagram)}</pre>
<script type="module">
import mermaid from "${MERMAID_MODULE}";
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
try { await mermaid.run(); } catch (error) {
  const pre = document.createElement("pre"); pre.className = "artifact-error";
  pre.textContent = "This diagram could not be drawn:\\n\\n" + (error && error.message || error);
  document.body.appendChild(pre);
}
</script>
</body></html>
`;
}
