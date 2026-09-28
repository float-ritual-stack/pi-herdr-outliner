import { createBlockComment } from "./block-comments";
import { readSavedView } from "./saved-view-read";
import {inspectWorkspaceConnection} from './workspace-diagnostics';
import { parseArgs } from "node:util";
import { normalizePropertyQueryScope, parsePropertyFilterClause } from "./block-query";
import {
  focusBlockByQuery,
  formatBlockFocusMatch,
} from "./block-focus";
import { createOutlinerClient, OutlinerRequestError, type RequestInput } from "./client";
import { requireClientIdForRole } from "./client-target";
import { resolveClientPaths } from "./paths";
import { navigateOutlinerLink, parseOutlinerLinkUri, resolveOutlinerLinkTarget } from "./outliner-links";
import { blockDisplayTitle } from "./references";
import type { BlockReadField, BlockSearchQuery, CaptureReceipt } from "./types";

if(process.argv[2]==='doctor'){
 const report=await inspectWorkspaceConnection();
 console.log(process.argv.includes('--json')?JSON.stringify(report,null,2):report.lines.join('\n'));
 process.exit(report.ok?0:1);
}
const paths = resolveClientPaths();
function parseRevision(value: string | undefined): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("--expected must be the positive integer revision read before editing");
  }
  return revision;
}
function parseLimit(value: string | undefined, fallback: number): number {
  const limit = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return limit;
}

/** Comma-separated block fields; the service validates the names. */
function parseFields(value: string): BlockReadField[] {
  return value.split(",").map((field) => field.trim()).filter(Boolean) as BlockReadField[];
}

const [command = "list", ...rest] = process.argv.slice(2);
const client = createOutlinerClient(paths);
let request: RequestInput | null = null;
let directResult: unknown;

