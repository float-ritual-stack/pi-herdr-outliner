import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OutlinerClientRegistration, OutlinerClientRole } from "../../src/types";
import { runHerdrScenario, type HerdrScenarioSession } from "./herdr-runner";

const SCENARIO_NAME = "resource-authoring";
const AUTHORED_TITLE = "PIE267 authored README";
const AUTHORED_TEXT = `${AUTHORED_TITLE} [file::README.md]`;
const README_SENTINEL = "PIE267-README-DETAIL-SENTINEL";
const README_CONTENT = `# PIE-267 Resource fixture\n\n${README_SENTINEL}\n`;

interface CatalogIds {
  readonly sourceIds: readonly string[];
  readonly resourceIds: readonly string[];
}

interface IdRow {
  readonly id: string;
}

interface BlockRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly text: string;
}

interface ResourceIdentityRow {
  readonly resource_id: string;
  readonly source_id: string;
  readonly resource_provider: string;
  readonly address_json: string;
  readonly canonical_key: string;
  readonly source_provider: string;
  readonly boundary_json: string;
}

function readCatalogIds(session: HerdrScenarioSession): CatalogIds {
  const sources = session.database
    .query("SELECT id FROM resource_sources ORDER BY id")
    .all() as IdRow[];
  const resources = session.database
    .query("SELECT id FROM resources ORDER BY id")
    .all() as IdRow[];
  return {
    sourceIds: sources.map(({ id }) => id),
    resourceIds: resources.map(({ id }) => id),
  };
}

function catalogEvidence(catalog: CatalogIds): Record<string, unknown> {
  return {
    sourceCount: catalog.sourceIds.length,
    sourceIds: catalog.sourceIds,
    resourceCount: catalog.resourceIds.length,
    resourceIds: catalog.resourceIds,
  };
}

function assertCatalogUnchanged(
  expected: CatalogIds,
  actual: CatalogIds,
  step: string,
): void {
  assert.deepEqual(actual.sourceIds, expected.sourceIds, `${step} changed Resource Source identities`);
  assert.deepEqual(actual.resourceIds, expected.resourceIds, `${step} changed Resource identities`);
}

function onlyAddedId(
  label: string,
  before: readonly string[],
  after: readonly string[],
): string {
  const previous = new Set(before);
  for (const id of before) {
    assert.ok(after.includes(id), `${label} removed baseline identity ${id}`);
  }
  const added = after.filter((id) => !previous.has(id));
  assert.equal(added.length, 1, `${label} must add exactly one identity`);
  const id = added[0];
  assert.ok(id, `${label} did not expose its new identity`);
  return id;
}

