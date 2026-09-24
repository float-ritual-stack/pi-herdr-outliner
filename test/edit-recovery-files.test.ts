import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,writeFileSync,rmSync,readdirSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {EditRecoveryFiles} from "../src/edit-recovery-files";

test("external return retains exact writing despite canonical changes and survives reopening",async()=>{
  const root=mkdtempSync(join(tmpdir(),"recovery-journal-"));
  try {
    const files=new EditRecoveryFiles(root);
    const result=await files.edit({blockId:"note",baseText:"Base",expectedRevision:1,text:"Unsaved before launch"},{editor:"fixture",cwd:root,suspendTerminal(){},restoreTerminal(){},async currentRevision(){throw Error("must not discard returned writing");},async run(_cmd,file){writeFileSync(file,"Long returned 日本語\n```\n[work-id::PIE-1]\n```");return 0;}});
    expect(result.recoveryInput.prelaunchText).toBe("Unsaved before launch");
    expect(statSync(result.recoveryPath).mode&0o777).toBe(0o600);
    const reopened=new EditRecoveryFiles(root).pending("note");
    expect(reopened).toHaveLength(1);expect(reopened[0]!.input.draftText).toBe(result.text);
    reopened[0]!.cleanup();expect(files.pending("note")).toEqual([]);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("nonzero editor exit keeps its returned writing discoverable in the same process",async()=>{
  const root=mkdtempSync(join(tmpdir(),"recovery-journal-"));
  try {
    const files=new EditRecoveryFiles(root);
    await expect(files.edit({blockId:"note",baseText:"Base",expectedRevision:1,text:"Before"},{editor:"fixture",cwd:root,suspendTerminal(){},restoreTerminal(){},async currentRevision(){return "2";},async run(_cmd,file){writeFileSync(file,"Still valuable");return 1;}})).rejects.toThrow();
    expect(files.pending("note")[0]?.input.draftText).toBe("Still valuable");
    const dir=join(root,"editor-drafts",readdirSync(join(root,"editor-drafts"))[0]!);
    const manifest=JSON.parse(readFileSync(join(dir,"context.json"),"utf8"));
    expect(manifest.returned).toBe(true);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("a damaged journal stays visible without blocking other retained drafts",()=>{
  const root=mkdtempSync(join(tmpdir(),"recovery-journal-"));
  try {
    const files=new EditRecoveryFiles(root);
    const input={id:crypto.randomUUID(),blockId:"note",baseText:"Base",baseRevision:1,prelaunchText:"Before",draftText:"Valuable writing",source:"save-conflict" as const};
    files.retain(input);
    const broken=join(root,"editor-drafts",readdirSync(join(root,"editor-drafts"))[0]!);
    writeFileSync(join(broken,"context.json"),"{partial");
    files.retain({...input,id:crypto.randomUUID()});
    const issues:string[]=[];
    const pending=files.pending("note",message=>issues.push(message));
    expect(pending).toHaveLength(1);expect(pending[0]?.input.draftText).toBe("Valuable writing");
    expect(issues[0]).toContain(broken);expect(issues[0]).toContain("Files retained");
    expect(readFileSync(join(broken,"draft.md"),"utf8")).toBe("Valuable writing");
  } finally {rmSync(root,{recursive:true,force:true});}
});
