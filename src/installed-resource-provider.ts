import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { ResourceExtensionRuntime } from "./resource-extensions";
import {
  DefaultRemoteEntityProviderClient,
  type RemoteEntityProviderClient,
  type RemoteEntityResource,
  type RemoteEntitySource,
} from "./remote-entity";
import {
  normalizeResourceAddress,
  normalizeResourceRevisionRef,
  ResourceCatalogError,
  type RemoteEntityDocument,
  type ResourceProviderCommandInput,
} from "./resources";

const Identity = Type.Object(
  {
    entityId: Type.String({ minLength: 1, maxLength: 255 }),
    locator: Type.String({ minLength: 1, maxLength: 255 }),
  },
  { additionalProperties: false },
);
const Document = Type.Object(
  {
    ...Identity.properties,
    title: Type.String({ minLength: 1, maxLength: 4000 }),
    markdown: Type.String({ maxLength: 800000 }),
    sourceContent: Type.String({ maxLength: 800000 }),
    metadata: Type.Record(
      Type.String(),
      Type.Union([
        Type.String({ maxLength: 4000 }),
        Type.Array(Type.String({ maxLength: 4000 }), { maxItems: 200 }),
        Type.Null(),
      ]),
    ),
    externalUrl: Type.String({ maxLength: 4096 }),
    updatedAt: Type.String({ minLength: 1, maxLength: 100 }),
    /** Contract 2: the record the service keeps as blocks (src/extension-records.ts). */
    record: Type.Optional(Type.Object(
      {
        title: Type.String({ minLength: 1, maxLength: 4000 }),
        fields: Type.Array(Type.Object({
          key: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,39}$" }),
          value: Type.Union([
            Type.String({ maxLength: 4000 }),
            Type.Array(Type.String({ maxLength: 4000 }), { maxItems: 200 }),
            Type.Null(),
          ]),
        }, { additionalProperties: false }), { maxItems: 64 }),
        body: Type.String({ maxLength: 400000 }),
        comments: Type.Optional(Type.Array(Type.Object({
          id: Type.String({ minLength: 1, maxLength: 255 }),
          author: Type.String({ maxLength: 1000 }),
          createdAt: Type.String({ maxLength: 100 }),
          body: Type.String({ maxLength: 100000 }),
        }, { additionalProperties: false }), { maxItems: 100 })),
      },
      { additionalProperties: false },
    )),
  },
  { additionalProperties: false },
);
const Changed = Type.Object(
  {
    items: Type.Array(Identity, { maxItems: 1000 }),
  },
  { additionalProperties: false },
);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const invalid = () =>
  new ResourceCatalogError(
    "source-unavailable",
    "Resource extension returned an invalid document or identity",
  );

/** First binding of the process contract: read-only Jira entities. Other provider families retain their owners. */
export class InstalledResourceProviderClient
  implements RemoteEntityProviderClient
{
  constructor(
    readonly runtime = new ResourceExtensionRuntime(),
    private readonly builtin: RemoteEntityProviderClient = new DefaultRemoteEntityProviderClient(
      {
        fetch: globalThis.fetch,
        resolveCredential: (name) => process.env[name],
      },
    ),
  ) {}
  async resolveLocator(source: RemoteEntitySource, locator: string) {
    if (source.provider !== "jira") {
      if (!this.builtin.resolveLocator) throw invalid();
      return this.builtin.resolveLocator(source, locator);
    }
    const result = await this.runtime.invoke("jira", "resolve", {
      source: source.boundary,
      locator,
    });
    try {
      const value = Parse(Identity, result.value);
      normalizeResourceAddress(source, {
        kind: "jira",
        entityId: value.entityId,
        key: value.locator,
      });
      return value;
    } catch {
      throw invalid();
    }
  }
  async changedSince(source: RemoteEntitySource, locators: readonly string[], sinceMinutes: number) {
    if (source.provider !== "jira") return this.builtin.changedSince?.(source, locators, sinceMinutes) ?? [];
    const result = await this.runtime.invoke("jira", "changed", {
      source: source.boundary,
      locators: [...locators],
      sinceMinutes: Math.max(1, Math.ceil(sinceMinutes)),
    });
    try {
      return Parse(Changed, result.value).items;
    } catch {
      throw invalid();
    }
  }
  /** The installed extension behind a provider key, when there is one (wave A: Jira). */
  describeExtension(provider: string) {
    return this.runtime.describe(provider);
  }
  async observe(
    resource: RemoteEntityResource,
    source: RemoteEntitySource,
  ): Promise<RemoteEntityDocument> {
    if (resource.provider !== "jira")
      return this.builtin.observe(resource, source);
    if (source.provider !== "jira" || source.id !== resource.sourceId)
      throw invalid();
    const result = await this.runtime.invoke("jira", "read", {
      source: source.boundary,
      entityId: resource.address.entityId,
    });
    try {
      const value = Parse(Document, result.value);
      if (value.entityId !== resource.address.entityId) throw invalid();
      normalizeResourceAddress(source, {
        kind: "jira",
        entityId: value.entityId,
        key: value.locator,
      });
      const url = new URL(value.externalUrl);
      if (
        url.origin !== source.boundary.origin ||
        url.username ||
        url.password ||
        !["https:", "http:"].includes(url.protocol)
      )
        throw invalid();
      const revision = normalizeResourceRevisionRef(
        {
          resourceId: resource.id,
          addressVersion: resource.addressVersion,
          revision: {
            kind: "jira",
            validator: { kind: "updated-at", value: value.updatedAt },
          },
        },
        resource,
      );
      const now = new Date().toISOString();
      return {
        ...(value.record ? { record: value.record } : {}),
        title: value.title,
        metadata: value.metadata,
        markdown: value.markdown,
        externalUrl: url.href,
        commandDescriptors: [],
        sourceSnapshot: {
          provider: "jira",
          resourceId: resource.id,
          addressVersion: resource.addressVersion,
          entityId: value.entityId,
          locator: value.locator,
          contentHash: hash(value.sourceContent),
          revision,
          fetchedAt: now,
        },
        representation: {
          mediaType: "text/markdown",
          adapter: {
            id: `${result.adapter.id}@${result.manifestHash.slice(0, 12)}`,
            version: result.adapter.version,
          },
          contentHash: hash(value.markdown),
          derivedAt: now,
        },
      };
    } catch {
      throw invalid();
    }
  }
  async execute(
    resource: RemoteEntityResource,
    source: RemoteEntitySource,
    input: ResourceProviderCommandInput,
  ) {
    if (resource.provider === "jira")
      throw new ResourceCatalogError(
        "source-unavailable",
        "Installed Jira extensions are read-only",
      );
    return this.builtin.execute(resource, source, input);
  }
}
