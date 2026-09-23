import {getOsc8LinkAtColumn} from '@earendil-works/pi-tui';
import {DocumentPreviewInput} from './document-preview-input';
import {parseTreePrimaryPointer} from './tree-mouse';
import type {InboxResultDetail} from './inbox-types';
import type {InboxSearchCollection} from './inbox-search';
import type { RequestInput } from "./client";
import type { OutlinerRequester } from "./client-target";
import type { InboxResultSummary, InboxStatus } from "./inbox-types";
import {DocumentPreview} from "./document-preview";
import {pointInPreview,type DocumentPreviewFrame,type PreviewRect} from "./document-preview-renderer";
import {parseTreeWheelEvent} from "./tree-mouse";
import { TextBuffer } from "./text-buffer";
import { isPrintableInput, sanitizeDynamicText, type TerminalKey } from "./terminal";
import type { Block } from "./types";
import type { InternResourceReceipt } from "./resources";

interface InboxEffects extends OutlinerRequester {
  invalidate(): void;
  open(blockId: string, destination: "tree" | "detail"): Promise<void>;
  openResource(resourceId: string): Promise<void>;
  close(): void | Promise<void>;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function boundedInstructions(text: string, capacity: number): string {
  const clean = sanitizeDynamicText(text.replace(/[\r\n]+/g, " "));
  if (clean.length <= capacity) return clean;
  return clean.slice(0, graphemes.segment(clean).containing(capacity)?.index ?? capacity);
}

export class InboxController {
  private active = false;
  private session = 0;
  private epoch = 0;
  private refreshNeeded = false;
  private refreshJob: Promise<void> | null = null;
  private buffer = new TextBuffer();
  private reconsiderSourceId: string | null = null;
  snapshot: InboxStatus | null = null;
  attentionOnly = false;
  resultsOffset = 0;
  index = 0;
  targetIndex = 0;
  detailOffset = 0;
  loading = false;
  busy = false;
  error = "";
  notice = "";

