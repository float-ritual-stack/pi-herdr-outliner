import type {OutlinerActionMenuItem} from "./outliner-actions";
import {CHECKLIST_CHOICES} from "./checklist-session";

export function checklistStatusMenu(): OutlinerActionMenuItem[] {
  return CHECKLIST_CHOICES.map(choice => ({id: choice.id, label: choice.label, description: "", binding: "", group: "Edit"}));
}

export function listItemRemovalMenu(ids: readonly string[]): OutlinerActionMenuItem[] {
  return [
    {id: "keep", label: "Keep editing", description: "Keep the draft open; nothing is saved yet", binding: "", group: "Edit"},
    {id: "remove", label: `Save and remove ${ids.length} item address${ids.length === 1 ? "" : "es"}`,
      description: `${ids.map(id => `^${id}`).join(", ")} · links, embeds and comments may become unresolved`, binding: "", group: "Edit"},
  ];
}
