import { expect, test } from "bun:test";
import type { RequestInput } from "../src/client";
import {
  dispatchNavigation,
  focusTreeForClient,
  resolveNavigationDestination,
} from "../src/navigation-routes";

test("forwards unlocked-pool navigation resolution", async () => {
  const calls: RequestInput[] = [];
  const requester = {
    async request<T>(input: RequestInput): Promise<T> {
      calls.push(input);
      return {
        sourceClientId: "tree-a",
        targetClientId: "detail-a",
        intent: "open",
        resolution: "unlocked",
      } as T;
    },
  };

  const result = await resolveNavigationDestination(requester, "tree-a", "open");

  expect(result.targetClientId).toBe("detail-a");
  expect(calls).toEqual([{
    action: "navigation.resolve",
    sourceClientId: "tree-a",
    intent: "open",
  }]);
});

test("focuses the Tree selected by live same-tab routing", async () => {
  const calls: RequestInput[] = [];
  const requester = {
    async request<T>(input: RequestInput): Promise<T> {
      calls.push(input);
      if (input.action === "navigation.resolve") {
        return {
          sourceClientId: "detail-second",
          targetClientId: "tree-visible",
          intent: "reveal",
          resolution: "same-tab",
        } as T;
      }
      return undefined as T;
    },
  };

  await expect(focusTreeForClient(requester, "detail-second")).resolves.toBe("tree-visible");
  expect(calls).toEqual([
    {
      action: "navigation.resolve",
      sourceClientId: "detail-second",
      intent: "reveal",
    },
    {
      action: "ui.command.send",
      command: {
        targetClientId: "tree-visible",
        command: "focus",
      },
    },
  ]);
});

test("forwards a preview dispatch without inventing a destination", async () => {
  const calls: RequestInput[] = [];
  const requester = {
    async request<T>(input: RequestInput): Promise<T> {
      calls.push(input);
      return {
        sourceClientId: "tree-a",
        targetClientId: "detail-a",
        intent: "preview",
        resolution: "unlocked",
        command: {
          targetClientId: "detail-a",
          command: "preview",
          blockId: "block-a",
        },
      } as T;
    },
  };

  await dispatchNavigation(requester, "tree-a", "block-a", "preview");

  expect(calls).toEqual([{
    action: "navigation.dispatch",
    sourceClientId: "tree-a",
    blockId: "block-a",
    intent: "preview",
  }]);
});

test("forwards source preservation as an explicit routing constraint", async () => {
  const calls: RequestInput[] = [];
  const requester = {
    async request<T>(input: RequestInput): Promise<T> {
      calls.push(input);
      return {
        sourceClientId: "detail-a",
        targetClientId: "detail-b",
        intent: "open",
        resolution: "unlocked",
      } as T;
    },
  };

  await resolveNavigationDestination(requester, "detail-a", "open", {
    preserveSource: true,
  });
  await dispatchNavigation(requester, "detail-a", "block-a", "open", {
    preserveSource: true,
  });

  expect(calls).toEqual([
    {
      action: "navigation.resolve",
      sourceClientId: "detail-a",
      intent: "open",
      preserveSource: true,
    },
    {
      action: "navigation.dispatch",
      sourceClientId: "detail-a",
      blockId: "block-a",
      intent: "open",
      preserveSource: true,
    },
  ]);
});
