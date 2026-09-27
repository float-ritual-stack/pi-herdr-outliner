import {checklistControlId,findChecklistControl,type ChecklistControl} from "./checklist-controls";
import {CHECKLIST_CHOICES,ChecklistSession,type ChecklistChoice} from "./checklist-session";
import {annotationSourceHash} from './annotations';
import {DEFAULT_OUTLINER_ACTION_KEYMAP,displayActionChord,type OutlinerActionKeymap} from './outliner-actions';
import {blockAnnotationRepresentation,resourceAnnotationRepresentation} from './annotation-representations';
import {TextBuffer} from './text-buffer';
import {textBufferEditorCommand,applyTextBufferEditorCommand} from './text-buffer-editor';
import type {AnnotationTarget,AnnotationBatchReceipt,AnnotationRecord} from './types';
import {documentPreviewLines,documentPreviewLinks,documentPreviewThreadRow,revealDocumentPreviewSourceLine} from './document-preview-renderer';
import {detailAnnotationGroups} from './detail-annotations';
import {parsePreviewRegionActionUri, previewRegionActionUri, togglePreviewRegionDisclosure} from './detail-preview-regions';
import type {OutlinerRequester} from './client-target';
import {loadDetailReadPreview} from './detail-read-preview';
import type {DetailReadPreviewDocument} from './detail-pi-preview';
import {blockDisplayTitle} from './references';
import {parseOutlinerLinkUri,followResourceOccurrence} from './outliner-links';
import {isAuthoredFileOccurrence} from './resource-references';
import {resolveFragmentSlice} from './fragments';
import type {TerminalKey} from './terminal';
import type {Block, AnnotationThread, PageAddressResolution, OutlinerNavigationTarget} from './types';
import type {ResourceDescription} from './resources';
import {resourceDescriptionLabel} from './resources';

type SavedPreviewSource = Pick<Block,"id"|"text"|"revision"> & Partial<Pick<Block,"updatedAt">> & {inboxAttemptId?:string};

export interface PreviewPassageCapture {
  sourceAnchor?:Extract<AnnotationTarget['anchor'],{kind:'text-quote'}>|null;
  document:DetailReadPreviewDocument;
  input:"pointer"|"keyboard";
  quote:string;
  snapshotText:string;
  capturedAt:string;
  renderRevision:number;
}

export interface PreviewSelectionInput {
  readonly selecting:boolean;
  captureSelection():PreviewPassageCapture|null;
  selectionKey(key:TerminalKey,str?:string):boolean;
  clearSelection():void;
}

export interface PreviewCommentDraft {
  requestId:string;
  target?:AnnotationTarget;
  annotationId?:string;
  buffer:TextBuffer;
  saving:boolean;
}
export interface DocumentPreviewState {
  readonly bindings?:{comment:string;select:string};
  readonly comment?:PreviewCommentDraft;
  readonly checklistPicker?:{control:ChecklistControl;index:number};
  readonly checklistBusy?:boolean;
  readonly selecting?:boolean;
  readonly passageSelected?:boolean;
  readonly target: OutlinerNavigationTarget;
  readonly title: string;
  readonly document: DetailReadPreviewDocument;
  readonly offset: number;
  readonly focused: boolean;
  readonly activeLink?: string;
  readonly activeLinkLabel?: string;
  readonly notice?: string;
  readonly loading?: boolean;
  readonly canBack?: boolean;
  readonly canForward?: boolean;
}

function plain(text: string): DetailReadPreviewDocument {
  return {canonicalText:text,resolvedText:text,projectedText:text,embedRanges:[],workIdPrefix:null};
}

