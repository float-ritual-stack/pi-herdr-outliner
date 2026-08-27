import { parseArgs } from "node:util";
import {
  focusBlockByQuery,
  formatBlockFocusMatch,
} from "./block-focus";
import { OutlinerClient, type RequestInput } from "./client";
import { resolvePaths } from "./paths";
import { navigateOutlinerLink } from "./outliner-links";
import type { BlockSearchQuery, PropertyFilter } from "./types";

function parsePropertyFilter(item: string): PropertyFilter {
  const separator = item.includes("::") ? "::" : "=";
  const index = item.indexOf(separator);
  if (index < 0) return { key: item };
  return {
    key: item.slice(0, index),
    value: item.slice(index + separator.length),
  };
}

function parseLimit(value: string | undefined, fallback: number): number {
  const limit = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return limit;
}

const [command = "list", ...rest] = process.argv.slice(2);
const client = new OutlinerClient(resolvePaths().socket);
let request: RequestInput | null = null;
let directResult: unknown;

switch (command) {
  case "list": {
    const { values } = parseArgs({
      args: rest,
      options: {
        filter: { type: "string", multiple: true },
        text: { type: "string" },
        limit: { type: "string" },
      },
      strict: true,
    });
    const filters = values.filter?.map(parsePropertyFilter);
    const limit = parseLimit(values.limit, 500);
    const query: BlockSearchQuery = {
      filters,
      text: values.text,
      limit,
    };
    request = { action: "blocks.query", query };
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
      },
      strict: true,
    });
    if (!values.id || values.text === undefined) throw new Error("update requires --id and --text");
    request = { action: "update", blockId: values.id, text: values.text };
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
      },
      allowPositionals: true,
      strict: true,
    });
    const query = values.query ?? positionals.join(" ");
    if (!query.trim()) throw new Error("goto requires a block ID, short prefix, or text query");
    const limit = parseLimit(values.limit, 10);
    const focused = await focusBlockByQuery(client, query, limit);
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
  case "link": {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { url: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    const url = values.url ?? positionals.join("");
    if (!url) throw new Error("link requires a pi-outliner URL");
    directResult = await navigateOutlinerLink(client, url);
    break;
  }
  case "selection":
    request = { action: "selection.get" };
    break;
  default:
    throw new Error(`Unknown command: ${command}`);
}

const result = request ? await client.request(request) : directResult;
console.log(JSON.stringify(result, null, 2));
