import {concatDocuments, generatedDocument, sliceDocument, type MappedDocument} from "./document-provenance";
import {createHash} from 'node:crypto';
import {marked, type Token} from 'marked';
import {markdownSourceTokens, type MarkdownSourceToken} from './markdown-structure';
import {fragmentAnchors} from './fragments';
import {previewRegionActionUri, type PreviewRegion, type PreviewRegionState} from './detail-preview-regions';
import type {DetailCalloutRegion} from './detail-callouts';

export interface DocumentFold extends PreviewRegion {
  kind: 'document-fold';
  structure: 'heading' | 'list-item';
  headerEndLine: number;
  contentStartLine: number;
}

export const listItemFoldId = (identity: string): string => `fold:explicit:list-item:^${identity}`;

/** Ranges belong to the supplied document occurrence, never to a different embedded note. */
export function documentFolds(source: string, boundaries: readonly {startLine: number; endLine: number}[] = [],
  projectedIdentities: ReadonlyMap<number, string> = new Map()): DocumentFold[] {
  const nodes = markdownSourceTokens(source);
  const lines = source.split(/\r?\n/);
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  const anchors = fragmentAnchors(source);
  // A source edit retires anonymous identities rather than moving a fold onto
  // a similarly named/reordered heading. Resizes do not change this identity.
  const revision = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const folds: DocumentFold[] = [];
  const occurrenceAt = (line: number) => boundaries.filter(range => range.startLine <= line && range.endLine >= line).sort((a,b) => b.startLine - a.startLine)[0];
  const add = (node: MarkdownSourceToken, endLine: number, headerEndLine: number, structure: DocumentFold['structure']) => {
    const containing = occurrenceAt(node.span.startLine);
    if (containing) endLine = Math.min(endLine, containing.endLine);
    const contentStartLine = headerEndLine + 1;
    if (!lines.slice(contentStartLine, endLine + 1).some(line => line.trim())) return;
    const explicit = anchors.find(anchor => anchor.lineIndex >= node.span.startLine && anchor.lineIndex <= headerEndLine);
    const mappedIdentity = structure === 'list-item' ? projectedIdentities.get(node.span.startLine) : undefined;
    const identity = mappedIdentity ? `^${mappedIdentity}` : explicit && anchors.filter(anchor => anchor.id === explicit.id).length === 1 ? `^${explicit.id}` : String(node.span.startLine);
    const id = mappedIdentity ? listItemFoldId(mappedIdentity) : `fold:${identity.startsWith('^') ? 'explicit' : revision}:${structure}:${identity}`;
    folds.push({id, kind: 'document-fold', structure, headerEndLine, contentStartLine,
      sourceSpan: {...node.span, end: lineStarts[endLine + 1] ?? source.length, endLine}, parentId: null, childIds: [], focusable: true,
      disclosure: {defaultExpanded: true, expanded: true}, activation: {type: 'document.disclosure.toggle', regionId: id}});
  };
  const visit = (siblings: MarkdownSourceToken[], boundary: number) => {
    for (const [index, node] of siblings.entries()) {
      if (node.token.type === 'heading') {
        const depth = node.token.depth;
        const occurrence = occurrenceAt(node.span.startLine);
        const next = siblings.slice(index + 1).find(other => other.token.type === 'heading' && other.token.depth <= depth && occurrenceAt(other.span.startLine) === occurrence);
        add(node, next ? next.span.startLine - 1 : boundary, node.span.endLine, 'heading');
      }
      if (node.token.type === 'list_item') {
        const lead = node.children.find(child => child.token.type !== 'space');
        if (lead && lead.token.type !== 'list') add(node, node.span.endLine, lead.span.endLine, 'list-item');
      }
      if (node.children.length) visit(node.children, node.span.endLine);
    }
  };
  visit(nodes, lines.length - 1);
  // A leading heading and its list item often name the very same content.
  // One disclosure owns that extent; different section extents remain separate.
  for (let index = folds.length - 1; index >= 0; index--) {
    const fold = folds[index]!;
    if (fold.structure === 'list-item' && folds.some(other => other.structure === 'heading' &&
      other.sourceSpan!.startLine === fold.sourceSpan!.startLine && other.contentStartLine === fold.contentStartLine &&
      other.sourceSpan!.endLine === fold.sourceSpan!.endLine)) folds.splice(index, 1);
  }
  folds.sort((a, b) => a.sourceSpan!.startLine - b.sourceSpan!.startLine || b.sourceSpan!.endLine - a.sourceSpan!.endLine);
  for (const fold of folds) {
    const parent = folds.filter(other => other !== fold && other.contentStartLine <= fold.sourceSpan!.startLine && other.sourceSpan!.endLine >= fold.sourceSpan!.endLine)
      .sort((a,b) => b.contentStartLine - a.contentStartLine)[0];
    fold.parentId = parent?.id ?? null;
    parent?.childIds.push(fold.id);
  }
  return folds;
}

