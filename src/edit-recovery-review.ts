import {truncateToWidth,wrapTextWithAnsi,visibleWidth} from "@earendil-works/pi-tui";
import {documentPreviewLines} from "./document-preview-renderer";
import {outlinerActionLink} from "./outliner-actions";
import {sanitizeDynamicText,type TerminalKey} from "./terminal";
import type {EditRecovery} from "./edit-recovery";
import type {EditRecoveryClient} from "./edit-recovery-client";
import {createTwoFilesPatch} from "diff";

export type RecoveryChoice = {action:"proposal"|"manual"|"separate"|"later";record:EditRecovery};
type Version = "base"|"draft"|"latest"|"proposal"|"prelaunch"|"changes"|"problems";
const versions:Version[]=["base","draft","latest","proposal","prelaunch","changes","problems"];
const retainedActions=["proposal","manual","agent","refresh","separate","discard","next","later"] as const;
const historyActions=["restore","undo","next","later"] as const;
const labels:Record<typeof retainedActions[number]|typeof historyActions[number],string>={restore:"Restore draft",undo:"Undo save",proposal:"Use proposal",manual:"Edit draft",agent:"Ask agent",refresh:"Refresh latest",separate:"Save separate",discard:"Discard recovery",next:"Next draft",later:"Later"};

