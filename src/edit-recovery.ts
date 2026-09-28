import {createHash} from "node:crypto";
import {mergeEdits, type EditMerge} from "./edit-merge";
import type {OutlinerStore} from "./store";
import type {Block, ChecklistIdentityChange, MutationProvenance} from "./types";
import {BLOCK_EDIT_ACTIVITY_KIND_SQL} from "./types";

export interface EditRecoveryStart {
  id: string;
  blockId: string;
  baseText: string;
  baseRevision: number;
  prelaunchText: string;
  draftText: string;
  source: "external-editor" | "save-conflict";
}
export interface EditRecoveryProposal {
  text: string;
  basedOnRevision: number;
  source: "mechanical" | "agent" | "manual";
  unresolved: string[];
  explanation: string;
  evidence?: { model: string; promptSha256: string; session: import("./assistant-session").AssistantSessionEvidence };
}
export interface EditRecovery extends EditRecoveryStart {
  revision: number;
  originalDraft: string;
  latest: Block;
  merge: EditMerge;
  proposal: EditRecoveryProposal | null;
  state: "retained" | "applied" | "discarded";
  createdAt: string;
  updatedAt: string;
  appliedBlockId?: string;
  latestEdit?: {author:string;actorId:string|null;sessionId:string|null;taskId:string|null;kind:string;editedAt:string}|null;
}

function content(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 2 * 1024 * 1024) throw Error(`${name} must be text of at most 2 MiB`);
}
function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw Error("Recovery requires a positive revision");
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw Error("Invalid recovery identifier");
}
function prepared(input: EditRecoveryStart, latest: Block): Pick<EditRecovery,"merge"|"proposal"|"latest"> {
  const merge = mergeEdits(input.baseText,input.draftText,latest.text);
  return {latest,merge,proposal:merge.incomplete || merge.conflicts.length || merge.propertyConflicts?.length ? null : {
    text:merge.text,basedOnRevision:latest.revision,source:"mechanical",unresolved:[],
    explanation:latest.revision === input.baseRevision ? "Retained local draft" : "Combined independent edits; review before saving",
  }};
}

/** Service-owned recovery evidence; these records never enter note assistance. */
export class EditRecoveryRepository {
  constructor(private readonly store: OutlinerStore) {
    store.database.exec(`CREATE TABLE IF NOT EXISTS edit_recovery (
      id TEXT PRIMARY KEY, block_id TEXT NOT NULL, revision INTEGER NOT NULL,
      state TEXT NOT NULL, input_hash TEXT NOT NULL, payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS edit_recovery_block ON edit_recovery(block_id,state,updated_at);`);
  }

  get(id: string): EditRecovery {
    identifier(id);
    const row = this.store.database.query("SELECT payload FROM edit_recovery WHERE id=?").get(id) as {payload:string}|null;
    if (!row) throw Error("Recoverable draft not found");
    return JSON.parse(row.payload) as EditRecovery;
  }

  list(blockId: string, includeHistory=false): EditRecovery[] {
    identifier(blockId);
    const rows = this.store.database.query(`SELECT payload FROM edit_recovery WHERE block_id=? ${includeHistory?"":"AND state='retained'"} ORDER BY (state='retained') DESC, updated_at DESC, id`).all(blockId) as Array<{payload:string}>;
    return rows.map(row=>JSON.parse(row.payload) as EditRecovery);
  }

  start(input: EditRecoveryStart): EditRecovery {
    identifier(input.id); identifier(input.blockId); revision(input.baseRevision);
    for (const field of ["baseText","prelaunchText","draftText"] as const) content(input[field],field);
    if (!["external-editor","save-conflict"].includes(input.source)) throw Error("Invalid recovery source");
    const hash=createHash("sha256").update(JSON.stringify([input.blockId,input.baseRevision,input.baseText,input.prelaunchText,input.draftText,input.source])).digest("hex");
    return this.store.database.transaction(()=>{
      const existing=this.store.database.query("SELECT input_hash FROM edit_recovery WHERE id=?").get(input.id) as {input_hash:string}|null;
      if(existing){if(existing.input_hash!==hash)throw Error("Recovery request ID was already used for different writing");return this.get(input.id);}
      const latest=this.live(input.blockId);
      if(input.baseRevision>latest.revision)throw Error("Recovery base is newer than the canonical note");
      if(input.baseRevision===latest.revision&&input.baseText!==latest.text)throw Error("Recovery base text does not match its canonical revision");
      const now=new Date().toISOString();
      const record:EditRecovery={...input,revision:1,originalDraft:input.draftText,...prepared(input,latest),latestEdit:this.latestEdit(input.blockId),state:"retained",createdAt:now,updatedAt:now};
      this.store.database.query("INSERT INTO edit_recovery VALUES(?,?,?,?,?,?,?)").run(record.id,record.blockId,record.revision,record.state,hash,JSON.stringify(record),now);
      return record;
    })();
  }

