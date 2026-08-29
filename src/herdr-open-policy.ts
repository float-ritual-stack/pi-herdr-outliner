import type { OutlinerClientRegistration } from "./types";

export function selectTreeClient(
  clients: OutlinerClientRegistration[],
  requestedClientId?: string,
): OutlinerClientRegistration {
  if (requestedClientId) {
    const selected = clients.find((client) => client.clientId === requestedClientId);
    if (!selected) {
      throw new Error(`Requested Tree client is not registered: ${requestedClientId}`);
    }
    return selected;
  }
  if (clients.length === 0) throw new Error("No live Tree client is registered");
  if (clients.length > 1) {
    throw new Error(
      `Multiple live Tree clients are registered; choose --client: ${clients
        .map((client) => client.clientId)
        .join(", ")}`,
    );
  }
  return clients[0]!;
}