  searchEditing = false;
  searchResults: InboxSearchCollection | null = null;
  searchLoading = false;
  searchRanking = false;
  searchError = "";
  private searchBuffer: TextBuffer | null = null;
  private searchGeneration = 0;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private searchTouched = false;
  private beforeSearch: {id?:string;index:number;targetIndex:number;detailOffset:number;previewMode:'content'|'activity';sourceOffset:number;outputOffset:number;outputIndex:number;sourceVersion:'before'|'current';focused:boolean}|null = null;
  get searching(): boolean {return this.searchBuffer !== null;}
  get searchQuery(): string {return this.searchBuffer?.text ?? "";}
  startSearch(): void {
    if (!this.searching) {
      this.beforeSearch={id:this.selected?.id,index:this.index,targetIndex:this.targetIndex,detailOffset:this.detailOffset,previewMode:this.previewMode,sourceOffset:this.sourceReader.state?.offset??0,outputOffset:this.outputReader.state?.offset??0,outputIndex:this.outputIndex,sourceVersion:this.sourceVersion,focused:this.reader.state?.focused??false};
      this.searchBuffer=new TextBuffer();this.searchChanged();
    }
    this.searchEditing=true;this.focusReader(false);this.effects.invalidate();
  }
  async cancelSearch(): Promise<void> {
    const saved=this.beforeSearch;
    this.searchBuffer=null;this.searchEditing=false;this.searchResults=null;this.searchLoading=false;this.searchRanking=false;
    this.searchGeneration++;clearTimeout(this.searchTimer);this.beforeSearch=null;this.searchError="";
    if(saved){this.index=Math.max(0,this.results.findIndex(result=>result.id===saved.id));this.targetIndex=saved.targetIndex;this.outputIndex=saved.outputIndex;this.sourceVersion=saved.sourceVersion;this.detailOffset=saved.detailOffset;this.previewMode=saved.previewMode;}
    this.previewKey="";
    const generation = this.searchGeneration;
    await this.refreshPreview();
    if(saved && this.active && generation === this.searchGeneration && !this.searching && this.selected?.id === saved.id && this.targetIndex === saved.targetIndex && this.sourceVersion === saved.sourceVersion){
      this.sourceReader.restoreOffset(saved.sourceOffset);
      this.outputReader.restoreOffset(saved.outputOffset);
      this.focusReader(saved.focused);
    }
    this.effects.invalidate();
  }
  private searchChanged(preserveSelection = false): void {
    const generation=++this.searchGeneration;clearTimeout(this.searchTimer);
    const query=this.searchQuery;
    if(!preserveSelection){this.searchResults=null;this.index=0;this.targetIndex=0;this.previewKey="";this.sourceReader.clear();this.outputReader.clear();this.outputIndex=0;}
    this.searchTouched=preserveSelection;this.notice="";this.searchLoading=true;this.searchRanking=false;this.searchError="";
    const load=async(semantic:boolean)=>{
      try {
        const result=await this.effects.request<InboxSearchCollection>({action:'inbox.search',query,semantic});
        if(!this.active||generation!==this.searchGeneration||!this.searching)return;
        const selectedId=this.searchTouched||this.reader.state?.focused?this.selected?.id:undefined;
        if(!semantic||!selectedId||result.matches.some(match=>match.result.id===selectedId)){
          this.searchResults=result;this.index=selectedId?Math.max(0,result.matches.findIndex(match=>match.result.id===selectedId)):0;
          if(!selectedId)this.targetIndex=0;
          this.refreshPreview();
        }
      }catch(error){if(generation===this.searchGeneration)this.searchError=message(error);}
      finally{if(generation===this.searchGeneration){if(semantic)this.searchRanking=false;else this.searchLoading=false;this.effects.invalidate();}}
    };
    void load(false).then(()=>{
      if(generation!==this.searchGeneration||!this.searching||query.trim().length<3||this.searchError)return;
      this.searchTimer=setTimeout(()=>{this.searchRanking=true;this.effects.invalidate();void load(true);},350);
    });
    this.effects.invalidate();
  }
  private async searchInput(str:string,key:TerminalKey):Promise<boolean>{
    if(!this.searching)return false;
    if(key.name==='escape'){await this.cancelSearch();return true;}
    if(!this.searchEditing)return false;
    if(key.name==='up'||key.name==='down'){this.move(key.name==='up'?-1:1);return true;}
    if(key.name==='return'){this.searchTouched=true;this.searchEditing=false;if(key.meta)await this.open(this.targets[this.targetIndex]?.id,'detail');this.effects.invalidate();return true;}
    const before=this.searchQuery;
    if(key.name==='backspace')this.searchBuffer!.backspace();
    else if(key.name==='delete')this.searchBuffer!.deleteForward();
    else if(key.name==='left')this.searchBuffer!.moveLeft();
    else if(key.name==='right')this.searchBuffer!.moveRight();
    else if(key.name==='home')this.searchBuffer!.moveHome();
    else if(key.name==='end')this.searchBuffer!.moveEnd();
    else if(isPrintableInput(str,key))this.searchBuffer!.insert(boundedInstructions(str,Math.max(0,500-before.length)));
    if(before!==this.searchQuery)this.searchChanged();else this.effects.invalidate();
    return true;
  }

