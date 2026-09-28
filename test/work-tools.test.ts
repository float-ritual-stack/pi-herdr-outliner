import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "../src/paths";
import { parsePropertyRecords } from "../src/properties";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";

const REPO = "example-org/example-app";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The spawned CLI's environment: this fixture only, never a Herdr session. */
function isolatedEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("HERDR_") && !key.startsWith("OUTLINER_")) env[key] = value;
  }
  return { ...env, ...extra };
}

async function runCli(env: Record<string, string>, args: string[], stdin?: string) {
  const child = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."), env,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/**
 * A private service with a work queue and a `gh` stand-in on PATH that
 * answers `gh pr view` from `pulls`.
 */
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "outliner-work-tools-"));
  const env = { OUTLINER_STATE_DIR: join(root, "state"), OUTLINER_WORKSPACE_ROOT: root };
  const paths = resolvePaths(env);
  const store = new OutlinerStore(paths.database, { workspaceRoot: root });
  const server = new OutlinerServer(store, paths.socket);
  await server.start();
  cleanups.push(async () => {
    await server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.configureWorkIdPrefix("PIE");
  store.create("Work [type::work-queue] [project::demo]");
  const bin = join(root, "bin");
  const pulls = join(root, "pulls");
  Bun.spawnSync(["mkdir", "-p", bin, pulls]);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n# gh pr view N --repo R --json …\ncat "${pulls}/$3.json" 2>/dev/null || { echo "no pull request $3" >&2; exit 1; }\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const cliEnv = isolatedEnv({ ...env, PATH: `${bin}:${process.env.PATH}` });
  const run = async (args: string[], stdin?: string) => {
    const result = await runCli(cliEnv, args, stdin);
    return { ...result, json: result.exitCode === 0 ? JSON.parse(result.stdout) : undefined, error: result.stderr.trim() };
  };
  const pull = (number: number, state: "OPEN" | "MERGED", head = "feature/pie-001", mergeCommit: string | null = null, repo = REPO) =>
    writeFileSync(join(pulls, `${number}.json`), JSON.stringify({
      number, url: `https://github.com/${repo}/pull/${number}`, state,
      mergeCommit: mergeCommit ? { oid: mergeCommit } : null, headRefName: head, baseRefName: "main",
    }));
  const file = (name: string, text: string) => {
    writeFileSync(join(root, name), text);
    return join(root, name);
  };
  const create = (extra: string[] = []) => run([
    "work", "create", "--title", "Example outcome", "--project", "demo", "--arc", "workflow",
    "--track", "workflow", "--priority", "medium", "--stage", "queued", ...extra,
  ]);
  return { store, run, pull, file, create };
}

test("an item is created, staged and read back by Work ID with its revision", async () => {
  const h = await setup();
  const created = await h.create(["--body-file", "/dev/null", "--author", "agent", "--actor", "test-agent"]);
  expect(created.json).toMatchObject({ workId: "PIE-001", workStage: "queued", revision: 1 });
  expect(created.json.ref).toBe(`((${created.json.blockId}))`);
  const block = h.store.require(created.json.blockId);
  expect(block).toMatchObject({ author: "agent", actorId: "test-agent" });

  let revision = 1;
  for (const stage of ["doing", "review", "validate"]) {
    const staged = await h.run(["work", "stage", "PIE-1", stage, "--expected", String(revision)]);
    expect(staged.json).toMatchObject({ workId: "PIE-001", key: "work-stage", value: stage, workStage: stage, changed: true });
    expect(staged.json.revision).toBe(revision + 1);
    revision = staged.json.revision;
    expect(h.store.require(block.id).properties).toContainEqual({ key: "work-stage", value: stage });
  }
  const unchanged = await h.run(["work", "stage", block.id, "validate"]);
  expect(unchanged.json).toMatchObject({ changed: false, revision });

  const set = await h.run(["work", "set", `((${block.id}))`, "priority", "high"]);
  expect(set.json).toMatchObject({ key: "priority", previous: "medium", value: "high", revision: revision + 1 });
});

test("unclear or unsafe property writes are refused before anything changes", async () => {
  const h = await setup();
  const { json } = await h.create(["--track", "second-track"]);
  const before = h.store.require(json.blockId);
  const refusals: Array<[string[], string]> = [
    [["work", "stage", "PIE-001", "shipping"], 'Unknown work stage "shipping"'],
    [["work", "stage", "PIE-001", "done"], "use work complete"],
    [["work", "stage", "PIE-001", "doing", "--expected", "7"], "is at revision 1, not 7"],
    [["work", "set", "PIE-001", "work-id", "PIE-999"], "identity and cannot be changed"],
    [["work", "set", "PIE-001", "status", "done"], "no status"],
    [["work", "set", "PIE-001", "track", "other"], "[track::…] is a list"],
    [["work", "set", "PIE-001", "depends-on", "other"], "[depends-on::…] is a list"],
    [["work", "stage", "Example outcome", "doing"], "not \"Example outcome\""],
    [["work", "stage", "PIE-042", "doing"], "No block has Work ID PIE-042"],
    [["work", "stage", "PIE-001", "superseded"], "exactly one superseded-by"],
  ];
  for (const [args, message] of refusals) {
    const result = await h.run(args);
    expect(result.exitCode).toBe(1);
    expect(result.error).toStartWith("error: ");
    expect(result.error).toContain(message);
  }
  expect(h.store.require(before.id)).toEqual(before);
});

test("a pull request is recorded as the delivery: open reaches review, merge reaches validate", async () => {
  const h = await setup();
  const { json } = await h.create();
  await h.run(["work", "stage", "PIE-001", "doing"]);

  h.pull(7, "OPEN", "feature/other");
  const mismatch = await h.run(["work", "deliver", "PIE-001", "--repo", REPO, "--pr", "7", "--branch", "feature/pie-001"]);
  expect(mismatch.error).toContain("merges feature/other into main, not feature/pie-001 into main");
  expect(h.store.children(json.blockId)).toEqual([]);

  h.pull(8, "OPEN");
  const opened = await h.run(["work", "deliver", "PIE-001", "--repo", REPO, "--pr", "8"]);
  expect(opened.json).toMatchObject({
    workId: "PIE-001", workStage: "review", changed: true,
    delivery: { deliveryKey: "PIE-001/primary", stage: "review", created: true },
    pullRequest: { number: 8, state: "OPEN", mergeCommit: null },
  });

  h.pull(8, "MERGED", "feature/pie-001", "abc1234");
  const merged = await h.run(["work", "deliver", "PIE-001", "--repo", REPO, "--pr", "8", "--base", "main"]);
  expect(merged.json).toMatchObject({
    workStage: "validate",
    delivery: { blockId: opened.json.delivery.blockId, stage: "validate", created: false },
  });
  const delivery = h.store.require(opened.json.delivery.blockId);
  expect(delivery.properties).toContainEqual({ key: "merge-commit", value: "abc1234" });
  expect(delivery.properties).toContainEqual({ key: "work-branch", value: "feature/pie-001" });
});

test("completion needs a merged delivery and records proof, delivery Complete and Done", async () => {
  const h = await setup();
  const { json } = await h.create();
  const proofFile = h.file("proof.md", "Checked in a private fixture\n\nThe journey:\n- created\n- delivered");
  h.pull(9, "OPEN");
  const opened = await h.run(["work", "deliver", "PIE-001", "--repo", REPO, "--pr", "9"]);
  const deliveryId = opened.json.delivery.blockId;

  const unnamed = await h.run(["work", "complete", "PIE-001", "--proof-file", proofFile]);
  expect(unnamed.error).toContain(`PIE-001 has another incomplete delivery, so it cannot be done yet: PIE-001/primary ${deliveryId}`);
  expect(unnamed.error).toContain(`PR #9 is not merged (review): merge it and sync with work deliver PIE-001 --repo ${REPO} --pr 9 --key primary`);
  const unmerged = await h.run(["work", "complete", "PIE-001", "--delivery", deliveryId, "--proof-file", proofFile]);
  expect(unmerged.error).toContain("must have a merged PR");
  expect(h.store.children(json.blockId).map((child) => child.id)).toEqual([deliveryId]);

  h.pull(9, "MERGED", "feature/pie-001", "def5678");
  await h.run(["work", "deliver", "PIE-001", "--repo", REPO, "--pr", "9"]);
  const completed = await h.run(["work", "complete", "PIE-001", "--delivery", deliveryId, "--proof-file", proofFile]);
  expect(completed.json).toMatchObject({
    workId: "PIE-001", workStage: "done",
    proof: { created: true },
    deliveries: [{ blockId: deliveryId, deliveryKey: "PIE-001/primary", stage: "complete" }],
  });
  const proof = h.store.require(completed.json.proof.blockId);
  expect(proof.parentId).toBe(json.blockId);
  expect(parsePropertyRecords(proof.text).filter((record) => record.scope === "block").map(({ key, value }) => [key, value]))
    .toEqual([["type", "proof"], ["source-block", json.blockId]]);
  expect(proof.text).toContain("- delivered");
  const item = h.store.require(json.blockId);
  expect(item.properties).toContainEqual({ key: "work-stage", value: "done" });
  expect(item.properties).toContainEqual({ key: "proof", value: proof.id });

  const again = await h.run(["work", "complete", "PIE-001", "--proof-block", proof.id]);
  expect(again.error).toContain("already done");
});

const DOOR = "example-org/example-door";

/** PIE-001 with a merged primary delivery in REPO (#11) and a merged one in DOOR (#12) under `doorKey`. */
async function twoMergedDeliveries(doorKey?: string) {
  const h = await setup();
  const { json } = await h.create();
  h.pull(11, "MERGED", "feature/pie-001", "aaa1111");
  const primary = await h.run(["work", "deliver", "PIE-001", "--repo", REPO, "--pr", "11"]);
  h.pull(12, "MERGED", "feature/pie-001-door", "bbb2222", DOOR);
  const door = await h.run(["work", "deliver", "PIE-001", "--repo", DOOR, "--pr", "12", ...(doorKey ? ["--key", doorKey] : [])]);
  expect(door.error).toBe("");
  return { h, itemId: json.blockId as string, primaryId: primary.json.delivery.blockId as string, door };
}

test("a second repository's PR becomes a second delivery named after the repository", async () => {
  const { h, itemId, primaryId, door } = await twoMergedDeliveries();
  expect(door.json).toMatchObject({
    workStage: "validate",
    delivery: { deliveryKey: "PIE-001/example-door", stage: "validate", created: true },
    pullRequest: { number: 12, url: `https://github.com/${DOOR}/pull/12` },
  });
  expect(h.store.require(door.json.delivery.blockId).properties).toContainEqual({ key: "repository", value: DOOR });
  expect(h.store.require(primaryId).properties).toContainEqual({ key: "repository", value: REPO });

  // Syncing either PR again finds its own delivery without a key.
  const again = await h.run(["work", "deliver", "PIE-001", "--repo", DOOR, "--pr", "12"]);
  expect(again.json.delivery).toMatchObject({ blockId: door.json.delivery.blockId, created: false });
  expect(h.store.children(itemId).length).toBe(2);
});

test("--key names a delivery; a second branch in primary's repository needs one", async () => {
  const h = await setup();
  await h.create();
  h.pull(21, "OPEN");
  await h.run(["work", "deliver", "PIE-001", "--repo", REPO, "--pr", "21"]);
  h.pull(22, "OPEN", "feature/pie-001-docs");
  const unnamed = await h.run(["work", "deliver", "PIE-001", "--repo", REPO, "--pr", "22"]);
  expect(unnamed.error).toContain(`PIE-001/primary (${REPO}:feature/pie-001) already records another branch of ${REPO}; pass --key <name>`);
  const taken = await h.run(["work", "deliver", "PIE-001", "--repo", REPO, "--pr", "22", "--key", "primary"]);
  expect(taken.error).toContain("PIE-001/primary already records");
  expect((await h.run(["work", "deliver", "PIE-001", "--repo", REPO, "--pr", "22", "--key", "PIE-002/docs"])).error)
    .toContain("does not belong to PIE-001");
  const named = await h.run(["work", "deliver", "PIE-001", "--repo", REPO, "--pr", "22", "--key", "docs"]);
  expect(named.json.delivery).toMatchObject({ deliveryKey: "PIE-001/docs", stage: "review", created: true });
});

test("completing one delivery is refused while another is incomplete, naming it and how to finish it", async () => {
  const { h, itemId, primaryId, door } = await twoMergedDeliveries("PIE-001/door");
  const doorId = door.json.delivery.blockId;
  const before = [itemId, primaryId, doorId].map((id) => h.store.require(id));
  const proofFile = h.file("proof.md", "Checked both deliveries");

  const one = await h.run(["work", "complete", "PIE-001", "--delivery", primaryId, "--proof-file", proofFile]);
  expect(one.exitCode).toBe(1);
  expect(one.error).toContain(
    `PIE-001 has another incomplete delivery, so it cannot be done yet: PIE-001/door ${doorId} — merged: include it with --delivery PIE-001/door, or use --all-merged`,
  );
  expect([itemId, primaryId, doorId].map((id) => h.store.require(id))).toEqual(before);
  expect(h.store.children(itemId).length).toBe(2);

  const both = await h.run(["work", "complete", "PIE-001", "--delivery", `${primaryId},door`, "--proof-file", proofFile]);
  expect(both.json).toMatchObject({
    workStage: "done",
    deliveries: [
      { blockId: primaryId, deliveryKey: "PIE-001/primary", stage: "complete" },
      { blockId: doorId, deliveryKey: "PIE-001/door", stage: "complete" },
    ],
  });
});

test("--all-merged completes every merged delivery, and refuses while one is unmerged", async () => {
  const { h, itemId, primaryId, door } = await twoMergedDeliveries();
  h.pull(13, "OPEN", "feature/pie-001-extra");
  const extra = await h.run(["work", "deliver", "PIE-001", "--repo", REPO, "--pr", "13", "--key", "extra"]);
  const proofFile = h.file("proof.md", "Checked every delivery");
  const before = h.store.require(itemId);

  const refused = await h.run(["work", "complete", "PIE-001", "--all-merged", "--proof-file", proofFile]);
  expect(refused.error).toContain(`PIE-001/extra ${extra.json.delivery.blockId} — PR #13 is not merged (review)`);
  expect(refused.error).toContain(`work deliver PIE-001 --repo ${REPO} --pr 13 --key extra`);
  expect(h.store.require(itemId)).toEqual(before);
  expect(h.store.children(itemId).length).toBe(3);
  expect((await h.run(["work", "complete", "PIE-001", "--all-merged", "--delivery", "extra", "--proof-file", proofFile])).error)
    .toContain("not both");

  h.pull(13, "MERGED", "feature/pie-001-extra", "ccc3333");
  await h.run(["work", "deliver", "PIE-001", "--repo", REPO, "--pr", "13", "--key", "extra"]);
  const done = await h.run(["work", "complete", "PIE-001", "--all-merged", "--proof-file", proofFile]);
  expect(done.json.workStage).toBe("done");
  expect(done.json.deliveries.map((delivery: { blockId: string; stage: string }) => [delivery.blockId, delivery.stage])).toEqual([
    [primaryId, "complete"], [door.json.delivery.blockId, "complete"], [extra.json.delivery.blockId, "complete"],
  ]);
});

test("a delivery left in validate on a done item is completed with work set, revision-checked", async () => {
  const h = await setup();
  const { json } = await h.create();
  h.pull(31, "MERGED", "feature/pie-001", "ddd4444");
  const primary = await h.run(["work", "deliver", "PIE-001", "--repo", REPO, "--pr", "31"]);
  await h.run(["work", "complete", "PIE-001", "--delivery", "primary", "--proof-file", h.file("proof.md", "Checked")]);
  h.pull(32, "MERGED", "feature/pie-001-door", "eee5555", DOOR);
  const door = await h.run(["work", "deliver", "PIE-001", "--repo", DOOR, "--pr", "32"]);
  expect(door.json).toMatchObject({ workStage: "done", delivery: { deliveryKey: "PIE-001/example-door", stage: "validate" } });
  const doorId = door.json.delivery.blockId;
  const revision = h.store.require(doorId).revision;

  const again = await h.run(["work", "complete", "PIE-001", "--proof-block", h.store.children(json.blockId)[1]!.id]);
  expect(again.error).toContain(`already done; finish a leftover delivery with work set <delivery> delivery-stage complete: PIE-001/example-door ${doorId} (validate)`);
  const refusals: Array<[string[], string]> = [
    [["work", "set", doorId, "delivery-stage", "complete", "--expected", String(revision + 5)], `is at revision ${revision}`],
    [["work", "set", doorId, "delivery-stage", "review"], "comes from its PR"],
    [["work", "set", doorId, "priority", "high"], "only delivery-stage"],
    [["work", "set", "PIE-001", "delivery-stage", "complete"], "belongs to a delivery"],
    [["work", "set", "PIE-001/nothing", "delivery-stage", "complete"], "PIE-001 has no delivery nothing"],
  ];
  for (const [args, message] of refusals) expect((await h.run(args)).error).toContain(message);
  expect(h.store.require(doorId).revision).toBe(revision);

  const set = await h.run(["work", "set", "PIE-001/example-door", "delivery-stage", "complete", "--expected", String(revision)]);
  expect(set.json).toMatchObject({
    workId: "PIE-001", taskBlockId: json.blockId, blockId: doorId, deliveryKey: "PIE-001/example-door",
    previous: "validate", stage: "complete", changed: true, revision: revision + 1,
  });
  expect(h.store.require(doorId).properties).toContainEqual({ key: "delivery-stage", value: "complete" });
  expect(h.store.require(primary.json.delivery.blockId).properties).toContainEqual({ key: "delivery-stage", value: "complete" });
  expect((await h.run(["work", "complete", "PIE-001", "--proof-block", h.store.children(json.blockId)[1]!.id])).error)
    .toBe("error: PIE-001 is already done");
});

test("an existing proof block completes work that has no delivery; unlinked proof is refused", async () => {
  const h = await setup();
  const { json } = await h.create();
  const stray = h.store.create("Unrelated note");
  expect((await h.run(["work", "complete", "PIE-001", "--proof-block", stray.id])).error).toContain("must be a child of PIE-001");
  const proof = h.store.create(`Checked [type::proof] [source-block::${json.blockId}]`);
  const completed = await h.run(["work", "complete", "PIE-001", "--proof-block", proof.id]);
  expect(completed.json).toMatchObject({ workStage: "done", deliveries: [], proof: { blockId: proof.id, created: false } });
});

test("a note section is replaced up to the next heading of its level; the rest is kept", async () => {
  const h = await setup();
  const note = h.store.create([
    "Status brief [type::note]", "", "## Now", "", "old now", "", "## Next", "", "old next", "",
    "```", "## Not a heading", "```", "", "### Detail", "nested", "", "## Later", "", "later stays",
  ].join("\n"));
  const replaced = await h.run(["note", "section", note.id, "Next", "--stdin"], "fresh next\n");
  expect(replaced.json).toMatchObject({ blockId: note.id, revision: 2, heading: "## Next" });
  expect(replaced.json.previous).toBe("old next\n\n```\n## Not a heading\n```\n\n### Detail\nnested");
  expect(h.store.require(note.id).text).toBe([
    "Status brief [type::note]", "", "## Now", "", "old now", "", "## Next", "", "fresh next", "", "## Later", "", "later stays",
  ].join("\n"));

  const missing = await h.run(["note", "section", note.id, "Not a heading", "--stdin"], "x");
  expect(missing.error).toContain("headings: ## Now; ## Next; ## Later");
  const stale = await h.run(["note", "section", note.id, "Now", "--stdin", "--expected", "1"], "x");
  expect(stale.error).toContain("is at revision 2, not 1");
});

test("a trailing callout belongs to the last section, as Detail folds it, and comes back in previous", async () => {
  const h = await setup();
  const note = h.store.create("Brief\n\n## Last\n\nold\n\n> [!note]- History\n> earlier");
  const replaced = await h.run(["note", "section", note.id, "Last", "--stdin"], "new");
  expect(replaced.json.previous).toBe("old\n\n> [!note]- History\n> earlier");
  expect(h.store.require(note.id).text).toBe("Brief\n\n## Last\n\nnew");
});

test("an item body is replaced below its title and property lines", async () => {
  const h = await setup();
  const block = h.store.create("PIE-900 — Example [type::task]\n [project::demo] [owner::example]\n\nOld body\n- old");
  const replaced = await h.run(["work", "body", block.id, "--stdin", "--expected", "1"], "New body\n\n- new\n");
  expect(replaced.json).toMatchObject({ blockId: block.id, revision: 2, previous: "Old body\n- old" });
  const after = h.store.require(block.id);
  expect(after.text).toBe("PIE-900 — Example [type::task]\n [project::demo] [owner::example]\n\nNew body\n\n- new");
  expect(after.properties).toEqual(block.properties);
});

test("a service older than this client is refused with a restart instruction", async () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-work-old-"));
  const env = { OUTLINER_STATE_DIR: join(root, "state"), OUTLINER_WORKSPACE_ROOT: root };
  const socket = resolvePaths(env).socket;
  Bun.spawnSync(["mkdir", "-p", join(socket, "..")]);
  const old = createServer((connection) => connection.on("data", (chunk) => {
    const { id } = JSON.parse(String(chunk).split("\n")[0]!);
    connection.end(`${JSON.stringify({ id, ok: true, result: { status: "ready", protocolVersion: 1 } })}\n`);
  }));
  await new Promise<void>((resolve) => old.listen(socket, resolve));
  cleanups.push(async () => {
    await new Promise((resolve) => old.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const result = await runCli(isolatedEnv(env), ["work", "stage", "PIE-001", "doing"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("uses protocol 1");
  expect(result.stderr).toContain("Restart the service");
});
