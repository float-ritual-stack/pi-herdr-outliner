import { describe, expect, test } from "bun:test";
import { OutlinerActionKeymap } from "../src/outliner-actions";
import {
  DEFAULT_OPEN_DESTINATION_TIMEOUT_MS,
  OpenDestinationChooser,
  openDestinationTimeoutFromEnvironment,
  type OpenDestination,
  type OpenDestinationScheduler,
  type OpenDestinationTarget,
} from "../src/open-destination-chooser";

type Timer = { callback: () => void; cleared: boolean };

class FakeScheduler implements OpenDestinationScheduler {
  readonly timers: Timer[] = [];

  set(callback: () => void): Timer {
    const timer = { callback, cleared: false };
    this.timers.push(timer);
    return timer;
  }

  clear(handle: unknown): void {
    (handle as Timer).cleared = true;
  }

  fire(index: number): void {
    this.timers[index]!.callback();
  }
}

const target: OpenDestinationTarget = { blockId: "target-1", title: "Target one" };

function harness(options: {
  firstUnlocked?: boolean;
  scheduler?: FakeScheduler;
  actionKeymap?: OutlinerActionKeymap;
} = {}) {
  const calls: Array<string> = [];
  const chooser = new OpenDestinationChooser({
    beforeOpen: (_target, destination) => {
      calls.push(`before:${destination}`);
    },
    replace: (opened) => {
      calls.push(`replace:${opened.blockId}`);
    },
    openFirstUnlocked: (opened) => {
      calls.push(`first:${opened.blockId}`);
      return options.firstUnlocked ?? true;
    },
    openNewDetail: (opened, direction) => {
      calls.push(`split:${direction}:${opened.blockId}`);
    },
    opened: (_opened, destination) => {
      calls.push(`opened:${destination}`);
    },
    invalidate: () => calls.push("invalidate"),
  }, {
    timeoutMs: 7_500,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    ...(options.actionKeymap ? { actionKeymap: options.actionKeymap } : {}),
  });
  return { chooser, calls };
}

async function choose(
  destination: Exclude<OpenDestination, "default">,
  chooser: OpenDestinationChooser,
): Promise<void> {
  const input = destination === "replace"
    ? ["R", { name: "r", shift: true }]
    : destination === "first-unlocked"
    ? ["f", { name: "f" }]
    : destination === "split-right"
    ? ["r", { name: "r" }]
    : ["d", { name: "d" }];
  await chooser.handleKeypress(input[0] as string, input[1] as { name: string; shift?: boolean });
}

