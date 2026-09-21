import assert from "node:assert/strict";
import type { Block, BrowsingContextState } from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";

const result = await runHerdrScenario({
  name: "tree-inline-preview",
  async prepare() {},
  async run(session) {
    const create = (text: string, parentId: string | null = null) =>
      session.client.request<Block>({ action: "create", text, parentId });
    const note = await create("INLINE-NOTE [probe::inline-note]\n\nINLINE ROOT BODY");
    const child = await create("INLINE-CHILD [probe::inline-child]\n\nINLINE CHILD BODY", note.id);
    const inner = await create("INLINE-INNER [type::virtual-branch] [query::probe=inline-note] [probe::inline-board]");
    const outer = await create("INLINE-OUTER [type::virtual-branch] [query::probe=inline-board]");
    const treePane = session.panes.tree;
    const tree = (await session.registrations()).find((client) =>
      client.runtime?.paneId === treePane && client.role === "tree"
    );
    assert.ok(tree?.contextId);
    const context = () => session.client.request<BrowsingContextState>({
      action: "browsing-context.get", contextId: tree.contextId!,
    });
    const selected = (id: string) => session.waitFor("selected canonical block", context,
      (state) => state.target?.kind === "block" && state.target.blockId === id);
    const expand = async (label: string, body: string) => {
      assert.ok(!(await session.visible(treePane)).includes(body), `${label}: initially collapsed`);
      await session.keys(treePane, ".");
      await session.waitVisible(treePane, body);
      await session.checkpoint(label);
      await session.keys(treePane, ".");
      await session.waitFor(`${label}: collapsed body disappears`, () => session.visible(treePane),
        (frame) => !frame.includes(body));
    };

    // Inline reading must work while the independent Detail stays on another target.
    await session.revealTree(treePane, outer.id);
    await session.waitVisible(session.panes.detail, "INLINE-OUTER");
    await session.keys(session.panes.detail, "i");
    await session.waitFor("Detail locked to the outer branch", session.registrations, (entries) =>
      entries.some((entry) => entry.runtime?.paneId === session.panes.detail && entry.locked === true &&
        entry.currentTarget?.kind === "block" && entry.currentTarget.blockId === outer.id)
    );

    await session.revealTree(treePane, note.id);
    await expand("01-physical-source", "INLINE ROOT BODY");
    await session.revealTree(treePane, inner.id);
    await session.keys(treePane, "down");
    await selected(note.id);
    await expand("02-direct-projection", "INLINE ROOT BODY");
    await session.revealTree(treePane, outer.id);
    await session.keys(treePane, "down");
    await selected(inner.id);
    await session.keys(treePane, "down");
    await selected(note.id);
    await expand("03-nested-projection", "INLINE ROOT BODY");
    await session.keys(treePane, "down");
    await selected(child.id);
    await expand("04-nested-child", "INLINE CHILD BODY");

    const detail = (await session.registrations()).find((entry) =>
      entry.runtime?.paneId === session.panes.detail
    );
    assert.equal(detail?.locked, true);
    assert.equal(detail?.currentTarget?.kind, "block");
    assert.equal(detail?.currentTarget?.kind === "block" && detail.currentTarget.blockId, outer.id);
    for (const original of [note, child, inner, outer]) {
      const current = await session.client.request<Block>({ action: "get", blockId: original.id });
      assert.equal(current.text, original.text);
      assert.equal(current.revision, original.revision);
    }
    await session.record("inline-preview-invariants", {
      noteId: note.id, childId: child.id, innerId: inner.id, outerId: outer.id,
      detail, canonicalTextAndRevisionsUnchanged: true,
    });
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "failed") process.exitCode = 1;
