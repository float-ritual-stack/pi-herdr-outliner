import {mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync,renameSync,rmSync} from "node:fs";
import {join} from "node:path";
import {editTextInExternalEditor,type ExternalEditorOptions,type ExternalEditorResult} from "./external-editor";
import type {EditRecoveryStart} from "./edit-recovery";

interface Journal {
  input: Omit<EditRecoveryStart,"draftText">;
  ownerPid: number;
  returned: boolean;
}
export interface JournaledEditorResult extends ExternalEditorResult { recoveryInput: EditRecoveryStart }

/** Client-local working files survive an editor or transport failure. Canonical
 * recovery is transferred to the service before these files may be cleaned up. */
export class EditRecoveryFiles {
  private readonly directory: string;
  constructor(stateDirectory:string) { this.directory=join(stateDirectory,"editor-drafts"); }

  async edit(input:{blockId:string;baseText:string;expectedRevision:number;text:string},options:ExternalEditorOptions):Promise<JournaledEditorResult> {
    mkdirSync(this.directory,{recursive:true,mode:0o700});
    const directory=mkdtempSync(join(this.directory,"draft-"));
    const journal:Journal={ownerPid:process.pid,returned:false,input:{id:crypto.randomUUID(),blockId:input.blockId,baseText:input.baseText,baseRevision:input.expectedRevision,prelaunchText:input.text,source:"external-editor"}};
    writeFileSync(join(directory,"draft.md"),input.text,{encoding:"utf8",mode:0o600});
    this.write(directory,journal);
    let result: ExternalEditorResult;
    try {
      result=await editTextInExternalEditor({text:input.text,expectedRevision:String(input.expectedRevision)},{...options,preparedFile:join(directory,"draft.md"),verifyRevision:false});
    } finally {
      this.write(directory,{...journal,returned:true});
    }
    return {...result,recoveryInput:{...journal.input,draftText:result.text}};
  }

  retain(input:EditRecoveryStart):()=>void {
    mkdirSync(this.directory,{recursive:true,mode:0o700});
    const directory=mkdtempSync(join(this.directory,"draft-"));
    writeFileSync(join(directory,"draft.md"),input.draftText,{encoding:"utf8",mode:0o600});
    this.write(directory,{input,ownerPid:process.pid,returned:true});
    return ()=>rmSync(directory,{recursive:true,force:true});
  }

  pending(blockId:string):Array<{input:EditRecoveryStart;cleanup:()=>void}> {
    let names:string[];
    try { names=readdirSync(this.directory); }
    catch(error){if(error instanceof Error&&"code" in error&&error.code==="ENOENT")return [];throw error;}
    return names.flatMap(name=>{
      if(!/^draft-[a-zA-Z0-9]+$/.test(name))return [];
      const directory=join(this.directory,name);
      const journal=JSON.parse(readFileSync(join(directory,"context.json"),"utf8")) as Journal;
      if(journal.input.blockId!==blockId)return [];
      if(!journal.returned){
        try{process.kill(journal.ownerPid,0);return [];}
        catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ESRCH"))return [];}
      }
      const bytes=readFileSync(join(directory,"draft.md"));
      const draftText=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);
      return [{input:{...journal.input,draftText},cleanup:()=>rmSync(directory,{recursive:true,force:true})}];
    });
  }

  private write(directory:string,journal:Journal):void {
    const path=join(directory,"context.json"),staging=join(directory,"context.pending");
    writeFileSync(staging,JSON.stringify(journal),{encoding:"utf8",mode:0o600});renameSync(staging,path);
  }
}
