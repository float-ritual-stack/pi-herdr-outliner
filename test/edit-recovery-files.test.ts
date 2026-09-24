import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,writeFileSync,rmSync,readdirSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {EditRecoveryFiles} from "../src/edit-recovery-files";
import {EditRecoveryClient,EditRecoveryRetainedLocallyError} from "../src/edit-recovery-client";
import {OutlinerClient} from "../src/client";

test("retention distinguishes service failure from failure to journal locally",async()=>{
  const root=mkdtempSync(join(tmpdir(),"recovery-journal-"));
  try {
    const client=new OutlinerClient(join(root,"unused.sock"));
    const serviceError=Error("Disconnected");
    let requests=0;
    client.request=async()=>{requests++;throw serviceError;};
    const recovery=new EditRecoveryClient(client,root);
    const input={id:crypto.randomUUID(),blockId:"note",baseText:"Base",baseRevision:1,prelaunchText:"Draft",draftText:"Draft",source:"save-conflict" as const};
    await expect(recovery.retain(input)).rejects.toBeInstanceOf(EditRecoveryRetainedLocallyError);
    expect(recovery.files.pending("note")[0]?.input.draftText).toBe("Draft");
    const blocked=join(root,"blocked");writeFileSync(blocked,"not a directory");
    const unavailable=new EditRecoveryClient(client,blocked);
    let failure:unknown;
    try {await unavailable.retain(input);} catch(error){failure=error;}
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(EditRecoveryRetainedLocallyError);
    expect(requests).toBe(1);
  } finally {rmSync(root,{recursive:true,force:true});}
});

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

for (const failure of ["editor-unset","editor-invalid","terminal-yield-failed","launch-failed","nonzero-exit"] as const) {
  test(`${failure} discards unchanged editor journals across repeated attempts`,async()=>{
    const root=mkdtempSync(join(tmpdir(),"recovery-journal-"));
    try {
      const files=new EditRecoveryFiles(root);
      for (let attempt=0;attempt<2;attempt++) {
        await expect(files.edit({blockId:"note",baseText:"Base",expectedRevision:1,text:"Unsaved draft"},{
          editor:failure==="editor-unset" ? undefined : failure==="editor-invalid" ? "'" : "fixture",cwd:root,
          suspendTerminal(){if(failure==="terminal-yield-failed")throw Error("Cannot yield");},restoreTerminal(){},
          async currentRevision(){return "1";},async run(){if(failure==="launch-failed")throw Error("Cannot launch");return 1;},
        })).rejects.toMatchObject({code:failure});
        expect(files.pending("note")).toEqual([]);
        expect(readdirSync(join(root,"editor-drafts"))).toEqual([]);
      }
    } finally {rmSync(root,{recursive:true,force:true});}
  });
}

test("successful unchanged editor returns remain journaled",async()=>{
  const root=mkdtempSync(join(tmpdir(),"recovery-journal-"));
  try {
    const files=new EditRecoveryFiles(root);
    await files.edit({blockId:"note",baseText:"Base",expectedRevision:1,text:"Unsaved draft"},{editor:"fixture",cwd:root,suspendTerminal(){},restoreTerminal(){},async currentRevision(){return "1";},async run(){return 0;}});
    expect(files.pending("note")[0]?.input.draftText).toBe("Unsaved draft");
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("failed editors preserve changed invalid UTF-8 bytes instead of comparing replacement characters",async()=>{
  const root=mkdtempSync(join(tmpdir(),"recovery-journal-"));
  try {
    const files=new EditRecoveryFiles(root);
    await expect(files.edit({blockId:"note",baseText:"Base",expectedRevision:1,text:"\uFFFD"},{editor:"fixture",cwd:root,suspendTerminal(){},restoreTerminal(){},async currentRevision(){return "1";},async run(_cmd,file){writeFileSync(file,Buffer.from([0xff]));return 1;}})).rejects.toThrow();
    const directory=join(root,"editor-drafts",readdirSync(join(root,"editor-drafts"))[0]!);
    expect(readFileSync(join(directory,"draft.md"))).toEqual(Buffer.from([0xff]));
    expect(JSON.parse(readFileSync(join(directory,"context.json"),"utf8")).returned).toBe(true);
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
