import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { InboxController } from "./inbox-controller";
import type { InboxStatus } from "./inbox-types";
import { outlinerActionLink } from "./outliner-actions";
import { sanitizeDynamicText } from "./terminal";
import {renderDocumentPreview} from "./document-preview-renderer";
import { basename } from "node:path";

export function inboxStatusCue(snapshot: InboxStatus | null | undefined, error = ""): string {
  if (error) return "Inbox unavailable";
  if (!snapshot) return "";
  const state = snapshot.state === "unavailable" ? "unavailable" : !snapshot.enabled ? "disabled" : snapshot.state;
  const attention = snapshot.attentionCount;
  return `Inbox ${state}${snapshot.pending ? ` · ${snapshot.pending} pending` : ""}${attention ? ` · ${attention} need attention` : ""}`;
}

function detailLines(controller: InboxController, width: number): string[] {
  const result = controller.selected;
  if (!result) return controller.loading
    ? ["Loading results…"]
    : (controller.attentionOnly
      ? ["Nothing needs attention.", "", "Switch to recent results to inspect completed work."]
      : ["No results yet.", "", "Captures are processed here as work finishes.", "Closing this view leaves the agent running."])
    .flatMap(line => wrapTextWithAnsi(line, width));
  const lines: string[] = [];
  const plain = (text: string) => lines.push(...wrapTextWithAnsi(sanitizeDynamicText(text, true), width));
  plain(`${(result.state === "applied" ? result.kind ?? result.state : result.state).toUpperCase()} · ${result.createdAt.replace("T", " ").slice(0, 19)}`);
  plain(result.sourceTitle);
  lines.push("");
  plain(result.summary);
  if(result.attempt){
    plain(`Trigger: ${result.attempt.trigger} · source revision ${result.attempt.sourceRevision}`);
    const prior=result.attempt.prior;
    if(prior)plain(`Prior attempt: ${prior.id} · ${prior.state}${prior.cost===undefined?' · cost not recorded':` · $${prior.cost.toFixed(4)}`}`);
  }
  if(result.failureKind)plain(`Failure: ${result.failureKind}`);
  if (result.error) { lines.push(""); plain(`${result.state === "canceled" ? "Canceled" : "Needs attention"}: ${result.error}`); }
  if (result.state === "held") plain("Reconsider to answer or give direction.");
  lines.push("");
  controller.targets.forEach((target, index) => {
    const marker = index === controller.targetIndex ? "›" : " ";
    const label = `${marker} ${target.label} · ${target.id.slice(0, 8)}`;
    lines.push(truncateToWidth(target.sessionPath ? sanitizeDynamicText(label) : outlinerActionLink(`tree.inbox.open-target:${index}`, label), width));
  });
  const usage = result.usage;
  if (usage?.jevWarning) plain(usage.jevWarning);
  if (usage?.notChecked === undefined) plain("Coverage: not recorded for this attempt");
  else if (usage.notChecked.length) {
    plain("Not checked:");
    for(const omitted of usage.notChecked)plain(`• ${omitted.area}: ${omitted.reason}`);
  }
  lines.push(outlinerActionLink('tree.inbox.preview.technical', controller.technicalDetails ? '▾ Technical details' : '▸ Technical details'));
  if (usage && controller.technicalDetails) {
    if(!result.attempt)plain("Trigger: not recorded for this attempt");
    lines.push("");
    for (const session of usage.piSessions ?? []) {
      plain(`Pi ${session.outcome} · ${session.phase}`);
      if (session.path) plain(`Service session: ${session.path}`);
      if (session.warning) plain(session.warning);
    }
    plain(`${usage.provider} · ${usage.model}`);
    if (usage.promptRevisions?.length) plain(`Prompts: ${usage.promptRevisions.map(prompt => `${basename(prompt.path)} @ ${prompt.sha256.slice(0, 12)}`).join(" · ")}`);
    for(const prompt of usage.promptRevisions??[])if(prompt.packagedSha256&&prompt.packagedSha256!==prompt.sha256){
      plain(`${basename(prompt.path)} differs from packaged ${prompt.packagedSha256.slice(0,12)} · active file retained: ${prompt.path}`);
      for(const line of prompt.packagedDifferences?.added??[])plain(`Packaged only: ${line}`);
      for(const line of prompt.packagedDifferences?.removed??[])plain(`Active only: ${line}`);
      if(prompt.packagedDifferences?.truncated)plain("Comparison truncated: first four differing lines per file, 300 characters each; inspect the files for the full difference");
    }
    plain(`${usage.inputTokens.toLocaleString("en-US")} in / ${usage.outputTokens.toLocaleString("en-US")} out · estimated $${usage.cost.toFixed(4)}`);
    plain(`${usage.jevSuccessfulCalls === undefined ? `Jev ${usage.jevCalls} calls` : `Jev ${usage.jevCalls} attempted / ${usage.jevSuccessfulCalls} successful`} · model work ${(usage.elapsedMs / 1000).toFixed(1)}s`);

  }
  return lines;
}

