import { parsePropertyRecords } from "./properties";
import { isPropertyKey, propertyTokenPattern } from "./property-grammar";

/**
 * Extension records: a remote record (a Jira ticket first) kept as real blocks.
 *
 * The test for this module is "as if the person had copied the ticket into the
 * outline and mapped its fields to properties themselves". A record is an
 * ordinary child block of the block that asked for it (the ticket page, or a
 * block with a `jira::` line): its title is the subject line, its fields are
 * namespaced block properties (`[jira.status::In Review]`) and its description
 * is the body. `--comments` adds one child block per comment. Views, queries,
 * backlinks, comments, embeds and the publisher treat them like any block.
 *
 * What differs is ownership. The service records which blocks an extension
 * owns (`extension_records` in the store) and refuses a write to them from
 * anyone but that extension, so a refresh never overwrites what a person typed:
 * their own notes and `[status::]` live on the parent block. Every write the
 * extension makes is attributed `author: agent`, `actorId: ext:<id>`.
 *
 * This file is pure: what the blocks say and what a refusal says. The store
 * owns the table and the guard; `extension-sync.ts` decides when to write.
 */

/** Why a block is owned, and by what. */
export interface ExtensionRecordOwner {
  /** The extension and the property namespace it writes (`jira` → `jira.status`). */
  readonly extensionId: string;
  /** How readers name it: "Jira". */
  readonly label: string;
  /** `record`: the ticket; `comment`: one of its comments. */
  readonly role: "record" | "comment";
  /** The ticket key, or the comment's provider id. */
  readonly itemKey: string;
}

export interface ExtensionRecordField {
  /** The field without the namespace: `status`, `assignee`, `label`. */
  readonly key: string;
  /** A list becomes one property per value (`[jira.label::a] [jira.label::b]`). */
  readonly value: string | readonly string[] | null;
}

export interface ExtensionRecordComment {
  readonly id: string;
  readonly author: string;
  readonly createdAt: string;
  readonly body: string;
}

/** What an extension's `read` returns for a record, beside the Resource document. */
export interface ExtensionRecordData {
  readonly title: string;
  readonly fields: readonly ExtensionRecordField[];
  /** Markdown. */
  readonly body: string;
  /** The latest comments the provider returned, oldest first. Absent when it returned none. */
  readonly comments?: readonly ExtensionRecordComment[];
}

/** The actor every extension write carries. */
export function extensionActorId(extensionId: string): string {
  return `ext:${extensionId}`;
}

export function isExtensionActor(actorId: string | undefined | null): boolean {
  return typeof actorId === "string" && actorId.startsWith("ext:");
}

const MAX_VALUE_UNITS = 200;
const MAX_TITLE_UNITS = 300;
const FIELD_KEY = /^[a-z][a-z0-9_-]*$/;

/** A property value: one line, no `]`, bounded. Empty means "leave the property out". */
function propertyValue(value: string): string {
  const single = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replaceAll("]", ")").replace(/\s+/g, " ").trim();
  return single.length > MAX_VALUE_UNITS ? `${single.slice(0, MAX_VALUE_UNITS - 1)}…` : single;
}

/** Text that must stay text: a `[key::value]` in a title or body is escaped, not a property. */
function escapeTokens(text: string): string {
  return text.replace(propertyTokenPattern(), (token, _key, _value, offset: number, whole: string) =>
    offset > 0 && whole[offset - 1] === "\\" ? token : `\\${token}`);
}

/**
 * A line that starts `key::` in a body would be a line property (and `jira::`
 * a provider line that asks for another ticket). A zero-width joiner after the
 * key keeps the words and drops the meaning.
 */
function inertLines(text: string): string {
  return text.replace(/^([ \t]*(?:[-*+][ \t]+)?[A-Za-z][A-Za-z0-9_.-]*)::/gm, "$1:‍:");
}

function title(text: string): string {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() || "(untitled)";
  const bounded = line.length > MAX_TITLE_UNITS ? `${line.slice(0, MAX_TITLE_UNITS - 1)}…` : line;
  // A subject that starts like a heading, list item or property line would read as one.
  return escapeTokens(bounded.replace(/^([#>*+-]|\d+\.)/, "\\$1"));
}

function body(text: string): string {
  return inertLines(escapeTokens(text.replace(/\r\n?/g, "\n"))).trim();
}

function propertyLine(namespace: string, fields: readonly ExtensionRecordField[]): string {
  const tokens: string[] = [];
  for (const field of fields) {
    if (!FIELD_KEY.test(field.key)) continue;
    const key = `${namespace}.${field.key}`;
    if (!isPropertyKey(key)) continue;
    const values = field.value === null ? [] : typeof field.value === "string" ? [field.value] : field.value;
    for (const value of values) {
      const normalized = propertyValue(value);
      if (normalized) tokens.push(`[${key}::${normalized}]`);
    }
  }
  return tokens.join(" ");
}

/** The record block's text: title, the namespaced fields, then the body. */
export function recordBlockText(namespace: string, key: string, data: ExtensionRecordData): string {
  const line = propertyLine(namespace, [{ key: "key", value: key }, ...data.fields.filter((field) => field.key !== "key")]);
  const text = body(data.body);
  return `${title(data.title)}\n${line}${text ? `\n\n${text}` : ""}`;
}

/** One comment's block text: who and when, its fields, then what they wrote. */
export function commentBlockText(namespace: string, comment: ExtensionRecordComment): string {
  const when = Number.isFinite(Date.parse(comment.createdAt))
    ? new Date(comment.createdAt).toISOString().slice(0, 16).replace("T", " ")
    : comment.createdAt;
  const line = propertyLine(namespace, [
    { key: "comment", value: comment.id },
    { key: "author", value: comment.author },
    { key: "created", value: comment.createdAt },
  ]);
  const text = body(comment.body);
  return `${title(`${comment.author} · ${when}`)}\n${line}${text ? `\n\n${text}` : ""}`;
}

function namespacedValues(text: string, namespace: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const record of parsePropertyRecords(text)) {
    if (record.scope !== "block" || !record.key.startsWith(`${namespace}.`)) continue;
    values.set(record.key, [...values.get(record.key) ?? [], record.value]);
  }
  return values;
}

/**
 * What the service says when someone other than the extension writes an owned
 * block. A changed field names itself (`jira.status comes from Jira`); any
 * other change names the body. Both point at the parent block, where the
 * person's own notes and properties live.
 */
export function extensionWriteRefusal(owner: ExtensionRecordOwner, before: string, after: string): string {
  const was = namespacedValues(before, owner.extensionId);
  const now = namespacedValues(after, owner.extensionId);
  const changed = [...new Set([...was.keys(), ...now.keys()])].sort()
    .find((key) => JSON.stringify(was.get(key) ?? []) !== JSON.stringify(now.get(key) ?? []));
  const what = owner.role === "comment" ? "comment" : `${owner.itemKey}`;
  if (changed) {
    const own = changed.slice(owner.extensionId.length + 1);
    return `${changed} comes from ${owner.label}; write your own [${own}::] on the parent block (this ${what} is refreshed from ${owner.label})`;
  }
  return `This ${owner.role === "comment" ? `${owner.label} comment` : `${owner.label} ticket's text`} comes from ${owner.label}; write your own notes on the parent block (${what} is refreshed from ${owner.label})`;
}
