import {hyperlink,truncateToWidth} from '@earendil-works/pi-tui';
import {completionWindow} from './completion';
import {sanitizeDynamicText} from './terminal';
import type {ReferenceCompletionState} from './reference-completion';

export const COMPLETION_ROWS=8;
/** Shared compact list: canonical choice actions, readable context, bounded geometry. */
export function renderReferenceCompletion(state:ReferenceCompletionState,width:number,height=COMPLETION_ROWS,action='completion.choose',help='↑↓ select · Enter/Tab insert · Esc dismiss'):string[]{
  const fit=(text:string)=>truncateToWidth(sanitizeDynamicText(text),Math.max(1,width),'…');
  if(height<=0)return [];
  if(!state.items.length)return [fit(state.message??'No matches')];
  const showHeader=height>=3,showFooter=height>=2,showContext=height>=6;
  const capacity=Math.max(1,Math.floor((height-Number(showHeader)-Number(showFooter))/(showContext?2:1)));
  const window=completionWindow(state.items.length,state.index,capacity);
  const rows=showHeader?[fit(`References ${state.index+1}/${state.items.length}${state.incompleteness?` · Partial search`:state.truncatedLimit?` · Showing first ${state.truncatedLimit} matches`:''}`)]:[];
  for(let index=window.start;index<window.end;index++){
    const item=state.items[index]!;
    const label=fit(`${index===state.index?'›':' '} ${item.label}`);
    rows.push(`${index===state.index?'\x1b[7m':''}${hyperlink(label,`pi-outliner-action:${action}:${index}:${state.generation??0}`)}\x1b[0m`);
    if(showContext)rows.push(`\x1b[2m${fit(`  ${item.kind??'reference'} · ${item.context||'Select to inspect context'}`)}\x1b[0m`);
  }
  if(showFooter)rows.push(fit(state.message||help));
  return rows.slice(0,Math.max(0,height));
}
