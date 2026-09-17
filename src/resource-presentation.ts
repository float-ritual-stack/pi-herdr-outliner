import {
  RESOURCE_CAPABILITIES,
  deriveResourceCapabilityReport,
  type Resource,
  type ResourceCapability,
  type ResourceCapabilityDecision,
  type ResourceDescription,
  type ResourceKind,
  type ResourcePlacement,
  type ResourcePresentationAttempt,
  type ResourcePresentationContext,
  type ResourcePresentationDecision,
  type ResourcePresentationSelection,
  type ResourceRenderer,
  type ResourceRepresentationKind,
  type ResourceSurface,
  type ResourceRepresentationAdapter,
} from "./resources";

const SURFACES = ["tui", "gui", "native", "external"] as const;
const PLACEMENTS = ["inline", "pane", "window", "external"] as const;
const RENDERERS = [
  "markdown",
  "embedded-browser",
  "native-document",
  "metadata",
  "external-open",
] as const;
const ACCESS_STATES = ["available", "unavailable", "unknown"] as const;

export const TUI_RESOURCE_PRESENTATION_CONTEXT: ResourcePresentationContext = {
  surface: "tui",
  placement: "pane",
  host: {
    id: "outliner-tui",
    renderers: ["markdown", "metadata", "external-open"],
    placements: ["pane", "external"],
    capabilities: ["read", "refresh", "open-external"],
  },
  providerAccess: {
    credentials: "unknown",
    connectivity: "unknown",
  },
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function printable(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) throw new Error(`${label} must be 1-200 printable characters`);
  return value.trim();
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`Unsupported ${label}: ${String(value)}`);
  }
  return value as T;
}

