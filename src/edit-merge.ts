import {diffLines} from "diff";
import {parsePropertyRecords} from "./properties";

export interface EditHunk { start: number; end: number; text: string }
export interface EditMerge {
  text: string;
  conflicts: Array<{ local: EditHunk; latest: EditHunk }>;
  incomplete: boolean;
  propertyConflicts?: string[];
}

function changes(base: string, changed: string): EditHunk[] | null {
  const diff = diffLines(base, changed, {timeout: 100, maxEditLength: 20_000});
  if (!diff) return null;
  let offset = 0;
  const result: EditHunk[] = [];
  let pending: EditHunk | undefined;
  for (const part of diff) {
    if (!part.added && !part.removed) {
      if (pending) result.push(pending);
      pending = undefined;
      offset += part.value.length;
    } else {
      pending ??= {start: offset, end: offset, text: ""};
      if (part.removed) { offset += part.value.length; pending.end = offset; }
      else pending.text += part.value;
    }
  }
  if (pending) result.push(pending);
  return result;
}

function overlaps(a: EditHunk, b: EditHunk): boolean {
  // Two insertions at the same boundary have no unambiguous order. An insertion
  // on the edge of a replacement is also left for explicit review.
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

/** Exact text merging only. An overlap preserves the local draft for review. */
export function mergeEdits(base: string, local: string, latest: string): EditMerge {
  if (local === latest || latest === base) return {text: local, conflicts: [], incomplete: false};
  if (local === base) return {text: latest, conflicts: [], incomplete: false};
  const properties=(text:string)=>{
    const values=new Map<string,string[]>();
    for(const record of parsePropertyRecords(text))if(record.scope==="block")values.set(record.key,[...(values.get(record.key)??[]),record.value]);
    return new Map([...values].map(([key,value])=>[key,JSON.stringify(value.sort())]));
  };
  const baseProperties=properties(base),localProperties=properties(local),latestProperties=properties(latest);
  const propertyConflicts=[...new Set([...baseProperties.keys(),...localProperties.keys(),...latestProperties.keys()])].filter(key=>
    localProperties.get(key)!==baseProperties.get(key)&&latestProperties.get(key)!==baseProperties.get(key)&&localProperties.get(key)!==latestProperties.get(key));
  const ours = changes(base, local), theirs = changes(base, latest);
  if (!ours || !theirs) return {text: local, conflicts: [], incomplete: true};
  const conflicts: EditMerge["conflicts"] = [];
  const combined = [...ours];
  for (const other of theirs) {
    if (ours.some(h => h.start === other.start && h.end === other.end && h.text === other.text)) continue;
    for (const h of ours) if (overlaps(h, other)) conflicts.push({local: h, latest: other});
    combined.push(other);
  }
  if (conflicts.length || propertyConflicts.length) return {text: local, conflicts, ...(propertyConflicts.length?{propertyConflicts}:{}), incomplete: false};
  let text = base;
  for (const h of combined.sort((a,b) => b.start - a.start)) text = text.slice(0,h.start) + h.text + text.slice(h.end);
  return {text, conflicts, incomplete: false};
}
