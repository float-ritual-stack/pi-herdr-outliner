import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { Block, BrowsingContextState, OutlinerRequest, QuickCaptureDraft, VisibleBlockCollection } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const result = await runHerdrScenario({
  name: "capture-retry",
  async prepare() {},
  async run(session) {
    // Faults affect only this popup's existing RPC seam, after the real service starts.
    const socketPath = join(session.projectRoot, "capture-fault.sock");
    let fault: "cleanup" | "capture-reply" | null = "cleanup";
    const trace: Array<{ action: string; response?: unknown; fault?: string }> = [];
    const sockets = new Set<Socket>();
    const proxy = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as OutlinerRequest;
        buffer = "";
        void (async () => {
          assert.ok(request.action === "ping" || request.action.startsWith("capture."), "Capture fixture received an unrelated operation");
          if (fault === "cleanup" && request.action === "capture.draft.clear") {
            fault = null;
            trace.push({ action: request.action, fault: "rejected before cleanup" });
            throw new Error("fixture: draft cleanup unavailable");
          }
          const response = await session.client.request(request);
          trace.push({ action: request.action, response });
          if (fault === "capture-reply" && request.action === "capture.create") {
            fault = null;
            trace.push({ action: request.action, fault: "committed response dropped" });
            socket.end();
            return;
          }
          socket.end(`${JSON.stringify({ id: request.id, ok: true, result: response })}\n`);
        })().catch((error) => {
          socket.end(`${JSON.stringify({ id: request.id, ok: false, error: String(error) })}\n`);
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(socketPath, resolve);
    });
    try {
      const terminal = await session.attachClient();
      const output = () => terminal.visible();
      await session.waitFor("attached Herdr paints the application", output, (text) => text.includes("Outliner"));
      await session.focus(session.panes.tree);
      const before = await session.client.request({ action: "selection.get" });
      const tree = (await session.registrations()).find((client) => client.role === "tree");
      assert.ok(tree?.contextId);
      const context = () => session.client.request<BrowsingContextState>({
        action: "browsing-context.get", contextId: tree.contextId,
      });
      const beforeContext = await context();
      const origin = await session.client.request<Block>({ action: "create", text: "S2 capture context" });
      const readDraft = () => session.client.request<QuickCaptureDraft | null>({ action: "capture.draft.get" });
      const captures = async () => {
        const found = await session.client.request<VisibleBlockCollection>({
          action: "blocks.query", query: { filters: [{ key: "type", value: "capture" }], limit: 100 },
        });
        assert.equal(found.completeness.kind, "complete");
        return found.blocks;
      };
      const paste = (text: string) => terminal.write(`\x1b[200~${text}\x1b[201~`);
      const waitOutput = async (text: string) => {
        await session.waitFor(`attached popup output: ${text}`,
          output, (current) => current.includes(text), 35_000);
      };
      const open = async () => {
        await session.waitFor("previous popup has exited", output, (frame) => !frame.includes("Quick capture"));
        await session.openCapturePopup(origin.id, socketPath);
        await waitOutput("Quick capture");
      };

      await open();
      await paste("S2 First line");
      await terminal.write("\x13");
      await waitOutput("draft cleanup failed");
      assert.equal((await captures()).length, 1);
      await session.checkpoint("00-cleanup-failed");
      await paste("\nS2 Added after cleanup failure");
      await terminal.write("\x13");
      await waitOutput("changed draft retained");
      const retained = await readDraft();
      assert.equal(retained?.text, "S2 First line\nS2 Added after cleanup failure");
      assert.equal(retained?.capturedFromBlockId, origin.id);
      assert.equal((await captures()).length, 1);
      await session.record("cleanup-failure-new-text-retained", retained);
      await session.checkpoint("01-new-text-retained");

      // Escape retains the changed draft; the next popup resumes its original context.
      await terminal.write("\x1b");
      await session.waitFor("changed draft retained on close", readDraft,
        (draft) => !!draft && draft.revision > retained!.revision);
      await open();
      assert.equal((await readDraft())?.text, retained?.text);
      await terminal.write("\x13");
      await session.waitFor("retained edit captured", readDraft, (draft) => draft === null);
      assert.equal((await captures()).length, 2);

      // Lose the reply after the real commit. Close and resume, then retry exactly once.
      fault = "capture-reply";
      await open();
      await paste("S2 Reply lost original");
      await terminal.write("\x13");
      await waitOutput("Capture failed");
      const uncertain = await readDraft();
      assert.equal(uncertain?.submittedText, "S2 Reply lost original");
      assert.equal((await captures()).length, 3);
      await session.checkpoint("02-committed-reply-lost");
      await terminal.write("\x1b");
      await session.waitFor("uncertain draft retained on close", readDraft,
        (draft) => !!draft && draft.revision > uncertain!.revision);
      await open();
      await terminal.write("\x13");
      await session.waitFor("same submission acknowledged after reopen", readDraft, (draft) => draft === null);
      const finalCaptures = await captures();
      assert.equal(finalCaptures.length, 3, "Lost reply retry created a duplicate capture");
      assert.equal(finalCaptures.filter((block) => block.text.includes("S2 Added after cleanup failure")).length, 1);
      assert.deepEqual(await session.client.request({ action: "selection.get" }), before);
      assert.deepEqual(await context(), beforeContext);
      await session.record("captured-without-duplicates", finalCaptures);
      await session.checkpoint("02-retry-completed");

      // Return to ordinary Tree keys, then launch capture through Tree's actual command.
      await session.waitFor("saved popup exits", output, (frame) => !frame.includes("Quick capture"));
      await terminal.write("\x1b[B");
      const navigated = await session.waitFor("Tree navigation after capture", context,
        (value) => JSON.stringify(value.target) !== JSON.stringify(beforeContext.target));
      assert.equal(navigated.target?.kind, "block");
      await terminal.write("c");
      await waitOutput("Quick capture");
      await paste("S2 ordinary Tree capture retained");
      await terminal.write("\x1b");
      await session.waitFor("ordinary popup exits after retain", output, (frame) => !frame.includes("Quick capture"));
      const ordinary = await session.waitFor("ordinary popup retains draft", readDraft,
        (draft) => draft?.text === "S2 ordinary Tree capture retained");
      assert.equal(ordinary?.capturedFromBlockId,
        navigated.target?.kind === "block" ? navigated.target.blockId : undefined);
      assert.deepEqual(await context(), navigated);
      await session.record("ordinary-tree-navigation-and-capture", { navigated, ordinary });
      await session.checkpoint("03-ordinary-tree-capture");
    } finally {
      await session.record("capture-fault-trace", trace);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    }
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status !== "passed") process.exitCode = 1;