  readonly sourceReader: DocumentPreview;
  readonly outputReader: DocumentPreview;
  get reader(): DocumentPreview { return this.targets[this.targetIndex]?.role === 'output' ? this.outputReader : this.sourceReader; }
  sourceVersion: 'before' | 'current' = 'current';
  technicalDetails = false;
  reviewFraction = 0.35;
  sourceFraction = 0.5;
  comparison = false;
  sourceFrame: DocumentPreviewFrame | undefined;
  outputFrame: DocumentPreviewFrame | undefined;
  horizontalDivider: PreviewRect | undefined;
  verticalDivider: PreviewRect | undefined;
  reviewBody: PreviewRect | undefined;
  private renderedLines: string[] = [];
  private resizeAxis: 'horizontal' | 'vertical' | undefined;
  private sourceInput = new DocumentPreviewInput();
  private outputInput = new DocumentPreviewInput();
  private sourceKey = '';
  private outputKey = '';
  private outputIndex = 0;
  get outputTarget() { return this.targets.filter(target => target.role === 'output')[this.outputIndex]; }
  focusReader(focused = true, role: 'source' | 'output' = this.reader === this.outputReader ? 'output' : 'source'): void {
    if (focused) {
      if (this.searching) this.searchTouched = true;
      this.searchEditing = false;
      this.previewMode = 'content';
      const index = this.targets.findIndex(target => role === 'source' ? target.role === 'source' : target.id === this.outputTarget?.id);
      if (index >= 0) this.targetIndex = index;
    }
    this.sourceReader.focus(focused && role === 'source');
    this.outputReader.focus(focused && role === 'output');
  }
  setSourceVersion(version: 'before' | 'current'): void {
    this.sourceVersion = version;
    this.sourceKey = "";
    const index = this.targets.findIndex(target => target.role === 'source');
    if (index >= 0) this.selectTarget(index);
  }
  renderInputs(lines: string[]): string[] {
    this.renderedLines = lines;
    return this.outputInput.render(this.sourceInput.render(lines, this.sourceFrame, this.sourceReader.state), this.outputFrame, this.outputReader.state);
  }
  handlePreviewMouse(sequence: string, copy: (text: string) => void): boolean {
    if (!this.reviewBody) this.resizeAxis = undefined;
    const pointer = parseTreePrimaryPointer(sequence);
    const readers = [
      ['source', this.sourceInput, this.sourceReader, this.sourceFrame],
      ['output', this.outputInput, this.outputReader, this.outputFrame],
    ] as const;
    const handle = ([role, input, reader, frame]: typeof readers[number]) => input.handle(sequence, {
        focus: (focused = true) => { if (focused) this.focusReader(true, role); else reader.focus(false); },
        scroll: delta => {if (this.searching) this.searchTouched = true; if (frame) reader.scroll(delta, frame.content.width, frame.content.height);},
        resize: () => {}, invoke: async () => {},
      }, copy, () => this.effects.invalidate());
    if (!this.reviewBody) this.resizeAxis = undefined;
    // A drag belongs to the reader where it began, even across another reader or toolbar.
    if (pointer && pointer.phase !== 'down') {
      const owner = readers.find(([, input]) => input.ownsPointer);
      if (owner && handle(owner)) return true;
    }

    if (pointer) {
      if (pointer.phase === 'down') {
        if (this.horizontalDivider && pointInPreview(this.horizontalDivider, pointer.column, pointer.row)) this.resizeAxis = 'horizontal';
        else if (this.verticalDivider && pointInPreview(this.verticalDivider, pointer.column, pointer.row)) this.resizeAxis = 'vertical';
      }
      if (this.resizeAxis && this.reviewBody) {
        const body = this.reviewBody;
        if (this.resizeAxis === 'horizontal') this.reviewFraction = Math.max(0.2, Math.min(0.65, (pointer.row - body.y) / body.height));
        else this.sourceFraction = Math.max(0.25, Math.min(0.75, (pointer.column - body.x) / body.width));
        if (pointer.phase === 'up') this.resizeAxis = undefined;
        this.effects.invalidate(); return true;
      }
      const toolbar = this.sourceFrame && pointer.row === this.sourceFrame.rect.y + 1 && pointInPreview(this.sourceFrame.rect, pointer.column, pointer.row);
      if (toolbar) {
        const link = getOsc8LinkAtColumn(this.renderedLines[pointer.row] ?? '', pointer.column);
        if (link === 'pi-outliner-action:tree.inbox.preview.before' || link === 'pi-outliner-action:tree.inbox.preview.current') {
          if (pointer.phase === 'down') this.setSourceVersion(link.endsWith('.before') ? 'before' : 'current');
          return true;
        }
      }
    }
    for (const entry of readers) if (handle(entry)) return true;
    return this.handleActivityMouse(sequence);
  }
  previewMode: 'content' | 'activity' = 'content';
  previewFrame: DocumentPreviewFrame | undefined;
  activityRect: PreviewRect | undefined;
  handleActivityMouse(sequence: string): boolean {
    const wheel = parseTreeWheelEvent(sequence);
    if (!wheel || !this.activityRect || !pointInPreview(this.activityRect,wheel.column,wheel.row)) return false;
    this.detailOffset = Math.max(0,this.detailOffset + (wheel.direction === "up" ? -3 : 3));
    this.effects.invalidate(); return true;
  }
  private previewKey = '';
  constructor(private readonly effects: InboxEffects) {
    this.sourceReader = new DocumentPreview(effects, () => effects.invalidate());
    this.outputReader = new DocumentPreview(effects, () => effects.invalidate());
  }
  selectResult(index: number): void {
    if (!Number.isInteger(index) || !this.results[index]) return;
    this.searchEditing=false;
    this.focusReader(false);
    this.move(index - this.index);
  }
  selectTarget(index: number): void {
    if (!Number.isInteger(index) || !this.targets[index]) return;
    if(this.searching)this.searchTouched=true;
    this.focusReader(false);
    this.notice = '';
    this.targetIndex = Math.max(0,Math.min(this.targets.length - 1,index));
    if (this.targets[index]?.role === 'output') this.outputIndex = this.targets.filter(target => target.role === 'output').findIndex(target => target.id === this.targets[index]?.id);
    this.previewMode = this.targets[this.targetIndex]?.role === 'diagnostics' ? 'activity' : 'content';
    this.refreshPreview(); this.effects.invalidate();
  }
  nextOutput(): void {
    const indices = this.targets.flatMap((target,index)=>target.role === "output" ? [index] : []);
    if (!indices.length) {this.notice="No separate output; preview the current Source";this.effects.invalidate();return;}
    this.selectTarget(indices[(indices.indexOf(this.targetIndex)+1)%indices.length]!);
  }
  toggleTechnicalDetails(): void {this.technicalDetails = !this.technicalDetails; this.effects.invalidate();}
  showActivity(): void {if(this.searching)this.searchTouched=true;this.previewMode = 'activity'; this.focusReader(false); this.effects.invalidate();}
  scrollPreview(delta: number): void {
    if(this.searching)this.searchTouched=true;
    const frame = this.reader === this.outputReader ? this.outputFrame : this.sourceFrame;
    if (frame) this.reader.scroll(delta,frame.content.width,frame.content.height);
  }
  private async refreshPreview(force = false): Promise<boolean> {
    if (!this.active) return false;
    const result = this.selected;
    if (!result) {this.sourceReader.clear(); this.outputReader.clear(); this.sourceKey = this.outputKey = ''; return false;}
    const reset = !this.previewKey;
    this.previewKey = result.id;
    const jobs: Promise<boolean>[] = [];
    const sourceKey = `${result.id}/${result.sourceId}/${this.sourceVersion}`;
    if ((this.sourceVersion === 'current' && (force || reset)) || sourceKey !== this.sourceKey || !this.sourceReader.state) {
      this.sourceKey = sourceKey;
      const target = {kind: 'block' as const, blockId: result.sourceId};
      jobs.push(this.sourceVersion === 'current'
        ? this.sourceReader.load(target, force)
        : this.sourceReader.loadText(target, result.sourceTitle, this.effects.request<InboxResultDetail>({action: 'inbox.result', resultId: result.id}).then(detail =>
          detail.beforeSource?.text ?? 'No saved source before this attempt. Current source is available separately.')));
    }
    const output = this.outputTarget;
    const outputKey = output ? `${result.id}/${output.id}` : '';
    if (!output) {this.outputKey = ''; this.outputReader.clear();}
    else if (force || reset || outputKey !== this.outputKey) {
      this.outputKey = outputKey;
      jobs.push(this.outputReader.load({kind: 'block', blockId: output.id}, force));
    }
    return (await Promise.all(jobs)).some(Boolean);
  }

