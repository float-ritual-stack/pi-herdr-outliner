import type { RequestInput } from "./client";
import type {
  OutlinerClientRegistration,
  OutlinerClientRole,
  OutlinerUiCommand,
} from "./types";
type OutlinerUiCommandInput = OutlinerUiCommand extends infer Command
  ? Command extends { targetClientId: string }
    ? Omit<Command, "targetClientId">
    : never
  : never;

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

export async function requireContextClientId(
  requester: OutlinerRequester,
  role: OutlinerClientRole,
  contextId: string,
): Promise<string> {
  const clients = (await listLiveClients(requester, role))
    .filter((client) => client.contextId === contextId);
  if (clients.length === 1) return clients[0]!.clientId;
  if (clients.length === 0) {
    throw new Error(`No live ${role} client is registered in this browsing context`);
  }
  throw new Error(`Multiple live ${role} clients are registered in this browsing context`);
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

function targetUiCommand(
  targetClientId: string,
  command: OutlinerUiCommandInput,
): OutlinerUiCommand {
  switch (command.command) {
    case "focus":
      return { ...command, targetClientId };
    case "edit":
    case "reveal":
      return { ...command, targetClientId };
    case "preview":
    case "open":
    case "replace":
      return { ...command, targetClientId };
    case "backlinks.select":
      return { ...command, targetClientId };
    case "comment.selection":
      return { ...command, targetClientId };
  }
}

export async function sendClientCommand(
  requester: OutlinerRequester,
  targetClientId: string,
  command: OutlinerUiCommandInput,
): Promise<void> {
  await requester.request({
    action: "ui.command.send",
    command: targetUiCommand(targetClientId, command),
  });
}

export async function sendUniqueClientCommand(
  requester: OutlinerRequester,
  role: OutlinerClientRole,
  command: OutlinerUiCommandInput,
): Promise<string> {
  const clientId = await requireUniqueClientId(requester, role);
  await sendClientCommand(requester, clientId, command);
  return clientId;
}

export async function sendContextClientCommand(
  requester: OutlinerRequester,
  role: OutlinerClientRole,
  contextId: string,
  command: OutlinerUiCommandInput,
): Promise<string> {
  const clientId = await requireContextClientId(requester, role, contextId);
  await sendClientCommand(requester, clientId, command);
  return clientId;
}
