import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {createExtensionRuntime,getAgentDir,ModelRuntime,type ResourceLoader} from "@earendil-works/pi-coding-agent";

export class AssistantConfigurationError extends Error {
  constructor(readonly code:"settings"|"default"|"runtime"|"auth",message:string){super(message);}
}

export async function configuredPiAssistant(agentDirectory?:string,signal?:AbortSignal) {
  const agentDir=agentDirectory??getAgentDir();
  let settings:{defaultProvider?:string;defaultModel?:string;defaultThinkingLevel?:string};
  try{settings=JSON.parse(await readFile(join(agentDir,"settings.json"),"utf8"));}
  catch{throw new AssistantConfigurationError("settings","Configure a default model in Pi settings");}
  if(!settings.defaultProvider||!settings.defaultModel)throw new AssistantConfigurationError("default","Configure a default provider and model in Pi settings");
  let runtime:ModelRuntime;
  try{runtime=await ModelRuntime.create({authPath:join(agentDir,"auth.json"),modelsPath:join(agentDir,"models.json"),allowModelNetwork:false,signal});}
  catch{throw new AssistantConfigurationError("runtime","Pi model configuration is unavailable");}
  const model=runtime.getModel(settings.defaultProvider,settings.defaultModel);
  if(!model||!runtime.hasConfiguredAuth(settings.defaultProvider))throw new AssistantConfigurationError("auth","Configure an available authenticated model in Pi");
  const level=settings.defaultThinkingLevel;
  const thinkingLevel=level==="off"||level==="minimal"||level==="low"||level==="high"||level==="xhigh"?level:"medium";
  return {agentDir,runtime,model,thinkingLevel} as const;
}

/** A task-specific session has only its declared instructions and tools. */
export function isolatedAssistantResources(prompt:string):ResourceLoader {
  return {
    getExtensions:()=>({extensions:[],errors:[],runtime:createExtensionRuntime()}),
    getSkills:()=>({skills:[],diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),
    getThemes:()=>({themes:[],diagnostics:[]}),getAgentsFiles:()=>({agentsFiles:[]}),
    getSystemPrompt:()=>prompt,getSystemPromptSource:()=>undefined,
    getAppendSystemPrompt:()=>[],getAppendSystemPromptSources:()=>[],
    extendResources:()=>{},reload:async()=>{},
  };
}
