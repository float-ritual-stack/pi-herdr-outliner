import {expect, test} from "bun:test";
import {mergeEdits} from "../src/edit-merge";

test("combines assistance metadata with independent long-note writing exactly", () => {
  const base = "My work note\n\nFirst paragraph\n";
  const draft = base + "\n## More\n\n日本語 👩🏽‍💻\n```ts\nconst x = 1;\n```\n";
  const latest = base.replace("My work note", "My work note [type::note]");
  expect(mergeEdits(base, draft, latest)).toEqual({text: draft.replace("My work note", "My work note [type::note]"), conflicts: [], incomplete: false});
});

test("retains overlapping body and property edits for explicit review", () => {
  for (const base of ["Title\n\noriginal\n", "Title [tag::original]\n"]){
    const draft=base.replace("original","local"),latest=base.replace("original","remote");
    const result=mergeEdits(base,draft,latest);
    expect(result.text).toBe(draft);expect(result.conflicts).toHaveLength(1);
  }
});

test("deduplicates identical edits and preserves CRLF, deletion and missing final newline", () => {
  const base="A\r\nB\r\nC";
  expect(mergeEdits(base,"AA\r\nB\r\nC","AA\r\nB\r\nC").text).toBe("AA\r\nB\r\nC");
  expect(mergeEdits(base,"A\r\nC","A\r\nB\r\nCC")).toEqual({text:"A\r\nCC",conflicts:[],incomplete:false});
});

test("same-position insertions cannot silently pick an order", () => {
  expect(mergeEdits("A\n","A\none\n","A\ntwo\n").conflicts).toHaveLength(1);
});

test("concurrent property edits on separate lines still require review",()=>{
  const base="Note\n[tag::work]\n\nBody\n";
  const result=mergeEdits(base,base.replace("Note","Note [type::progress]"),base.replace("[tag::work]","[tag::work] [type::note]"));
  expect(result.propertyConflicts).toContain("type");
  expect(result.text).toBe(base.replace("Note","Note [type::progress]"));
});