function readResourceIdentity(
  session: HerdrScenarioSession,
  resourceId: string,
): ResourceIdentityRow | null {
  return session.database.query(`
    SELECT
      resource.id AS resource_id,
      resource.source_id AS source_id,
      resource.provider AS resource_provider,
      resource.address_json AS address_json,
      resource.canonical_key AS canonical_key,
      source.provider AS source_provider,
      source.boundary_json AS boundary_json
    FROM resources resource
    JOIN resource_sources source ON source.id = resource.source_id
    WHERE resource.id = ?
  `).get(resourceId) as ResourceIdentityRow | null;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function validateFilesystemIdentity(
  session: HerdrScenarioSession,
  identity: ResourceIdentityRow,
  expectedResourceId: string,
  expectedSourceId: string,
): void {
  assert.equal(identity.resource_id, expectedResourceId, "Canonical Resource ID changed");
  assert.equal(identity.source_id, expectedSourceId, "Canonical Resource Source ID changed");
  assert.equal(identity.resource_provider, "filesystem", "Resource provider must be filesystem");
  assert.equal(identity.source_provider, "filesystem", "Resource Source provider must be filesystem");
  assert.equal(identity.canonical_key, "README.md", "Filesystem canonical key must be README.md");
  assert.deepEqual(
    parseJson(identity.address_json, "Resource address"),
    { kind: "filesystem", path: "README.md" },
  );
  assert.deepEqual(
    parseJson(identity.boundary_json, "Resource Source boundary"),
    { root: session.projectRoot },
  );
}

function matchingClient(
  registrations: readonly OutlinerClientRegistration[],
  paneId: string,
  role: OutlinerClientRole,
): OutlinerClientRegistration | null {
  const matches = registrations.filter((registration) =>
    registration.role === role && registration.runtime?.paneId === paneId
  );
  return matches.length === 1 ? matches[0] ?? null : null;
}

async function waitForDetailTarget(
  session: HerdrScenarioSession,
  resourceId: string,
  requireFocus: boolean,
): Promise<OutlinerClientRegistration> {
  const registrations = await session.waitFor(
    requireFocus ? "focused Detail Resource target" : "Detail Resource target",
    () => session.registrations(),
    (clients) => {
      const detail = matchingClient(clients, session.panes.detail, "detail");
      return detail?.currentTarget?.kind === "resource" &&
        detail.currentTarget.resourceId === resourceId &&
        (!requireFocus || detail.runtime?.focused === true);
    },
  );
  const detail = matchingClient(registrations, session.panes.detail, "detail");
  assert.ok(detail, "Owned Detail registration must remain unique and live");
  return detail;
}

async function waitForTreeFocus(session: HerdrScenarioSession): Promise<void> {
  await session.waitFor(
    "Tree focus",
    () => session.registrations(),
    (clients) => matchingClient(clients, session.panes.tree, "tree")?.runtime?.focused === true,
  );
}

async function waitForAuthoredBlock(session: HerdrScenarioSession): Promise<BlockRow> {
  const rows = await session.waitFor(
    "authored block persistence",
    () => session.database
      .query("SELECT id, parent_id, text FROM blocks WHERE text = ? AND effective_deleted_root_id IS NULL ORDER BY id")
      .all(AUTHORED_TEXT) as BlockRow[],
    (matches) => matches.length === 1,
  );
  assert.equal(rows.length, 1, "Tree authoring must create exactly one matching block");
  const row = rows[0];
  assert.ok(row, "Authored block identity must be readable");
  assert.equal(row.text, AUTHORED_TEXT);
  assert.ok(row.parent_id, "Authored block must be a child of the selected Workspace block");
  return row;
}

export const resourceAuthoringScenario = {
  name: SCENARIO_NAME,
  async prepare(projectRoot: string): Promise<void> {
    await writeFile(join(projectRoot, "README.md"), README_CONTENT, "utf8");
  },
  async run(session: HerdrScenarioSession): Promise<void> {
    await session.record("scenario-fixture", {
      authoredTitle: AUTHORED_TITLE,
      authoredText: AUTHORED_TEXT,
      readmeSentinel: README_SENTINEL,
    });
    const baseline = readCatalogIds(session);
    await session.record("catalog-baseline", catalogEvidence(baseline));

    await session.focus(session.panes.tree);
    await waitForTreeFocus(session);
    await session.keys(session.panes.tree, "a");
    await session.waitVisible(session.panes.tree, "↵ save");
    await session.record("add-child-input-ready", true);
    await session.text(session.panes.tree, AUTHORED_TEXT);
    await session.keys(session.panes.tree, "enter");
    await session.waitVisible(session.panes.tree, AUTHORED_TITLE);

    const authoredBlock = await waitForAuthoredBlock(session);
    assertCatalogUnchanged(baseline, readCatalogIds(session), "Authoring the Resource reference");
    await session.record("authored-block", {
      id: authoredBlock.id,
      parentId: authoredBlock.parent_id,
      text: authoredBlock.text,
    });
    await session.checkpoint("02-block-authored");


    await session.keys(session.panes.tree, "?");
    await session.waitVisible(session.panes.tree, "Find:");
    await session.text(session.panes.tree, "Show authored links");
    await session.waitVisible(session.panes.tree, "Show or hide this block");
    await session.keys(session.panes.tree, "enter");
    await session.waitVisible(session.panes.tree, "Resource not registered");

    const afterReveal = readCatalogIds(session);
    assertCatalogUnchanged(baseline, afterReveal, "Revealing authored links");
    await session.record("catalog-after-reveal", catalogEvidence(afterReveal));
    await session.checkpoint("03-authored-links-revealed");

    await session.keys(session.panes.tree, "down");
    await session.waitVisible(session.panes.tree, "1 authored Resources");
    const atResourcesHeader = readCatalogIds(session);
    assertCatalogUnchanged(baseline, atResourcesHeader, "Selecting the Resources header");

    await session.keys(session.panes.tree, "down");
    await session.waitVisible(session.panes.tree, "Enter creates the Resource");
    const beforeActivation = readCatalogIds(session);
    assertCatalogUnchanged(baseline, beforeActivation, "Selecting the generated README row");
    await session.record("catalog-before-activation", catalogEvidence(beforeActivation));
    await session.checkpoint("04-resource-row-selected");

    await session.keys(session.panes.tree, "enter");
    const firstCatalog = await session.waitFor(
      "first authored Resource activation",
      () => readCatalogIds(session),
      (catalog) =>
        catalog.sourceIds.length === baseline.sourceIds.length + 1 &&
        catalog.resourceIds.length === baseline.resourceIds.length + 1,
    );
    const sourceId = onlyAddedId("First activation Resource Source", baseline.sourceIds, firstCatalog.sourceIds);
    const resourceId = onlyAddedId("First activation Resource", baseline.resourceIds, firstCatalog.resourceIds);
    await session.waitVisible(session.panes.detail, README_SENTINEL);
    const firstDetail = await waitForDetailTarget(session, resourceId, true);

    const firstIdentity = readResourceIdentity(session, resourceId);
    assert.ok(firstIdentity, "Activated Resource must have one canonical readonly SQL identity");
    validateFilesystemIdentity(session, firstIdentity, resourceId, sourceId);
    await session.record("first-activation", {
      catalog: catalogEvidence(firstCatalog),
      resourceIdentity: firstIdentity,
      detailClientId: firstDetail.clientId,
      detailTarget: firstDetail.currentTarget,
      detailPaneId: firstDetail.runtime?.paneId,
    });
    await session.checkpoint("05-resource-activated");

    await session.focus(session.panes.tree);
    await waitForTreeFocus(session);
    await session.keys(session.panes.tree, "down");
    await session.waitVisible(session.panes.tree, "README.md selected");

    const beforeRepeat = readCatalogIds(session);
    assertCatalogUnchanged(firstCatalog, beforeRepeat, "Refocusing and reselecting the canonical Resource");
    await session.keys(session.panes.tree, "enter");
    const repeatedDetail = await waitForDetailTarget(session, resourceId, true);
    await session.waitVisible(session.panes.detail, README_SENTINEL);

    const repeatedCatalog = readCatalogIds(session);
    assertCatalogUnchanged(firstCatalog, repeatedCatalog, "Repeated Resource activation");
    const repeatedIdentity = readResourceIdentity(session, resourceId);
    assert.deepEqual(repeatedIdentity, firstIdentity, "Repeated activation must preserve canonical Resource identity");
    assert.equal(repeatedDetail.clientId, firstDetail.clientId, "Repeated activation must reuse the live Detail client");
    assert.equal(
      repeatedDetail.currentTarget?.kind === "resource"
        ? repeatedDetail.currentTarget.resourceId
        : null,
      resourceId,
      "Repeated activation must retain the canonical Resource target",
    );
    await session.record("repeated-activation", {
      catalog: catalogEvidence(repeatedCatalog),
      resourceIdentity: repeatedIdentity,
      detailClientId: repeatedDetail.clientId,
      detailTarget: repeatedDetail.currentTarget,
      sentinelVisible: true,
    });
    await session.checkpoint("06-resource-reactivated");
  },
} satisfies Parameters<typeof runHerdrScenario>[0];

if (import.meta.main) {
  const result = await runHerdrScenario(resourceAuthoringScenario);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "failed") process.exitCode = 1;
}
