import {documentPreviewLines,documentPreviewLinks} from './document-preview-renderer';
import type {OutlinerRequester} from './client-target';
import {loadDetailReadPreview} from './detail-read-preview';
import type {DetailReadPreviewDocument} from './detail-pi-preview';
import {blockDisplayTitle} from './references';
import {parseOutlinerLinkUri} from './outliner-links';
import {resolveFragmentSlice} from './fragments';
import type {TerminalKey} from './terminal';
import type {Block, PageAddressResolution, OutlinerNavigationTarget} from './types';
import type {ResourceDescription} from './resources';
import {resourceAddressLabel} from './resources';

export interface DocumentPreviewState {
  readonly target: OutlinerNavigationTarget;
  readonly title: string;
  readonly document: DetailReadPreviewDocument;
  readonly offset: number;
  readonly focused: boolean;
  readonly activeLink?: string;
  readonly activeLinkLabel?: string;
  readonly notice?: string;
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
  constructor(private client: OutlinerRequester, private changed: () => void, private clientId?: string, private openExternal?: (url:string)=>void|Promise<void>) {}
  get state(): DocumentPreviewState | null { return this.value ? {...this.value,canBack:this.history.length>0,canForward:this.future.length>0} : null; }
  cancelLoad(): void { this.generation++; }
  clear(): void { this.history=[];this.future=[];this.generation++; this.value = null; this.changed(); }
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
    const links=[...new Map(documentPreviewLinks(this.value.document,Math.max(1,width)).map(link=>[link.uri,link])).values()];
    const index=links.findIndex(link=>link.uri===this.value!.activeLink);
    const next=links[index<0?(delta>0?0:links.length-1):(index+delta+links.length)%links.length];
    if(!next){this.value={...this.value,notice:'No links in this Preview'};this.changed();return;}
    const offset=next.row<this.value.offset||next.row>=this.value.offset+height?next.row:this.value.offset;
    this.value={...this.value,activeLink:next.uri,activeLinkLabel:next.label,offset,notice:undefined};this.changed();
  }
  async key(key:TerminalKey,width:number,height:number,open:(target:OutlinerNavigationTarget)=>Promise<void>):Promise<boolean>{
    if(!this.value?.focused)return false;
    if(key.name==='tab'){this.cycleLink(key.shift?-1:1,width,height);return true;}
    if(key.meta&&(key.name==='left'||key.name==='right')){await this.action(key.name==='left'?'preview.back':'preview.forward',open);return true;}
    if(key.name==='return'){await this.action(!key.meta&&this.value.activeLink?'preview.follow':'preview.open',open);return true;}
    return false;
  }
  async action(action:string,open:(target:OutlinerNavigationTarget)=>Promise<void>):Promise<void>{
    const generation=this.generation;
    try {
      if(action==='preview.back'||action==='preview.forward'){
        const from=action==='preview.back'?this.history:this.future;
        const to=action==='preview.back'?this.future:this.history;
        const next=from.pop();
        if(next&&this.value){to.push(this.value);this.generation++;this.value={...next,focused:this.value.focused,notice:undefined};this.changed();}
      } else if(action==='preview.open'&&this.value) await open(this.value.target);
      else if(action==='preview.follow'&&this.value?.activeLink) await this.follow(this.value.activeLink);
      else if(action.startsWith('preview.link:')) await this.follow(decodeURIComponent(action.slice('preview.link:'.length)));
    } catch(error){
      if(generation===this.generation&&this.value){this.value={...this.value,notice:error instanceof Error?error.message:String(error)};this.changed();}
    }
  }
  private async follow(uri:string):Promise<void>{
    if(!this.value)return;
    const generation=this.generation;
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
  /** Historical text is rendered as saved: do not resolve live embeds into a before-image. */
  async loadText(target: OutlinerNavigationTarget, title: string, content: Promise<string>): Promise<boolean> {
    this.history=[];this.future=[];
    const generation = ++this.generation;
    this.value = {target, title, document: plain('Loading saved source…'), offset: 0, focused: this.value?.focused ?? false};
    this.changed();
    try {
      const text = await content;
      if (generation !== this.generation) return false;
      this.value = {...this.value!, document: plain(text)};
    } catch (error) {
      if (generation !== this.generation) return false;
      this.value = {...this.value!, document: plain(error instanceof Error ? error.message : String(error))};
    }
    this.changed();
    return true;
  }

  async load(target: OutlinerNavigationTarget, refresh = false, navigating = false): Promise<boolean> {
    const generation = ++this.generation;
    if(!refresh&&!navigating){this.history=[];this.future=[];}
    let title = target.kind === 'block' ? target.blockId : target.resourceId;
    const offset = refresh ? this.value?.offset ?? 0 : 0;
    if (!refresh) this.value = {target, title, document: plain('Loading Preview…'), offset:0, focused:this.value?.focused ?? false};
    this.changed();
    try {
      let document: DetailReadPreviewDocument;
      if (target.kind === 'block') {
        const block = await this.client.request<Block>({action:'get',blockId:target.blockId});
        if (block.deletedAt || block.effectiveDeletedRootId) throw new Error('This note is in Trash');
        title = blockDisplayTitle(block);
        if(target.fragmentId){
          const fragment=resolveFragmentSlice(block.text,target.fragmentId);
          if(fragment.status!=='resolved')throw Error(`Fragment ${fragment.status}: ${target.fragmentId}`);
          document=await loadDetailReadPreview(this.client,{...block,text:fragment.slice.text});
        }else document = await loadDetailReadPreview(this.client,block);
      } else {
        if (!this.clientId) throw new Error('Resource preview requires a registered reader');
        const resource = await this.client.request<ResourceDescription>({action:'resources.describe',destinationClientId:this.clientId,target});
        title = resourceAddressLabel(resource.resource.address);
        document = plain(resource.filesystem?.text ?? resource.web?.markdown ?? resource.remoteEntity?.markdown ?? resource.pdf?.markdown ?? resource.computed?.markdown ?? 'No cached readable representation · Open explicitly to inspect this Resource');
      }
      if (generation !== this.generation) return false;
      this.value = {target,title,document,offset,focused:this.value?.focused ?? false};
      this.changed(); return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.value = {target,title,document:plain(error instanceof Error ? error.message : String(error)),offset:0,focused:this.value?.focused ?? false};
    }
    this.changed(); return false;
  }
}
