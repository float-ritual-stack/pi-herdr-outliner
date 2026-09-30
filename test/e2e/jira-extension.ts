import assert from "node:assert/strict";
import { cp, mkdir, writeFile, mkdtemp, readFile, chmod } from "node:fs/promises";
import {tmpdir} from "node:os";
import {visibleWidth} from "@earendil-works/pi-tui";
import { dirname, join } from "node:path";
import type {
  InternResourceReceipt,
  ResourceDescription,
} from "../../src/types";
import { runHerdrScenario } from "./herdr-runner";
// A loopback fixture only. LANG is a harmless inherited value used as the synthetic credential.
const previousLang = process.env.LANG;
process.env.LANG = "C.UTF-8";
const targetUrl='https://example.test/browse/DEMO-234?from=DEMO-345#DEMO-456';
const capture=await mkdtemp(join(tmpdir(),'jira-opener-')),opened=join(capture,'opened.txt');
await writeFile(join(capture,'xdg-open'),`#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`);await chmod(join(capture,'xdg-open'),0o700);
const previousPath=process.env.PATH;process.env.PATH=`${capture}:${previousPath}`;
let seenBasic = false;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    seenBasic =
      req.headers.get("authorization") ===
      "Basic " + Buffer.from("fixture@example.test:C.UTF-8").toString("base64");
    if (!seenBasic) return new Response("", { status: 403 });
    return Response.json({
      id: "10001",
      key: "DEMO-123",
      fields: {
        summary: "External Jira installation",
        updated: "2026-09-25T12:00:00Z",
        description: {
          type: "doc",
          version: 1,
          content: [
            {type:"paragraph",content:[{type:"inlineCard",attrs:{url:targetUrl}}]},
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Basic auth and readable issue content through the installed extension.",
                },
              ],
            },
          ],
        },
        status: { name: "Doing" },
        labels: [],
      },
    });
  },
});
const origin = `http://127.0.0.1:${provider.port}`;
try {
  const result = await runHerdrScenario({
    name: "jira-extension",
    async prepare(root) {
      // The contract 2 folder in the service's user extensions folder, as `outliner ext add jira` installs it.
      const configDir = join(dirname(root), "xdg-config/pi-herdr-outliner");
      const extension = join(configDir, "extensions", "jira");
      await mkdir(dirname(extension), { recursive: true });
      await cp(join(import.meta.dir, "../../extensions/jira"), extension, { recursive: true });
      await writeFile(join(extension, "config.json"), JSON.stringify({
        config: { authMode: "basic", email: "fixture@example.test" },
        secrets: { token: { env: "LANG" } },
      }));
    },
    async run(s) {
      const terminal=await s.attachClient();await terminal.resize(300,80);
      await s.waitFor("native dimensions settled",terminal.visible,t=>t.split("\n").length>=79&&Math.max(...t.split("\n").map(visibleWidth))>290);
      await s.client.request({
        action: "resource-sources.create",
        input: {
          name: "Installed Jira",
          provider: "jira",
          boundary: { origin, project: "DEMO" },
        },
      });
      const receipt = await s.client.request<InternResourceReceipt>({
        action: "resources.follow-authored",
        reference: { kind: "jira", key: "DEMO-123" },
      });
      const clients = await s.registrations();
      const detail = clients.find((c) => c.runtime?.paneId === s.panes.detail)!;
      const tree = clients.find((c) => c.runtime?.paneId === s.panes.tree)!;
      await s.client.request({
        action: "navigation.dispatch",
        sourceClientId: tree.clientId,
        destination: { clientId: detail.clientId, region: "detail" },
        intent: "open",
        target: { kind: "resource", resourceId: receipt.resource.id },
      });
      await s.keys(s.panes.detail, "r");
      await s.waitVisible(s.panes.detail, "External Jira installation");
      await s.waitVisible(
        s.panes.detail,
        "Basic auth and readable issue content",
      );
      assert(seenBasic);
      const description = await s.client.request<ResourceDescription>({
        action: "resources.describe",
        target: { kind: "resource", resourceId: receipt.resource.id },
        destinationClientId: detail.clientId,
      });
      assert.equal(
        description.remoteEntity?.externalUrl,
        origin + "/browse/DEMO-123",
      );
      await s.checkpoint("jira-installed-basic");
      const note:any=await s.client.request({action:'create',text:`URL SPAN NOTE\n\n${targetUrl}, DEMO-999.\n\n<${targetUrl}>`});
      let targetPane=s.panes.detail,header='● Current';
      const locate=(frame:string,label:string)=>{
        const lines=frame.split('\n'),h=lines.findIndex(l=>l.includes(header)),row=lines.findIndex((l,i)=>i>h&&l.includes(label));
        if(h<0||row<0)return null;
        const column=visibleWidth(lines[row]!.slice(0,lines[row]!.indexOf(label)));
        return {row,column,relativeRow:row-h,relativeColumn:column-visibleWidth(lines[h]!.slice(0,lines[h]!.indexOf(header)))};
      };
      const point=async(label:string)=>{
        const aligned=await s.waitFor('native/local URL geometry',async()=>({native:locate(await terminal.visible(),label),local:locate(await s.visible(targetPane),label)}),p=>!!p.native&&!!p.local&&p.native.relativeRow===p.local.relativeRow&&p.native.relativeColumn===p.local.relativeColumn);
        return aligned.native!;
      };
      const clickUrl=async()=>{const p=await point(targetUrl);await terminal.write(`\x1b[<0;${p.column+2};${p.row+1}M\x1b[<0;${p.column+2};${p.row+1}m`);};
      const openedUrls=()=>readFile(opened,'utf8').then(t=>t.trim().split('\n')).catch(()=>[] as string[]);
      const copyUrl=async()=>{
        const p=await point(targetUrl),log=join(s.artifactDirectory,'attached-client.ansi'),before=(await readFile(log,'utf8')).length;
        const end=p.column+targetUrl.length+(targetPane===s.panes.tree?1:0);
        await terminal.write(`\x1b[<0;${p.column+1};${p.row+1}M\x1b[<32;${end};${p.row+1}M\x1b[<0;${end};${p.row+1}m`);
        const copied=await s.waitFor('whole URL copied',async()=>[...(await readFile(log,'utf8')).slice(before).matchAll(/\x1b\]52;[^;]*;([A-Za-z0-9+/=]+)/g)].map(m=>Buffer.from(m[1]!,'base64').toString()),a=>a.length>0);
        assert.deepEqual(copied,[targetUrl]);
      };
      // Same native URL interaction for installed Jira smart links and authored URLs.
      await s.focus(s.panes.detail);await clickUrl();await s.waitFor('Jira URL opens intact',openedUrls,a=>a.length===1);assert.deepEqual(await openedUrls(),[targetUrl]);await copyUrl();
      await s.client.request({action:'navigation.dispatch',sourceClientId:tree.clientId,destination:{clientId:detail.clientId,region:'detail'},intent:'open',target:{kind:'block',blockId:note.id}});
      await s.waitVisible(s.panes.detail,'URL SPAN NOTE');await clickUrl();await s.waitFor('authored URL opens intact',openedUrls,a=>a.length===2);await copyUrl();
      await s.keys(s.panes.detail,'escape','tab','enter');await s.waitFor('Detail keyboard follows intact URL',openedUrls,a=>a.length===3);
      const other:any=await s.client.request({action:'create',text:'Other reader\n\nOnly Preview contains the test URL.'});
      await s.client.request({action:'navigation.dispatch',sourceClientId:tree.clientId,destination:{clientId:detail.clientId,region:'detail'},intent:'open',target:{kind:'block',blockId:other.id}});
      await s.waitVisible(s.panes.detail,'Only Preview contains');targetPane=s.panes.tree;header='Preview ·';
      await s.client.request({action:'navigation.link.set',source:{clientId:tree.clientId,region:'tree'},destination:null});
      await s.revealTree(s.panes.tree,note.id);await s.client.request({action:'ui.command.send',command:{targetClientId:tree.clientId,command:'preview',target:{kind:'block',blockId:note.id}}});
      await s.focus(s.panes.tree);await s.waitFor('Tree Preview URL',()=>s.visible(s.panes.tree),t=>t.includes(targetUrl));
      // Tree is leftmost in the native frame, so its URL is the first match.
      await clickUrl();await s.waitFor('Preview pointer follows intact URL',openedUrls,a=>a.length===4);await copyUrl();
      await s.keys(s.panes.tree,'escape','tab','enter');await s.waitFor('Preview keyboard follows intact URL',openedUrls,a=>a.length===5);
      assert.deepEqual(await openedUrls(),Array(5).fill(targetUrl));
      await terminal.resize(110,80);await s.waitFor('narrow reader reflow',()=>s.visible(s.panes.tree),t=>t.includes('DEMO-234')&&Math.max(...t.split('\n').map(visibleWidth))<50);
      await s.keys(s.panes.tree,'enter');await s.waitFor('narrow Preview follows intact URL',openedUrls,a=>a.length===6);
      assert.deepEqual(await openedUrls(),Array(6).fill(targetUrl));
      await s.checkpoint('url-spans-narrow');
      assert.equal((await s.client.request<any>({action:'get',blockId:note.id})).text,note.text);
      await terminal.resize(300,80);

      const remote = await s.openRemoteBrowsingContext({
        detailTransport: "forwarded",
      });
      const remoteDetail = (await s.registrations()).find(
        (c) => c.runtime?.paneId === remote.detail,
      )!;
      await s.client.request({
        action: "navigation.dispatch",
        sourceClientId: tree.clientId,
        destination: { clientId: remoteDetail.clientId, region: "detail" },
        intent: "open",
        target: { kind: "resource", resourceId: receipt.resource.id },
      });
      await s.waitVisible(remote.detail, "External Jira installation");
      await s.checkpoint("jira-forwarded-reader");
    },
  });
  console.log(JSON.stringify(result));
  if (result.status !== "passed") process.exitCode = 1;
} finally {
  provider.stop(true);process.env.PATH=previousPath;
  if (previousLang === undefined) delete process.env.LANG;
  else process.env.LANG = previousLang;
}
