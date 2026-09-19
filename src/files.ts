import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getProperty } from "./properties";
import type { Block } from "./types";
import { ResourceCatalogError, type ResourceRevision } from "./resources";

export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

export interface FileContents {
  readonly absolutePath: string;
  readonly displayPath: string;
  readonly text: string;
  readonly revision: Extract<ResourceRevision, { kind: "filesystem" }> & { readonly contentHash: string };
  readonly contentHash: string;
  readonly capturedAt: string;
}

export interface ReferencedFile {
  absolutePath: string;
  displayPath: string;
  sourcePath: string;
  lines: string[];
  firstLine: number;
  sourceText?: string;
  sourceVersion?: string;
  sourceHash?: string;
  capturedAt?: string;
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

export function readFileContents(sourcePath: string, workspaceRoot: string): FileContents {
  const absolutePath = resolveReferencedPath(sourcePath, workspaceRoot);
  let stat;
  let bytes: Buffer;
  try {
    stat = statSync(absolutePath, { bigint: true });
    if (!stat.isFile()) throw new Error("not a regular file");
    if (stat.size > BigInt(MAX_TEXT_FILE_BYTES)) {
      throw new Error(`exceeds ${MAX_TEXT_FILE_BYTES / 1024 / 1024} MiB`);
    }
    bytes = readFileSync(absolutePath);
  } catch (error) {
    throw new ResourceCatalogError(
      "source-unavailable",
      `Filesystem Resource is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = bytes.toString("utf8");
  return {
    absolutePath,
    displayPath: relative(workspaceRoot, absolutePath) || absolutePath,
    text,
    revision: {
      kind: "filesystem",
      mtimeNs: stat.mtimeNs.toString(),
      size: stat.size.toString(),
      contentHash: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    },
    contentHash: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
    capturedAt: new Date(Number(stat.mtimeMs)).toISOString(),
  };
}

export function referencedFilePreview(block: Pick<Block, "properties">, contents: FileContents): ReferencedFile {
  const sourcePath = getProperty(block.properties, "file");
  if (!sourcePath) throw new Error("Selected block has no [file::path] property");
  const allLines = contents.text.split(/\r?\n/);
  const firstLine = Math.max(1, Number(getProperty(block.properties, "line-start") ?? 1));
  const requestedEnd = Number(getProperty(block.properties, "line-end") ?? allLines.length);
  const lastLine = Math.max(firstLine, Math.min(allLines.length, requestedEnd));
  return {
    absolutePath: contents.absolutePath,
    displayPath: contents.displayPath,
    sourcePath,
    lines: allLines.slice(firstLine - 1, lastLine),
    firstLine,
    sourceText: contents.text,
    sourceVersion: `${contents.revision.mtimeNs}:${contents.revision.size}:${contents.revision.contentHash}`,
    sourceHash: contents.contentHash,
    capturedAt: contents.capturedAt,
  };
}
