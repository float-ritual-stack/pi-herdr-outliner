import {resourceDocumentObservation} from '../src/document-resources';
import {blockAnnotationRepresentation} from "../src/annotation-representations";
import {captureAnnotationPassage,renderedDocumentAnnotationTarget} from "../src/document-annotation";
import {observeDocument} from "../src/document-provenance";
import {checklistItems} from "../src/checklist-items";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { annotationSourceHash, createAnnotationReferenceContext, createTextQuoteAnchor } from "../src/annotations";
import { OutlinerClient } from "../src/client";
import { OutlinerServer } from "../src/server";
import { OutlinerStore } from "../src/store";
import type { AnnotationBatchReceipt, AnnotationTarget, AnnotationThread, AnnotationReconcileReceipt, Block } from "../src/types";

test("annotation socket requests preserve occurrence scope, provenance and thread state after service restart", async () => {
  const root = mkdtempSync("/tmp/annotation-reference-protocol-");
  const databasePath = join(root, "outliner.sqlite");
  const socketPath = join(root, "outliner.sock");
  writeFileSync(join(root, "same.txt"), "Shared file passage");
  let store = new OutlinerStore(databasePath);
  let server = new OutlinerServer(store, socketPath);
  const client = new OutlinerClient(socketPath);
  try {
    await server.start();
    const host = await client.request<Block>({ action: "create", text: "First [file::same.txt].\nSecond [file::same.txt]." });
    const resource = store.resources.internFilesystem({ path: join(root, "same.txt") }).resource;
    const file = store.resources.describe(resource.id, true).filesystem!;
    const passage: AnnotationTarget = {
      representation: {
        id: `filesystem:${resource.id}:${file.contentHash}`,
        subject: { kind: "resource", resourceId: resource.id },
        sourceSnapshot: { kind: "resource", resourceId: resource.id, sourceSnapshotId: null, revision: file.revision },
        adapter: { id: "filesystem.text", version: 1 }, mediaType: "text/plain",
        contentHash: file.contentHash, capturedAt: file.capturedAt,
      },
      anchor: createTextQuoteAnchor(file.text, 0, file.text.length),
    };
    const contexts = [host.text.indexOf("[file::"), host.text.lastIndexOf("[file::")]
      .map(start => createAnnotationReferenceContext(host, start, start + 16));
    const observedResource=resourceDocumentObservation(store.resources.describe(resource.id,true))!;
    const resourcePassage=captureAnnotationPassage({text:'Shared file passage',origins:[{kind:'source',slices:[{
      document:observedResource,start:0,end:19,
    }]}]});
    const rendered=renderedDocumentAnnotationTarget({subject:{kind:'resource',resourceId:resource.id},
      passage:resourcePassage,snapshotText:'Shared file passage',capturedAt:file.capturedAt,
      readerId:'fixture-reader',renderRevision:1,input:'pointer',projection:'resolved'});
    await expect(client.request({action:'annotations.batch',requestId:'missing-passage',operations:[{
      operationId:'invalid',type:'create',input:{target:{...rendered,passage:undefined},body:'Rejected',source:'user'},
    }]})).rejects.toThrow('Rendered Resource annotations require a captured passage');
    const targets = [...contexts.map(referenceContext => ({ ...passage, referenceContext })), passage, rendered,
      ...contexts.map(referenceContext=>({...rendered,referenceContext}))];
    const created = await client.request<AnnotationBatchReceipt>({ action: "annotations.batch", requestId: "scoped-threads",
      author: "agent", provenance: { actorId: "test-agent", sessionId: "test-session", taskId: "test-task" },
      operations: targets.map((target, index) => ({ operationId: `thread-${index}`, type: "create",
        input: { target, body: `Thread ${index}`, source: "agent" } })),
    });
    const second = created.annotations[1]!;
    await client.request({ action: "annotations.reply", requestId: "second-reply",
      input: { annotationId: second.block.id, body: "Still the second use", source: "user" } });
    await client.request({ action: "annotations.lifecycle", input: { annotationId: second.block.id, lifecycle: "resolved" },
      mutation: { author: "user", actorId: "test-user" } });
    await server.close();
    store.close();
    store = new OutlinerStore(databasePath);
    server = new OutlinerServer(store, socketPath);
    await server.start();
    const threads = await client.request<AnnotationThread[]>({ action: "annotations.list",
      query: { subject: { kind: "resource", resourceId: resource.id }, includeResolved: true } });
    expect(threads).toHaveLength(6);
    for (const [index, record] of created.annotations.entries()) {
      const reopened = threads.find(thread => thread.block.id === record.block.id)!;
      expect(reopened.originalTarget).toEqual(targets[index]!);
      expect(reopened.resolvedTarget).toEqual(targets[index]!);
      expect(reopened.source).toBe("agent");
      expect(reopened.block.author).toBe("agent");
      expect(reopened.block).toMatchObject({ actorId: "test-agent", sessionId: "test-session", taskId: "test-task" });
      expect(reopened.resolutionHistory).toEqual(record.resolutionHistory);
    }
    const reopenedSecond = threads.find(thread => thread.block.id === second.block.id)!;
    expect(reopenedSecond.lifecycle).toBe("resolved");
    expect(reopenedSecond.replies.map(reply => reply.body)).toEqual(["Still the second use"]);
    expect(reopenedSecond.replies[0]!.originalTarget).toEqual(targets[1]!);
    const hostThreads = await client.request<AnnotationThread[]>({ action: "annotations.list",
      query: { subject: { kind: "block", blockId: host.id }, includeResolved: true } });
    expect(hostThreads.map(thread => thread.block.id).sort()).toEqual([...created.annotations.slice(0, 2),...created.annotations.slice(4)].map(record => record.block.id).sort());
    expect((await client.request<Block>({ action: "get", blockId: host.id })).text).toBe(host.text);
    const shifted=await client.request<Block>({action:'update',blockId:host.id,expectedRevision:host.revision,
      text:'New heading\n\n'+host.text,mutation:{author:'user'}});
    const reconciled=await client.request<AnnotationReconcileReceipt>({action:'annotations.reconcile',input:{
      subject:{kind:'block',blockId:host.id},newRepresentation:blockAnnotationRepresentation(shifted),content:shifted.text,
    }});
    const shiftedSecond=reconciled.threads.find(thread=>thread.block.id===created.annotations[5]!.block.id)!;
    expect(shiftedSecond.currentResolution.status).toBe('resolved');
    expect(shiftedSecond.resolvedTarget?.referenceContext?.sourceText).toBe(shifted.text);
    expect(shiftedSecond.resolvedTarget?.referenceContext?.anchor.start).toBe(shifted.text.lastIndexOf('[file::'));
    expect(shiftedSecond.originalTarget).toEqual(targets[5]!);
    const repeated=await client.request<AnnotationReconcileReceipt>({action:'annotations.reconcile',input:{
      subject:{kind:'resource',resourceId:resource.id},newRepresentation:passage.representation,content:file.text,
    }});
    expect(repeated.threads.find(thread=>thread.block.id===shiftedSecond.block.id)!.resolutionHistory)
      .toEqual(shiftedSecond.resolutionHistory);
    const ambiguous=await client.request<Block>({action:'update',blockId:host.id,expectedRevision:shifted.revision,
      text:shifted.text+'\nSecond [file::same.txt].',mutation:{author:'user'}});
    const lost=await client.request<AnnotationReconcileReceipt>({action:'annotations.reconcile',input:{
      subject:{kind:'block',blockId:host.id},newRepresentation:blockAnnotationRepresentation(ambiguous),content:ambiguous.text,
    }});
    const unresolved=lost.threads.find(thread=>thread.block.id===shiftedSecond.block.id)!;
    expect(unresolved.currentResolution.status).toBe('ambiguous');
    expect(unresolved.resolvedTarget).toBeNull();
    expect(unresolved.currentResolution.passageResolution?.fragments[0]?.sources[0]?.status).toBe('resolved');
    // Removing one identical occurrence cannot prove which one survived.
    const restored=await client.request<Block>({action:'update',blockId:host.id,expectedRevision:ambiguous.revision,
      text:shifted.text,mutation:{author:'user'}});
    const stillLost=await client.request<AnnotationReconcileReceipt>({action:'annotations.reconcile',input:{
      subject:{kind:'block',blockId:host.id},newRepresentation:blockAnnotationRepresentation(restored),content:restored.text,
    }});
    expect(stillLost.threads.find(thread=>thread.block.id===shiftedSecond.block.id)!.currentResolution.status).toBe('ambiguous');

  } finally {
    await server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("one rendered comment retains discontiguous sources and repeated occurrences across restart", async () => {
  const root = mkdtempSync("/tmp/annotation-passage-protocol-");
  const databasePath = join(root, "outliner.sqlite");
  const socketPath = join(root, "outliner.sock");
  let store = new OutlinerStore(databasePath);
  let server = new OutlinerServer(store, socketPath);
  const client = new OutlinerClient(socketPath);
  try {
    await server.start();
    const note = await client.request<Block>({action: "create", text: "one **two** | three"});
    const token = `!((${note.id}))`;
    const host = await client.request<Block>({action: "create", text: `Lead ${token} / ${token}`});
    const observed = observeDocument({kind: "block", blockId: note.id}, note.text, note.revision);
    const hostDocument = observeDocument({kind: "block", blockId: host.id}, host.text, host.revision);
    const first = {document: hostDocument, start: 5, end: 5 + token.length};
    const second = {document: hostDocument, start: 8 + token.length, end: host.text.length};
    const passage = captureAnnotationPassage({text: "one two / one two · 2", origins: [
      ...[first, second].map(host => ({kind: "source" as const,
        slices: [{document: observed, start: 0, end: 3}, {document: observed, start: 6, end: 9}],
        occurrence: {host, path: [{token: host, target: note.id}]},
      })),
      {kind: "reference", token: first, destination: note.id},
      {kind: "generated", reason: "table separator"},
      {kind: "derived", resultId: "visible-count", dependencies: [first, second]},
    ]});
    // The capture owns its evidence before the service or composer sees it.
    observed.text = "changed caller object";
    expect(passage.documents.map(document => document.text).sort()).toEqual(["one **two** | three", host.text].sort());
    expect(passage.fragments.filter(fragment => fragment.kind === "source").map(fragment =>
      fragment.slices.map(slice => [slice.anchor.start, slice.anchor.end, slice.anchor.exact]),
    )).toEqual([[[0, 3, "one"], [6, 9, "two"]], [[0, 3, "one"], [6, 9, "two"]]]);
    const observation = {quote: passage.quote, capturedAt: "2026-01-02T03:04:05.000Z", hostBlockId: host.id,
      paneId: "test:pane", contentRevision: 7, contextId: "test-context", detailClientId: "test-reader",
      validation: "detail-pointer" as const, projection: "mixed" as const};
    const target: AnnotationTarget = {
      representation: {id: "rendered-test-frame", subject: {kind: "block", blockId: host.id},
        sourceSnapshot: {kind: "rendered", observation}, adapter: null, mediaType: "text/plain",
        contentHash: annotationSourceHash(passage.quote), capturedAt: observation.capturedAt, observation},
      anchor: {kind: "text-quote", start: null, end: null, exact: passage.quote, prefix: "", suffix: ""},
      passage,
    };
    const receipt = await client.request<AnnotationBatchReceipt>({action: "annotations.create", requestId: "one-passage",
      input: {target, body: "Compare the two occurrences", source: "user"}});
    expect(receipt.annotations).toHaveLength(1);
    const annotationId = receipt.annotations[0]!.block.id;
    expect(receipt.annotations[0]!.currentResolution.passageResolution?.fragments.slice(0, 2).map(fragment =>
      fragment.sources.map(position => position.resolvedTarget?.anchor),
    )).toMatchObject([
      [{start: 0, end: 3, exact: "one"}, {start: 6, end: 9, exact: "two"}],
      [{start: 0, end: 3, exact: "one"}, {start: 6, end: 9, exact: "two"}],
    ]);
    const sourceThreads = await client.request<AnnotationThread[]>({action: "annotations.list",
      query: {subject: {kind: "block", blockId: note.id}, includeResolved: true}});
    expect(sourceThreads.map(thread => thread.block.id)).toEqual([annotationId]);
    const replay = await client.request<AnnotationBatchReceipt>({action: "annotations.create", requestId: "one-passage",
      input: {target, body: "Compare the two occurrences", source: "user"}});
    expect(replay.annotations.map(annotation => annotation.block.id)).toEqual([annotationId]);
    await client.request({action: "annotations.reply", requestId: "passage-reply",
      input: {annotationId, body: "One thread, several source slices", source: "agent"}});
    const updated = await client.request<Block>({action: "update", blockId: note.id, expectedRevision: note.revision,
      text: "New words", mutation: {author: "user"}});
    const reconcile = () => client.request<AnnotationReconcileReceipt>({action: "annotations.reconcile",
      input: {subject: {kind: "block", blockId: note.id}, newRepresentation: blockAnnotationRepresentation(updated)}});
    const changed = await reconcile();
    expect(changed.changed).toBe(true);
    expect(changed.threads[0]!.currentResolution.status).toBe("unresolved");
    expect(changed.threads[0]!.currentResolution.passageResolution?.fragments.slice(0, 2).every(fragment =>
      fragment.sources.every(source => source.resolvedTarget === null))).toBe(true);
    expect(changed.threads[0]!.currentResolution.passageResolution?.fragments[2]?.sources[0]?.status).toBe("resolved");
    expect((await reconcile()).changed).toBe(false);
    await server.close();
    store.close();
    store = new OutlinerStore(databasePath);
    server = new OutlinerServer(store, socketPath);
    await server.start();
    const threads = await client.request<AnnotationThread[]>({action: "annotations.list",
      query: {subject: {kind: "block", blockId: host.id}, includeResolved: true}});
    expect(threads).toHaveLength(1);
    expect(threads[0]!.originalTarget.passage).toEqual(passage);
    expect(threads[0]!.resolutionHistory).toEqual(changed.threads[0]!.resolutionHistory);
    expect(threads[0]!.replies.map(reply => reply.body)).toEqual(["One thread, several source slices"]);
    expect(threads[0]!.replies[0]!.originalTarget.passage).toEqual(passage);
    expect((await client.request<Block>({action: "get", blockId: host.id})).text).toBe(host.text);

    for (const [label, damage, error] of [
      ["hash", (value: any) => {value.passage.documents[0].hash = "incorrect";}, "hash does not match"],
      ["range", (value: any) => {value.passage.fragments[0].slices[0].anchor.start = 1;
        value.passage.fragments[0].slices[0].anchor.end = 4;}, "slice does not match"],
      ["context", (value: any) => {value.passage.fragments[0].slices[0].anchor.suffix = "wrong";}, "slice does not match"],
      ["document", (value: any) => {value.passage.fragments[0].slices[0].document = 50;}, "unknown document"],
      ["quote", (value: any) => {value.passage.quote = "not the selection";}, "quote must match"],
    ] as const) {
      const damaged = structuredClone(target);
      damage(damaged);
      await expect(client.request({action: "annotations.create", requestId: `invalid-${label}`,
        input: {target: damaged, body: "Must not persist", source: "user"}})).rejects.toThrow(error);
    }
    expect((await client.request<AnnotationThread[]>({action: "annotations.list",
      query: {subject: {kind: "block", blockId: host.id}, includeResolved: true}}))).toHaveLength(1);
  } finally {
    await server.close();
    store.close();
    rmSync(root, {recursive: true, force: true});
  }
});


test("stale passage saves use quote matching, never coincidental old offsets", async () => {
  const root = mkdtempSync("/tmp/annotation-passage-stale-");
  const store = new OutlinerStore(join(root, "outliner.sqlite"));
  const server = new OutlinerServer(store, join(root, "outliner.sock"));
  const client = new OutlinerClient(join(root, "outliner.sock"));
  try {
    await server.start();
    for (const [name, latest, draft, expectedStatus, expectedStart, expectedMethod] of [
      ["same bytes", "echo", false, "resolved", 0, "unchanged-representation"],
      ["moved", "prefix echo", false, "resolved", 7, "unique-exact-quote"],
      ["duplicated at old offset", "echo echo", false, "ambiguous", null, "quote-context"],
      ["erased", "", false, "orphaned", null, "local-fuzzy"],
      ["draft", "echo", true, "unsupported", null, "unsaved-observation"],
    ] as const) {
      const block = await client.request<Block>({action: "create", text: "echo"});
      const document = {...observeDocument({kind: "block", blockId: block.id}, block.text, block.revision),
        ...(draft ? {draft: true as const} : {})};
      const passage = captureAnnotationPassage({text: "echo", origins: [{kind: "source", slices: [{document, start: 0, end: 4}]}]});
      const observation = {quote: "echo", capturedAt: "2026-01-02T03:04:05.000Z", hostBlockId: block.id,
        paneId: "test:pane", contentRevision: 1, contextId: "test-context", detailClientId: "test-reader",
        validation: "detail-pointer" as const, projection: "canonical" as const};
      await client.request({action: "update", blockId: block.id, expectedRevision: block.revision,
        text: latest, mutation: {author: "user"}});
      const target: AnnotationTarget = {representation: {id: `frame-${name}`,
        subject: {kind: "block", blockId: block.id}, sourceSnapshot: {kind: "rendered", observation},
        contentHash: annotationSourceHash("echo"), capturedAt: observation.capturedAt, adapter: null, mediaType: "text/plain", observation},
        anchor: {kind: "text-quote", start: null, end: null, exact: "echo", prefix: "", suffix: ""}, passage};
      const receipt = await client.request<AnnotationBatchReceipt>({action: "annotations.create", requestId: name,
        input: {target, body: "Keep the captured observation", source: "user"}});
      const record = receipt.annotations[0]!;
      const location = record.currentResolution.passageResolution?.fragments[0]?.sources[0];
      expect(location?.status).toBe(expectedStatus);
      expect(location?.method.method).toBe(expectedMethod);
      expect(location?.resolvedTarget?.anchor).toEqual(expectedStart === null ? undefined :
        expect.objectContaining({kind: "text-quote", start: expectedStart, end: expectedStart + 4, exact: "echo"}));
      expect(record.originalTarget.passage?.documents[0]?.text).toBe("echo");
      if (expectedStatus === "ambiguous") expect(location?.candidates).toHaveLength(2);
    }
  } finally {
    await server.close();
    store.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test("rendered task comments assign identities atomically and retain ownership after rewording", async () => {
  const root = mkdtempSync("/tmp/annotation-passage-tasks-");
  let store = new OutlinerStore(join(root, "outline.sqlite"));
  let server = new OutlinerServer(store, join(root, "outliner.sock"));
  const client = new OutlinerClient(join(root, "outliner.sock"));
  try {
    await server.start();
    const shared = await client.request<Block>({action:'create',text:'Shared words'});
    const token = `!((${shared.id}))`;
    const repeated = '\n\n'+'same context '.repeat(8)+token+' same context'.repeat(8);
    const note = await client.request<Block>({action:"create", text:"# Plan\n\n- [ ] alpha\n  echo echo\n- [ ] beta"+repeated+repeated});
    const observed = observeDocument({kind:"block",blockId:note.id}, note.text, note.revision);
    const start = note.text.lastIndexOf("echo"), beta = note.text.indexOf("beta");
    const hostToken={document:observed,start:note.text.lastIndexOf(token),end:note.text.lastIndexOf(token)+token.length};
    const passage = captureAnnotationPassage({text:"echo beta Shared words", origins:[{kind:"source", slices:[
      {document:observed,start,end:start+4}, {document:observed,start:beta,end:beta+4},
    ]},{kind:'source',slices:[{document:observeDocument({kind:'block',blockId:shared.id},shared.text,shared.revision),start:0,end:12}],
      occurrence:{host:hostToken,path:[{token:hostToken,target:shared.id}]}}]});
    const observation = {quote:passage.quote,capturedAt:"2026-01-02T03:04:05.000Z",hostBlockId:note.id,
      paneId:"test:pane",contentRevision:1,contextId:"fixture",detailClientId:"reader",validation:"detail-pointer" as const,projection:"canonical" as const};
    const target: AnnotationTarget = {representation:{id:"task-frame",subject:observed.subject,
      sourceSnapshot:{kind:"rendered",observation},contentHash:annotationSourceHash(passage.quote),
      capturedAt:observation.capturedAt,adapter:null,mediaType:"text/plain",observation},
      anchor:{kind:"text-quote",start:null,end:null,exact:passage.quote,prefix:"",suffix:""},passage};
    const request = {action:"annotations.create" as const,requestId:"task-capture",input:{target,body:"Discuss both steps",source:"user" as const}};
    const created = await client.request<AnnotationBatchReceipt>(request);
    const saved = await client.request<Block>({action:"get",blockId:note.id});
    const items = checklistItems(saved.text);
    expect(items.map(item => item.identity)).toEqual(["unique","unique"]);
    expect(saved.revision).toBe(note.revision+1); // One note write, two identity insertions.
    const original = created.annotations[0]!.originalTarget;
    const slices = original.passage!.fragments.flatMap(fragment => fragment.kind === "source" ? fragment.slices : []);
    expect(slices.map(slice => slice.listItemId)).toEqual([...items.map(item => item.itemId),undefined]);
    expect(original.passage!.documents[0]!.text).toBe(note.text);
    const positions = created.annotations[0]!.currentResolution.passageResolution!.fragments[0]!.sources;
    expect(positions[0]!.resolvedTarget?.anchor).toMatchObject({kind:"text-quote",start:saved.text.lastIndexOf("echo"),exact:"echo"});
    expect(positions[1]!.resolvedTarget?.anchor).toMatchObject({kind:"text-quote",start:saved.text.indexOf("beta"),exact:"beta"});
    const occurrence=created.annotations[0]!.currentResolution.passageResolution!.fragments[1]!.occurrence!;
    expect(occurrence.host.status).toBe('resolved');
    expect(occurrence.host.resolvedTarget?.anchor).toMatchObject({start:saved.text.lastIndexOf(token),exact:token});
    expect(occurrence.path[0]!.resolvedTarget?.anchor).toEqual(occurrence.host.resolvedTarget?.anchor);
    expect((await client.request<AnnotationBatchReceipt>(request)).deduplicated).toBe(true);
    expect((await client.request<Block>({action:"get",blockId:note.id})).revision).toBe(saved.revision);
    const updated = await client.request<Block>({action:"update",blockId:note.id,expectedRevision:saved.revision,
      text:saved.text.replace("echo echo", "different wording").replace("beta", "replacement task"),mutation:{author:"user"}});
    await client.request({action:"annotations.reconcile",input:{subject:{kind:"block",blockId:note.id},newRepresentation:blockAnnotationRepresentation(updated)}});
    await server.close(); store.close();
    store = new OutlinerStore(join(root,"outline.sqlite"));
    server = new OutlinerServer(store,join(root,"outliner.sock"));
    await server.start();
    const threads = await client.request<AnnotationThread[]>({action:"annotations.list",query:{subject:{kind:"block",blockId:note.id},includeResolved:true}});
    expect(threads).toHaveLength(1);
    expect(threads[0]!.originalTarget).toEqual(original);
    expect(threads[0]!.currentResolution.passageResolution!.fragments[0]!.sources.map(position => position.resolvedTarget?.anchor))
      .toEqual(items.map(item => ({kind:"list-item",itemId:item.itemId!})));
    // A forged incoming attachment cannot redirect a quote to another task.
    const forged = structuredClone(target);
    const first = forged.passage!.fragments[0]!;
    if (first.kind !== "source") throw Error("Expected source fixture");
    (first.slices[0] as {listItemId?:string}).listItemId = items[1]!.itemId;
    await expect(client.request({...request,requestId:"forged-task",input:{...request.input,target:forged}})).rejects.toThrow(/checklist|item/i);
  } finally {
    await server.close();store.close();rmSync(root,{recursive:true,force:true});
  }
});