  /** History restoration creates a fresh review; it never writes canonical text. */
  restore(id:string, requestId:string, version:"draft"|"before-save"):EditRecovery {
    if(version!=="draft"&&version!=="before-save")throw Error("Unknown recovery version");
    const previous=this.get(id);
    if(version==="before-save"&&(previous.state!=="applied"||previous.appliedBlockId!==previous.blockId))throw Error("This recovery did not replace the original note");
    const draftText=version==="draft"?previous.originalDraft:previous.latest.text;
    identifier(requestId);
    const existing=this.store.database.query("SELECT payload FROM edit_recovery WHERE id=?").get(requestId) as {payload:string}|null;
    if(existing){const record=JSON.parse(existing.payload) as EditRecovery;if(record.blockId!==previous.blockId||record.draftText!==draftText)throw Error("Recovery request ID was already used for different writing");return record;}
    const latest=this.live(previous.blockId);
    return this.start({id:requestId,blockId:latest.id,baseText:latest.text,baseRevision:latest.revision,prelaunchText:latest.text,draftText,source:"save-conflict"});
  }

  /** Refresh the comparison without replacing the original returned writing. */
  refresh(id: string, expectedRevision: number): EditRecovery {
    return this.change(id,expectedRevision,record=>({...record,...prepared(record,this.live(record.blockId)),latestEdit:this.latestEdit(record.blockId)}));
  }

  propose(id: string, expectedRevision: number, proposal: EditRecoveryProposal): EditRecovery {
    content(proposal.text,"Merge proposal");content(proposal.explanation,"Merge explanation");revision(proposal.basedOnRevision);
    if(!["agent","manual"].includes(proposal.source)||!Array.isArray(proposal.unresolved)||proposal.unresolved.length>100)throw Error("Invalid merge proposal");
    proposal.unresolved.forEach(value=>content(value,"Unresolved conflict"));
    return this.change(id,expectedRevision,record=>{
      const latest=this.live(record.blockId);
      if(latest.revision!==proposal.basedOnRevision)throw Error("The note changed during reconciliation; draft retained. Refresh the comparison.");
      return {...record,latest,latestEdit:this.latestEdit(record.blockId),proposal:structuredClone(proposal)};
    });
  }

  commit(id: string, expectedRevision: number, text: string, basedOnRevision: number, mutation: MutationProvenance, identityChanges?:ChecklistIdentityChange[]): Block {
    content(text,"Reviewed draft");revision(basedOnRevision);
    return this.store.database.transaction(()=>{
      const record=this.retained(id,expectedRevision);
      if(record.latest.revision!==basedOnRevision)throw Error("Refresh the recovery comparison before saving");
      // The ordinary canonical guard remains authoritative even after review.
      const updated=this.store.update(record.blockId,text,basedOnRevision,mutation,"text",identityChanges);
      this.save({...record,state:"applied",appliedBlockId:updated.id},expectedRevision);
      return updated;
    })();
  }

  discard(id:string, expectedRevision:number):EditRecovery {
    return this.change(id,expectedRevision,record=>({...record,state:"discarded"}));
  }

  separate(id:string,expectedRevision:number,mutation:MutationProvenance):Block {
    return this.store.database.transaction(()=>{
      const record=this.retained(id,expectedRevision);
      const ticks=Math.max(3,...[...record.draftText.matchAll(/`+/g)].map(match=>match[0].length+1));
      const fence="`".repeat(ticks);
      // Quoting preserves exact writing without declaring a second Work-ID owner.
      const block=this.store.create(`Recovered writing\n\nOriginal: ((${record.blockId}))\n\nRetained draft, quoted so its metadata is not applied to this new note.\n\n${fence}text\n${record.draftText}\n${fence}`,null,mutation.author,mutation.author==="agent"?{...mutation,actorId:mutation.actorId??"detail"}:undefined);
      this.save({...record,state:"applied",appliedBlockId:block.id},expectedRevision);
      return block;
    })();
  }

  private live(blockId:string):Block {
    const block=this.store.get(blockId);
    if(!block||block.deletedAt||block.effectiveDeletedRootId)throw Error("The original note is unavailable; retained writing remains recoverable");
    return block;
  }
  private latestEdit(blockId:string):EditRecovery["latestEdit"] {
    return this.store.database.query(`SELECT author, actor_id AS actorId, session_id AS sessionId, task_id AS taskId, kind, edited_at AS editedAt FROM block_edit_activity WHERE block_id=? AND ${BLOCK_EDIT_ACTIVITY_KIND_SQL} ORDER BY activity_id DESC LIMIT 1`).get(blockId) as EditRecovery["latestEdit"];
  }
  private retained(id:string,expectedRevision:number):EditRecovery {
    revision(expectedRevision);
    const record=this.get(id);
    if(record.revision!==expectedRevision)throw Error("Recovery changed in another view; reload it before continuing");
    if(record.state!=="retained")throw Error("This recovery was already applied or discarded");
    return record;
  }
  private change(id:string,expectedRevision:number,change:(record:EditRecovery)=>EditRecovery):EditRecovery {
    return this.store.database.transaction(()=>this.save(change(this.retained(id,expectedRevision)),expectedRevision))();
  }
  private save(record:EditRecovery,expectedRevision:number):EditRecovery {
    const next={...record,revision:expectedRevision+1,updatedAt:new Date().toISOString()};
    const result=this.store.database.query("UPDATE edit_recovery SET revision=?,state=?,payload=?,updated_at=? WHERE id=? AND revision=?").run(next.revision,next.state,JSON.stringify(next),next.updatedAt,next.id,expectedRevision);
    if(result.changes!==1)throw Error("Recovery changed in another view");
    return next;
  }
}
