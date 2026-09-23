import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {readFile, realpath} from "node:fs/promises";
import {join} from "node:path";
import {promisify} from "node:util";
import type {Block, BrowsingContextState} from "../../src/types";
import {runHerdrScenario} from "./herdr-runner";

const composed = process.argv.includes("--composed");
const heading = "Keys seen by this pane";
const result = await runHerdrScenario({
  name: `key-inspector${composed ? "-composed" : ""}`,
  layout: composed ? "composed" : "separate",
  async prepare() {},
  async run(s) {
    const terminal = await s.attachClient();
    await terminal.resize(720, 70);
    const registrations = await s.registrations();
    const tree = registrations.find(c => c.runtime?.paneId === s.panes.tree && c.role === (composed ? "composed" : "tree"))!;
    const detail = registrations.find(c => c.runtime?.paneId === s.panes.detail && c.role === (composed ? "composed" : "detail"))!;
    assert.ok(tree && detail);
    const doc = await s.client.request<Block>({action: "create", text: "KEY INSPECTOR RETAINED DOCUMENT\n\nOrdinary keys must not edit this body."});
    await s.revealTree(s.panes.tree, doc.id); await s.keys(s.panes.tree, "enter");
    await s.waitVisible(s.panes.detail, "Ordinary keys must not edit this body.");
    const context = () => s.client.request<BrowsingContextState>({action: "browsing-context.get", contextId: tree.contextId!});
    let ansiInput: {focus(): Promise<void>; visible(): Promise<string>; keys(...keys: string[]): Promise<void>} | undefined;
    const inspect = async (pane: string, clientId: string, label: string, startup = false) => {
      const input = startup ? ansiInput! : {focus: () => s.focus(pane), visible: () => s.visible(pane), keys: (...keys: string[]) => s.keys(pane, ...keys)};
      const visibleText = (text: string) => s.waitFor(`${label} shows ${text}`, input.visible, frame => frame.includes(text));
      await input.focus();
      if (composed) {
        const region = label === "tree" ? "tree" : "detail";
        await s.client.request({action: "ui.command.send", command: {command: "focus", targetClientId: clientId, targetRegion: region}});
        await s.waitFor("inspected region focused", s.registrations, values => values.find(c => c.clientId === clientId)?.focusedRegion === region);
      }
      const beforeClients = await s.registrations();
      const before = beforeClients.find(c => c.clientId === clientId)!;
      const beforeContext = await context();
      if (!startup) {
        await input.keys("?"); await visibleText("Find:");
        await s.text(pane, "Inspect received keys"); await visibleText("Inspect received keys");
        await input.keys("enter");
      }
      await visibleText(heading);
      // Only the newest raw chunk is checked, so an earlier matching sample
      // cannot conceal dropped input or a stale diagnostic frame.
      const latest = (frame: string) => frame.slice(frame.indexOf("Chunk ")).split(/\n[^\n]*Chunk /)[0]!;
      const sample = async (name: string, send: () => Promise<void>, expected: string[]) => {
        const serialBefore = Number((await input.visible()).match(/Chunk (\d+)/)?.[1] ?? 0);
        await send();
        const frame = await s.waitFor(`${label} ${name} captured`, () => input.visible(), text => text.includes(heading) && Number(text.match(/Chunk (\d+)/)?.[1] ?? 0) > serialBefore && expected.every(part => latest(text).includes(part)));
        await s.record(`${label}-${name}`, {frame, latest: latest(frame)});
        return latest(frame);
      };
      const literal = await sample("literal-option-text", () => terminal.write("¬"), ["Hex: c2 ac", "U+00AC"]);
      assert.ok(literal.includes("Tree browse: none") && literal.includes("Detail preview: none"));
      await sample("native-alt-l", () => terminal.write("\x1bl"), ["Alt+L", "tree.navigation.link", "detail.navigation.link"]);
      await sample("herdr-alt-l", () => input.keys("alt+l"), ["Alt+L", "tree.navigation.link", "detail.navigation.link"]);
      await sample("modified-arrow", () => terminal.write("\x1b[1;4C"), ["Alt+Shift+ArrowRight"]);
      await sample("ordinary-edit-key", () => terminal.write("e"), ["Hex: 65"]);
      await sample("ordinary-down", () => input.keys("down"), ["ArrowDown"]);
      await sample("bare-escape", () => terminal.write("\x1b"), ["Hex: 1b", "U+001B"]);
      await s.checkpoint(`${label}-captured-escape-without-closing`);
      await terminal.write("\x11");
      await s.waitFor("Ctrl+Q closes inspector only", () => input.visible(), frame => !frame.includes(heading) && frame.includes("KEY INSPECTOR RETAINED DOCUMENT"));
      const afterClients = await s.registrations();
      assert.deepEqual(afterClients.map(c => c.clientId).sort(), beforeClients.map(c => c.clientId).sort(), "Diagnostic keys must not open or close app panes");
      const after = afterClients.find(c => c.clientId === clientId)!;
      assert.deepEqual(after.currentTarget, before.currentTarget);
      assert.deepEqual(after.previewTarget, before.previewTarget);
      assert.deepEqual(after.navigationProtection ?? null, before.navigationProtection ?? null, "Typing e in the inspector must not start an editor");
      assert.deepEqual(await context(), beforeContext, "Arrow keys in the inspector must not change Tree selection");
      assert.equal((await s.client.request<Block>({action: "get", blockId: doc.id})).text, doc.text);
      const restored = await input.visible();
      assert.ok(!restored.includes("Link destination ·"), "Alt+L is inspected without executing its action");
      await s.record(`${label}-closed-with-state-preserved`, {before, after, beforeContext, frame: restored});
      await s.checkpoint(`${label}-closed-app-still-live`);
    };
    await inspect(s.panes.tree, tree.clientId, "tree");
    await inspect(s.panes.detail, detail.clientId, "detail-pi");
    if (!composed) {
      // ANSI has no action-menu adapter. Exercise its documented startup flag
      // through a fresh pane on the verified private Herdr session instead.
      const isolation = JSON.parse(await readFile(join(s.artifactDirectory, "isolation.json"), "utf8")) as {runRoot: string; sessionName: string; effectiveEnvironment: Record<string, string>};
      const execute = promisify(execFile);
      const nativeText = async (args: string[]): Promise<string> => {
        const {stdout} = await execute(isolation.effectiveEnvironment.HERDR_BIN_PATH!, ["--session", isolation.sessionName, ...args], {env: {...process.env, ...isolation.effectiveEnvironment}, timeout: 10000});
        return stdout;
      };
      const native = async (args: string[]): Promise<unknown> => { const output = await nativeText(args); return output.trim() ? JSON.parse(output) : undefined; };
      const status = await native(["status", "server", "--json"]) as {session: string; socket: string};
      assert.equal(status.session, isolation.sessionName); assert.ok(status.socket.startsWith(`${isolation.runRoot}/`));
      await s.record("ansi-private-session", status);
      const before = await s.registrations();
      await native(["plugin", "pane", "open", "--plugin", "float.pi-outliner", "--entrypoint", "detail", "--placement", "split", "--target-pane", s.panes.detail, "--direction", "right", "--focus",
        "--env", "OUTLINER_DETAIL_RENDERER=ansi", "--env", "OUTLINER_DEBUG_KEYS=1", "--env", `OUTLINER_WORKSPACE_ROOT=${s.projectRoot}`,
        "--env", `OUTLINER_BROWSING_CONTEXT_ID=${crypto.randomUUID()}`, "--env", `OUTLINER_DETAIL_TARGET=${encodeURIComponent(JSON.stringify({kind: "block", blockId: doc.id}))}`]);
      const added = await s.waitFor("ANSI inspector pane registered", s.registrations, values => values.some(c => c.role === "detail" && !!c.runtime?.paneId && !before.some(old => old.clientId === c.clientId)));
      const ansi = added.find(c => c.role === "detail" && !before.some(old => old.clientId === c.clientId))!;
      const pane = ansi.runtime!.paneId!;
      await s.waitFor("ANSI initial Current loaded", s.registrations, values => { const target = values.find(c => c.clientId === ansi.clientId)?.currentTarget; return target?.kind === "block" && target.blockId === doc.id; });
      // adoptDetached verifies the default Pi renderer. Keep this ANSI-only
      // startup diagnostic bounded here, with explicit process/environment proof.
      try {
        const processInfo = await native(["pane", "process-info", "--pane", pane]) as {result: {process_info: {pane_id: string; foreground_processes: Array<{pid: number}>}}};
        assert.equal(processInfo.result.process_info.pane_id, pane);
        const proof = await s.waitFor("ANSI startup environment", async () => {
          for (const {pid} of processInfo.result.process_info.foreground_processes) {
            try {
              const entries = new Map((await readFile(`/proc/${pid}/environ`, "utf8")).split("\0").map(entry => {const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)];}));
              const expected = {HERDR_SOCKET_PATH: status.socket, HERDR_PANE_ID: pane, OUTLINER_DETAIL_RENDERER: "ansi", OUTLINER_DEBUG_KEYS: "1", OUTLINER_STATE_DIR: isolation.effectiveEnvironment.OUTLINER_STATE_DIR!};
              if (Object.entries(expected).every(([key, value]) => entries.get(key) === value)) return {pid, cwd: await realpath(`/proc/${pid}/cwd`), environment: expected};
            } catch { /* The shell can be replaced by the actual pane process. */ }
          }
          return null;
        }, value => value !== null);
        const provenance = JSON.parse(await readFile(join(s.artifactDirectory, "provenance.json"), "utf8")) as {pluginRoot: string};
        assert.equal(proof!.cwd, provenance.pluginRoot);
        await s.record("ansi-inspector-process", proof);
        ansiInput = {
          async focus() { await native(["plugin", "pane", "focus", pane]); },
          visible: () => nativeText(["pane", "read", pane, "--source", "visible", "--format", "text"]),
          async keys(...keys) { await native(["pane", "send-keys", pane, ...keys]); },
        };
        await inspect(pane, ansi.clientId, "detail-ansi", true);
      } finally { await native(["pane", "close", pane]); }
    }
  },
});
console.log(JSON.stringify(result, null, 2));
if (result.status !== "passed") process.exitCode = 1;
