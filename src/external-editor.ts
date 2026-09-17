import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ExternalEditorErrorCode =
  | "editor-unset"
  | "editor-invalid"
  | "temporary-file-failed"
  | "terminal-yield-failed"
  | "launch-failed"
  | "nonzero-exit"
  | "read-failed"
  | "terminal-restore-failed"
  | "conflict-check-failed"
  | "version-conflict"
  | "cleanup-failed";

export class ExternalEditorError extends Error {
  constructor(
    readonly code: ExternalEditorErrorCode,
    message: string,
    readonly recoveryPath: string | null,
    options?: ErrorOptions,
  ) {
    super(
      recoveryPath === null
        ? message
        : `${message}. Recoverable editor file: ${recoveryPath}`,
      options,
    );
    this.name = "ExternalEditorError";
  }
}

export interface ExternalEditorInput {
  readonly text: string;
  readonly expectedUpdatedAt: string;
}

export interface ExternalEditorResult {
  readonly text: string;
  readonly changed: boolean;
  readonly recoveryPath: string;
  cleanup(): void;
}

export type ExternalEditorCommand = readonly [executable: string, ...arguments_: string[]];

export type ExternalEditorRunner = (
  command: ExternalEditorCommand,
  filePath: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
) => Promise<number>;

export interface ExternalEditorOptions {
  readonly editor?: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly temporaryRoot?: string;
  readonly suspendTerminal: () => void | Promise<void>;
  readonly restoreTerminal: () => void | Promise<void>;
  readonly currentUpdatedAt: () => Promise<string>;
  readonly run?: ExternalEditorRunner;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(
  code: ExternalEditorErrorCode,
  message: string,
  recoveryPath: string | null,
  cause?: unknown,
): ExternalEditorError {
  return new ExternalEditorError(
    code,
    message,
    recoveryPath,
    cause === undefined ? undefined : { cause },
  );
}

export function parseExternalEditorCommand(value: string): ExternalEditorCommand {
  const arguments_: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote === "single") {
      if (character === "'") quote = null;
      else token += character;
      continue;
    }
    if (quote === "double") {
      if (character === "\"") {
        quote = null;
      } else if (character === "\\") {
        const escaped = value[index + 1];
        if (escaped === undefined) throw new Error("Editor command ends with an escape");
        token += escaped;
        index += 1;
      } else {
        token += character;
      }
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        arguments_.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    if (character === "'" || character === "\"") {
      tokenStarted = true;
      quote = character === "'" ? "single" : "double";
      continue;
    }
    if (character === "\\") {
      const escaped = value[index + 1];
      if (escaped === undefined) throw new Error("Editor command ends with an escape");
      tokenStarted = true;
      token += escaped;
      index += 1;
      continue;
    }
    tokenStarted = true;
    token += character;
  }
  if (quote !== null) throw new Error("Editor command has an unterminated quote");
  if (tokenStarted) arguments_.push(token);
  if (!arguments_[0]) throw new Error("Editor command has no executable");
  return arguments_ as [string, ...string[]];
}

async function runTerminalEditor(
  command: ExternalEditorCommand,
  filePath: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const child = Bun.spawn([...command, filePath], {
    cwd,
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

function readUtf8(filePath: string): string {
  const bytes = readFileSync(filePath);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export async function editTextInExternalEditor(
  input: ExternalEditorInput,
  options: ExternalEditorOptions,
): Promise<ExternalEditorResult> {
  const editor = options.editor?.trim();
  if (!editor) {
    throw failure(
      "editor-unset",
      "Set VISUAL or EDITOR before using Edit in $EDITOR",
      null,
    );
  }
  let command: ExternalEditorCommand;
  try {
    command = parseExternalEditorCommand(editor);
  } catch (error) {
    throw failure(
      "editor-invalid",
      `Configured editor command is invalid: ${reason(error)}`,
      null,
      error,
    );
  }

  let directory: string;
  try {
    directory = mkdtempSync(join(options.temporaryRoot ?? tmpdir(), "pi-outliner-editor-"));
  } catch (error) {
    throw failure(
      "temporary-file-failed",
      `Could not create the external editor temporary directory: ${reason(error)}`,
      null,
      error,
    );
  }
  const filePath = join(directory, "draft.md");
  try {
    writeFileSync(filePath, input.text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw failure(
      "temporary-file-failed",
      `Could not prepare the external editor draft: ${reason(error)}`,
      null,
      error,
    );
  }

  const environment = options.environment ?? process.env;
  const run = options.run ?? runTerminalEditor;
  let primaryError: ExternalEditorError | null = null;
  let importedText: string | null = null;

  try {
    try {
      await options.suspendTerminal();
    } catch (error) {
      throw failure(
        "terminal-yield-failed",
        `Could not yield the Detail terminal: ${reason(error)}`,
        filePath,
        error,
      );
    }

    let exitCode: number;
    try {
      exitCode = await run(command, filePath, options.cwd, environment);
    } catch (error) {
      throw failure(
        "launch-failed",
        `Could not launch ${command[0]}: ${reason(error)}`,
        filePath,
        error,
      );
    }
    if (exitCode !== 0) {
      throw failure(
        "nonzero-exit",
        `${command[0]} exited with status ${exitCode}; the Detail draft was not changed`,
        filePath,
      );
    }

    try {
      importedText = readUtf8(filePath);
    } catch (error) {
      throw failure(
        "read-failed",
        `Could not read UTF-8 text returned by ${command[0]}: ${reason(error)}`,
        filePath,
        error,
      );
    }
  } catch (error) {
    primaryError = error instanceof ExternalEditorError
      ? error
      : failure("launch-failed", reason(error), filePath, error);
  }

  try {
    await options.restoreTerminal();
  } catch (error) {
    throw failure(
      "terminal-restore-failed",
      `Could not restore the originating Detail terminal: ${reason(error)}`,
      filePath,
      primaryError ?? error,
    );
  }
  if (primaryError) throw primaryError;
  if (importedText === null) {
    throw failure("read-failed", "The external editor returned no readable text", filePath);
  }

  let currentUpdatedAt: string;
  try {
    currentUpdatedAt = await options.currentUpdatedAt();
  } catch (error) {
    throw failure(
      "conflict-check-failed",
      `Could not verify the canonical block after editing: ${reason(error)}`,
      filePath,
      error,
    );
  }
  if (currentUpdatedAt !== input.expectedUpdatedAt) {
    throw failure(
      "version-conflict",
      "The canonical block changed while the external editor was open; the Detail draft was not changed",
      filePath,
    );
  }

  let cleaned = false;
  return {
    text: importedText,
    changed: importedText !== input.text,
    recoveryPath: filePath,
    cleanup() {
      if (cleaned) return;
      try {
        rmSync(directory, { recursive: true });
        cleaned = true;
      } catch (error) {
        throw failure(
          "cleanup-failed",
          `Could not remove the external editor temporary directory: ${reason(error)}`,
          filePath,
          error,
        );
      }
    },
  };
}
