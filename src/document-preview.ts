import {documentPreviewLines} from './document-preview-renderer';
import type {OutlinerRequester} from './client-target';
import {loadDetailReadPreview} from './detail-read-preview';
import type {DetailReadPreviewDocument} from './detail-pi-preview';
import {blockDisplayTitle} from './references';
import type {Block, OutlinerNavigationTarget} from './types';
import type {ResourceDescription} from './resources';
import {resourceAddressLabel} from './resources';

export interface DocumentPreviewState {
  readonly target: OutlinerNavigationTarget;
  readonly title: string;
  readonly document: DetailReadPreviewDocument;
  readonly offset: number;
  readonly focused: boolean;
}

function plain(text: string): DetailReadPreviewDocument {
  return {canonicalText:text,resolvedText:text,projectedText:text,embedRanges:[],workIdPrefix:null};
}

/** A disposable reader. It owns requests, focus and scrolling; callers own selection and Open. */
export class DocumentPreview {
  private generation = 0;
  private value: DocumentPreviewState | null = null;
  constructor(private client: OutlinerRequester, private changed: () => void, private clientId?: string) {}
  get state(): DocumentPreviewState | null { return this.value; }
  cancelLoad(): void { this.generation++; }
  clear(): void { this.generation++; this.value = null; this.changed(); }
  focus(focused = true): void {
    if (this.value && this.value.focused !== focused) { this.value = {...this.value, focused}; this.changed(); }
  }
  scroll(delta: number, width: number, height: number): void {
    if (!this.value) return;
    const rows = documentPreviewLines(this.value.document, Math.max(1,width)).length;
    this.value = {...this.value, offset: Math.max(0, Math.min(Math.min(this.value.offset, Math.max(0, rows - Math.max(1,height))) + delta, rows - Math.max(1,height)))};
    this.changed();
  }
  async load(target: OutlinerNavigationTarget, refresh = false): Promise<boolean> {
    const generation = ++this.generation;
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
        document = await loadDetailReadPreview(this.client,block);
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