  contentChanged(): void { this.previewKey = ""; this.refreshPreview(true); }

  get results(): InboxResultSummary[] {
    if(this.searching)return this.searchResults?.matches.map(match=>match.result)??[];
    return this.snapshot?.attentionOnly === this.attentionOnly && this.snapshot.resultsOffset === this.resultsOffset ? this.snapshot.results : [];
  }
  get selected(): InboxResultSummary | undefined { return this.results[this.index]; }
  get steering(): boolean { return this.reconsiderSourceId !== null; }
  get instructions(): string { return this.buffer.text; }
  get column(): number { return this.buffer.column; }
  get targets(): Array<{ id: string; label: string; sessionPath?: string; role: "source" | "output" | "diagnostics" }> {
    const result = this.selected;
    if (!result) return [];
    return [
      ...result.outputIds.map((id, index) => ({ id, label: `Output ${index + 1}`, role: "output" as const })),
      { id: result.sourceId, label: "Source", role: "source" },
      ...(result.usage?.piSessions ?? []).flatMap((session, index) => session.path
        ? [{ id: session.id, label: `Pi session ${index + 1}${session.snapshot ? " · partial" : ""}`, sessionPath: session.path, role: "diagnostics" as const }] : []),
    ];
  }

  async start(): Promise<void> {
    this.searchBuffer=null;this.searchResults=null;this.searchEditing=false;this.searchGeneration++;clearTimeout(this.searchTimer);
    this.active = true;
    const session = ++this.session;
    this.reconsiderSourceId = null;
    this.attentionOnly = true;
    this.resultsOffset = 0;
    const epoch = this.epoch + 1;
    await this.changedCollection();
    // Pick the opening view once. Refreshes must preserve an explicit history choice.
    if (this.active && session === this.session && epoch === this.epoch && !this.error
      && this.snapshot?.attentionOnly && this.snapshot.attentionCount === 0) {
      this.attentionOnly = false;
      await this.changedCollection();
    }
  }

