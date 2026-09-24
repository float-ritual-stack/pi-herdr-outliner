import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initTheme} from '@earendil-works/pi-coding-agent';
import {OutlinerStore} from '../src/store';
import {OutlinerServer} from '../src/server';
import {OutlinerClient} from '../src/client';
import {DocumentPreview} from '../src/document-preview';
import {documentPreviewLinks} from '../src/document-preview-renderer';
import {TUI_RESOURCE_PRESENTATION_CONTEXT} from '../src/resource-presentation';

test('Preview activates a file once, follows a page from its Markdown and returns without changing the note',async()=>{
 initTheme(undefined,false);
 const root=mkdtempSync(join(tmpdir(),'local-file-preview-'));
 writeFileSync(join(root,'project.md'),'# Project file\n\nFile body [[Context page]]');
 const store=new OutlinerStore(join(root,'db.sqlite'),{workspaceRoot:root}),server=new OutlinerServer(store,join(root,'rpc.sock'));
 const target=store.create('Context page [page::Context page]\n\nOutline context');
 const note=store.create('Daily note\n\nRead [file::project.md] beside my notes.\n\nAlso [file::missing.md].');
 await server.start();const client=new OutlinerClient(join(root,'rpc.sock')),ready=Promise.withResolvers<void>();
 const watcher=client.watch({client:{clientId:'file-reader',role:'detail',contextId:'file-context',resourcePresentation:TUI_RESOURCE_PRESENTATION_CONTEXT},onConnect:ready.resolve,onEvent(){},onError:ready.reject});
 try{
  await ready.promise;const preview=new DocumentPreview(client,()=>{},'file-reader'),sequence=store.sequence;
  await preview.load({kind:'block',blockId:note.id});expect(store.sequence).toBe(sequence);
  const fileLink=documentPreviewLinks(preview.state!.document,100).find(l=>l.label.includes('project.md'))!;
  expect(fileLink).toBeDefined();await preview.action('preview.link:'+fileLink.uri,async()=>{});
  expect(preview.state?.target.kind).toBe('resource');expect(preview.state?.document.canonicalText).toContain('File body');
  const page=documentPreviewLinks(preview.state!.document,100).find(l=>l.label.includes('Context page'))!;
  expect(page).toBeDefined();await preview.action('preview.link:'+page.uri,async()=>{});
  expect(preview.state?.target).toEqual({kind:'block',blockId:target.id});
  await preview.action('preview.back',async()=>{});expect(preview.state?.document.canonicalText).toContain('File body');
  await preview.action('preview.back',async()=>{});expect(preview.state?.document.canonicalText).toBe(note.text);
  const missing=documentPreviewLinks(preview.state!.document,100).find(l=>l.label.includes('missing.md'))!;
  await preview.action('preview.link:'+missing.uri,async()=>{});
  expect(preview.state?.notice).toMatch(/unavailable|not found|ENOENT|does not exist/i);
  expect(preview.state?.target).toEqual({kind:"block",blockId:note.id});
  expect(store.require(note.id)).toEqual(note);
 }finally{watcher.stop();await server.close();store.close();rmSync(root,{recursive:true,force:true});}
});
