import type { RequestInput } from "./client";
import type {
  OutlinerClientRegistration,
  OutlinerClientRole,
  OutlinerUiCommand,
} from "./types";

export interface OutlinerRequester {
  request<T>(input: RequestInput): Promise<T>;
}

export async function listLiveClients(
  requester: OutlinerRequester,
  role?: OutlinerClientRole,
): Promise<OutlinerClientRegistration[]> {
  return requester.request<OutlinerClientRegistration[]>({
    action: "clients.list",
    ...(role ? { role } : {}),
  });
}

export async function requireUniqueClientId(
  requester: OutlinerRequester,
  role: OutlinerClientRole,
): Promise<string> {
  const clients = await listLiveClients(requester, role);
  if (clients.length === 1) return clients[0]!.clientId;
  if (clients.length === 0) throw new Error(`No live ${role} client is registered`);
  throw new Error(
    `Multiple live ${role} clients are registered; choose clientId: ${clients
      .map((client) => client.clientId)
      .join(", ")}`,
  );
}

export async function requireClientIdForRole(
  requester: OutlinerRequester,
  clientId: string,
  role: OutlinerClientRole,
): Promise<string> {
  const client = (await listLiveClients(requester))
    .find((registered) => registered.clientId === clientId);
  if (!client) throw new Error(`Client is not registered: ${clientId}`);
  if (client.role !== role) {
    throw new Error(`Client ${clientId} has role ${client.role}; expected ${role}`);
  }
  return clientId;
}

export async function sendClientCommand(
  requester: OutlinerRequester,
  targetClientId: string,
  command: Omit<OutlinerUiCommand, "targetClientId">,
): Promise<void> {
  await requester.request({
    action: "ui.command.send",
    command: { ...command, targetClientId },
  });
}

export async function sendUniqueClientCommand(
  requester: OutlinerRequester,
  role: OutlinerClientRole,
  command: Omit<OutlinerUiCommand, "targetClientId">,
): Promise<string> {
  const clientId = await requireUniqueClientId(requester, role);
  await sendClientCommand(requester, clientId, command);
  return clientId;
}