/** One review model for Pi and ANSI. Esc cancels work, never deletes writing. */
export class EditRecoveryReview {
  private index=0;
  private version:Version="draft";
  private offset=0;
  private selected=retainedActions.length-1;
  private generation=0;
  private pending=false;
  private closed=false;
  private discardArmed=false;
  private status="Review a version, then choose what to do. Using a proposal opens an editable draft; it does not save.";
  private page=10;
  private maximum=0;
  private cachedDocument?: {text:string;document:Parameters<typeof documentPreviewLines>[0]};
  private cachedChanges?: {record:EditRecovery;text:string};
  constructor(private records:EditRecovery[],private client:Pick<EditRecoveryClient,"refresh"|"assist"|"cancel"|"discard"> & Partial<Pick<EditRecoveryClient,"restore">>,
    private changed:()=>void,private finish:(choice:RecoveryChoice)=>void,private warnings:readonly string[]=[]) {}
  private get actions(){return this.record.state==="retained"?retainedActions:historyActions;}
  get record():EditRecovery{return this.records[this.index];}
  invalidate():void {}
  render(width:number,height:number):string[] {
    const record=this.record;
    const actions=this.actions;this.selected=Math.min(this.selected,actions.length-1);
    const control=(id:string,label:string)=>outlinerActionLink(`recovery.${id}`,`[${label}]`);
    const controls=wrapTextWithAnsi(actions.map((action,index)=>control(action,`${index===this.selected?"› ":""}${action==="agent"&&this.pending?"Cancel merge":labels[action]}`)).join(" "),Math.max(1,width));
    const tabs=wrapTextWithAnsi(versions.map((version,index)=>control(`version.${version}`,`${index+1} ${version}${version===this.version?" ●":""}`)).join(" "),Math.max(1,width));
    const explanation=record.proposal?.explanation??(record.merge.incomplete?"Comparison exceeded its budget; review manually":record.merge.propertyConflicts?.length?`Conflicting properties: ${record.merge.propertyConflicts.join(", ")}`:"Overlapping edits need review");
    const unresolved=record.proposal?.unresolved.length?`Unresolved: ${record.proposal.unresolved.join("; ")}`:"";
    const header=[`Recoverable writing · ${this.index+1}/${this.records.length} · ${record.state} · base r${record.baseRevision} / latest r${record.latest.revision}`,
      ...tabs,...controls,truncateToWidth(sanitizeDynamicText(explanation),Math.max(1,width))];
    if(this.warnings.length)header.push(truncateToWidth(sanitizeDynamicText(this.warnings.join(" · ")),Math.max(1,width)));
    if(this.version==="changes"&&this.cachedChanges?.record!==record){
      const patches=[createTwoFilesPatch("Base","Draft",record.baseText,record.draftText,undefined,undefined,{timeout:100,maxEditLength:20_000})??"Draft comparison exceeded its budget; read Base and Draft directly.",createTwoFilesPatch("Base","Latest",record.baseText,record.latest.text,undefined,undefined,{timeout:100,maxEditLength:20_000})??"Latest comparison exceeded its budget; read Base and Latest directly."].join("\n");
      const fence="`".repeat(Math.max(3,...[...patches.matchAll(/`+/g)].map(match=>match[0].length+1)));
      const provenance=record.latestEdit?`Latest recorded edit: ${record.latestEdit.author} · ${record.latestEdit.actorId??"actor unknown"} · ${record.latestEdit.editedAt}`:"Latest edit provenance unavailable";
      this.cachedChanges={record,text:`${sanitizeDynamicText(provenance)}\n\n${fence}diff\n${patches}\n${fence}`};
    }
    const text=this.version==="problems"?(this.warnings.length?this.warnings.map(w=>sanitizeDynamicText(w)).join("\n\n"):"No local recovery problems reported"):this.version==="base"?record.baseText:this.version==="draft"?record.draftText:this.version==="latest"?record.latest.text:this.version==="prelaunch"?record.prelaunchText:this.version==="changes"?this.cachedChanges!.text:
      (unresolved ? `> [!warning] Unresolved choices\n${record.proposal!.unresolved.map(item=>`> ${sanitizeDynamicText(item)}`).join("\n")}\n\n` : "")+(record.proposal?.text??"No proposal yet. Ask the agent or edit your retained draft.");
    if(this.cachedDocument?.text!==text)this.cachedDocument={text,document:{canonicalText:text,resolvedText:text,projectedText:text,embedRanges:[],workIdPrefix:null}};
    const rows=documentPreviewLines(this.cachedDocument.document,Math.max(1,width));
    this.page=Math.max(1,height-header.length-2);this.maximum=Math.max(0,rows.length-this.page);this.offset=Math.min(this.offset,this.maximum);
    return [...header,...Array.from({length:this.page},(_,i)=>rows[this.offset+i]??""),sanitizeDynamicText(this.status),"1–7 versions/changes/problems · Tab actions · Enter choose · ↑↓ scroll · Esc retain and return"]
      .slice(0,height).map(line=>{const fitted=truncateToWidth(line,Math.max(1,width));return fitted+" ".repeat(Math.max(0,width-visibleWidth(fitted)));});
  }
  key(str:string,key:TerminalKey):void {
    const actions=this.actions;this.selected=Math.min(this.selected,actions.length-1);
    if(key.name==="escape"){void this.action(this.pending?"agent":"later");return;}
    if(key.name==="tab"){this.selected=(this.selected+(key.shift?-1:1)+actions.length)%actions.length;this.changed();return;}
    if(key.name==="return"){void this.action(actions[this.selected]);return;}
    const version=versions[Number(str)-1];
    if(version){void this.action(`version.${version}`);return;}
    const delta=key.name==="up"?-1:key.name==="down"?1:key.name==="pageup"?-this.page:key.name==="pagedown"?this.page:0;
    this.offset=Math.max(0,Math.min(this.maximum,this.offset+delta));this.changed();
  }
  async action(id:string):Promise<void> {
    if(this.closed)return;
    if(id.startsWith("version.")){
      const version=id.slice(8) as Version;if(versions.includes(version)){this.version=version;this.offset=0;this.changed();}return;
    }
    const record=this.record;
    if(this.pending){
      if(id==="agent"||id==="later"){
        this.generation++;this.pending=false;this.status="Merge cancelled; all versions retained";
        void this.client.cancel(record).catch(error=>{if(!this.closed){this.status=`Draft retained; cancellation could not be confirmed: ${sanitizeDynamicText(String(error))}`;this.changed();}});
        this.changed();
      }
      return;
    }
    if(id!=="discard")this.discardArmed=false;
    if(record.state!=="retained"&&!["restore","undo","next","later"].includes(id)){this.status="Saved history: restore a draft or undo the save to start a new review";this.changed();return;}

    if(id==="later"||id==="manual"||id==="separate"||id==="proposal") {
      if(id==="proposal"&&!record.proposal){this.status="No proposal to use; choose Edit draft or Ask agent";this.changed();return;}
      this.closed=true;this.generation++;this.finish({action:id,record});return;
    }
    if(id==="next"){this.index=(this.index+1)%this.records.length;this.offset=0;this.version="draft";this.changed();return;}
    if(id==="discard"&&!this.discardArmed){this.discardArmed=true;this.status="Choose Discard recovery again to hide this retained draft. The canonical note is unchanged.";this.changed();return;}
    const generation=++this.generation;this.pending=true;this.status=id==="agent"?"Preparing merge proposal · Esc cancels; writing stays retained":"Updating recovery…";this.changed();
    try {
      if(id==="restore"||id==="undo"){
        if(!this.client.restore)throw Error("Recovery restoration is unavailable");
        const restored=await this.client.restore(record,id==="undo"?"before-save":"draft");
        if(generation!==this.generation||this.closed)return;
        this.records.splice(this.index,0,restored);this.version="proposal";this.offset=0;this.selected=retainedActions.length-1;
        this.status="Current note unchanged · restored draft ready for review and Ctrl+S";
      }else if(id==="agent"||id==="refresh"){
        const updated=await(id==="agent"?this.client.assist(record):this.client.refresh(record));
        if(generation!==this.generation||this.closed)return;
        this.records[this.index]=updated;this.version="proposal";this.offset=0;this.status="Review the proposal before using it";
      }else if(id==="discard"){
        await this.client.discard(record);if(generation!==this.generation||this.closed)return;
        this.records.splice(this.index,1);
        if(!this.records.length){this.closed=true;this.finish({action:"later",record:{...record,state:"discarded"}});return;}
        this.index%=this.records.length;this.offset=0;this.discardArmed=false;this.status="Recovery hidden; original writing remains in the recovery evidence";
      }
    }catch(error){if(generation===this.generation)this.status=`Writing retained · ${error instanceof Error?error.message:String(error)}`;}
    finally {if(generation===this.generation){this.pending=false;this.changed();}}
  }
}
