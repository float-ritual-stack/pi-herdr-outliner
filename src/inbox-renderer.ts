import { hyperlink, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { InboxController } from "./inbox-controller";
import type { InboxStatus } from "./inbox-types";
import { outlinerLinkUri } from "./outliner-links";
import { sanitizeDynamicText } from "./terminal";
import { basename } from "node:path";

export function inboxStatusCue(snapshot: InboxStatus | null | undefined, error = ""): string {
  if (error) return "Inbox unavailable";
  if (!snapshot) return "";
  const state = snapshot.state === "unavailable" ? "unavailable" : !snapshot.enabled ? "disabled" : snapshot.state;
  const attention = snapshot.attentionCount;
  return `Inbox ${state}${snapshot.pending ? ` · ${snapshot.pending} pending` : ""}${attention ? ` · ${attention} need attention` : ""}`;
}

function linkedTarget(id: string, text: string): string {
  try { return hyperlink(sanitizeDynamicText(text), outlinerLinkUri("block", id)); }
  catch { return sanitizeDynamicText(text); }
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
  plain(`${result.state.toUpperCase()} · ${result.createdAt.replace("T", " ").slice(0, 19)}`);
  plain(result.sourceTitle);
  lines.push("");
  plain(result.summary);
  if (result.error) { lines.push(""); plain(`Needs attention: ${result.error}`); }
  if (result.state === "held") plain("Reconsider to answer or give direction.");
  lines.push("");
  controller.targets.forEach((target, index) => {
    const marker = index === controller.targetIndex ? "›" : " ";
    lines.push(truncateToWidth(linkedTarget(target.id, `${marker} ${target.label} · ${target.id.slice(0, 8)}`), width));
  });
  const usage = result.usage;
  if (usage) {
    lines.push("");
    plain(`${usage.provider} · ${usage.model}`);
    if (usage.promptRevisions?.length) plain(`Prompts: ${usage.promptRevisions.map(prompt => `${basename(prompt.path)} @ ${prompt.sha256.slice(0, 12)}`).join(" · ")}`);
    plain(`${usage.inputTokens.toLocaleString("en-US")} in / ${usage.outputTokens.toLocaleString("en-US")} out · estimated $${usage.cost.toFixed(4)}`);
    plain(`${usage.jevSuccessfulCalls === undefined ? `Jev ${usage.jevCalls} calls` : `Jev ${usage.jevCalls} attempted / ${usage.jevSuccessfulCalls} successful`} · ${(usage.elapsedMs / 1000).toFixed(1)}s`);
    if (usage.jevWarning) plain(usage.jevWarning);
  }
  return lines;
}

export function renderInboxFrame(controller: InboxController, width: number, height: number, help: string): string[] {
  width = Math.max(1, width);
  height = Math.max(1, height);
  if (width < 20 || height < 12) return Array.from({ length: height }, (_, index) => truncateToWidth(index === 0 ? "Inbox · enlarge terminal" : index === height - 1 ? "Esc close" : "", width));
  const inner = width - 4;
  const body = height - 8;
  const wide = inner >= 86;
  const listWidth = wide ? Math.floor(inner * 0.4) : inner;
  const listHeight = wide ? body : Math.max(2, Math.floor(body * 0.35));
  const detailWidth = wide ? inner - listWidth - 1 : inner;
  const detailHeight = wide ? body : Math.max(1, body - listHeight - 1);
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
    const line = fit(`${selected ? "›" : " "} ${result.state} · ${sanitizeDynamicText(result.sourceTitle)}`, listWidth);
    list.push(selected ? `\x1b[48;5;238m\x1b[1m${line}\x1b[0m` : line);
    list.push(fit(`  \x1b[2m${sanitizeDynamicText(result.summary)}\x1b[0m`, listWidth));
  }
  if (!results.length) list.push(controller.loading ? "Loading results…" : controller.attentionOnly ? "Nothing needs attention" : "No recent results");
  const details = detailLines(controller, detailWidth);
  const maxOffset = Math.max(0, details.length - detailHeight);
  controller.detailOffset = Math.min(controller.detailOffset, maxOffset);
  const detail = details.slice(controller.detailOffset, controller.detailOffset + detailHeight);
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
  const output = [
    ` ┌${"─".repeat(inner)}┐ `,
    bordered(`\x1b[1;36mInbox agent\x1b[0m · ${state}${snapshot ? ` · ${snapshot.pending} pending` : ""}`),
    bordered(sanitizeDynamicText(message)),
    bordered(`\x1b[${attention ? "1;33" : "2"}m${current}\x1b[0m`),
  ];
  for (let row = 0; row < body; row++) {
    output.push(bordered(wide
      ? `${fit(list[row] ?? "", listWidth)}│${fit(detail[row] ?? "", detailWidth)}`
      : row < listHeight ? list[row] ?? "" : row === listHeight ? "─".repeat(inner) : detail[row - listHeight - 1] ?? ""));
  }
  const instructions = sanitizeDynamicText(controller.instructions);
  const before = instructions.slice(0, controller.column);
  const editor = `Direction: ${sliceByColumn(before, Math.max(0, visibleWidth(before) - Math.max(1, inner - 13)), Math.max(1, inner - 13), true)}▏${instructions.slice(controller.column)}`;
  const detailProgress = maxOffset ? ` · detail ${controller.detailOffset + 1}-${Math.min(details.length, controller.detailOffset + detailHeight)}/${details.length}` : "";
  const selection = controller.attentionOnly ? `${controller.index + 1}/${results.length} needing attention` : `Result ${controller.resultsOffset + controller.index + 1} · recent ${recentRange}`;
  const status = controller.notice || (controller.loading ? "Refreshing…" : `${results.length ? selection : "Ready"}${omitted}${detailProgress}`);
  const [mainHelp = "", navigationHelp = ""] = help.split("\n");
  output.push(
    bordered(controller.steering ? editor : sanitizeDynamicText(status)),
    bordered(controller.steering ? sanitizeDynamicText(controller.notice) : `\x1b[2m${navigationHelp}\x1b[0m`),
    bordered(`\x1b[2m${mainHelp}\x1b[0m`),
    ` └${"─".repeat(inner)}┘ `,
  );
  return output;
}
