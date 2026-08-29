import { expect, test } from "bun:test";
import type { RequestInput } from "../src/client";
import { requireClientIdForRole } from "../src/client-target";

const requester = {
  async request<T>(input: RequestInput): Promise<T> {
    if (input.action !== "clients.list") throw new Error(`Unexpected request: ${input.action}`);
    return [
      { clientId: "tree-client", role: "tree" },
      { clientId: "detail-client", role: "detail" },
    ] as T;
  },
};

test("validates an explicit target against the live client role", async () => {
  await expect(requireClientIdForRole(requester, "tree-client", "tree"))
    .resolves.toBe("tree-client");
  await expect(requireClientIdForRole(requester, "detail-client", "tree"))
    .rejects.toThrow("Client detail-client has role detail; expected tree");
  await expect(requireClientIdForRole(requester, "missing-client", "tree"))
    .rejects.toThrow("Client is not registered: missing-client");
});