/** A disposable reader. It owns requests, focus and scrolling; callers own selection and Open. */
export class DocumentPreview {
  private generation = 0;
  private history:DocumentPreviewState[]=[];
  private future:DocumentPreviewState[]=[];
  private value: DocumentPreviewState | null = null;
  private checklist:ChecklistSession;
  private checklistBusy=false;
  constructor(private client: OutlinerRequester, private changed: () => void, private clientId?: string, private openExternal?: (url:string)=>void|Promise<void>,private selectionInput?:PreviewSelectionInput,private keymap:OutlinerActionKeymap=DEFAULT_OUTLINER_ACTION_KEYMAP,private copyText?:(text:string)=>void|Promise<void>) {
    this.checklist=new ChecklistSession((blockId,input)=>this.client.request({action:"checklist.update",blockId,input,mutation:{author:"user",actorId:"preview"}}));
  }
  get state(): DocumentPreviewState | null { return this.value ? {...this.value,
    bindings:{comment:displayActionChord(this.keymap.primaryBinding('tree.reader.comment')),select:displayActionChord(this.keymap.primaryBinding('tree.reader.select'))},
    passageSelected:!!this.selectionInput?.captureSelection(),selecting:this.selectionInput?.selecting??false,canBack:this.history.length>0,canForward:this.future.length>0} : null; }
  cancelLoad(): void { this.generation++; }
  get hasDraft():boolean { return !!this.value?.comment; }
  private protectDraft():boolean {
    if(!this.value?.comment)return false;
    this.value={...this.value,notice:'Comment draft retained here · Ctrl+S saves · Esc cancels'};
    this.changed();return true;
  }
  clear(): boolean { if(this.protectDraft())return false; this.history=[];this.future=[];this.generation++; this.value = null; this.changed(); return true; }
  focus(focused = true): void {
    if (this.value && this.value.focused !== focused) { this.value = {...this.value, focused}; this.changed(); }
  }
  restoreOffset(offset: number): void {
    if (!this.value || !Number.isSafeInteger(offset) || offset < 0) return;
    this.value = {...this.value, offset};
    this.changed();
  }
  scroll(delta: number, width: number, height: number): void {
    if (!this.value) return;
    const rows = documentPreviewLines(this.value.document, Math.max(1,width)).length;
    this.value = {...this.value, offset: Math.max(0, Math.min(Math.min(this.value.offset, Math.max(0, rows - Math.max(1,height))) + delta, rows - Math.max(1,height)))};
    this.changed();
  }
  cycleLink(delta:number,width:number,height:number):void {
    if(!this.value)return;
    const focusKey=(uri:string)=>{const action=parsePreviewRegionActionUri(uri);return action?.type==='document.disclosure.toggle'?previewRegionActionUri(action):uri;};
    const links=[...new Map(documentPreviewLinks(this.value.document,Math.max(1,width)).map(link=>[focusKey(link.uri),link])).values()];
    const index=links.findIndex(link=>focusKey(link.uri)===focusKey(this.value!.activeLink??''));
    const next=links[index<0?(delta>0?0:links.length-1):(index+delta+links.length)%links.length];
    if(!next){this.value={...this.value,notice:'No links in this Preview'};this.changed();return;}
    const offset=next.row<this.value.offset||next.row>=this.value.offset+height?next.row:this.value.offset;
    this.value={...this.value,activeLink:next.uri,activeLinkLabel:next.label,offset,notice:undefined};this.changed();
  }
  async key(key:TerminalKey,width:number,height:number,open:(target:OutlinerNavigationTarget)=>Promise<void>,str=''):Promise<boolean>{
    if(!this.value?.focused)return false;
    // A save can replace the document before the next host paint. Resolve input
    // against its current measured controls, never the previous region table.
    if(!this.value.comment&&!this.value.checklistPicker)documentPreviewLines(this.value.document,Math.max(1,width));
    if(this.value.checklistPicker){
      const picker=this.value.checklistPicker;
      if(key.name==='escape'){this.value={...this.value,checklistPicker:undefined,notice:undefined};this.changed();}
      else if(key.name==='up'||key.name==='down'||key.name==='tab'){
        const delta=key.name==='up'||key.name==='tab'&&key.shift?-1:1;
        this.value={...this.value,checklistPicker:{...picker,index:(picker.index+delta+CHECKLIST_CHOICES.length)%CHECKLIST_CHOICES.length}};this.changed();
      } else if(key.name==='return')await this.changeChecklist(CHECKLIST_CHOICES[picker.index]!.id,picker.control);
      return true;
    }
    if(this.value.comment){
      if(this.value.comment.saving)return true;
      const result=applyTextBufferEditorCommand(this.value.comment.buffer,textBufferEditorCommand(str,key,false));
      if(result==='save')await this.saveComment();
      else if(result==='cancel'){this.value={...this.value,comment:undefined,notice:'Comment cancelled'};}
      this.changed();return true;
    }
    if(key.ctrl&&key.name==='z'&&this.value.document.sourceBlock){await this.changeChecklist('undo');return true;}
    if(key.name==='space'||str===' '){
      const action=parsePreviewRegionActionUri(this.value.activeLink??'');
      const control=action?.type==='checklist.open'?findChecklistControl(this.value.document.previewRegions?.regions??[],action.regionId):undefined;
      if(control){await this.changeChecklist(control.item.status==='done'?'todo':'done',control);return true;}
    }
    if(this.selectionInput?.selectionKey(key,str)){this.changed();return true;}
    const character=str||key.name;
    if(character==='c'&&!key.ctrl&&!key.meta){this.beginComment();return true;}
    if(!key.ctrl&&!key.meta&&(character==='['||character===']')){this.moveComment(character===']'?1:-1,width);return true;}
    if(key.name==='tab'){this.cycleLink(key.shift?-1:1,width,height);return true;}
    if(key.meta&&(key.name==='left'||key.name==='right')){await this.action(key.name==='left'?'preview.back':'preview.forward',open);return true;}
    if(key.name==='return'){await this.action(!key.meta&&this.value.activeLink?'preview.follow':'preview.open',open);return true;}
    return false;
  }
  private async changeChecklist(choice:ChecklistChoice|'undo',control?:ChecklistControl):Promise<void> {
    const value=this.value;
    if(!value||value.loading||this.checklistBusy||value.comment)return;
    const blockId=value.document.sourceBlock?.id;
    if(!blockId||control&&control.blockId!==blockId)return;
    const generation=this.generation;
    this.checklistBusy=true;
    this.value={...value,checklistPicker:undefined,checklistBusy:true,notice:'Updating step…'};this.changed();
    try {
      if(choice==='copy-link'&&!this.copyText)throw Error('Clipboard output is unavailable in this host');
      const result=choice==='undo'?{receipt:await this.checklist.undo(blockId)}:await this.checklist.choose(control!,choice);
      if(generation!==this.generation||!this.value)return;
      if(!result.receipt){this.value={...this.value,notice:'No checklist change to undo'};return;}
      if('link' in result&&result.link)await this.copyText!(result.link);
      if(generation!==this.generation)return;
      // Reload canonical content and comments, retaining local folds and reading position.
      const refreshed=await this.load(value.target,true);
      if(!refreshed||!this.value)return;
      const id=checklistControlId(blockId,result.receipt.item,result.receipt.block.revision);
      this.value={...this.value,activeLink:previewRegionActionUri({type:'checklist.open',regionId:id}),
        activeLinkLabel:'Checklist step',notice:choice==='copy-link'?'Step link copied':choice==='undo'?'Checklist change undone':'Step updated · Ctrl+Z undo'};
    } catch(error){
      if(generation===this.generation&&this.value)this.value={...this.value,notice:error instanceof Error?error.message:String(error)};
    } finally {
      this.checklistBusy=false;
      if(this.value)this.value={...this.value,checklistBusy:false};
      this.changed();
    }
  }
  paste(text:string):boolean {
    const draft=this.value?.comment;
    if(!draft)return false;
    if(!draft.saving)draft.buffer.insert(text);
    this.changed();return true;
  }
  beginComment(annotationId?:string):void {
    if(!this.value||this.value.loading||this.value.comment)return;
    let target=this.value.document.commentTarget;
    const capture=annotationId?null:this.selectionInput?.captureSelection();
    if(capture){
      if(capture.document!==this.value.document || !target || !this.clientId){
        this.value={...this.value,notice:'The selected passage is no longer available here; select it again'};this.changed();return;
      }
      const document=this.value.document;
      const projected=document.projectedText!==document.canonicalText,resolved=document.resolvedText!==document.projectedText;
      target={...target,representation:{...target.representation,observation:{
        validation:'preview-selection',input:capture.input,quote:capture.quote,capturedAt:capture.capturedAt,readerId:this.clientId,
        ...(this.value.target.kind==='block'&&this.value.target.fragmentId?{fragmentId:this.value.target.fragmentId}:{}),
        renderRevision:capture.renderRevision,representationId:target.representation.id,snapshotHash:annotationSourceHash(capture.snapshotText),
        projection:projected&&resolved?'mixed':projected?'generated':resolved?'resolved':'canonical',
      }},anchor:capture.sourceAnchor??{kind:'text-quote',start:null,end:null,exact:capture.quote,prefix:'',suffix:''}};
    }
    if(annotationId&&!this.value.document.annotations?.annotationThreads.some(thread=>thread.block.id===annotationId))return;
    if(!annotationId&&!target){this.value={...this.value,notice:'No captured source available to comment on'};this.changed();return;}
    this.selectionInput?.clearSelection();
    this.generation++;
    this.value={...this.value,focused:true,comment:{requestId:crypto.randomUUID(),buffer:new TextBuffer(),saving:false,
      ...(annotationId?{annotationId}:{target:structuredClone(target!)})},notice:undefined};
    this.changed();
  }
  private async saveComment():Promise<void> {
    const value=this.value;
    const draft=value?.comment;
    if(!value||!draft||draft.saving)return;
    if(!draft.buffer.text.trim()){this.value={...value,notice:'Write a comment before saving'};this.changed();return;}
    draft.saving=true;this.changed();
    try {
      const receipt=await this.client.request<AnnotationBatchReceipt>(draft.annotationId
        ?{action:'annotations.reply',requestId:draft.requestId,author:'user',input:{annotationId:draft.annotationId,body:draft.buffer.text,source:'user'}}
        :{action:'annotations.create',requestId:draft.requestId,author:'user',input:{target:draft.target!,body:draft.buffer.text,source:'user'}});
      this.value={...this.value!,comment:undefined,notice:'Comment saved'};
      // Keep the displayed document and position: a refresh must not silently replace a before-image.
      try { await this.refreshComments(value.document); }
      catch(error){ if(this.value?.document===value.document)this.value={...this.value,notice:`Comment saved; refresh failed: ${error instanceof Error?error.message:String(error)}`}; }
      const annotationId=draft.annotationId??receipt.annotations[0]?.block.id;
      if(annotationId&&value.document.annotations)value.document.annotations.selectedAnnotationId=annotationId;
    } catch(error){this.value={...this.value!,notice:error instanceof Error?error.message:String(error)};}
    finally {draft.saving=false;this.changed();}
  }
  private async refreshComments(document:DetailReadPreviewDocument):Promise<void> {
    const annotations=document.annotations;
    const target=annotations?.target;
    if(!annotations||!target)return;
    const threads=await this.client.request<AnnotationThread[]>({action:'annotations.list',query:{
      subject:target.kind==='block'?{kind:'block',blockId:target.blockId}:{kind:'resource',resourceId:target.resourceId},includeResolved:true}});
    document.annotations={...annotations,annotationThreads:threads};
    // A new document identity invalidates the shared row/link cache while preserving disclosure choices.
    if(this.value?.document===document)this.value={...this.value,document:{...document}};
  }
  private selectComment(annotationId:string,width?:number):void {
    const document=this.value?.document;
    const annotations=document?.annotations;
    if(!document||!annotations||!this.value)return;
    documentPreviewThreadRow(document,annotationId,width);
    const groups=detailAnnotationGroups({...annotations,resolvedSelectedText:document.resolvedText,previewRegions:document.previewRegions!},
      line=>line,document.projectedText.split(/\r?\n/).length,document.projectedText);
    const group=groups.find(group=>group.threads.some(thread=>thread.block.id===annotationId));
    if(!group)return;
    annotations.selectedAnnotationId=annotationId;
    document.previewRegions!.disclosureOverrides.set(group.regionId,true);
    document.previewRegions!.focusedRegionId=`annotation-thread:${annotationId}`;
    const row=documentPreviewThreadRow(document,annotationId,width);
    this.value={...this.value,offset:row??this.value.offset,notice:undefined};
    this.changed();
  }
  private moveComment(delta:number,width?:number):void {
    const document=this.value?.document,annotations=document?.annotations;
    if(!document||!annotations?.annotationThreads.length)return;
    const threads=detailAnnotationGroups({...annotations,resolvedSelectedText:document.resolvedText,previewRegions:document.previewRegions!},
      line=>line,document.projectedText.split(/\r?\n/).length,document.projectedText).flatMap(group=>group.threads);
    if(!threads.length)return;
    const current=threads.findIndex(thread=>thread.block.id===annotations.selectedAnnotationId);
    const next=current<0?(delta>0?0:threads.length-1):(current+delta+threads.length)%threads.length;
    this.selectComment(threads[next]!.block.id,width);
  }
  async action(action:string,open:(target:OutlinerNavigationTarget)=>Promise<void>):Promise<void>{
    if(action==='preview.checklist.cancel'){
      if(this.value)this.value={...this.value,checklistPicker:undefined};this.changed();return;
    }
    if(action.startsWith('preview.checklist.choose:')){
      const picker=this.value?.checklistPicker;
      const choice=CHECKLIST_CHOICES.find(option=>option.id===action.slice('preview.checklist.choose:'.length));
      if(picker&&choice)await this.changeChecklist(choice.id,picker.control);
      return;
    }
    if(action==='preview.comment'){this.beginComment();return;}
    if(action==='preview.selection.cancel'){this.selectionInput?.clearSelection();this.changed();return;}
    if(this.protectDraft())return;
    if(action==='preview.select'){
      this.focus();this.selectionInput?.selectionKey({name:'v'},'v');this.changed();return;
    }
    if(action==='preview.previous'||action==='preview.next'){this.moveComment(action==='preview.next'?1:-1);return;}
    if(action==='preview.reply'||action==='preview.lifecycle'){
      const annotationId=this.value?.document.annotations?.selectedAnnotationId;
      if(annotationId){
        if(action==='preview.reply')this.beginComment(annotationId);
        else await this.action('preview.link:'+encodeURIComponent(previewRegionActionUri({type:'annotation.thread.lifecycle',annotationId})),open);
      }
      return;
    }
    const following=action==='preview.follow'||action.startsWith('preview.link:');
    const generation=following?++this.generation:this.generation;
    try {
      if(action==='preview.back'||action==='preview.forward'){
        const from=action==='preview.back'?this.history:this.future;
        const to=action==='preview.back'?this.future:this.history;
        const next=from.pop();
        if(next&&this.value){
          to.push(this.value);this.generation++;this.value={...next,checklistPicker:undefined,checklistBusy:false,focused:this.value.focused,notice:undefined};this.changed();
          // An unfinished visit is an address, not a cached successful document.
          if(next.loading)await this.load(next.target,false,true);
        }
      } else if(action==='preview.open'&&this.value) await open(this.value.target);
      else if(action==='preview.follow'&&this.value?.activeLink) await this.follow(this.value.activeLink,generation);
      else if(action.startsWith('preview.link:')) await this.follow(decodeURIComponent(action.slice('preview.link:'.length)),generation);
    } catch(error){
      if(generation===this.generation&&this.value){this.value={...this.value,notice:error instanceof Error?error.message:String(error)};this.changed();}
    }
  }
  private async follow(uri:string,generation:number):Promise<void>{
    if(!this.value)return;
    const disclosure = parsePreviewRegionActionUri(uri);
    if(disclosure?.type==='checklist.open'){
      const control=findChecklistControl(this.value.document.previewRegions?.regions??[],disclosure.regionId);
      if(control&&!this.checklistBusy&&!this.value.loading){
        this.selectionInput?.clearSelection();
        this.value={...this.value,focused:true,activeLink:uri,activeLinkLabel:'Checklist step',checklistPicker:{control,index:0},notice:undefined};this.changed();
      }
      return;
    }
    if (disclosure?.type === 'document.disclosure.toggle' || disclosure?.type === 'callout.disclosure.toggle' || disclosure?.type === 'annotation.disclosure.toggle') {
      const state = this.value.document.previewRegions;
      if (!state || togglePreviewRegionDisclosure(state, disclosure.regionId) === null) return;
      state.focusedRegionId = disclosure.regionId;
      this.value = {...this.value, activeLink:uri, activeLinkLabel:'Toggle section', notice:undefined};
      this.changed();
      return;
    }
    if(disclosure?.type==='annotation.thread.reply'){this.beginComment(disclosure.annotationId);return;}
    if(disclosure?.type==='annotation.thread.lifecycle'){
      const document=this.value.document;
      const thread=document.annotations?.annotationThreads.find(thread=>thread.block.id===disclosure.annotationId);
      if(thread){
        await this.client.request<AnnotationRecord>({action:'annotations.lifecycle',input:{annotationId:thread.block.id,
          lifecycle:thread.lifecycle==='open'?'resolved':'open'},mutation:{author:'user',actorId:'preview'}});
        if(generation===this.generation){await this.refreshComments(document);this.changed();}
      }
      return;
    }
    if(disclosure?.type==='annotation.thread.select'){
      this.selectComment(disclosure.annotationId);return;
    }
    if(disclosure?.type==='annotation.thread.move'){
      this.moveComment(disclosure.delta);return;
    }
    if(!uri.startsWith('pi-outliner:')){
      if(!/^https?:\/\//i.test(uri)||!this.openExternal)throw Error(`Unsupported link: ${uri}`);
      await this.openExternal(uri);
      if(generation===this.generation&&this.value){this.value={...this.value,notice:`Opened externally: ${uri}`};this.changed();}
      return;
    }
    const link=parseOutlinerLinkUri(uri);
    let target:OutlinerNavigationTarget;
    if(link.kind==='block')target={kind:'block',blockId:link.value,...link.fragmentId?{fragmentId:link.fragmentId}:{}};
    else if(link.kind==='resource')target={kind:'resource',resourceId:link.value};
    else if(link.kind==='reference'&&link.occurrence&&this.value.target.kind==='block'&&link.value===this.value.target.blockId&&
      isAuthoredFileOccurrence(this.value.document.canonicalText,link.occurrence.start,link.occurrence.end)){
      const receipt=await followResourceOccurrence(this.client,link);
      if(generation!==this.generation)return;
      target={kind:'resource',resourceId:receipt.resource.id,referenceContext:receipt.referenceContext};
    }
    else if(link.kind==='page'||link.kind==='work'){
      const resolved=await this.client.request<PageAddressResolution>({action:'pages.resolve',address:link.value});
      if(generation!==this.generation)return;
      if(!resolved.block)throw Error(`Unresolved ${link.kind}: ${link.value}`);
      target={kind:'block',blockId:resolved.block.id};
    }else throw Error('This link requires explicit Open in Detail');
    if(generation!==this.generation)return;
    const before=this.value;
    this.history.push(before);if(this.history.length>50)this.history.shift();this.future=[];
    await this.load(target,false,true);
  }
  /** Explicit local Open keeps this reader's browsing trail and current scroll. */
  async visit(target: OutlinerNavigationTarget): Promise<boolean> {
    if(this.protectDraft())return false;
    if (this.value && JSON.stringify(this.value.target) === JSON.stringify(target)) return true;
    if (this.value) { this.history.push(this.value); if(this.history.length>50)this.history.shift(); }
    this.future=[];
    return this.load(target,false,true);
  }
  /** Historical text is rendered as saved: do not resolve live embeds into a before-image. */
  async loadText(target: OutlinerNavigationTarget, title: string,
    content: Promise<string> | (() => Promise<string | SavedPreviewSource>)): Promise<boolean> {
    if(this.protectDraft())return false;
    this.history=[];this.future=[];
    const generation = ++this.generation;
    this.value = {target, title, document: plain('Loading saved source…'), loading:true, offset: 0, focused: this.value?.focused ?? false};
    this.changed();
    try {
      // The lazy source loader starts only after draft protection admits navigation.
      const saved = await (typeof content === 'function' ? content() : content);
      if (generation !== this.generation) return false;
      const document=plain(typeof saved==='string'?saved:saved.text);
      let notice:string|undefined;
      if(typeof saved!=='string' && target.kind==='block' && saved.id===target.blockId && saved.updatedAt){
        document.commentTarget={representation:blockAnnotationRepresentation({...saved,updatedAt:saved.updatedAt},saved.inboxAttemptId),anchor:{kind:'whole-subject'}};
        document.annotations={target,context:{selected:saved},historical:true,annotationThreads:[],selectedAnnotationId:undefined,document:{kind:'empty'}};
        try {
          document.annotations.annotationThreads=await this.client.request<AnnotationThread[]>({action:'annotations.list',
            query:{subject:{kind:'block',blockId:saved.id},includeResolved:true}});
        } catch(error){notice=`Comments unavailable: ${error instanceof Error?error.message:String(error)}`;}
      }
      if (generation !== this.generation) return false;
      this.value = {...this.value!, document, loading:false, notice};
    } catch (error) {
      if (generation !== this.generation) return false;
      this.value = {...this.value!, loading:false, document: plain(error instanceof Error ? error.message : String(error))};
    }
    this.changed();
    return true;
  }

  async load(target: OutlinerNavigationTarget, refresh = false, navigating = false): Promise<boolean> {
    if(this.protectDraft())return false;
    const generation = ++this.generation;
    const previousDocument = this.value?.document;
    const revealInDocument = target.kind === 'block' && !!target.fragmentId && previousDocument?.sourceBlock?.id === target.blockId;
    const previous = (revealInDocument || refresh && JSON.stringify(this.value?.target) === JSON.stringify(target)) ? previousDocument?.previewRegions : undefined;
    let revealSourceLine:number|undefined;
    if(!refresh&&!navigating){this.history=[];this.future=[];}
    let title = target.kind === 'block' ? target.blockId : target.resourceId;
    let offset = refresh ? this.value?.offset ?? 0 : 0;
    if (!refresh) this.value = {target, title, document: plain('Loading Preview…'), loading:true, offset:0, focused:this.value?.focused ?? false};
    this.changed();
    try {
      let document: DetailReadPreviewDocument;
      let selected:Block|null=null;
      let resourceDescription:ResourceDescription|null=null;
      if (target.kind === 'block') {
        const block = await this.client.request<Block>({action:'get',blockId:target.blockId});
        if (block.deletedAt || block.effectiveDeletedRootId) throw new Error('This note is in Trash');
        title = blockDisplayTitle(block);
        selected=block;
        if(target.fragmentId){
          const fragment=resolveFragmentSlice(block.text,target.fragmentId);
          if(fragment.status!=='resolved')throw Error(`Fragment ${fragment.status}: ${target.fragmentId}`);
          if (revealInDocument) {
            document=await loadDetailReadPreview(this.client,block);
            if (!refresh) revealSourceLine=fragment.slice.anchor.lineIndex;
          } else document={...await loadDetailReadPreview(this.client,{...block,text:fragment.slice.text}),sourceBlock:undefined};
        }else document = await loadDetailReadPreview(this.client,block);
      } else {
        if (!this.clientId) throw new Error('Resource preview requires a registered reader');
        const resource = await this.client.request<ResourceDescription>({action:'resources.describe',destinationClientId:this.clientId,target});
        title = resourceDescriptionLabel(resource);
        resourceDescription=resource;
        document = plain(resource.filesystem?.text ?? resource.web?.markdown ?? resource.remoteEntity?.markdown ?? resource.pdf?.markdown ?? resource.computed?.markdown ?? resource.computedFailure?.message ?? 'No cached readable representation · Open explicitly to inspect this Resource');
        if(resource.source.provider==='computed'&&resource.source.boundary.registry==='outliner.capture-history'){
          document={...document,preserveMetadata:true};
        }
      }
      if (generation !== this.generation) return false;
      const representation=resourceDescription?resourceAnnotationRepresentation(resourceDescription):selected?blockAnnotationRepresentation(selected):null;
      if(representation)document.commentTarget={representation,anchor:{kind:'whole-subject'},
        ...(target.kind==='resource'&&target.referenceContext?{referenceContext:target.referenceContext}:{})};
      let notice:string|undefined;
      try {
        const annotationThreads=await this.client.request<AnnotationThread[]>({action:'annotations.list',query:{
          subject:target.kind==='block'?{kind:'block',blockId:target.blockId}:{kind:'resource',resourceId:target.resourceId},includeResolved:true,
        }});
        document.annotations={target,context:{selected:document.sourceBlock?selected:null},selectedAnnotationId:undefined,annotationThreads,
          document:resourceDescription?{kind:'ready',document:{kind:'resource',description:resourceDescription}}:{kind:'empty'}};
      } catch(error) { notice=`Comments unavailable: ${error instanceof Error?error.message:String(error)}`; }
      if(generation!==this.generation)return false;
      // Reconcile the saved choices against the new document at its next render.
      // Anonymous identities change on edits; explicit stable IDs may survive.
      if (previous) document.previewRegions = {regions:[],focusedRegionId:previous.focusedRegionId,disclosureOverrides:new Map(previous.disclosureOverrides)};
      if(revealSourceLine!==undefined && previousDocument) offset=revealDocumentPreviewSourceLine(document,revealSourceLine,previousDocument);
      this.value = {target,title,document,offset,notice,focused:this.value?.focused ?? false};
      this.changed(); return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.value = {target,title,document:plain(error instanceof Error ? error.message : String(error)),offset:0,focused:this.value?.focused ?? false};
    }
    this.changed(); return false;
  }
}
