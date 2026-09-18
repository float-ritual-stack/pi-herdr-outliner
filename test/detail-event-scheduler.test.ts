import { expect, test } from "bun:test";
import { DetailEventScheduler } from "../src/detail-event-scheduler";
import type { OutlinerEvent } from "../src/types";

function navigationEvent(
  id: string,
  command: "preview" | "open" | "replace",
  blockId: string,
): OutlinerEvent {
  return {
    id,
    domain: "ui",
    action: "command",
    sequence: Number(id.replace(/\D/g, "")) || 1,
    command: {
      targetClientId: "detail-test",
      command,
      target: { kind: "block", blockId },
    },
  };
}

test("a rapid preview burst paints only its final target", async () => {
  const queued: Array<() => Promise<void>> = [];
  const firstResponse = Promise.withResolvers<void>();
  const started: string[] = [];
  const painted: string[] = [];
  let generation = 0;
  const scheduler = new DetailEventScheduler({
    clientId: "detail-test",
    enqueue(task) {
      queued.push(task);
    },
    supersedePreview() {
      generation += 1;
    },
    async handle(event) {
      const command = event.command;
      if (
        !command ||
        (command.command !== "preview" &&
          command.command !== "open" &&
          command.command !== "replace")
      ) return;
      if (command.target.kind !== "block") return;
      const target = command.target.blockId;
      const loadGeneration = ++generation;
      started.push(target);
      if (target === "a") await firstResponse.promise;
      if (loadGeneration === generation) painted.push(target);
    },
  });

  scheduler.schedule(navigationEvent("preview-1", "preview", "a"));
  const active = queued.shift();
  if (!active) throw new Error("Expected the first preview task");
  const firstLoad = active();
  scheduler.schedule(navigationEvent("preview-2", "preview", "b"));
  scheduler.schedule(navigationEvent("preview-3", "preview", "c"));
  scheduler.schedule(navigationEvent("preview-4", "preview", "d"));

  firstResponse.resolve();
  await firstLoad;
  expect(queued).toHaveLength(3);
  while (queued.length > 0) {
    const next = queued.shift();
    if (next) await next();
  }

  expect(started).toEqual(["a", "d"]);
  expect(painted).toEqual(["d"]);
});

test("keeps explicit opens ordered while coalescing only adjacent previews", async () => {
  const queued: Array<() => Promise<void>> = [];
  const handled: string[] = [];
  const scheduler = new DetailEventScheduler({
    clientId: "detail-test",
    enqueue(task) {
      queued.push(task);
    },
    supersedePreview() {},
    async handle(event) {
      const command = event.command;
      if (
        !command ||
        (command.command !== "preview" &&
          command.command !== "open" &&
          command.command !== "replace")
      ) return;
      if (command.target.kind !== "block") return;
      handled.push(`${command.command}:${command.target.blockId}`);
    },
  });

  scheduler.schedule(navigationEvent("event-1", "preview", "preview-a"));
  scheduler.schedule(navigationEvent("event-2", "preview", "preview-b"));
  scheduler.schedule(navigationEvent("event-3", "open", "open-a"));
  scheduler.schedule(navigationEvent("event-4", "preview", "preview-c"));
  scheduler.schedule(navigationEvent("event-5", "preview", "preview-d"));
  scheduler.schedule(navigationEvent("event-6", "open", "open-b"));

  while (queued.length > 0) {
    const next = queued.shift();
    if (next) await next();
  }
  expect(handled).toEqual([
    "preview:preview-b",
    "open:open-a",
    "preview:preview-d",
    "open:open-b",
  ]);
});
