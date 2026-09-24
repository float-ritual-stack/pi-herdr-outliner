import {hyperlink,truncateToWidth} from '@earendil-works/pi-tui';
import {completionWindow} from './completion';
import {sanitizeDynamicText} from './terminal';
import type {ReferenceCompletionState} from './reference-completion';

export const COMPLETION_ROWS=8;
/** Shared compact list: canonical choice actions, readable context, bounded geometry. */
export function renderReferenceCompletion(state:ReferenceCompletionState,width:number,height=COMPLETION_ROWS,action='completion.choose'):string[]{
  const fit=(text:string)=>truncateToWidth(sanitizeDynamicText(text),Math.max(1,width),'…');
  const capacity=Math.max(0,Math.floor((height-2)/2));
  const window=completionWindow(state.items.length,state.index,capacity);
  const rows=[fit(state.items.length?`References ${state.index+1}/${state.items.length}${state.truncatedLimit?` · Showing first ${state.truncatedLimit} matches`:''}`:state.message??'No matches')];
  for(let index=window.start;index<window.end;index++){
    const item=state.items[index]!;
    const label=fit(`${index===state.index?'›':' '} ${item.label}`);
    rows.push(`${index===state.index?'\x1b[7m':''}${hyperlink(label,`pi-outliner-action:${action}:${index}:${state.generation??0}`)}\x1b[0m`);
    rows.push(`\x1b[2m${fit(`  ${item.kind??'reference'} · ${item.context||'Select to inspect context'}`)}\x1b[0m`);
  }
  if(height>1)rows.push(fit(state.message||'↑↓ select · Enter/Tab insert · Esc dismiss'));
  return rows.slice(0,Math.max(0,height));
}
