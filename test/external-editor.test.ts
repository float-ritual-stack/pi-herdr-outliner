import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editTextInExternalEditor,
  ExternalEditorError,
  parseExternalEditorCommand,
} from "../src/external-editor";

test("parses configured editor arguments without invoking a shell", () => {
  expect(parseExternalEditorCommand(`code --wait "profile name" 'literal $HOME'`)).toEqual([
    "code",
    "--wait",
    "profile name",
    "literal $HOME",
  ]);
  expect(() => parseExternalEditorCommand(`code "unterminated`)).toThrow(
    "unterminated quote",
  );
});

test("imports exact UTF-8 text only after terminal restoration and removes the temporary file", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-external-editor-test-"));
  let filePath = "";
  const phases: string[] = [];
  try {
    const result = await editTextInExternalEditor(
      { text: "before\n", expectedUpdatedAt: "version-1" },
      {
        editor: `fixture-editor --wait`,
        cwd: root,
        temporaryRoot: root,
        suspendTerminal() {
          phases.push("suspend");
        },
        restoreTerminal() {
          phases.push("restore");
        },
        async currentUpdatedAt() {
          phases.push("check");
          return "version-1";
        },
        async run(command, candidate) {
          phases.push(`run:${command.join(" ")}`);
          filePath = candidate;
          writeFileSync(candidate, "héllo\n[[PIE-136]]\n", "utf8");
          return 0;
        },
      },
    );

    expect(result.text).toBe("héllo\n[[PIE-136]]\n");
    expect(result.changed).toBe(true);
    expect(result.recoveryPath).toBe(filePath);
    expect(phases).toEqual([
      "suspend",
      "run:fixture-editor --wait",
      "restore",
      "check",
    ]);
    expect(existsSync(filePath)).toBe(true);
    result.cleanup();
    expect(existsSync(filePath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves a leading U+FEFF and treats an untouched file as unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-external-editor-bom-"));
  try {
    const text = "\uFEFFauthored";
    const result = await editTextInExternalEditor(
      { text, expectedUpdatedAt: "version-1" },
      {
        editor: "fixture-editor",
        cwd: root,
        temporaryRoot: root,
        suspendTerminal() {},
        restoreTerminal() {},
        async currentUpdatedAt() {
          return "version-1";
        },
        async run() {
          return 0;
        },
      },
    );

    expect(result.text).toBe(text);
    expect(result.changed).toBe(false);
    result.cleanup();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nonzero editor exit preserves the original draft and identifies recovery content", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-external-editor-failure-"));
  let filePath = "";
  let restored = false;
  try {
    const error = await editTextInExternalEditor(
      { text: "before", expectedUpdatedAt: "version-1" },
      {
        editor: "fixture-editor",
        cwd: root,
        temporaryRoot: root,
        suspendTerminal() {},
        restoreTerminal() {
          restored = true;
        },
        async currentUpdatedAt() {
          throw new Error("must not check after editor failure");
        },
        async run(_command, candidate) {
          filePath = candidate;
          writeFileSync(candidate, "recoverable changes", "utf8");
          return 9;
        },
      },
    ).then(
      () => null,
      (candidate) => candidate,
    );

    expect(error).toBeInstanceOf(ExternalEditorError);
    expect(error).toMatchObject({ code: "nonzero-exit", recoveryPath: filePath });
    expect(restored).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("recoverable changes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent canonical changes reject import and retain the edited file", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-external-editor-conflict-"));
  let filePath = "";
  try {
    const error = await editTextInExternalEditor(
      { text: "before", expectedUpdatedAt: "version-1" },
      {
        editor: "fixture-editor",
        cwd: root,
        temporaryRoot: root,
        suspendTerminal() {},
        restoreTerminal() {},
        async currentUpdatedAt() {
          return "version-2";
        },
        async run(_command, candidate) {
          filePath = candidate;
          writeFileSync(candidate, "after", "utf8");
          return 0;
        },
      },
    ).then(
      () => null,
      (candidate) => candidate,
    );

    expect(error).toMatchObject({ code: "version-conflict", recoveryPath: filePath });
    expect(readFileSync(filePath, "utf8")).toBe("after");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal restoration failure blocks import and retains the edited file", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-external-editor-restore-"));
  let filePath = "";
  let checkedVersion = false;
  try {
    const error = await editTextInExternalEditor(
      { text: "before", expectedUpdatedAt: "version-1" },
      {
        editor: "fixture-editor",
        cwd: root,
        temporaryRoot: root,
        suspendTerminal() {},
        restoreTerminal() {
          throw new Error("pane unavailable");
        },
        async currentUpdatedAt() {
          checkedVersion = true;
          return "version-1";
        },
        async run(_command, candidate) {
          filePath = candidate;
          writeFileSync(candidate, "after", "utf8");
          return 0;
        },
      },
    ).then(
      () => null,
      (candidate) => candidate,
    );

    expect(error).toMatchObject({
      code: "terminal-restore-failed",
      recoveryPath: filePath,
    });
    expect(checkedVersion).toBe(false);
    expect(readFileSync(filePath, "utf8")).toBe("after");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
