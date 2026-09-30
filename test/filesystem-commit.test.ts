import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { OutlinerStore } from "../src/store";
import { createHash, randomUUID } from "node:crypto";

test("pending recovery cannot publish a symlink outside a confined Source", () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/outliner-file-recovery-boundary-"));
  const sourceRoot = join(root, "source");
  fs.mkdirSync(sourceRoot);
  const path = join(sourceRoot, "note.txt");
  const outside = join(root, "outside.txt");
  fs.writeFileSync(path, "ORIGINAL");
  fs.writeFileSync(outside, "OUTSIDE-SOURCE-SENTINEL");
  const store = new OutlinerStore(join(root, "outline.sqlite"));
  try {
    const source = store.resources.createSource({ name: "confined", provider: "filesystem",
      boundary: { root: sourceRoot }, policy: { deniedCapabilities: [] } });
    const resource = store.resources.intern({ sourceId: source.id,
      address: { kind: "filesystem", path: "note.txt" } }).resource;
    fs.unlinkSync(path);
    const name = `.outliner-save-${randomUUID()}`;
    const directory = join(sourceRoot, name);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(join(directory, "save.json"), JSON.stringify({ target: "note.txt" }));
    fs.symlinkSync(outside, join(directory, "original"));
    const marker = join(sourceRoot, `.outliner-save-${createHash("sha256").update("note.txt").digest("hex").slice(0, 24)}.pending`);
    fs.writeFileSync(marker, name);
    const description = store.resources.describe(resource.id, true);
    expect(description.filesystem).toBeNull();
    expect(fs.existsSync(path)).toBe(false);
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("OUTSIDE-SOURCE-SENTINEL");
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// Each root is a real path: the store writes through real paths, and on macOS /tmp is a link to /private/tmp.
for (const writerKind of ["in-place", "replacement"] as const) {
test(`a ${writerKind} writer at the filesystem commit boundary retains its bytes and the submitted draft`, () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/outliner-file-commit-"));
  const path = join(root, "note.txt");
  const store = new OutlinerStore(join(root, "outline.sqlite"));
  const rename = fs.renameSync;
  let intercepted = false;
  let trap: ReturnType<typeof spyOn> | undefined;
  try {
    fs.writeFileSync(path, "ORIGINAL");
    const resource = store.resources.internFilesystem({ path }).resource;
    const opened = store.resources.describe(resource.id, true).filesystem!;
    trap = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!intercepted && (String(from) === path || String(to) === path)) {
        intercepted = true;
        const writer = Bun.spawnSync([
          process.execPath, "-e",
          writerKind === "in-place"
            ? 'require("node:fs").writeFileSync(process.argv[1], "EXTERNAL-WINNER")'
            : 'const fs=require("node:fs"),p=process.argv[1]; fs.writeFileSync(p+".external","EXTERNAL-WINNER"); fs.renameSync(p+".external",p)', path,
        ]);
        expect(writer.exitCode).toBe(0);
      }
      rename(from, to);
    });
    expect(() => store.resources.writeFilesystem({
      resourceId: resource.id, expectedRevision: opened.revision, text: "OUTLINER-DRAFT",
    })).toThrow(/changed during save.*Recoverable files:/);
    expect(intercepted).toBe(true);
    expect(fs.readFileSync(path, "utf8")).toBe("EXTERNAL-WINNER");
    const retained = fs.readdirSync(root).filter(name => name.startsWith(".outliner-save-") && fs.statSync(join(root, name)).isDirectory());
    expect(retained).toHaveLength(1);
    expect(fs.readFileSync(join(root, retained[0]!, "draft"), "utf8")).toBe("OUTLINER-DRAFT");
    expect(fs.readFileSync(join(root, retained[0]!, "original"), "utf8")).toBe("EXTERNAL-WINNER");
  } finally {
    trap?.mockRestore();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
}

test("a replacement created after displacement wins without destroying either earlier version", () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/outliner-file-create-"));
  const path = join(root, "note.txt");
  const store = new OutlinerStore(join(root, "outline.sqlite"));
  const link = fs.linkSync;
  let intercepted = false;
  let trap: ReturnType<typeof spyOn> | undefined;
  try {
    fs.writeFileSync(path, "ORIGINAL");
    const resource = store.resources.internFilesystem({ path }).resource;
    const opened = store.resources.describe(resource.id, true).filesystem!;
    trap = spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (!intercepted && String(to) === path) {
        intercepted = true;
        const writer = Bun.spawnSync([
          process.execPath, "-e",
          'require("node:fs").writeFileSync(process.argv[1], "EXTERNAL-CREATE", {flag:"wx"})', path,
        ]);
        expect(writer.exitCode).toBe(0);
      }
      link(from, to);
    });
    expect(() => store.resources.writeFilesystem({
      resourceId: resource.id, expectedRevision: opened.revision, text: "OUTLINER-DRAFT",
    })).toThrow(/changed during save.*Recoverable files:/);
    expect(intercepted).toBe(true);
    expect(fs.readFileSync(path, "utf8")).toBe("EXTERNAL-CREATE");
    const directory = join(root, fs.readdirSync(root).find(name => name.startsWith(".outliner-save-") && fs.statSync(join(root, name)).isDirectory())!);
    expect(fs.readFileSync(join(directory, "original"), "utf8")).toBe("ORIGINAL");
    expect(fs.readFileSync(join(directory, "draft"), "utf8")).toBe("OUTLINER-DRAFT");
  } finally {
    trap?.mockRestore(); store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an external descriptor opened before a successful save remains recoverable afterward", () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/outliner-file-descriptor-"));
  const path = join(root, "note.txt");
  const store = new OutlinerStore(join(root, "outline.sqlite"));
  let fd: number | undefined;
  try {
    fs.writeFileSync(path, "ORIGINAL", { mode: 0o640 });
    const resource = store.resources.internFilesystem({ path }).resource;
    const opened = store.resources.describe(resource.id, true).filesystem!;
    fd = fs.openSync(path, "r+");
    const saved = store.resources.writeFilesystem({
      resourceId: resource.id, expectedRevision: opened.revision, text: "OUTLINER-DRAFT",
    });
    expect(saved.text).toBe("OUTLINER-DRAFT");
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, "LATE-EXTERNAL");
    fs.fsyncSync(fd);
    const directory = join(root, fs.readdirSync(root).find(name => name.startsWith(".outliner-save-") && fs.statSync(join(root, name)).isDirectory())!);
    expect(fs.readFileSync(path, "utf8")).toBe("OUTLINER-DRAFT");
    expect(fs.readFileSync(join(directory, "original"), "utf8")).toBe("LATE-EXTERNAL");
    expect(fs.readFileSync(join(directory, "draft"), "utf8")).toBe("OUTLINER-DRAFT");
    expect(fs.statSync(path).mode & 0o777).toBe(0o640);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(join(directory, "draft")).mode & 0o777).toBe(0o600);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const phase of ["before-displacement", "after-displacement", "after-publication", "after-marker-removal", "recreated-before-recovery"] as const) {
  test(`process interruption ${phase} recovers without discarding either version`, () => {
    const root = fs.realpathSync(fs.mkdtempSync("/tmp/outliner-file-crash-"));
    const path = join(root, "note.txt");
    let store = new OutlinerStore(join(root, "outline.sqlite"));
    try {
      fs.writeFileSync(path, "ORIGINAL", { mode: 0o600 });
      const resource = store.resources.internFilesystem({ path }).resource;
      store.close();
      const child = Bun.spawnSync([process.execPath, "-e", `
        import { spyOn } from "bun:test";
        import * as fs from "node:fs";
        import { OutlinerStore } from ${JSON.stringify(import.meta.resolve("../src/store"))};
        const [root, id, phase] = process.argv.slice(1);
        const path = root + "/note.txt";
        const store = new OutlinerStore(root + "/outline.sqlite");
        const opened = store.resources.describe(id, true).filesystem;
        const kill = () => { process.kill(process.pid, "SIGKILL"); };
        const rename = fs.renameSync, link = fs.linkSync, unlink = fs.unlinkSync;
        spyOn(fs, "renameSync").mockImplementation((from, to) => {
          if (String(from) === path && phase === "before-displacement") kill();
          rename(from, to);
          if (String(from) === path && (phase === "after-displacement" || phase === "recreated-before-recovery")) kill();
        });
        spyOn(fs, "linkSync").mockImplementation((from, to) => {
          link(from, to);
          if (String(to) === path && phase === "after-publication") kill();
        });
        spyOn(fs, "unlinkSync").mockImplementation(path => {
          unlink(path);
          if (String(path).endsWith(".pending") && phase === "after-marker-removal") kill();
        });
        store.resources.writeFilesystem({resourceId:id, expectedRevision:opened.revision, text:"OUTLINER-DRAFT"});
        throw new Error("Fault barrier was not reached");
      `, root, resource.id, phase]);
      expect(child.signalCode).toBe("SIGKILL");
      if (phase === "after-displacement") expect(fs.existsSync(path)).toBe(false);
      if (phase === "recreated-before-recovery") fs.writeFileSync(path, "EXTERNAL-CREATE", { mode: 0o600, flag: "wx" });
      store = new OutlinerStore(join(root, "outline.sqlite"));
      const recovered = store.resources.describe(resource.id, true).filesystem!;
      expect(recovered.text).toBe(phase === "recreated-before-recovery" ? "EXTERNAL-CREATE" : phase === "before-displacement" || phase === "after-displacement" ? "ORIGINAL" : "OUTLINER-DRAFT");
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
      const directory = join(root, fs.readdirSync(root).find(name => name.startsWith(".outliner-save-") && fs.statSync(join(root, name)).isDirectory())!);
      expect(fs.readFileSync(join(directory, "draft"), "utf8")).toBe("OUTLINER-DRAFT");
      if (phase !== "before-displacement") expect(fs.readFileSync(join(directory, "original"), "utf8")).toBe("ORIGINAL");
      expect(fs.readdirSync(root).some(name => name.endsWith(".pending"))).toBe(false);
    } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("unsupported hard links fail before the source is displaced", () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/outliner-file-unsupported-"));
  const path = join(root, "note.txt");
  const store = new OutlinerStore(join(root, "outline.sqlite"));
  let trap: ReturnType<typeof spyOn> | undefined;
  try {
    fs.writeFileSync(path, "ORIGINAL");
    const resource = store.resources.internFilesystem({ path }).resource;
    const opened = store.resources.describe(resource.id, true).filesystem!;
    trap = spyOn(fs, "linkSync").mockImplementation(() => { throw Object.assign(new Error("unsupported hard link"), { code: "ENOTSUP" }); });
    expect(() => store.resources.writeFilesystem({resourceId: resource.id, expectedRevision: opened.revision, text: "DRAFT"})).toThrow(/unsupported hard link/);
    expect(fs.readFileSync(path, "utf8")).toBe("ORIGINAL");
    expect(store.resources.describe(resource.id, true).filesystem!.revision).toEqual(opened.revision);
  } finally { trap?.mockRestore(); store.close(); fs.rmSync(root, {recursive: true, force: true}); }
});