describe("open destination chooser", () => {
  test("defers navigation until confirmation and defaults to first unlocked", async () => {
    const state = harness();
    state.chooser.open(target);

    expect(state.chooser.state.active).toBe(true);
    expect(state.calls.filter((call) => call.startsWith("first:") || call.startsWith("split:")))
      .toEqual([]);

    await state.chooser.handleKeypress("", { name: "return" });

    expect(state.calls).toContain("before:default");
    expect(state.calls).toContain("first:target-1");
    expect(state.calls).toContain("opened:default");
    expect(state.calls).not.toContain("split:right:target-1");
    expect(state.chooser.state.active).toBe(false);
  });

  test("falls back to a right split only for the default choice", async () => {
    const fallback = harness({ firstUnlocked: false });
    fallback.chooser.open(target);
    await fallback.chooser.handleKeypress("", { name: "return" });
    expect(fallback.calls).toContain("split:right:target-1");
    expect(fallback.chooser.state.active).toBe(false);

    const explicitFirst = harness({ firstUnlocked: false });
    explicitFirst.chooser.open(target);
    await choose("first-unlocked", explicitFirst.chooser);
    expect(explicitFirst.calls).not.toContain("split:right:target-1");
    expect(explicitFirst.chooser.state.active).toBe(true);
    expect(explicitFirst.chooser.state.status).toContain("No unlocked Detail");
  });

  test("dispatches every explicit destination through one key model", async () => {
    const cases: Array<[Exclude<OpenDestination, "default" | "first-unlocked">, string]> = [
      ["replace", "replace:target-1"],
      ["split-right", "split:right:target-1"],
      ["split-down", "split:down:target-1"],
    ];
    for (const [destination, expected] of cases) {
      const state = harness();
      state.chooser.open(target);
      await choose(destination, state.chooser);
      expect(state.calls).toContain(`before:${destination}`);
      expect(state.calls).toContain(expected);
      expect(state.chooser.state.active).toBe(false);
    }
  });
  test("uses configured directional bindings and reports them in chooser help", async () => {
    const actionKeymap = new OutlinerActionKeymap("<test>", {
      "detail.pane.right": ["Shift+ArrowRight"],
      "detail.pane.below": ["Shift+ArrowDown"],
    });
    for (const [keyName, direction] of [
      ["right", "right"],
      ["down", "down"],
    ] as const) {
      const state = harness({ actionKeymap });
      state.chooser.open(target);
      await state.chooser.handleKeypress("", { name: keyName, shift: true });
      expect(state.calls).toContain(`split:${direction}:target-1`);
    }
    expect(harness({ actionKeymap }).chooser.helpText()).toContain(
      "⇧→/r split right  ⇧↓/d split down",
    );
  });


  test("consumes input, resets idle dismissal, and rejects stale timers", async () => {
    const scheduler = new FakeScheduler();
    const state = harness({ scheduler });
    state.chooser.open(target);
    expect(scheduler.timers).toHaveLength(1);

    expect(await state.chooser.handleKeypress("x", { name: "x" })).toBe(true);
    expect(scheduler.timers).toHaveLength(2);
    scheduler.fire(0);
    expect(state.chooser.state.active).toBe(true);

    scheduler.fire(1);
    expect(state.chooser.state.active).toBe(false);
    expect(state.chooser.state.target).toBeNull();
  });

  test("rebinding a target makes the prior target's timer harmless", () => {
    const scheduler = new FakeScheduler();
    const state = harness({ scheduler });
    state.chooser.open(target);
    state.chooser.open({ blockId: "target-2", title: "Target two" });

    scheduler.fire(0);
    expect(state.chooser.state.target?.blockId).toBe("target-2");
    scheduler.fire(1);
    expect(state.chooser.state.active).toBe(false);
  });

  test("does not dispatch a stale choice after its target is disposed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const chooser = new OpenDestinationChooser({
      beforeOpen: async () => {
        await gate;
      },
      replace: () => {
        calls.push("replace");
      },
      openFirstUnlocked: () => true,
      openNewDetail: () => {},
      invalidate: () => {},
    });
    chooser.open(target);
    const pending = chooser.handleKeypress("R", { name: "r", shift: true });
    chooser.dispose();
    release();
    await pending;

    expect(calls).toEqual([]);
    expect(chooser.state.active).toBe(false);
  });

  test("input during an in-flight destination does not cancel it", async () => {
    const scheduler = new FakeScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const chooser = new OpenDestinationChooser({
      beforeOpen: async () => {
        await gate;
      },
      replace: () => {
        calls.push("replace");
      },
      openFirstUnlocked: () => true,
      openNewDetail: () => {},
      invalidate: () => {},
    }, { scheduler, timeoutMs: 7_500 });
    chooser.open(target);
    const pending = chooser.handleKeypress("R", { name: "r", shift: true });
    await chooser.handleKeypress("x", { name: "x" });
    scheduler.fire(1);
    expect(chooser.state.active).toBe(true);

    release();
    await pending;

    expect(calls).toEqual(["replace"]);
    expect(chooser.state.active).toBe(false);
  });

  test("idle timeout does not cancel an in-flight destination", async () => {
    const scheduler = new FakeScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const chooser = new OpenDestinationChooser({
      beforeOpen: async () => {
        await gate;
      },
      replace: () => {
        calls.push("replace");
      },
      openFirstUnlocked: () => true,
      openNewDetail: () => {},
      invalidate: () => {},
    }, { scheduler, timeoutMs: 7_500 });
    chooser.open(target);
    const pending = chooser.handleKeypress("R", { name: "r", shift: true });

    scheduler.fire(1);
    expect(chooser.state.active).toBe(true);
    expect(chooser.state.loading).toBe(true);
    release();
    await pending;

    expect(calls).toEqual(["replace"]);
    expect(chooser.state.active).toBe(false);
  });

  test("validates the configurable timeout", () => {
    expect(openDestinationTimeoutFromEnvironment(undefined)).toBe(
      DEFAULT_OPEN_DESTINATION_TIMEOUT_MS,
    );
    expect(openDestinationTimeoutFromEnvironment("5000")).toBe(5_000);
    expect(openDestinationTimeoutFromEnvironment("0")).toBe(
      DEFAULT_OPEN_DESTINATION_TIMEOUT_MS,
    );
    expect(openDestinationTimeoutFromEnvironment("not-a-number")).toBe(
      DEFAULT_OPEN_DESTINATION_TIMEOUT_MS,
    );
  });
});
