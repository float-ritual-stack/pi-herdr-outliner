import assert from "node:assert/strict";
import type { Block } from "../../src/types";
import {runHerdrScenario} from "./herdr-runner";

const result=await runHerdrScenario({
  name:"tree-roots",layout:process.argv.includes("--composed") ? "composed" : "separate",
  async prepare(){},
  async run(session){
    const terminal=await session.attachClient();await terminal.resize(240,65);
    const tree=session.panes.tree;
    const create=(text:string,parentId:string|null=null)=>session.client.request<Block>({action:"create",text,parentId});
    const a=await create("PIE303 Source folder");
    const q=await create("PIE303 Nested query\n[type::virtual-branch] [query::fixture=match] [fixture::query]",a.id);
    const b=await create("PIE303 Projected hub\n[type::virtual-branch] [query::fixture=query]");
    const match=await create("PIE303 Nested result\n[fixture::match]");
    await session.setKeybindings({"tree.root.focus":["Alt+F"],"tree.root.right":["Alt+T"],"tree.root.workspace":["Alt+W"],"tree.root.below":["Alt+Y"]});
    await session.keys(tree,"ctrl+r");
    await session.waitVisible(tree,"Keymap and bars reloaded");
    await session.revealTree(tree,a.id);
    await session.keys(tree,"space");
    await session.revealTree(tree,b.id);await session.keys(tree,"alt+f");
    await session.waitVisible(tree,"PIE303 Projected hub");
    await session.waitVisible(tree,"PIE303 Nested result");
    await session.checkpoint("01-collapsed-source-keeps-nested-query");
    // Focus the nested occurrence, not its canonical source.
    await session.keys(tree,"down","alt+f");
    await session.waitVisible(tree,"PIE303 Nested query");
    await session.keys(tree,"shift+left");
    await session.waitFor("nested root folded",()=>session.visible(tree),text=>!text.includes("PIE303 Nested result"));
    await session.keys(tree,"shift+right");await session.waitVisible(tree,"PIE303 Nested result");
    await session.keys(tree,"alt+left");await session.waitVisible(tree,"PIE303 Projected hub");
    const fresh=await session.client.request<Block>({action:"get",blockId:match.id});
    await session.client.request({action:"update",mutation:{author:"agent",actorId:"PIE303-fixture"},blockId:fresh.id,expectedRevision:fresh.revision,text:fresh.text.replace("Nested result","Refreshed result")});
    await session.waitVisible(tree,"PIE303 Refreshed result");
    await session.checkpoint("02-occurrence-focus-depth-and-refresh");
    const task=await create("Stage card\n[fixture::card] [work-stage::queued]");
    const roots:string[]=[tree];
    const views=[];
    for(const stage of ["queued","doing","done"]){
      const view=await create(`303 ${stage}\n[type::virtual-branch] [query::fixture=card work-stage=${stage}]`);
      views.push(view);
      if(stage === "queued") continue;
      await session.revealTree(tree,view.id);
      const before=new Set((await session.registrations()).map(r=>r.clientId));
      await session.keys(tree,process.argv.includes("--composed") ? "alt+y" : "alt+t");
      const registration=await session.waitFor("new rooted Tree",session.registrations,items=>items.some(r=>r.role === "tree" && !before.has(r.clientId)));
      const added=registration.find(r=>r.role === "tree" && !before.has(r.clientId))!;
      const pane=await session.adoptDetached(added.clientId,"tree");
      await session.waitVisible(pane,`303 ${stage}`);
      roots.push(pane);
    }
    await session.revealTree(tree,views[0]!.id);await session.keys(tree,"alt+f");
    await session.waitVisible(roots[0]!,"Stage card");
    await session.client.request({action:"properties.patch",mutation:{author:"agent",actorId:"PIE303-fixture"},blockId:task.id,expectedRevision:task.revision,operations:[{op:"replace",ordinal:1,value:"doing"}]});
    await session.waitVisible(roots[1]!,"Stage card");
    await session.waitFor("queued Tree updates independently",()=>session.visible(roots[0]!),text=>!text.includes("Stage card"));
    await session.waitVisible(roots[2]!,"303 done");
    await session.checkpoint("03-three-rooted-trees-follow-canonical-change");
    await session.closeDetached(roots[2]!);
    assert.equal((await session.client.request<Block>({action:"get",blockId:task.id})).properties.find(p=>p.key === "work-stage")?.value,"doing");
    await session.waitVisible(roots[1]!,"Stage card");
    await session.closeDetached(roots[1]!);
    const before=new Set((await session.registrations()).map(r=>r.clientId));
    await session.keys(tree,"alt+y");
    const added=await session.waitFor("rooted Tree below",session.registrations,items=>items.some(r=>r.role === "tree" && !before.has(r.clientId)));
    const below=await session.adoptDetached(added.find(r=>r.role === "tree" && !before.has(r.clientId))!.clientId,"tree");
    await session.waitVisible(below,"303 queued");await session.closeDetached(below);
    await session.checkpoint("04-close-view-keeps-data");
    assert.equal((await session.client.request<Block>({action:"get",blockId:q.id})).parentId,a.id);
  },
});
console.log(JSON.stringify(result));if(result.status!=="passed")process.exitCode=1;
