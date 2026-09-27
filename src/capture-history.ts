import type {Database} from "bun:sqlite";
import {Type} from "typebox";
import {defineComputedProducer} from "./computed-resources";
import type {ResourceCatalog} from "./resource-catalog";
import type {Block} from "./types";

export const CAPTURE_HISTORY_PRODUCER="builtin.capture-history";
const inputSchema=Type.Object({attemptId:Type.String({minLength:1,maxLength:200}),blockId:Type.String({minLength:1,maxLength:100})},{additionalProperties:false});

/** Read the preserved bytes by receipt and owner, never by matching current text. */
export function readCaptureBefore(database:Database,attemptId:string,blockId:string):Block|undefined {
  if(!database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbox_agent_results'").get())return undefined;
  const row=database.query("SELECT recovery_json FROM inbox_agent_results WHERE id=?").get(attemptId) as {recovery_json:string|null}|null;
  return row?.recovery_json ? (JSON.parse(row.recovery_json) as {before:Block[]}).before.find(block=>block.id===blockId) : undefined;
}

/** Resolve immutable before-images already owned by Inbox recovery. No new
 * authored note, execution request, or independent copy of the original. */
export function captureHistoryProducer(database:Database){
  return defineComputedProducer({id:CAPTURE_HISTORY_PRODUCER,version:1,inputSchema,
    permissions:["inbox.history.read"],determinism:"deterministic",cachePolicy:"content-addressed",outputMediaTypes:["text/markdown"],
    async execute({inputs}){
      if(inputs.attemptId.startsWith("lineage-unavailable:"))return {kind:"failure" as const,code:"lineage-limit",message:"Original capture lineage exceeded its historical inspection budget; the original is not fully identified. Current text is not a substitute."};
      const before=readCaptureBefore(database,inputs.attemptId,inputs.blockId);
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

/** Follow saved output lineage for pre-link captures as well as ordinary sources.
 * Each recursive step visits only older receipts, never the mutable source text. */
export function captureOriginalResources(database:Database,catalog:ResourceCatalog,block:Block,attemptId:string):string[]{
  type Receipt={ordinal:number,id:string,source_id:string,recovery_json:string|null};
  type Saved={before:Block[],createdIds:string[]};
  let remainingReceipts=128;
  const properties=(value:Block)=>value.properties.filter(p=>p.key==='raw-capture').map(p=>p.value);
  const resolve=(value:Block,fallback:string,beforeOrdinal=Number.MAX_SAFE_INTEGER,depth=0):string[]=>{
    const linked=properties(value);if(linked.length)return linked;
    if(depth>=32||remainingReceipts<=0)return [captureHistoryResource(database,catalog,'lineage-unavailable:'+value.id,value.id)];
    const rows=database.query(`SELECT rowid AS ordinal,id,source_id,recovery_json FROM inbox_agent_results
      WHERE rowid<? AND json_extract(result_json,'$.state') IN ('applied','undone')
      AND (source_id=? OR EXISTS(SELECT 1 FROM json_each(result_json,'$.outputIds') WHERE value=?))
      ORDER BY rowid LIMIT ?`).all(beforeOrdinal,value.id,value.id,remainingReceipts+1) as Receipt[];
    if(rows.length>remainingReceipts)return [captureHistoryResource(database,catalog,'lineage-unavailable:'+value.id,value.id)];
    remainingReceipts-=rows.length;
    if(!rows.length)return [captureHistoryResource(database,catalog,fallback,value.id)];
    const originals:string[]=[];
    for(const [index,row] of rows.entries()){
      const saved=row.recovery_json?JSON.parse(row.recovery_json) as Saved:undefined;
      if(index===0){
        if(row.source_id===value.id||!saved?.createdIds.includes(value.id)){
          const prior=saved?.before.find(b=>b.id===value.id);
          originals.push(...(prior&&properties(prior).length?properties(prior):[captureHistoryResource(database,catalog,row.id,value.id)]));
        }
      }
      if(row.source_id!==value.id){
        const source=saved?.before.find(b=>b.id===row.source_id);
        originals.push(...(source?resolve(source,row.id,row.ordinal,depth+1):[captureHistoryResource(database,catalog,row.id,row.source_id)]));
      }
    }
    return [...new Set(originals)];
  };
  return resolve(block,attemptId);
}
