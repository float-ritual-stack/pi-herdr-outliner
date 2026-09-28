import { setTimeout as sleep } from "node:timers/promises";
import {
  OUTLINER_MIN_SERVICE_PROTOCOL,
  OUTLINER_PROTOCOL_VERSION,
  type OutlinerCapability,
  type OutlinerServiceStatus,
} from "./types";

export type ServiceIncompatibility =
  | { reason: "service-too-old"; message: string }
  | { reason: "client-too-old"; message: string }
  | { reason: "missing-capability"; message: string; missing: string[] };

/**
 * Compatibility is negotiated, not an exact version match: the service must be
 * at least this checkout's minimum, must still serve this checkout's protocol,
 * and must advertise every capability the caller is about to use.
 */
export function checkServiceCompatibility(
  service: OutlinerServiceStatus,
  needed: readonly OutlinerCapability[] = [],
): ServiceIncompatibility | undefined {
  const version = service.protocolVersion;
  if (typeof version !== "number" || version < OUTLINER_MIN_SERVICE_PROTOCOL) {
    return {
      reason: "service-too-old",
      message: `Connected Outliner service uses protocol ${version}; this client requires at least ${OUTLINER_MIN_SERVICE_PROTOCOL}. Restart the service from the current checkout.`,
    };
  }
  if (service.minClientProtocol !== undefined && OUTLINER_PROTOCOL_VERSION < service.minClientProtocol) {
    return {
      reason: "client-too-old",
      message: `Connected Outliner service (protocol ${version}) no longer serves client protocol ${OUTLINER_PROTOCOL_VERSION}; it requires at least ${service.minClientProtocol}. Restart this client from the service's checkout.`,
    };
  }
  const offered = new Set(service.capabilities ?? []);
  const missing = needed.filter(capability => !offered.has(capability));
  if (missing.length > 0) {
    return {
      reason: "missing-capability",
      missing,
      message: `Connected Outliner service (protocol ${version}) does not support ${missing.join(", ")}. Restart the service from a checkout that provides ${missing.length === 1 ? "it" : "them"}.`,
    };
  }
  return undefined;
}

/** Throws a restart instruction naming the first incompatibility. */
export function requireCapabilities(
  service: OutlinerServiceStatus,
  needed: readonly OutlinerCapability[] = [],
): void {
  const problem = checkServiceCompatibility(service, needed);
  if (problem) throw new Error(problem.message);
}

interface PingClient {
  request<T>(input: { action: "ping" }, timeoutMs?: number): Promise<T>;
}

/**
 * Polls `ping` until a compatible service answers. An unreachable or
 * incompatible service is retried until the deadline, then the last reason
 * is reported, so a service that is restarting onto a newer checkout is
 * accepted while a genuinely old one is still rejected.
 */
export async function waitForCompatibleService(
  client: PingClient,
  options: { timeoutMs: number; pingTimeoutMs?: number; needed?: readonly OutlinerCapability[] },
): Promise<OutlinerServiceStatus> {
  const deadline = Date.now() + options.timeoutMs;
  let lastResponse = "No service response";
  do {
    try {
      const service = await client.request<OutlinerServiceStatus>({ action: "ping" }, options.pingTimeoutMs);
      const problem = checkServiceCompatibility(service, options.needed);
      if (!problem) return service;
      lastResponse = problem.message;
    } catch (error) {
      lastResponse = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(lastResponse);
}
