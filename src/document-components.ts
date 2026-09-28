import {closeSync, constants, fstatSync, openSync, readSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {Type} from 'typebox';
import {Parse} from 'typebox/value';
import {sliceDocument, type MappedDocument} from './document-provenance';

const identifier = /^[a-z0-9][a-z0-9.-]{0,99}$/;
const registrySchema = Type.Object({version: Type.Literal(1), renderers: Type.Record(Type.String(), Type.Object({
  manifest: Type.String({minLength: 1}), enabled: Type.Boolean(),
}, {additionalProperties: false}), {maxProperties: 64})}, {additionalProperties: false});
const manifestSchema = Type.Object({
  contract: Type.Literal(1), id: Type.String({pattern: identifier.source}), version: Type.Integer({minimum: 1}),
  renderer: Type.Object({layout: Type.Literal('labelled-values')}, {additionalProperties: false}),
}, {additionalProperties: false});

/** Only bounded local declarative data is loaded while compiling a document.
 * A compiled presentation does no I/O on resize and executes no plugin code. */
function readDefinition(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 32 * 1024) throw new Error('invalid definition');
    const bytes = Buffer.alloc(32 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > 32 * 1024) throw new Error('invalid definition');
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { closeSync(fd); }
}

export type DocumentComponent =
  | {kind: 'labelled-values'; entries: readonly {id: string; label: MappedDocument; value: MappedDocument}[]}
  | {kind: 'unavailable'; reason: string};

type RendererDefinition = {id:string; renderer:{layout:'labelled-values'}} | {kind:'unavailable';reason:string};

/** One document load owns its installation decisions. Reflow, folding and
 * theme changes may recompile layouts, but never reread a resolved renderer.
 * A new source load gets a fresh catalog, including fresh unavailable results. */
export class DocumentRendererCatalog {
  private readonly definitions = new Map<string,RendererDefinition>();
  private readonly registryPath = process.env.OUTLINER_DOCUMENT_RENDERERS ?? join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'pi-herdr-outliner', 'document-renderers.json');

  resolve(name:string):RendererDefinition {
    let definition=this.definitions.get(name);
    if(!definition){definition=this.load(name);this.definitions.set(name,definition);}
    return definition;
  }

  private load(name:string):RendererDefinition {
    let manifest;
    try {
      const registry = Parse(registrySchema, readDefinition(this.registryPath));
      if (!Object.hasOwn(registry.renderers, name)) return {kind: 'unavailable', reason: 'renderer is not installed'};
      const install = registry.renderers[name]!;
      if (!install.enabled) return {kind: 'unavailable', reason: 'renderer is disabled'};
      if (!isAbsolute(install.manifest)) throw new Error('invalid manifest path');
      manifest = Parse(manifestSchema, readDefinition(install.manifest));
    } catch {
      return {kind: 'unavailable', reason: 'renderer installation is unavailable or invalid'};
    }
    return manifest;
  }
}

/** Resolve only a declared component fence. Ordinary fenced code is untouched.
 * Input remains readable canonical text; separators are consumed, not searched
 * after rendering. Source and derived origins pass through unchanged. */
export function documentComponent(language: string, body: MappedDocument, path: string, catalog = new DocumentRendererCatalog()): DocumentComponent | null {
  if (!language.startsWith('component:')) return null;
  const name = language.slice('component:'.length);
  if (!identifier.test(name)) return {kind: 'unavailable', reason: 'invalid renderer name'};
  const manifest = catalog.resolve(name);
  if ('kind' in manifest) return manifest;
  if (Buffer.byteLength(body.text, 'utf8') > 16 * 1024) return {kind: 'unavailable', reason: 'component input exceeds 16 KiB'};
  const entries: {id: string; label: MappedDocument; value: MappedDocument}[] = [];
  let offset = 0;
  for (const line of body.text.split('\n')) {
    if (line.trim()) {
      const match = /^(\s*)(\S(?:.*?\S)?)(\s+::\s+)(\S(?:.*?\S)?)\s*$/.exec(line);
      if (!match || entries.length >= 64) return {kind: 'unavailable', reason: 'expected up to 64 “label :: value” rows'};
      const labelStart = offset + match[1]!.length;
      const valueStart = labelStart + match[2]!.length + match[3]!.length;
      entries.push({id: `${path}/${manifest.id}/row:${entries.length}`,
        label: sliceDocument(body, labelStart, labelStart + match[2]!.length),
        value: sliceDocument(body, valueStart, valueStart + match[4]!.length)});
    }
    offset += line.length + 1;
  }
  return entries.length ? {kind: manifest.renderer.layout, entries}
    : {kind: 'unavailable', reason: 'component has no labelled values'};
}
