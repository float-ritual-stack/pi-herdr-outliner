import { readFileSync, readdirSync, statSync } from "node:fs";
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
  sourceText?: string;
  sourceVersion?: string;
  sourceHash?: string;
}

export interface ReferencedPathCandidate {
  sourcePath: string;
  isDirectory: boolean;
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

export function completeReferencedPaths(
  prefix: string,
  workspaceRoot: string,
  homeDirectory = homedir(),
  limit = 20,
): ReferencedPathCandidate[] {
  if (prefix.startsWith("~") && prefix !== "~" && !prefix.startsWith("~/")) {
    resolveReferencedPath(prefix, workspaceRoot, homeDirectory);
  }
  const slash = prefix.lastIndexOf("/");
  const directoryPrefix =
    prefix === "~" ? "~/" : slash >= 0 ? prefix.slice(0, slash + 1) : "";
  const basenamePrefix = prefix === "~" ? "" : prefix.slice(slash + 1);
  const directoryPath = resolveReferencedPath(
    directoryPrefix || ".",
    workspaceRoot,
    homeDirectory,
  );

  return readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(basenamePrefix))
    .flatMap((entry) => {
      try {
        const stat = statSync(join(directoryPath, entry.name));
        if (!stat.isDirectory() && !stat.isFile()) return [];
        const isDirectory = stat.isDirectory();
        return [{
          sourcePath: `${directoryPrefix}${entry.name}${isDirectory ? "/" : ""}`,
          isDirectory,
        }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      return left.sourcePath.localeCompare(right.sourcePath);
    })
    .slice(0, Math.max(0, limit));
}

export function readReferencedFile(block: Block, workspaceRoot: string): ReferencedFile {
  const sourcePath = getProperty(block.properties, "file");
  if (!sourcePath) throw new Error("Selected block has no [file::path] property");

  const absolutePath = resolveReferencedPath(sourcePath, workspaceRoot);
  const stat = statSync(absolutePath);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${sourcePath}`);
  if (stat.size > MAX_PREVIEW_BYTES) throw new Error(`File exceeds the ${MAX_PREVIEW_BYTES / 1024 / 1024} MiB preview limit`);

  const sourceText = readFileSync(absolutePath, "utf8");
  const allLines = sourceText.split(/\r?\n/);
  const firstLine = Math.max(1, Number(getProperty(block.properties, "line-start") ?? 1));
  const requestedEnd = Number(getProperty(block.properties, "line-end") ?? allLines.length);
  const lastLine = Math.max(firstLine, Math.min(allLines.length, requestedEnd));

  return {
    absolutePath,
    displayPath: relative(workspaceRoot, absolutePath) || absolutePath,
    sourcePath,
    lines: allLines.slice(firstLine - 1, lastLine),
    firstLine,
    sourceText,
    sourceVersion: `${stat.mtimeMs}:${stat.size}`,
    sourceHash: new Bun.CryptoHasher("sha256").update(sourceText).digest("hex"),
  };
}
