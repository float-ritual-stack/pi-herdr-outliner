import { parseArgs } from "node:util";
import { OutlinerClient, type RequestInput } from "./client";
import { resolvePaths } from "./paths";
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

const [command = "list", ...rest] = process.argv.slice(2);
const client = new OutlinerClient(resolvePaths().socket);
let request: RequestInput;

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
    const limit = values.limit === undefined ? 500 : Number(values.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("--limit must be a positive integer");
    }
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
  case "selection":
    request = { action: "selection.get" };
    break;
  default:
    throw new Error(`Unknown command: ${command}`);
}

console.log(JSON.stringify(await client.request(request), null, 2));