export interface FoldedDocument {
  text: string;
  document: MappedDocument;
  /** Each source line maps to its visible line, or the disclosure hiding it. */
  lineMap: number[];
  visibleSourceLines: number[];
}

function headingLabel(source: MappedDocument, tokens: Token[], uri: string): MappedDocument {
  const parts: MappedDocument[] = []; let cursor = 0;
  const generated = (text: string) => generatedDocument(text, 'heading disclosure syntax');
  for (const token of tokens) {
    if (!source.text.startsWith(token.raw, cursor)) return source;
    const span = sliceDocument(source, cursor, cursor + token.raw.length); cursor += token.raw.length;
    if (token.type === 'link' || token.type === 'image' || !token.raw.trim()) {parts.push(span); continue;}
    if ('tokens' in token && token.tokens?.some((child: Token) => child.type === 'link')) {
      const size = token.type === 'strong' ? 2 : token.type === 'em' ? 1 : token.type === 'del' ? (token.raw.startsWith('~~') ? 2 : 1) : 0;
      parts.push(sliceDocument(span, 0, size), headingLabel(sliceDocument(span, size, span.text.length - size), token.tokens, uri),
        sliceDocument(span, span.text.length - size));
    } else parts.push(generated('['), span, generated(`](${uri})`));
  }
  return cursor === source.text.length ? concatDocuments(parts) : source;
}

/** Visibility is applied to source lines before Markdown layout and link measurement. */
export function foldDocument(source: MappedDocument, folds: readonly DocumentFold[], state: Readonly<PreviewRegionState>): FoldedDocument {
  const lines = source.text.split(/(?<=\n)/), output: MappedDocument[] = [], lineMap: number[] = [], visibleSourceLines: number[] = [];
  const expanded = (fold: DocumentFold) => state.disclosureOverrides.get(fold.id) ?? true;
  let offset = 0;
  for (let line = 0; line < lines.length; line++) {
    let mapped = sliceDocument(source, offset, offset + lines[line]!.length); offset += lines[line]!.length;
    const hidden = folds.find(fold => !expanded(fold) && line >= fold.contentStartLine && line <= fold.sourceSpan!.endLine);
    if (hidden) {lineMap.push(lineMap[hidden.sourceSpan!.startLine] ?? 0); continue;}
    lineMap.push(output.length); visibleSourceLines.push(line);
    const text = mapped.text;
    const leading = folds.filter(fold => fold.sourceSpan!.startLine === line);
    const heading = folds.find(fold => fold.structure === 'heading' && fold.sourceSpan!.startLine <= line && line <= fold.headerEndLine);
    const controls = generatedDocument(leading.map(fold => {
      const uri = previewRegionActionUri(fold.activation!).replace('//document-toggle/', '//document-control/');
      return `[${expanded(fold) ? '▾' : '▸'} ](${uri})`;
    }).join(''), 'fold disclosure control');
    if (heading) {
      // Preserve list/quote prefixes, closing ATX hashes and Setext underlines.
      // Every line of a multiline heading points to the same disclosure.
      const prefix = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX~!]\][ \t]+)?)?)(.*?)(\r?\n)?$/.exec(text)!;
      const atx = /^(#{1,6}[ \t]+)(.*)$/.exec(prefix[2]!);
      const underline = !atx && line === heading.headerEndLine && /^[ \t]*(?:=+|-+)[ \t]*$/.test(prefix[2]!);
      if (!underline) {
        const body = atx?.[2] ?? prefix[2]!;
        const closing = atx ? /[ \t]+#+[ \t]*$/.exec(body)?.[0] ?? '' : '';
        const start = prefix[1]!.length + (atx?.[1].length ?? 0), end = start + body.length - closing.length;
        const label = sliceDocument(mapped, start, end);
        mapped = concatDocuments([sliceDocument(mapped, 0, start), controls,
          headingLabel(label, marked.Lexer.lexInline(label.text), previewRegionActionUri(heading.activation!)), sliceDocument(mapped, end)]);
      }
    } else if (leading.length) {
      const marker = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX~!]\][ \t]+)?)/.exec(text);
      if (marker) mapped = concatDocuments([sliceDocument(mapped, 0, marker[1]!.length), controls, sliceDocument(mapped, marker[1]!.length)]);
    }
    output.push(mapped);
  }
  const document = concatDocuments(output);
  return {text: document.text, document, lineMap, visibleSourceLines};
}

export function revealFoldedLine(state: PreviewRegionState, folds: readonly (DocumentFold | DetailCalloutRegion)[], line: number): void {
  for (const fold of folds) if (line >= ('contentStartLine' in fold ? fold.contentStartLine : fold.headerLine + 1) && line <= fold.sourceSpan!.endLine) {
    state.disclosureOverrides.set(fold.id, true);
    const live = state.regions.find(region => region.id === fold.id);
    if (live?.disclosure) live.disclosure.expanded = true;
  }
}