  async close(): Promise<void> {
    this.active = false;
    this.searchGeneration++;clearTimeout(this.searchTimer);
    this.sourceReader.cancelLoad(); this.outputReader.cancelLoad();
    this.session++;
    this.reconsiderSourceId = null;
    await this.effects.close();
  }

  /** Events and reconnects refresh the retained status even while its view is closed. */
  refresh(): Promise<void> {
    this.refreshNeeded = true;
    if (this.refreshJob) return this.refreshJob;
    this.loading = true;
    this.effects.invalidate();
    this.refreshJob = this.refreshLoop().finally(() => {
      this.refreshJob = null;
      this.loading = false;
      this.effects.invalidate();
    });
    return this.refreshJob;
  }

  disconnected(): void {
    this.epoch++;
    this.error = "Workspace service disconnected; reconnecting…";
  }

  private async refreshLoop(): Promise<void> {
    while (this.refreshNeeded) {
      this.refreshNeeded = false;
      const epoch = this.epoch;
      try {
        const snapshot = await this.effects.request<InboxStatus>({
          action: "inbox.status",
          ...(this.attentionOnly ? { attentionOnly: true } : {}),
          ...(this.resultsOffset ? { resultsOffset: this.resultsOffset } : {}),
        });
        if (epoch === this.epoch) this.receive(snapshot);
      } catch (error) {
        if (epoch === this.epoch) this.error = message(error);
      }
    }
  }

  private receive(snapshot: InboxStatus): void {
    const selectedId = this.selected?.id;
    const targetId = this.targets[this.targetIndex]?.id;
    this.snapshot = snapshot;
    this.error = "";
    if(this.searching){this.refreshPreview();return;}
    const nextIndex = selectedId ? snapshot.results.findIndex(result => result.id === selectedId) : -1;
    this.index = nextIndex >= 0 ? nextIndex : Math.min(this.index, Math.max(0, snapshot.results.length - 1));
    this.targetIndex = Math.max(0, this.targets.findIndex(target => target.id === targetId));
    if (selectedId !== this.selected?.id) {this.detailOffset = 0; this.outputIndex = 0;}
    this.refreshPreview();
  }

  move(delta: number): void {
    if(this.searching)this.searchTouched=true;
    this.focusReader(false);
    this.index = Math.max(0, Math.min(this.results.length - 1, this.index + delta));
    this.outputIndex = 0;
    this.targetIndex = 0;
    this.detailOffset = 0;
    this.notice = "";
    this.previewMode = "content";
    this.refreshPreview();
    this.effects.invalidate();
  }

