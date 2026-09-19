import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OutlinerClient } from "../src/client";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import { forwardService } from "./e2e/service-forwarder";
import type { ResolvedBlockReferences } from "../src/types";

test("a held optional response leaves other RPCs and subscription events live", async () => {
  const root = mkdtempSync(join(tmpdir(), "outliner-response-barrier-"));
  const store = new OutlinerStore(join(root, "state.sqlite"));
  const upstream = join(root, "upstream.sock");
  const server = new OutlinerServer(store, upstream);
  let forwarder: Awaited<ReturnType<typeof forwardService>> | undefined;
  let watcher: ReturnType<OutlinerClient["watch"]> | undefined;
  try {
    await server.start();
    forwarder = await forwardService(join(root, "forward.sock"), upstream);
    const client = new OutlinerClient(forwarder.socketPath);
    const connected = Promise.withResolvers<void>();
    const content = Promise.withResolvers<void>();
    watcher = client.watch({ client: { clientId: "barrier-detail", role: "detail", contextId: "barrier-context" },
      onConnect: connected.resolve, onError: connected.reject,
      onEvent: event => { if (event.domain === "content") content.resolve(); } });
    await connected.promise;
    const barrier = forwarder.holdNext({ action: "references.resolve", contains: "held source" });
    let firstComplete = false;
    const first = client.request<ResolvedBlockReferences>({ action: "references.resolve", text: "held source" })
      .then(result => { firstComplete = true; return result; });
    await barrier.received;
    const second = await client.request<ResolvedBlockReferences>({ action: "references.resolve", text: "independent source" });
    expect(second.text).toBe("independent source");
    expect(firstComplete).toBe(false);
    await client.request({ action: "create", text: "A content event while a reply is held" });
    await content.promise;
    expect(barrier.state).toBe("held");
    barrier.release();
    expect((await first).text).toBe("held source");
    expect(() => barrier.release()).toThrow("no held reply");

    const failure = forwarder.holdNext({ action: "references.resolve", contains: "failed source" });
    const failed = client.request({ action: "references.resolve", text: "failed source" }).catch(error => error as Error);
    await failure.received;
    expect(failure.state).toBe("held");
    failure.release("fixture optional read failure");
    expect((await failed as Error).message).toBe("fixture optional read failure");
    expect(forwarder.measurements().filter(request => request.held).map(request => request.ok)).toEqual([true, false]);
  } finally {
    watcher?.stop();
    await forwarder?.close();
    await server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
