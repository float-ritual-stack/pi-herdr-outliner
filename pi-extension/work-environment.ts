import { basename } from "node:path";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { WorkEnvironmentSnapshot } from "../src/work-environment";

export type ExtensionExec = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

const INSPECTION_TIMEOUT_MS = 1_500;

function normalizedRepository(remote: string, root: string): string {
  const value = remote.trim().replace(/\.git$/i, "");
  const scp = value.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) return scp[1] === "github.com" ? scp[2]! : `${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/^\/+/, "");
    return url.hostname === "github.com" ? path : `${url.hostname}/${path}`;
  } catch {
    return value || basename(root);
  }
}

function parseStatus(
  cwd: string,
  root: string,
  repository: string,
  output: string,
): WorkEnvironmentSnapshot {
  let branch: string | null = null;
  let head: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirtyCount = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length).trim();
      head = oid === "(initial)" ? null : oid.slice(0, 12);
    } else if (line.startsWith("# branch.head ")) {
      const name = line.slice("# branch.head ".length).trim();
      branch = name === "(detached)" ? null : name;
    } else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      ahead = Number(match?.[1] ?? 0);
      behind = Number(match?.[2] ?? 0);
    } else if (line && !line.startsWith("# ")) {
      dirtyCount += 1;
    }
  }
  return { cwd, repository, root, branch, head, dirtyCount, ahead, behind };
}

export async function inspectWorkEnvironment(
  exec: ExtensionExec,
  cwd: string,
  signal?: AbortSignal,
): Promise<WorkEnvironmentSnapshot> {
  const options = { signal, timeout: INSPECTION_TIMEOUT_MS };
  try {
    const rootResult = await exec(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      options,
    );
    const root = rootResult.stdout.trim();
    if (rootResult.code !== 0 || !root) {
      return {
        cwd,
        repository: null,
        root: null,
        branch: null,
        head: null,
        dirtyCount: 0,
        ahead: 0,
        behind: 0,
      };
    }
    const [status, remote] = await Promise.all([
      exec(
        "git",
        ["-C", cwd, "status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
        options,
      ),
      exec("git", ["-C", cwd, "config", "--get", "remote.origin.url"], options),
    ]);
    if (status.code !== 0) throw new Error(status.stderr || "git status failed");
    return parseStatus(
      cwd,
      root,
      normalizedRepository(remote.code === 0 ? remote.stdout : "", root),
      status.stdout,
    );
  } catch {
    return {
      cwd,
      repository: null,
      root: null,
      branch: null,
      head: null,
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
    };
  }
}