  paste(text: string): void {
    if(this.searchEditing&&this.searchBuffer){this.searchBuffer.insert(boundedInstructions(text,Math.max(0,500-this.searchQuery.length)));this.searchChanged();return;}
    if (!this.steering || this.busy) return;
    this.buffer.insert(boundedInstructions(text, Math.max(0, 500 - this.instructions.length)));
    this.effects.invalidate();
  }

  async input(str: string, key: TerminalKey): Promise<void> {
    if (!this.active) return;
    if(this.searching && await this.searchInput(str,key))return;
    if(!this.steering&&str==="/"){this.startSearch();return;}
    if (key.name === "escape") {
      if (!this.steering && this.reader.state?.focused) {this.focusReader(false);return;}
      if (this.steering) { this.reconsiderSourceId = null; this.notice = ""; this.effects.invalidate(); }
      else await this.close();
      return;
    }
    if (this.busy) return;
    if (!this.steering && key.meta && key.name === 'p') {this.focusReader(!this.reader.state?.focused);return;}
    if (!this.steering && this.previewMode === 'content' && this.reader.state?.focused && ['up','down','pageup','pagedown'].includes(key.name ?? '')) {
      this.scrollPreview((key.name === 'up' || key.name === 'pageup' ? -1 : 1) * (key.name?.startsWith('page') ? Math.max(1,this.previewFrame?.content.height ?? 5) : 1));return;
    }
    if (this.steering) {
      if (key.name === "return") {
        const sourceId = this.reconsiderSourceId!;
        const instructions = this.instructions.trim();
        const ok = await this.mutate({ action: "inbox.retry", sourceId, ...(instructions ? { instructions } : {}) }, "Queued for reconsideration");
        if (ok) this.reconsiderSourceId = null;
      } else if (key.name === "backspace") this.buffer.backspace();
      else if (key.name === "delete") this.buffer.deleteForward();
      else if (key.name === "left") this.buffer.moveLeft();
      else if (key.name === "right") this.buffer.moveRight();
      else if (key.name === "home") this.buffer.moveHome();
      else if (key.name === "end") this.buffer.moveEnd();
      else if (isPrintableInput(str, key)) this.paste(str);
    } else if (str === "a") {
      if(this.searching){await this.cancelSearch();}
      this.attentionOnly = !this.attentionOnly;
      this.resultsOffset = 0;
      await this.changedCollection();
    } else if (key.name === "left" || key.name === "right") {
      if(this.searching){this.notice="Search covers all history; edit the query to narrow results";}
      else if (this.attentionOnly) this.notice = "Resolve these questions to reveal the remaining items";
      else if (key.name === "left" && this.resultsOffset > 0) {
        this.resultsOffset = Math.max(0, this.resultsOffset - 30);
        await this.changedCollection();
      } else if (key.name === "right" && this.snapshot?.resultsTruncated) {
        this.resultsOffset += 30;
        await this.changedCollection();
      } else this.notice = key.name === "left" ? "First page of recent results" : "No older results";
    } else if (key.name === "up" || key.name === "down") this.move(key.name === "up" ? -1 : 1);
    else if (key.name === "tab") {
      const count = this.targets.length;
      if (count) this.selectTarget((this.targetIndex + (key.shift ? -1 : 1) + count) % count);
    } else if (str === "A") this.showActivity();
    else if (key.name === "pageup" || key.name === "pagedown") {
      if (this.previewMode === "content") this.scrollPreview(key.name === "pageup" ? -5 : 5);
      else this.detailOffset = Math.max(0, this.detailOffset + (key.name === "pageup" ? -5 : 5));
    } else if (key.name === "return") {
      const target = this.targets[this.targetIndex];
      if (target?.sessionPath) await this.openSession(target.sessionPath);
      else await this.open(target?.id, key.meta ? "detail" : "tree");
    }
    else if (str === "t") {
      const target = this.targets.find(target => target.sessionPath);
      if (target?.sessionPath) await this.openSession(target.sessionPath);
      else this.notice = "No saved Pi session for this result";
    }
    else if (str === "s") await this.open(this.selected?.sourceId, "tree");
    else if (str === "p") {
      if (!this.snapshot) this.notice = "Wait for Inbox status before changing it";
      else await this.mutate({ action: this.snapshot.paused ? "inbox.resume" : "inbox.pause" }, this.snapshot.paused ? "Inbox agent resumed" : "Inbox agent paused");
    } else if (str === "u") {
      if (this.selected?.state === "applied") await this.mutate({ action: "inbox.undo", resultId: this.selected.id }, "Result undone");
      else this.notice = "Only an applied result can be undone";
    } else if (str === "r") {
      if (!this.selected) this.notice = "Select a result to reconsider";
      else if (this.selected.state === "applied") this.notice = "Undo this result before reconsidering it";
      else {
        this.reconsiderSourceId = this.selected.sourceId;
        this.buffer = new TextBuffer();
        this.notice = "Add optional instructions for this capture.";
      }
    }
    this.effects.invalidate();
  }