function enumArray<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
  allowEmpty = false,
): readonly T[] {
  const minimum = allowEmpty ? 0 : 1;
  if (!Array.isArray(value) || value.length < minimum || value.length > values.length) {
    throw new Error(`${label} must contain ${minimum}-${values.length} entries`);
  }
  const normalized = value.map((entry) => enumValue(entry, values, label));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} cannot contain duplicates`);
  return normalized;
}

export function normalizeResourcePresentationContext(
  value: unknown,
): ResourcePresentationContext {
  const context = record(value, "Resource presentation context");
  const host = record(context.host, "Resource presentation host");
  const providerAccess = record(context.providerAccess, "Resource provider access");
  return {
    surface: enumValue(context.surface, SURFACES, "resource surface") as ResourceSurface,
    placement: enumValue(context.placement, PLACEMENTS, "resource placement") as ResourcePlacement,
    host: {
      id: printable(host.id, "Resource presentation host ID"),
      renderers: enumArray(host.renderers, RENDERERS, "Resource renderers") as readonly ResourceRenderer[],
      placements: enumArray(host.placements, PLACEMENTS, "Resource placements") as readonly ResourcePlacement[],
      capabilities: enumArray(
        host.capabilities,
        RESOURCE_CAPABILITIES,
        "Resource host capabilities",
        true,
      ) as readonly ResourceCapability[],
    },
    providerAccess: {
      credentials: enumValue(
        providerAccess.credentials,
        ACCESS_STATES,
        "credential availability",
      ),
      connectivity: enumValue(
        providerAccess.connectivity,
        ACCESS_STATES,
        "connectivity availability",
      ),
    },
  };
}

function resourceKind(resource: Resource): ResourceKind {
  if (
    resource.provider === "github" ||
    resource.provider === "jira" ||
    resource.provider === "linear"
  ) return "entity";
  if (resource.provider === "application") return "application";
  return "document";
}

function externalUrl(description: ResourceDescription): string | null {
  const { resource, source, remoteEntity } = description;
  if (resource.address.kind === "web") return resource.address.url;
  if (resource.address.kind === "application") return resource.address.uri;
  if (resource.address.kind === "github" && source.provider === "github") {
    const path = resource.address.entity === "issue" ? "issues" : "pull";
    return new URL(
      `${source.boundary.owner}/${source.boundary.repository}/${path}/${resource.address.number}`,
      `${source.boundary.origin.replace(/\/$/, "")}/`,
    ).href;
  }
  if (resource.address.kind === "jira" && source.provider === "jira") {
    return new URL(
      `browse/${encodeURIComponent(resource.address.key)}`,
      `${source.boundary.origin.replace(/\/$/, "")}/`,
    ).href;
  }
  if (remoteEntity?.externalUrl) return remoteEntity.externalUrl;
  return null;
}

function capabilityReason(decision: ResourceCapabilityDecision): string {
  for (const factor of Object.values(decision.factors)) {
    if (factor.state === "blocked" || factor.state === "unknown") return factor.detail;
  }
  return "Capability is available";
}


function isTextualMediaType(mediaType: string | null): boolean {
  if (mediaType === null) return true;
  const normalized = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  return normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized.endsWith("+json") ||
    normalized === "application/xml" ||
    normalized.endsWith("+xml") ||
    normalized === "application/yaml" ||
    normalized === "application/toml";
}
function localReadDecision(
  decision: ResourceCapabilityDecision,
): Pick<ResourceCapabilityDecision, "status" | "factors"> {
  const factors = {
    provider: decision.factors.provider,
    "workspace-policy": decision.factors["workspace-policy"],
    "destination-host": decision.factors["destination-host"],
  };
  const assessments = Object.values(factors);
  return {
    status: assessments.some(({ state }) => state === "blocked")
      ? "unavailable"
      : assessments.some(({ state }) => state === "unknown")
      ? "indeterminate"
      : "available",
    factors: {
      ...decision.factors,
      credentials: { state: "not-required" },
      connectivity: { state: "not-required" },
    },
  };
}

interface CandidateDefinition {
  readonly representation: ResourceRepresentationKind;
  readonly renderer: ResourceRenderer;
  readonly placement: ResourcePlacement;
  readonly applicable: boolean;
  readonly missingReason: string;
  readonly capability?: ResourceCapability;
  readonly adapter: ResourceRepresentationAdapter | null;
  readonly externalUrl: string | null;
}

function orderedDefinitions(
  description: ResourceDescription,
  context: ResourcePresentationContext,
): readonly CandidateDefinition[] {
  const { resource, web, filesystem, pdf, remoteEntity, computed } = description;
  const unpinned = description.requestedRevision === null;
  const url = unpinned ? externalUrl(description) : null;
  const requestedPlacement = context.placement;
  const native: CandidateDefinition = {
    representation: "native-document",
    renderer: "native-document",
    placement: requestedPlacement,
    applicable:
      unpinned &&
      (context.surface === "gui" || context.surface === "native") &&
      resource.mediaType === "application/pdf" &&
      (pdf?.nativeRepresentation.contentAvailable === true || filesystem != null),
    missingReason: unpinned
      ? "Native document presentation requires an available PDF on a GUI/native surface"
      : "Pinned revisions require an exact retained representation",
    capability: "read",
    adapter: pdf?.nativeRepresentation.adapter ?? null,
    externalUrl: url,
  };
  const browser: CandidateDefinition = {
    representation: "embedded-browser",
    renderer: "embedded-browser",
    placement: requestedPlacement,
    applicable: unpinned && context.surface === "gui" && resource.provider === "web",
    missingReason: unpinned
      ? "Embedded browser presentation requires a GUI surface and web Resource"
      : "Pinned revisions cannot use a live embedded browser",
    capability: "embed",
    adapter: null,
    externalUrl: url,
  };
  const markdown: CandidateDefinition = {
    representation: "cached-markdown",
    renderer: "markdown",
    placement: requestedPlacement,
    applicable:
      web !== null ||
      pdf != null ||
      remoteEntity != null ||
      computed != null ||
      (filesystem != null && isTextualMediaType(resource.mediaType)),
    missingReason: "No local text or cached Markdown representation is available",
    adapter:
      web?.representation.adapter ??
      pdf?.representation.adapter ??
      remoteEntity?.representation.adapter ??
      computed?.adapter ??
      null,
    externalUrl: url,
  };
  const metadata: CandidateDefinition = {
    representation: "metadata",
    renderer: "metadata",
    placement: requestedPlacement,
    applicable: true,
    missingReason: "Resource metadata is unavailable",
    adapter: null,
    externalUrl: url,
  };
  const external: CandidateDefinition = {
    representation: "external-link",
    renderer: "external-open",
    placement: "external",
    applicable: url !== null,
    missingReason: unpinned
      ? "Resource has no external deep link"
      : "Pinned revisions cannot use a mutable external deep link",
    capability: "open-external",
    adapter: null,
    externalUrl: url,
  };
  if (context.surface === "external" || context.placement === "external") {
    return [external, metadata, markdown, native, browser];
  }
  if (context.surface === "gui") return [native, browser, markdown, external, metadata];
  if (context.surface === "native") return [native, markdown, external, metadata, browser];
  return [markdown, metadata, external, native, browser];
}

function presentationAttempt(
  definition: CandidateDefinition,
  status: ResourcePresentationAttempt["status"],
  reason: string,
): ResourcePresentationAttempt {
  return {
    representation: definition.representation,
    renderer: definition.renderer,
    placement: definition.placement,
    status,
    reason,
  };
}

function attempt(
  definition: CandidateDefinition,
  description: ResourceDescription,
  context: ResourcePresentationContext,
): ResourcePresentationAttempt {
  if (!definition.applicable) {
    return presentationAttempt(definition, "unavailable", definition.missingReason);
  }
  if (!context.host.renderers.includes(definition.renderer)) {
    return presentationAttempt(
      definition,
      "unavailable",
      `Host ${context.host.id} has no ${definition.renderer} renderer`,
    );
  }
  if (!context.host.placements.includes(definition.placement)) {
    return presentationAttempt(
      definition,
      "unavailable",
      `Host ${context.host.id} does not support ${definition.placement} placement`,
    );
  }
  const localRepresentation =
    definition.representation === "cached-markdown" ||
    definition.representation === "native-document";
  if (localRepresentation) {
    const decision = localReadDecision(description.capabilities.read);
    if (decision.status !== "available") {
      return presentationAttempt(definition, decision.status, capabilityReason(decision));
    }
  }
  if (definition.capability && !localRepresentation) {
    const decision = description.capabilities[definition.capability];
    if (decision.status !== "available") {
      return presentationAttempt(definition, decision.status, capabilityReason(decision));
    }
  }
  return presentationAttempt(definition, "available", "Available on this host");
}

export function negotiateResourcePresentation(
  description: ResourceDescription,
  contextValue: ResourcePresentationContext,
): ResourcePresentationDecision {
  const context = normalizeResourcePresentationContext(contextValue);
  const capabilities = deriveResourceCapabilityReport(
    description.source,
    true,
    context.host.capabilities,
    context.providerAccess,
  );
  const effectiveDescription = { ...description, capabilities };
  const definitions = orderedDefinitions(effectiveDescription, context);
  const attempts = definitions.map((definition) =>
    attempt(definition, effectiveDescription, context)
  );
  const selectedAttempt = attempts.find(({ status }) => status === "available") ??
    attempts.find(({ status }) => status === "indeterminate") ??
    null;
  const selected: ResourcePresentationSelection | null = selectedAttempt
    ? {
        representation: selectedAttempt.representation,
        renderer: selectedAttempt.renderer,
        placement: selectedAttempt.placement,
        status: selectedAttempt.status,
        reason: selectedAttempt.reason,
        mediaType: description.resource.mediaType,
        adapter: definitions[attempts.indexOf(selectedAttempt)]!.adapter,
        externalUrl: definitions[attempts.indexOf(selectedAttempt)]!.externalUrl,
      }
    : null;
  return {
    resourceId: description.resource.id,
    resourceKind: resourceKind(description.resource),
    surface: context.surface,
    requestedPlacement: context.placement,
    capabilities,
    selected,
    attempts,
  };
}
