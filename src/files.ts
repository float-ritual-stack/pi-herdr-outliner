import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getProperty } from "./properties";
import type { Block } from "./types";

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

export interface ReferencedFile {
  absolutePath: string;
  displayPath: string;
  sourcePath: string;
  lines: string[];
  firstLine: number;
}

export function resolveReferencedPath(
  sourcePath: string,
  workspaceRoot: string,
  homeDirectory = homedir(),
): string {
  if (sourcePath === "~") return homeDirectory;
  if (sourcePath.startsWith("~/")) return resolve(join(homeDirectory, sourcePath.slice(2)));
  if (sourcePath.startsWith("~")) {
    throw new Error(`Only current-user home paths using ~/ are supported: ${sourcePath}`);
  }
  return isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(workspaceRoot, sourcePath);
}

export function readReferencedFile(block: Block, workspaceRoot: string): ReferencedFile {
  const sourcePath = getProperty(block.properties, "file");
  if (!sourcePath) throw new Error("Selected block has no [file::path] property");

  const absolutePath = resolveReferencedPath(sourcePath, workspaceRoot);
  const stat = statSync(absolutePath);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${sourcePath}`);
  if (stat.size > MAX_PREVIEW_BYTES) throw new Error(`File exceeds the ${MAX_PREVIEW_BYTES / 1024 / 1024} MiB preview limit`);

  const allLines = readFileSync(absolutePath, "utf8").split(/\r?\n/);
  const firstLine = Math.max(1, Number(getProperty(block.properties, "line-start") ?? 1));
  const requestedEnd = Number(getProperty(block.properties, "line-end") ?? allLines.length);
  const lastLine = Math.max(firstLine, Math.min(allLines.length, requestedEnd));

  return {
    absolutePath,
    displayPath: relative(workspaceRoot, absolutePath) || absolutePath,
    sourcePath,
    lines: allLines.slice(firstLine - 1, lastLine),
    firstLine,
  };
}