switch (command) {
  case "mentions": {
    const operation=rest[0]??"list";
    if(operation==="ingest") request={action:"mentions.ingest",message:JSON.parse(await Bun.stdin.text())};
    else if(operation==="list") request={action:"mentions.list"};
    else if(operation==="clear") request={action:"mentions.clear"};
    else throw Error("mentions expects ingest (JSON stdin), list, or clear");
    break;
  }
  case "view": {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true, strict: true,
      options: { limit: { type: "string" }, offset: { type: "string" }, expected: { type: "string" } },
    });
    if (positionals.length !== 1) throw new Error("view requires one saved virtual-branch block ID");
    const offset = values.offset === undefined ? undefined : Number(values.offset);
    if (offset !== undefined && (!/^\d+$/.test(values.offset!) || !Number.isSafeInteger(offset))) {
      throw new Error("--offset must be a non-negative integer");
    }
    await client.requireCompatibleService(["views.read"]);
    directResult = await readSavedView(client, positionals[0]!, {
      ...(values.limit === undefined ? {} : { limit: parseLimit(values.limit, 200) }),
      ...(offset === undefined ? {} : { offset }),
      ...(values.expected === undefined ? {} : { expectedRevision: parseRevision(values.expected) }),
    });
    break;
  }
  case "properties-preview": {
    const { values } = parseArgs({
      args: rest, strict: true,
      options: { text: { type: "string" }, stdin: { type: "boolean" } },
    });
    if ((values.text !== undefined) === Boolean(values.stdin)) {
      throw new Error("properties-preview requires either --text or --stdin");
    }
    await client.requireCompatibleService(["properties.preview"]);
    request = { action: "properties.preview", text: values.stdin ? await Bun.stdin.text() : values.text! };
    break;
  }
  case "list": {
    const { values } = parseArgs({
      args: rest,
      options: {
        filter: { type: "string", multiple: true },
        query: { type: "string" },
        text: { type: "string" },
        limit: { type: "string" },
        subtree: { type: "string" },
        "property-scope": { type: "string" },
        fields: { type: "string" },
      },
      strict: true,
    });
    const filters = values.filter?.map((filter) => parsePropertyFilterClause(filter));
    const limit = parseLimit(values.limit, 500);
    const query: BlockSearchQuery = {
      filters,
      ...(values.query === undefined ? {} : { expression: values.query }),
      text: values.text,
      subtreeRootId: values.subtree,
      propertyScope: values["property-scope"] === undefined
        ? undefined
        : normalizePropertyQueryScope(values["property-scope"]),
      limit,
    };
    // An older service ignores `expression` and would return unfiltered results.
    if (query.expression !== undefined) await client.requireCompatibleService(["query.expression"]);
    request = {
      action: "blocks.query",
      query,
      ...(values.fields === undefined ? {} : { fields: parseFields(values.fields) }),
    };
    break;
  }
  case "read": {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true, strict: true,
      options: { fields: { type: "string" } },
    });
    if (positionals.length === 0) throw new Error("read requires one or more block IDs");
    await client.requireCompatibleService(["blocks.read"]);
    request = {
      action: "blocks.read",
      ids: positionals,
      ...(values.fields === undefined ? {} : { fields: parseFields(values.fields) }),
    };
    break;
  }
  case "comment": {
    const {values} = parseArgs({args: rest, strict: true, options: {
      id: {type: "string"}, expected: {type: "string"}, text: {type: "string"}, stdin: {type: "boolean"},
      "request-id": {type: "string"}, quote: {type: "string"}, start: {type: "string"},
      prefix: {type: "string"}, suffix: {type: "string"}, item: {type: "string"}, whole: {type: "boolean"},
    }});
    if (!values.id || !values["request-id"]) throw new Error("comment requires --id and a stable --request-id");
    if (values.whole === (values.quote !== undefined) || (!values.whole && values.quote === undefined)) {
      throw new Error("Choose either --quote with exact source text or --whole for a whole-block comment");
    }
    if (values.whole && [values.start, values.prefix, values.suffix, values.item].some(value => value !== undefined)) {
      throw new Error("Passage context cannot be used with --whole");
    }
    if ((values.text !== undefined) === Boolean(values.stdin)) throw new Error("comment requires either --text or --stdin");
    const body = values.stdin ? await Bun.stdin.text() : values.text!;
    const start = values.start === undefined ? undefined : Number(values.start);
    if (start !== undefined && (!Number.isSafeInteger(start) || start < 0)) throw new Error("--start must be a non-negative UTF-16 source offset");
    await client.requireCompatibleService();
    directResult = await createBlockComment(client, {
      requestId: values["request-id"], author: "user",
      input: {blockId: values.id, expectedRevision: parseRevision(values.expected), body, source: "user",
        ...(values.whole ? {} : {passage: {quote: values.quote!, start, prefix: values.prefix, suffix: values.suffix, itemId: values.item}})},
    });
    break;
  }
  case "capture": {
    const { values } = parseArgs({
      args: rest,
      options: {
        text: { type: "string" },
        stdin: { type: "boolean" },
        "request-id": { type: "string" },
        "captured-from": { type: "string" },
      },
      strict: true,
    });
    if (values.text !== undefined && values.stdin) {
      throw new Error("capture accepts either --text or --stdin, not both");
    }
    const readStdin =
      values.stdin === true || (values.text === undefined && process.stdin.isTTY !== true);
    if (values.text === undefined && !readStdin) {
      throw new Error("capture requires --text or stdin");
    }
    const text = values.text ?? await Bun.stdin.text();
    await client.requireCompatibleService();
    request = {
      action: "capture.create",
      requestId: values["request-id"] ?? crypto.randomUUID(),
      text,
      source: "cli",
      capturedFromBlockId: values["captured-from"],
      author: "user",
    };
    break;
  }
  case "create": {
    const { values } = parseArgs({
      args: rest,
      options: {
        text: { type: "string" },
        parent: { type: "string" },
        author: { type: "string", default: "user" },
      },
      strict: true,
    });
    if (!values.text) throw new Error("create requires --text");
    if (values.author !== "user" && values.author !== "agent" && values.author !== "system") {
      throw new Error("--author must be user, agent, or system");
    }
    request = {
      action: "create",
      text: values.text,
      parentId: values.parent ?? null,
      author: values.author,
    };
    break;
  }
  case "update": {
    const { values } = parseArgs({
      args: rest,
      options: {
        id: { type: "string" },
        text: { type: "string" },
        expected: { type: "string" },
      },
      strict: true,
    });
    if (!values.id || values.text === undefined) throw new Error("update requires --id and --text");
    request = {
      action: "update",
      blockId: values.id,
      text: values.text,
      expectedRevision: parseRevision(values.expected),
      mutation: { author: "user", actorId: "cli" },
    };
    break;
  }
  case "move": {
    const { values } = parseArgs({
      args: rest,
      options: {
        id: { type: "string" },
        parent: { type: "string" },
        position: { type: "string" },
      },
      strict: true,
    });
    if (!values.id || !values.parent) throw new Error("move requires --id and --parent");
    request = {
      action: "move",
      blockId: values.id,
      parentId: values.parent === "root" ? null : values.parent,
      position: values.position ? Number(values.position) : undefined,
    };
    break;
  }
  case "delete": {
    const { values } = parseArgs({
      args: rest,
      options: { id: { type: "string" } },
      strict: true,
    });
    if (!values.id) throw new Error("delete requires --id");
    request = { action: "delete", blockId: values.id };
    break;
  }
  case "select": {
    const { values } = parseArgs({
      args: rest,
      options: { id: { type: "string" } },
      strict: true,
    });
    if (!values.id) throw new Error("select requires --id");
    request = { action: "selection.set", blockId: values.id };
    break;
  }
  case "goto": {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        query: { type: "string" },
        limit: { type: "string" },
        client: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    const query = values.query ?? positionals.join(" ");
    if (!query.trim()) throw new Error("goto requires a block ID, short prefix, or text query");
    const limit = parseLimit(values.limit, 10);
    if (values.client !== undefined) {
      await requireClientIdForRole(client, values.client, "tree");
    }
    const focused = await focusBlockByQuery(client, query, limit, values.client);
    if (focused.resolution.kind === "none") {
      throw new Error(`No block matches: ${query}`);
    }
    if (focused.resolution.kind === "ambiguous") {
      directResult = {
        focused: false,
        query,
        candidates: focused.resolution.matches.map((match) => ({
          id: match.block.id,
          label: formatBlockFocusMatch(match, match.block.id),
          kind: match.kind,
        })),
      };
      process.exitCode = 2;
      break;
    }
    directResult = {
      focused: true,
      id: focused.resolution.match.block.id,
      title: focused.resolution.match.title,
      kind: focused.resolution.match.kind,
    };
    break;
  }
  case "resolve": {
    // Read-only: an unresolved page address is an error, never a new page.
    const [url, ...extra] = rest;
    if (!url || extra.length) throw new Error("resolve requires one pi-outliner URL");
    const resolved = await resolveOutlinerLinkTarget(client, parseOutlinerLinkUri(url), { followMissingPages: false });
    directResult = {
      id: resolved.block.id,
      title: blockDisplayTitle(resolved.block),
      ...(resolved.fragmentId ? { fragmentId: resolved.fragmentId } : {}),
      ...(resolved.block.effectiveDeletedRootId ? { deleted: true } : {}),
    };
    break;
  }
  case "link": {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        url: { type: "string" },
        "source-client": { type: "string" },
        "source-region": { type: "string" },
        "detail-client": { type: "string" },
        "tree-client": { type: "string" },
        "no-focus": { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 1 || (values.url !== undefined && positionals.length > 0)) {
      throw new Error("link accepts one URL, either positional or --url");
    }
    const url = values.url ?? positionals[0];
    if (!url) throw new Error("link requires a pi-outliner URL");
    const sourceClientId = values["source-client"];
    const sourceRegion = values["source-region"];
    const detailClientId = values["detail-client"];
    const treeClientId = values["tree-client"];
    for (const name of ["source-client", "detail-client", "tree-client"] as const) {
      if (values[name] !== undefined && !values[name].trim()) throw new Error(`--${name} requires a client ID`);
    }
    if (sourceRegion !== undefined && sourceRegion !== "tree" && sourceRegion !== "detail") {
      throw new Error("--source-region must be tree or detail");
    }
    if (sourceRegion !== undefined && !sourceClientId) {
      throw new Error("--source-region requires --source-client");
    }
    if ([sourceClientId, detailClientId, treeClientId].filter(value => value !== undefined).length > 1) {
      throw new Error("Use only one of --source-client, --detail-client, or --tree-client");
    }
    const target = parseOutlinerLinkUri(url);
    const resourceTarget = target.kind === "resource" || target.kind === "reference";
    if (detailClientId && target.kind === "goto") {
      throw new Error("goto URLs require --tree-client, not --detail-client");
    }
    if (values["no-focus"] && !detailClientId) {
      throw new Error("--no-focus requires --detail-client");
    }
    if (treeClientId && resourceTarget) {
      throw new Error("Resource and reference URLs require --detail-client or --source-client");
    }
    if (sourceClientId && target.kind === "goto") {
      throw new Error("goto URLs require --tree-client, not --source-client");
    }
    directResult = await navigateOutlinerLink(client, url, {
      sourceClientId, sourceRegion, detailClientId, treeClientId,
      ...(values["no-focus"] ? { focus: false } : {}),
    });
    break;
  }
  case "work-id-status":
    request = { action: "work-ids.status" };
    break;
  case "work-id-configure": {
    const { values } = parseArgs({
      args: rest,
      options: { prefix: { type: "string" } },
      strict: true,
    });
    if (!values.prefix) throw new Error("work-id-configure requires --prefix");
    request = { action: "work-ids.configure", prefix: values.prefix };
    break;
  }
  case "work-id-allocate": {
    const { values } = parseArgs({
      args: rest,
      options: {
        id: { type: "string" },
        expected: { type: "string" },
      },
      strict: true,
    });
    if (!values.id || !values.expected) {
      throw new Error("work-id-allocate requires --id and --expected");
    }
    request = {
      action: "work-ids.allocate",
      blockId: values.id,
      expectedRevision: parseRevision(values.expected),
    };
    break;
  }
  case "changes": {
    const { values } = parseArgs({
      args: rest,
      options: { since: { type: "string" }, limit: { type: "string" } },
      strict: true,
    });
    const sequence =
      values.since !== undefined && /^\d+$/.test(values.since) ? Number(values.since) : Number.NaN;
    if (!Number.isSafeInteger(sequence)) {
      throw new Error("changes requires --since <sequence>, a non-negative integer");
    }
    await client.requireCompatibleService(["changes.since"]);
    request = {
      action: "changes.since",
      sequence,
      ...(values.limit === undefined ? {} : { limit: parseLimit(values.limit, 200) }),
    };
    break;
  }
  case "selection":
    request = { action: "selection.get" };
    break;
  case "clients": {
    const { values } = parseArgs({
      args: rest,
      options: {
        role: { type: "string" },
      },
      strict: true,
    });
    if (values.role !== undefined && values.role !== "tree" && values.role !== "detail" && values.role !== "composed" && values.role !== "observer") {
      throw new Error("clients --role must be tree, detail, composed, or observer");
    }
    request = {
      action: "clients.list",
      ...(values.role ? { role: values.role } : {}),
    };
    break;
  }
  default:
    throw new Error(`Unknown command: ${command}`);
}

// Older services treat an absent timestamp token as an unconditional update.
// Never send the integer contract to one of those services.
if (request && "expectedRevision" in request) await client.requireCompatibleService();
let result: unknown;
try {
  result = request ? await client.request(request) : directResult;
} catch (error) {
  // Query syntax errors carry a position; print it as data instead of a stack trace.
  if (error instanceof OutlinerRequestError && error.problem) {
    console.error(JSON.stringify({ error: error.message, problem: error.problem }, null, 2));
    process.exit(1);
  }
  throw error;
}
if (command === "capture") {
  const receipt = result as CaptureReceipt;
  const capturedFromBlockId = receipt.block.properties.find(
    (property) => property.key === "captured-from",
  )?.value;
  console.log(JSON.stringify({
    blockId: receipt.block.id,
    inboxBlockId: receipt.inboxBlockId,
    source: "cli",
    ...(capturedFromBlockId ? { capturedFromBlockId } : {}),
    deduplicated: receipt.deduplicated,
  }, null, 2));
} else {
  console.log(JSON.stringify(result, null, 2));
}
