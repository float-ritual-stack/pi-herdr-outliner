import {initTheme} from "@earendil-works/pi-coding-agent";
initTheme();
import {expect,test} from "bun:test";
import {EditRecoveryReview,type RecoveryChoice} from "../src/edit-recovery-review";
import type {EditRecovery} from "../src/edit-recovery";
const record:EditRecovery={id:"draft",blockId:"note",revision:1,baseText:"Base",baseRevision:1,prelaunchText:"Before editor",draftText:"Local",originalDraft:"Local",source:"external-editor",latest:{id:"note",revision:2,text:"Latest",properties:[],parentId:null,position:0,author:"user",createdAt:"",updatedAt:""},merge:{text:"Local",conflicts:[],incomplete:false},proposal:{text:"Both",basedOnRevision:2,source:"mechanical",unresolved:[],explanation:"Independent changes"},state:"retained",createdAt:"",updatedAt:""};
test("mouse actions and keyboard choices share review state; Escape retains without saving",async()=>{
  let result:RecoveryChoice|undefined;
  const view=new EditRecoveryReview([record],{refresh:async r=>r,assist:async r=>r,cancel:async()=>{},discard:async r=>({...r,state:"discarded"})},()=>{},choice=>result=choice);
  view.key("3",{name:"3"});expect(view.render(80,20).join("\n")).toContain("Latest");
  await view.action("version.draft");expect(view.render(80,20).join("\n")).toContain("Local");
  view.key("",{name:"escape"});expect(result?.action).toBe("later");expect(result?.record.originalDraft).toBe("Local");
});
test("cancelled model work cannot replace review state when its late result arrives",async()=>{
  const pending=Promise.withResolvers<EditRecovery>();let cancelled=0;
  const view=new EditRecoveryReview([record],{refresh:async r=>r,assist:()=>pending.promise,cancel:async()=>{cancelled++;},discard:async r=>r},()=>{},()=>{});
  const work=view.action("agent");view.key("",{name:"escape"});pending.resolve({...record,proposal:{...record.proposal!,text:"Obsolete"}});await work;
  expect(cancelled).toBe(1);expect(view.record.proposal?.text).toBe("Both");expect(view.render(80,20).join("\n")).toContain("Merge cancelled");
});
test("discard requires confirmation; later returns even at narrow widths",async()=>{
  let discarded=0;let choice:RecoveryChoice|undefined;
  const view=new EditRecoveryReview([record],{refresh:async r=>r,assist:async r=>r,cancel:async()=>{},discard:async r=>{discarded++;return {...r,state:"discarded"};}},()=>{},c=>choice=c);
  await view.action("discard");expect(discarded).toBe(0);view.render(42,16);view.key("",{name:"escape"});expect(choice?.action).toBe("later");
});

test("saved history offers restore and undo as new reviews with no immediate save",async()=>{
  const applied={...record,state:"applied" as const,appliedBlockId:record.blockId};
  let restored="",finished=false;
  const view=new EditRecoveryReview([applied],{refresh:async r=>r,assist:async r=>r,cancel:async()=>{},discard:async r=>r,restore:async(_r,version)=>{restored=version;return {...record,id:"new-review"};}},()=>{},()=>{finished=true;});
  expect(view.render(100,24).join("\n")).toContain("Undo save");
  await view.action("proposal");expect(finished).toBe(false);
  await view.action("undo");expect(restored).toBe("before-save");expect(view.record.id).toBe("new-review");expect(finished).toBe(false);
  expect(view.render(100,24).join("\n")).toContain("Current note unchanged");
});
