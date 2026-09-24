import type {Database} from "bun:sqlite";
import {Type} from "typebox";
import {defineComputedProducer} from "./computed-resources";
import type {ResourceCatalog} from "./resource-catalog";
import type {Block} from "./types";

export const CAPTURE_HISTORY_PRODUCER="builtin.capture-history";
const inputSchema=Type.Object({attemptId:Type.String({minLength:1,maxLength:200}),blockId:Type.String({minLength:1,maxLength:100})},{additionalProperties:false});

/** Resolve immutable before-images already owned by Inbox recovery. No new
 * authored note, execution request, or independent copy of the original. */
export function captureHistoryProducer(database:Database){
  return defineComputedProducer({id:CAPTURE_HISTORY_PRODUCER,version:1,inputSchema,
    permissions:["inbox.history.read"],determinism:"deterministic",cachePolicy:"content-addressed",outputMediaTypes:["text/markdown"],
    async execute({inputs}){
      const row=database.query("SELECT recovery_json FROM inbox_agent_results WHERE id=?").get(inputs.attemptId) as {recovery_json:string|null}|null;
      const before=row?.recovery_json ? (JSON.parse(row.recovery_json) as {before:Block[]}).before.find(block=>block.id===inputs.blockId) : undefined;
      if(!before)return {kind:"failure" as const,code:"capture-unavailable",message:"No preserved capture exists for this attempt. Current text is not a substitute."};
      return {kind:"immutable-snapshot" as const,mediaType:"text/markdown",content:before.text};
    },
  });
}

/** Resource identity is shared by every output that cites the same before-image. */
export function captureHistoryResource(database:Database,catalog:ResourceCatalog,attemptId:string,blockId:string):string {
  const existing=database.query("SELECT resource_id FROM computed_invocations WHERE producer_id=? AND json_extract(inputs_json,'$.attemptId')=? AND json_extract(inputs_json,'$.blockId')=? ORDER BY created_at,id LIMIT 1").get(CAPTURE_HISTORY_PRODUCER,attemptId,blockId) as {resource_id:string}|null;
  if(existing)return existing.resource_id;
  const source=catalog.listSources().find(source=>source.provider==="computed"&&source.boundary.registry==="outliner.capture-history")??catalog.createSource({name:"Capture history",provider:"computed",boundary:{registry:"outliner.capture-history",allowedPermissions:["inbox.history.read"]}});
  return catalog.createComputedInvocation({sourceId:source.id,producerId:CAPTURE_HISTORY_PRODUCER,inputs:{attemptId,blockId},dependencies:[]}).resourceId;
}
