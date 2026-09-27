import {CHECKLIST_MARKS} from "./checklist-items";
import type {ChecklistControl} from "./checklist-controls";
import type {ChecklistStatus, ChecklistUpdateInput, ChecklistUpdateReceipt} from "./types";

export type ChecklistChoice = ChecklistStatus | "copy-link" | "address";
export const CHECKLIST_CHOICES: readonly {id: ChecklistChoice; label: string}[] = [
  {id: "done", label: `${CHECKLIST_MARKS.done} Mark done`},
  {id: "todo", label: `${CHECKLIST_MARKS.todo} Mark to do`},
  {id: "waiting", label: `${CHECKLIST_MARKS.waiting} Mark waiting`},
  {id: "problem", label: `${CHECKLIST_MARKS.problem} Mark problem`},
  {id: "copy-link", label: "Copy step link"},
  {id: "address", label: "Make addressable"},
];

type Update = (blockId: string, input: ChecklistUpdateInput) => Promise<ChecklistUpdateReceipt>;
type Undo = {blockId: string; itemId: string; evidence: string; status: ChecklistStatus};

/** Reader-local command history; canonical content and conflict decisions remain service-owned. */
export class ChecklistSession {
  private history: Undo[] = [];
  constructor(private update: Update) {}

  async choose(control: ChecklistControl, choice: ChecklistChoice): Promise<{receipt: ChecklistUpdateReceipt; link?: string}> {
    if (!CHECKLIST_CHOICES.some(option => option.id === choice)) throw Error("Unknown checklist choice");
    const item = control.item;
    const change: ChecklistUpdateInput["change"] = choice === "address" || choice === "copy-link"
      ? {kind: "ensure-id"} : {kind: "status", status: choice};
    const receipt = await this.update(control.blockId, {
      target: item.itemId ? {itemId: item.itemId} : {start: item.span.start, expectedRevision: control.revision},
      expectedEvidence: item.evidence, change,
    });
    if (change.kind === "status" && item.status !== change.status && receipt.changed) {
      this.history.push({blockId: control.blockId, itemId: receipt.item.itemId!, evidence: receipt.item.evidence, status: item.status});
      if (this.history.length > 50) this.history.shift();
    }
    return {receipt, ...(choice === "copy-link" ? {link: `((${control.blockId}^${receipt.item.itemId}))`} : {})};
  }

  async undo(blockId: string): Promise<ChecklistUpdateReceipt | null> {
    let index = this.history.length - 1;
    while (index >= 0 && this.history[index]!.blockId !== blockId) index--;
    const entry = this.history[index];
    if (!entry) return null;
    const receipt = await this.update(blockId, {target: {itemId: entry.itemId}, expectedEvidence: entry.evidence,
      change: {kind: "status", status: entry.status}});
    this.history.splice(index, 1);
    return receipt;
  }
}