  private async openSession(path: string): Promise<void> {
    this.busy = true;
    try {
      // This request is evaluated by the service owning the receipt and file,
      // including when this Tree runs on another host.
      const receipt = await this.effects.request<InternResourceReceipt>({ action: "resources.intern-filesystem", input: { path, mediaType: "text/plain" } });
      await this.effects.openResource(receipt.resource.id);
    } catch (error) { this.notice = message(error); }
    finally { this.busy = false; this.effects.invalidate(); }
  }

  private async changedCollection(): Promise<void> {
    this.epoch++;
    this.previewKey = "";
    this.sourceReader.clear(); this.outputReader.clear(); this.outputIndex = 0;
    this.previewMode = "content";
    this.index = 0;
    this.targetIndex = 0;
    this.detailOffset = 0;
    this.notice = "";
    await this.refresh();
  }

  private async mutate(input: RequestInput, notice: string): Promise<boolean> {
    this.busy = true;
    this.notice = "Saving…";
    this.epoch++;
    this.effects.invalidate();
    try {
      const snapshot = await this.effects.request<InboxStatus>(input);
      this.epoch++;
      if (this.attentionOnly || this.resultsOffset) await this.refresh();
      else this.receive(snapshot);
      if(this.searching)this.searchChanged(true);
      this.notice = notice;
      return true;
    } catch (error) {
      this.notice = message(error);
      return false;
    } finally {
      this.busy = false;
      this.effects.invalidate();
    }
  }

  /** One content resolver for keyboard, mouse and destination creation. */
  async resolveContentTarget(blockId = this.targets[this.targetIndex]?.role === "diagnostics"
    ? this.selected?.sourceId : this.targets[this.targetIndex]?.id): Promise<string> {
    if(this.searching)this.searchTouched=true;
    if (!blockId) throw new Error("Select an Inbox source or output");
    const session = this.session;
    const selectedId = this.selected?.id;
    // The initial content target may have been deleted since this receipt.
    // Explicit non-default choices remain explicit rather than silently redirecting.
    const candidates = this.targetIndex === 0 && blockId === this.targets[0]?.id
      ? this.targets.filter(target => target.role !== "diagnostics").map(target => target.id)
      : [blockId];
    let available: Block | null = null;
    for (const candidate of candidates) {
      const block = await this.effects.request<Block | null>({ action: "get", blockId: candidate }).catch(error => {
        if (error instanceof Error && error.message === `Block not found: ${candidate}`) return null;
        throw error;
      });
      if (!this.active || session !== this.session || selectedId !== this.selected?.id) throw new Error("Inbox selection changed; choose the target again");
      if (block && !block.deletedAt && !block.effectiveDeletedRootId) { available = block; break; }
    }
    if (!available) throw new Error("This block is no longer available");
    this.targetIndex = Math.max(0, this.targets.findIndex(target => target.id === available.id));
    return available.id;
  }

  private async open(blockId: string | undefined, destination: "tree" | "detail"): Promise<void> {
    if (!blockId) return;
    const session = this.session;
    try {
      const id = await this.resolveContentTarget(blockId);
      await this.effects.open(id, destination);
      if (destination === "tree") { this.active = false; this.reader.cancelLoad(); this.session++; }
    } catch (error) {
      if (this.active && session === this.session) this.notice = message(error);
    }
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
