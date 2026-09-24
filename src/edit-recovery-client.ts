import type { OutlinerClient } from "./client";
import type { Block } from "./types";
import type { EditRecovery, EditRecoveryStart } from "./edit-recovery";
import { EditRecoveryFiles } from "./edit-recovery-files";

/** The local journal succeeded, but the service did not acknowledge retention. */
export class EditRecoveryRetainedLocallyError extends Error {}

/** Transfers client-local writing only after the canonical service acknowledges it. */
export class EditRecoveryClient {
  warnings:string[]=[];
  readonly files: EditRecoveryFiles;
  constructor(private readonly client: OutlinerClient, stateDirectory: string) {
    this.files = new EditRecoveryFiles(stateDirectory);
  }
  async retain(input: EditRecoveryStart): Promise<EditRecovery> {
    const cleanup = this.files.retain(input);
    let record: EditRecovery;
    try {
      record = await this.client.request<EditRecovery>({action:"edit-recovery.start",input});
    } catch (error) {
      throw new EditRecoveryRetainedLocallyError(error instanceof Error ? error.message : String(error), {cause:error});
    }
    cleanup();
    return record;
  }
  checkpoint(input:EditRecoveryStart):void {
    this.files.retain(input);
  }
  async list(blockId: string, includeHistory=false): Promise<EditRecovery[]> {
    this.warnings=[];
    for (const pending of this.files.pending(blockId,message=>this.warnings.push(message))) {
      try {
        await this.client.request({action:"edit-recovery.start",input:pending.input});
        pending.cleanup();
      } catch(error) {this.warnings.push(`Draft ${pending.input.id} retained locally: ${error instanceof Error?error.message:String(error)}`);}
    }
    return this.client.request({action:"edit-recovery.list",blockId,includeHistory});
  }
  restore(record:EditRecovery,version:"draft"|"before-save"):Promise<EditRecovery> {
    return this.client.request({action:"edit-recovery.restore",recoveryId:record.id,requestId:crypto.randomUUID(),version});
  }
  refresh(record:EditRecovery):Promise<EditRecovery> {
    return this.client.request({action:"edit-recovery.refresh",recoveryId:record.id,expectedRevision:record.revision});
  }
  assist(record:EditRecovery):Promise<EditRecovery> {
    return this.client.request({action:"edit-recovery.assist",recoveryId:record.id,expectedRevision:record.revision},130_000);
  }
  cancel(record:EditRecovery):Promise<unknown> {
    return this.client.request({action:"edit-recovery.cancel",recoveryId:record.id});
  }
  discard(record:EditRecovery):Promise<EditRecovery> {
    return this.client.request({action:"edit-recovery.discard",recoveryId:record.id,expectedRevision:record.revision});
  }
  commit(record:EditRecovery,text:string):Promise<Block> {
    return this.client.request({action:"edit-recovery.commit",recoveryId:record.id,expectedRevision:record.revision,
      text,basedOnRevision:record.latest.revision,mutation:{author:"user",actorId:"detail"}});
  }
  separate(record:EditRecovery):Promise<Block> {
    return this.client.request({action:"edit-recovery.separate",recoveryId:record.id,expectedRevision:record.revision,mutation:{author:"user",actorId:"detail"}});
  }
}
