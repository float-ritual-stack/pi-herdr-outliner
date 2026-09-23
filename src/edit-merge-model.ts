import {join} from "node:path";
import {createAgentSession,defineTool,SettingsManager,type AgentSession} from "@earendil-works/pi-coding-agent";
import {Type} from "typebox";
import {loadEditMergePrompt,PromptFileError} from "./ai-prompts";
import {AssistantSession} from "./assistant-session";
import {AssistantConfigurationError,configuredPiAssistant,isolatedAssistantResources} from "./pi-assistant-config";
import type {EditRecovery,EditRecoveryProposal} from "./edit-recovery";

export interface EditMergeModelOptions {
  workspaceRoot:string;
  stateDirectory:string;
  promptDirectory?:string;
  agentDir?:string;
  timeoutMs?:number;
  stream?:AgentSession["agent"]["streamFunction"];
}

/** A proposal-only session: no filesystem, shell, note mutation or inherited tools. */
export async function proposeEditMerge(record:EditRecovery,options:EditMergeModelOptions,cancel:AbortSignal):Promise<EditRecoveryProposal> {
  const signal=AbortSignal.any([cancel,AbortSignal.timeout(options.timeoutMs??120_000)]);
  const input={baseText:record.baseText,draftText:record.draftText,prelaunchText:record.prelaunchText,latest:record.latest,
    changeProvenance:{source:record.source,latestRecordedEdit:record.latestEdit??null,coverage:"Most recent recorded edit only; not a full history of changes since the base"}};
  if(JSON.stringify(input).length>120_000)throw Error("This merge exceeds the 120,000-character model input budget; all versions remain available for manual review");
  let session:AgentSession|undefined,trace:AssistantSession|undefined;
  let proposal:EditRecoveryProposal|undefined;
  const abort=()=>session?.agent.abort();signal.addEventListener("abort",abort,{once:true});
  try {
    const prompt=await loadEditMergePrompt(options.promptDirectory);
    const config=await configuredPiAssistant(options.agentDir,signal);signal.throwIfAborted();
    trace=new AssistantSession(options.workspaceRoot,join(options.stateDirectory,"assistant-sessions"),record.blockId,"edit-recovery");
    const tool=defineTool({name:"finish_merge",label:"Propose merge",description:"Return the full merge proposal and unresolved conflicts for human review; saves no note.",parameters:Type.Object({text:Type.String({maxLength:120_000}),explanation:Type.String({maxLength:4000}),unresolved:Type.Array(Type.String({maxLength:4000}),{maxItems:100})},{additionalProperties:false}),async execute(_call,result){
      signal.throwIfAborted();proposal={...result,basedOnRevision:record.latest.revision,source:"agent"};
      return {content:[{type:"text" as const,text:"Proposal recorded for review; canonical note unchanged"}],details:{},terminate:true};
    }});
    const created=await createAgentSession({cwd:options.workspaceRoot,agentDir:config.agentDir,model:config.model,modelRuntime:config.runtime,thinkingLevel:config.thinkingLevel,noTools:"builtin",tools:["finish_merge"],customTools:[tool],resourceLoader:isolatedAssistantResources(prompt.text),sessionManager:trace.manager,settingsManager:SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false,provider:{maxRetries:0,timeoutMs:options.timeoutMs??120_000}},enableSkillCommands:false,enableAnalytics:false,enableInstallTelemetry:false})});
    session=created.session;signal.throwIfAborted();
    const stream=options.stream??session.agent.streamFunction.bind(session.agent);let turns=0;
    session.agent.streamFunction=(model,context,streamOptions)=>{
      signal.throwIfAborted();if(++turns>3)throw Error("Merge proposal turn budget exhausted");
      return stream(model,context,{...streamOptions,maxTokens:16_000,maxRetries:0,signal:AbortSignal.any([signal,...(streamOptions?.signal?[streamOptions.signal]:[])])});
    };
    session.agent.shouldStopAfterTurn=()=>!!proposal||signal.aborted;
    let rejectAbort:(()=>void)|undefined;
    const interrupted=new Promise<never>((_resolve,reject)=>{
      rejectAbort=()=>reject(new Error("Merge interrupted"));
      signal.addEventListener("abort",rejectAbort,{once:true});
    });
    try {await Promise.race([session.prompt(JSON.stringify(input),{expandPromptTemplates:false}),interrupted]);}
    finally {if(rejectAbort)signal.removeEventListener("abort",rejectAbort);}
    signal.throwIfAborted();
    if(!proposal)throw Error("Model returned no merge proposal; draft retained");
    return {...proposal,evidence:{model:`${config.model.provider}/${config.model.id}`,promptSha256:prompt.sha256,session:trace.finish("completed")}};
  } catch(error) {
    const evidence=trace?.finish(cancel.aborted?"canceled":"failed");
    const message=signal.aborted?(cancel.aborted?"Merge canceled; draft retained":"Outliner merge deadline expired; draft retained"):
      error instanceof PromptFileError||error instanceof AssistantConfigurationError?error.message:
      "Merge proposal unavailable; all versions remain available for manual review";
    throw Object.assign(new Error(message),{session:evidence});
  } finally {signal.removeEventListener("abort",abort);session?.dispose();}
}
