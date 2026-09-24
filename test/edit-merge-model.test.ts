import {expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createAssistantMessageEventStream,type AssistantMessage} from "@earendil-works/pi-ai";
import {proposeEditMerge,type EditMergeModelOptions} from "../src/edit-merge-model";
import {OutlinerStore} from "../src/store";
import {EditRecoveryRepository} from "../src/edit-recovery";

test("proposal-only Pi session has no editing tools, preserves unresolved choices and saves its trace",async()=>{
  const root=mkdtempSync(join(tmpdir(),"merge-model-"));
  const store=new OutlinerStore(join(root,"db.sqlite"));
  try {
    const agentDir=join(root,"agent");mkdirSync(agentDir);
    writeFileSync(join(agentDir,"settings.json"),JSON.stringify({defaultProvider:"openai",defaultModel:"gpt-4.1",defaultThinkingLevel:"off"}));
    writeFileSync(join(agentDir,"auth.json"),JSON.stringify({openai:{type:"api_key",key:"test-not-a-real-key"}}));
    const base=store.create("Original\n\nBase");
    const record=new EditRecoveryRepository(store).start({id:crypto.randomUUID(),blockId:base.id,baseText:base.text,baseRevision:base.revision,prelaunchText:base.text,draftText:"Returned",source:"external-editor"});
    const stream:NonNullable<EditMergeModelOptions["stream"]>=(_model,context)=>{
      expect(context.tools?.map(tool=>tool.name)).toEqual(["finish_merge"]);
      const value:AssistantMessage={role:"assistant",api:"openai-responses",provider:"openai",model:"gpt-4.1",content:[{type:"toolCall",id:"finish",name:"finish_merge",arguments:{text:"Returned",explanation:"Keep the local wording pending review",unresolved:["Latest and local disagree on the title"]}}],stopReason:"toolUse",timestamp:Date.now(),usage:{input:100,output:20,cacheRead:0,cacheWrite:0,totalTokens:120,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      const events=createAssistantMessageEventStream();events.push({type:"done",reason:"toolUse",message:value});return events;
    };
    const proposal=await proposeEditMerge(record,{workspaceRoot:root,stateDirectory:root,agentDir,stream},new AbortController().signal);
    expect(proposal.text).toBe("Returned");expect(proposal.unresolved).toHaveLength(1);
    expect(store.get(base.id)?.text).toBe(base.text);
    expect(proposal.evidence?.session).toBeDefined();
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

for(const failure of ["deadline","cancel","unavailable"] as const)test(`merge ${failure} preserves writing and reports an explicit failure`,async()=>{
  const root=mkdtempSync(join(tmpdir(),"merge-model-")),store=new OutlinerStore(join(root,"db.sqlite"));
  try {
    const agentDir=join(root,"agent");mkdirSync(agentDir);
    writeFileSync(join(agentDir,"settings.json"),JSON.stringify({defaultProvider:"openai",defaultModel:"gpt-4.1",defaultThinkingLevel:"off"}));
    writeFileSync(join(agentDir,"auth.json"),JSON.stringify({openai:{type:"api_key",key:"test-not-a-real-key"}}));
    const base=store.create("Original"),repo=new EditRecoveryRepository(store);
    const record=repo.start({id:crypto.randomUUID(),blockId:base.id,baseText:base.text,baseRevision:base.revision,prelaunchText:base.text,draftText:"Precious writing",source:"external-editor"});
    const controller=new AbortController();
    const stream:NonNullable<EditMergeModelOptions["stream"]>=()=>{
      if(failure==="unavailable")throw Error("Provider unavailable");
      if(failure==="cancel")queueMicrotask(()=>controller.abort());
      return createAssistantMessageEventStream();
    };
    await expect(proposeEditMerge(record,{workspaceRoot:root,stateDirectory:root,agentDir,stream,timeoutMs:failure==="deadline"?100:1000},controller.signal)).rejects.toThrow(failure==="deadline"?"deadline":failure==="cancel"?"canceled":"unavailable");
    expect(repo.get(record.id).originalDraft).toBe("Precious writing");expect(store.get(base.id)?.text).toBe("Original");
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
