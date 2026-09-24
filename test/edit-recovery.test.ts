import {afterEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OutlinerStore} from "../src/store";
import {EditRecoveryRepository} from "../src/edit-recovery";

const fixtures:Array<{store:OutlinerStore;dir:string}>=[];
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"edit-recovery-")),store=new OutlinerStore(join(dir,"outline.sqlite"));
  const item={store,dir};fixtures.push(item);
  return {...item,repository:new EditRecoveryRepository(store)};
}
afterEach(()=>{for(const f of fixtures.splice(0)){f.store.close();rmSync(f.dir,{recursive:true,force:true});}});
const mutation={author:"user" as const,actorId:"detail"};

test("retains original/base/prelaunch/latest and mechanically merges the reported metadata race",()=>{
  const{store,repository}=fixture(),base=store.create("Work note\n\nOriginal body");
  const latest=store.update(base.id,"Work note [type::note]\n\nOriginal body",base.revision,mutation);
  const draft=base.text+"\n\nA long returned thought 👩🏽‍💻";
  const record=repository.start({id:crypto.randomUUID(),blockId:base.id,baseText:base.text,baseRevision:base.revision,prelaunchText:base.text+"\nAlready in Detail",draftText:draft,source:"external-editor"});
  expect(record.originalDraft).toBe(draft);expect(record.latest.revision).toBe(latest.revision);
  expect(record.prelaunchText).toContain("Already in Detail");
  expect(record.proposal?.text).toBe(latest.text+"\n\nA long returned thought 👩🏽‍💻");
  expect(store.get(base.id)?.text).toBe(latest.text);
  const updated=repository.commit(record.id,record.revision,record.proposal!.text,latest.revision,mutation);
  expect(updated.text).toBe(record.proposal!.text);expect(repository.list(base.id)).toEqual([]);
  expect(repository.get(record.id).originalDraft).toBe(draft);
});

test("stale model and save attempts preserve writing without overwriting a newer note",()=>{
  const{store,repository}=fixture(),base=store.create("Note\n\nBase");
  const record=repository.start({id:crypto.randomUUID(),blockId:base.id,baseText:base.text,baseRevision:base.revision,prelaunchText:base.text,draftText:"Note\n\nLocal",source:"save-conflict"});
  store.update(base.id,"Note\n\nAnother writer",base.revision,mutation);
  expect(()=>repository.propose(record.id,record.revision,{text:"Merged",basedOnRevision:base.revision,source:"agent",unresolved:[],explanation:"Proposed"})).toThrow("note changed");
  expect(()=>repository.commit(record.id,record.revision,"Local",base.revision,mutation)).toThrow();
  expect(repository.get(record.id).originalDraft).toBe("Note\n\nLocal");
  const refreshed=repository.refresh(record.id,record.revision);
  expect(refreshed.proposal).toBeNull();expect(refreshed.merge.conflicts).toHaveLength(1);
  expect(store.get(base.id)?.text).toBe("Note\n\nAnother writer");
});

test("restart retains pending recovery independently of note assistance and exact title matches",()=>{
  const f=fixture(),base=f.store.create("Same title\n\nFirst");f.store.create("Same title\n\nSecond");
  const record=f.repository.start({id:crypto.randomUUID(),blockId:base.id,baseText:base.text,baseRevision:base.revision,prelaunchText:base.text,draftText:"Same title\n\nUnicode 日本語\n```\nraw\n```",source:"external-editor"});
  f.store.close();const restarted=new OutlinerStore(join(f.dir,"outline.sqlite"));fixtures.find(x=>x.dir===f.dir)!.store=restarted;
  const repository=new EditRecoveryRepository(restarted);
  expect(repository.list(base.id)).toEqual([record]);
  const discarded=repository.discard(record.id,record.revision);
  expect(repository.list(base.id)).toEqual([]);expect(repository.get(discarded.id).originalDraft).toBe(record.originalDraft);
});

test("request retries are payload-bound and a second recovery view cannot discard newer work",()=>{
  const{store,repository}=fixture(),base=store.create("Original");
  const input={id:crypto.randomUUID(),blockId:base.id,baseText:base.text,baseRevision:base.revision,prelaunchText:base.text,draftText:"Returned",source:"external-editor" as const};
  const record=repository.start(input);expect(repository.start(input)).toEqual(record);
  expect(()=>repository.start({...input,draftText:"Other"})).toThrow("different writing");
  repository.refresh(record.id,record.revision);
  expect(()=>repository.discard(record.id,record.revision)).toThrow("another view");
});

test("saved history can restore original writing or undo a save without overwriting later edits",()=>{
  const{store,repository}=fixture(),base=store.create("Base");
  const record=repository.start({id:crypto.randomUUID(),blockId:base.id,baseText:base.text,baseRevision:base.revision,prelaunchText:"Prelaunch",draftText:"Original draft",source:"external-editor"});
  const saved=repository.commit(record.id,record.revision,"Reviewed merge",base.revision,mutation);
  const newer=store.update(base.id,"Later writing",saved.revision,mutation);
  expect(repository.list(base.id,true)[0]?.state).toBe("applied");
  const requestId=crypto.randomUUID();
  const undo=repository.restore(record.id,requestId,"before-save");
  expect(undo.draftText).toBe("Base");expect(undo.latest.revision).toBe(newer.revision);
  expect(store.get(base.id)?.text).toBe("Later writing");
  const draft=repository.restore(record.id,crypto.randomUUID(),"draft");
  expect(draft.draftText).toBe("Original draft");
  store.update(base.id,"Even later",newer.revision,mutation);
  expect(repository.restore(record.id,requestId,"before-save")).toEqual(undo);
  expect(()=>repository.commit(undo.id,undo.revision,undo.draftText,undo.latest.revision,mutation)).toThrow();
  expect(repository.get(record.id).originalDraft).toBe("Original draft");
});