export function renderInboxFrame(controller: InboxController, width: number, height: number, help: string): string[] {
  controller.previewFrame = undefined;
  controller.sourceFrame = controller.outputFrame = undefined;
  controller.horizontalDivider = controller.verticalDivider = controller.reviewBody = undefined;
  controller.activityRect = undefined;
  width = Math.max(1, width);
  height = Math.max(1, height);
  if (width < 20 || height < 12) return Array.from({ length: height }, (_, index) => truncateToWidth(index === 0 ? "Inbox · enlarge terminal" : index === height - 1 ? "Esc close" : "", width));
  const inner = width - 4;
  const body = height - 9;
  const comparison = inner >= 100 && body >= 22;
  controller.comparison = comparison;
  const topHeight = comparison ? Math.max(7, Math.min(body - 10, Math.floor(body * controller.reviewFraction))) : body;
  const wide = inner >= 86 && body >= 5;
  const compact = !wide && body < 12;
  const compactReader = compact && (controller.reader.state?.focused || controller.previewMode === "activity");
  const listWidth = wide ? Math.floor(inner * 0.4) : inner;
  const listHeight = compact ? (compactReader ? 0 : body) : wide ? topHeight : Math.max(2, Math.floor(body * 0.35));
  const detailWidth = wide ? inner - listWidth - 1 : inner;
  const detailHeight = compact ? body : wide ? topHeight : Math.max(1, body - listHeight - 1);
  const detailRect = {x:wide?2+listWidth+1:2,y:wide||compact?5:5+listHeight+1,width:detailWidth,height:detailHeight};
  const slots = Math.max(1, Math.floor(listHeight / 2));
  const start = Math.max(0, controller.index - slots + 1);
  const fit = (text: string, columns: number) => {
    const clipped = truncateToWidth(text, columns);
    return clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
  };
  const bordered = (text: string) => ` │${fit(text, inner)}│ `;
  const snapshot = controller.snapshot;
  const results = controller.results;
  const state = controller.error ? "unavailable" : !snapshot ? "loading…" : snapshot.state === "unavailable" ? "unavailable" : !snapshot.enabled ? "disabled" : snapshot.state;
  const list: string[] = [];
  for (const [offset, result] of results.slice(start, start + slots).entries()) {
    const selected = start + offset === controller.index;
    const attempt = controller.searching ? ` · ${result.createdAt.replace("T"," ").slice(0,16)} · ${result.id.slice(0,8)}` : "";
    const line = fit(`${selected ? "›" : " "} ${result.state === "applied" ? result.kind ?? result.state : result.state} · ${sanitizeDynamicText(result.sourceTitle)}`, listWidth);
    list.push(outlinerActionLink(`tree.inbox.select:${start+offset}`, selected ? `\x1b[48;5;238m\x1b[1m${line}\x1b[0m` : line));
    list.push(outlinerActionLink(`tree.inbox.select:${start+offset}`,fit(`  \x1b[2m${sanitizeDynamicText(controller.searching ? attempt + " · " + result.summary : result.summary)}\x1b[0m`, listWidth)));
  }
  if (!results.length) list.push(controller.searching ? (controller.searchLoading ? "Searching history…" : "No matching results") : controller.loading ? "Loading results…" : controller.attentionOnly ? "Nothing needs attention" : "No recent results");
  const reading = !comparison && controller.previewMode === 'content' && controller.reader.state;
  const details = reading ? [] : detailLines(controller, detailWidth);
  let previewLines: string[] | undefined;
  controller.previewFrame = undefined;
  if (reading && (!compact || compactReader) && detailHeight >= 4) {
    const role = controller.targets[controller.targetIndex]?.label ?? 'Source';
    const frame = renderDocumentPreview({...reading,title:`${role} · ${controller.reader === controller.sourceReader && controller.sourceVersion === 'before' ? 'before this attempt' : 'current'} · ${reading.title}`}, detailRect,'Alt+P focus · Esc list · drag to copy', controller.reader === controller.sourceReader ? outlinerActionLink('tree.inbox.preview.before','[Before]') + ' ' + outlinerActionLink('tree.inbox.preview.current','[Current]') : undefined);
    previewLines = frame.lines;
    controller.previewFrame = frame;
    if (controller.reader === controller.sourceReader) controller.sourceFrame = frame;
    else controller.outputFrame = frame;
  }
  if (!reading && (!compact || compactReader)) controller.activityRect = detailRect;
  const maxOffset = Math.max(0, details.length - detailHeight);
  controller.detailOffset = Math.min(controller.detailOffset, maxOffset);
  const detail = reading && !previewLines ? ["Preview needs more height · Open in Detail"] : previewLines ?? details.slice(controller.detailOffset, controller.detailOffset + detailHeight);
  const omitted = snapshot?.attentionOnly === controller.attentionOnly && snapshot.resultsOffset === controller.resultsOffset && snapshot.resultsTruncated
    ? controller.attentionOnly ? " · more awaiting attention" : " · older results available"
    : "";
  const recentRange = results.length ? `${controller.resultsOffset + 1}–${controller.resultsOffset + results.length}` : "none";
  const attention = snapshot?.attentionCount ?? 0;
  const collection = controller.attentionOnly ? `Needs attention: ${attention} · Showing ${results.length}${omitted}` : `Recent results: ${recentRange}${omitted} · Needs attention: ${attention}`;
  const current = `${collection}${snapshot?.current ? ` · Current: ${sanitizeDynamicText(snapshot.current.title)}` : ""}`;
  const message = controller.error || (state === "idle" && attention
    ? `${attention} ${attention === 1 ? "item needs" : "items need"} your attention`
    : snapshot?.message || "Loading Inbox status…");

  const tinyTabs = inner < 30;
  const source = outlinerActionLink('tree.inbox.preview.source',tinyTabs?'[S]':'[Source]');
  const versions = outlinerActionLink('tree.inbox.preview.before', controller.sourceVersion === 'before' ? '[Before ●]' : '[Before]') + ' ' + outlinerActionLink('tree.inbox.preview.current', controller.sourceVersion === 'current' ? '[Current ●]' : '[Current]');
  const activity = outlinerActionLink('tree.inbox.preview.activity',tinyTabs?'[A]':'[Activity]');
  const expandedTabs = [source,activity,...controller.targets.flatMap((target,index)=>target.role !== 'output'?[]:[outlinerActionLink(`tree.inbox.preview-target:${index}`,`[${target.label}${controller.previewMode==='content'&&controller.targetIndex===index?' ●':''}]`)])].join(' ');
  const tabs = inner < 65 || visibleWidth(expandedTabs) > inner
    ? source + outlinerActionLink('tree.inbox.preview.next-output',tinyTabs?'[O]':'[Output ›]') + activity
    : expandedTabs;

  const output = [
    ` ┌${"─".repeat(inner)}┐ `,
    bordered(`\x1b[1;36mInbox agent\x1b[0m · ${state}${snapshot ? ` · ${snapshot.pending} pending` : ""}`),
    bordered(outlinerActionLink("tree.inbox.search","[Search /]")+" "+outlinerActionLink("tree.navigation.link", "[Link destination]")+" "+outlinerActionLink("tree.navigation.once", "[Open once]")+" · "+sanitizeDynamicText(message + (reading && controller.selected?.error ? ` · ${controller.selected.error}` : ""))),
    bordered(controller.searching ? outlinerActionLink("tree.inbox.search",fit(`Search: ${sliceByColumn(sanitizeDynamicText(controller.searchQuery),Math.max(0,visibleWidth(controller.searchQuery)-Math.max(1,inner-13)),Math.max(1,inner-13),true)}${controller.searchEditing?"▏":""}`,inner-4))+" "+outlinerActionLink("tree.inbox.search.clear","[×]") : `\x1b[${attention ? "1;33" : "2"}m${current}\x1b[0m`),
    bordered(tabs + (inner >= 80 ? " · " + versions : "") + (compact ? " · Alt+P List/Preview" : "")),
  ];
  for (let row = 0; row < body; row++) {
    output.push(bordered(compact ? (compactReader ? detail[row] ?? "" : list[row] ?? "") : wide
      ? `${fit(list[row] ?? "", listWidth)}│${fit(detail[row] ?? "", detailWidth)}`
      : row < listHeight ? list[row] ?? "" : row === listHeight ? "─".repeat(inner) : detail[row - listHeight - 1] ?? ""));
  }
  const instructions = sanitizeDynamicText(controller.instructions);
  const before = instructions.slice(0, controller.column);
  const editor = `Direction: ${sliceByColumn(before, Math.max(0, visibleWidth(before) - Math.max(1, inner - 13)), Math.max(1, inner - 13), true)}▏${instructions.slice(controller.column)}`;
  const detailProgress = maxOffset ? ` · detail ${controller.detailOffset + 1}-${Math.min(details.length, controller.detailOffset + detailHeight)}/${details.length}` : "";
  const selection = controller.attentionOnly ? `${controller.index + 1}/${results.length} needing attention` : `Result ${controller.resultsOffset + controller.index + 1} · recent ${recentRange}`;
  const searchStatus=controller.searching?controller.searchError||`${results.length} results · ${controller.searchLoading?"searching…":controller.searchRanking?"ranking…":controller.searchResults?.semantic.status==="ranked"?"Jev ranked":"text matches"}${controller.searchResults?.completeness.kind==="truncated"?" · more matches omitted":""}${controller.searchResults?.semantic.message?" · "+controller.searchResults.semantic.message:""}`:"";
  const status = controller.searching ? [controller.notice,searchStatus].filter(Boolean).join(" · ") : controller.notice || (controller.loading ? "Refreshing…" : snapshot?.paused || snapshot?.state === "unavailable" ? message : `${results.length ? selection : "Ready"}${omitted}${detailProgress}`);
  const [mainHelp = "", navigationHelp = ""] = help.split("\n");
  output.push(
    bordered(controller.steering ? editor : sanitizeDynamicText(status)),
    bordered(controller.steering ? sanitizeDynamicText(controller.notice) : `\x1b[2m${navigationHelp}\x1b[0m`),
    bordered(`\x1b[2m${mainHelp}\x1b[0m`),
    ` └${"─".repeat(inner)}┘ `,
  );
  if (comparison) {
    const bottomY = 5 + topHeight + 1;
    const bottomHeight = body - topHeight - 1;
    const hasOutput = !!controller.outputTarget;
    const sourceWidth = hasOutput ? Math.max(24, Math.min(inner - 25, Math.floor(inner * controller.sourceFraction))) : inner;
    controller.reviewBody = {x: 2, y: 5, width: inner, height: body};
    controller.horizontalDivider = {x: 2, y: bottomY - 1, width: inner, height: 1};
    output[bottomY - 1] = bordered(fit('─ drag to resize activity / documents ', inner).replace(/ /g, '─'));
    if (hasOutput) controller.verticalDivider = {x: 2 + sourceWidth, y: bottomY, width: 1, height: bottomHeight};
    const source = controller.sourceReader.state;
    const destination = controller.outputReader.state;
    if (source) controller.sourceFrame = renderDocumentPreview({...source, title: `Source · ${controller.sourceVersion === 'before' ? 'before this attempt' : 'current'} · ${source.title}`}, {x: 2, y: bottomY, width: sourceWidth, height: bottomHeight}, 'Alt+P focus · Esc list · drag to copy', versions);
    if (hasOutput && destination) controller.outputFrame = renderDocumentPreview({...destination, title: `${controller.outputTarget!.label} · current · ${destination.title}`}, {x: 3 + sourceWidth, y: bottomY, width: inner - sourceWidth - 1, height: bottomHeight}, 'Alt+P focus · Esc list · drag to copy');
    for (let row = 0; row < bottomHeight; row++) output[bottomY + row] = bordered(
      fit(controller.sourceFrame?.lines[row] ?? '', sourceWidth) +
      (hasOutput ? '│' + fit(controller.outputFrame?.lines[row] ?? '', inner - sourceWidth - 1) : ''));
    controller.previewFrame = controller.reader === controller.outputReader ? controller.outputFrame : controller.sourceFrame;
  }
  return controller.renderInputs(output);
}
