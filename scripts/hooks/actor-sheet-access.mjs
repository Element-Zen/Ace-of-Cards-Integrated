import { PROJECTFU_FUIDS } from "../constants.mjs";
import { openActorDeck } from "../api.mjs";
import { projectFUAdapter } from "../integrations/projectfu-adapter.mjs";
import { Log } from "../util/log.mjs";
import { reportDeckLaunchFailure } from "../services/deck-launch-feedback.mjs";
import {
  escapeSelectorValue,
  findProjectFUItemRow,
  findProjectFUNameTarget,
} from "./projectfu-sheet-dom.mjs";

const PILL_CLASS = "ace-of-cards-sheet-pill";
const FEATURE_FUIDS = new Set([PROJECTFU_FUIDS.CLASS, PROJECTFU_FUIDS.MAGIC_CARDS]);
const missingTargetReports = new Set();

function rootElement(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}

function sheetActor(app) {
  const actor = app?.actor ?? app?.document ?? app?.object;
  return actor?.documentName === "Actor" ? actor : null;
}

function reportMissingNameTarget(actor, item) {
  const key = `${actor.uuid}:${item.id}`;
  if (missingTargetReports.has(key)) return;
  missingTargetReports.add(key);
  Log.warn("Skipped Actor-sheet Deck pill because the ProjectFU item-name row did not match the expected structure.", {
    actorUuid: actor.uuid,
    itemId: item.id,
    fuid: item.system?.fuid ?? "",
  });
}

function createPill(actor, item) {
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = PILL_CLASS;
  pill.dataset.aceActorUuid = actor.uuid;
  pill.dataset.aceFeatureFuid = String(item.system?.fuid ?? "");

  const icon = document.createElement("i");
  icon.className = "fa-solid fa-cards";
  icon.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.textContent = game.i18n.localize("ACEOC.Sheet.CardDeck");

  pill.append(icon, label);
  pill.title = game.i18n.format("ACEOC.Sheet.OpenDeckHint", { actor: actor.name });
  pill.setAttribute("aria-label", pill.title);
  pill.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void Promise.resolve().then(() => openActorDeck(actor)).catch((error) => {
      reportDeckLaunchFailure(error, { source: "actor-sheet-pill" });
    });
  });
  return pill;
}

export function injectActorSheetAccess(app, html) {
  const root = rootElement(html);
  const actor = sheetActor(app);
  if (!root || !actor || !projectFUAdapter.active) return;
  if (!projectFUAdapter.canUserViewActor(actor, game.user)) return;

  for (const item of actor.items ?? []) {
    if (!FEATURE_FUIDS.has(String(item.system?.fuid ?? ""))) continue;
    const row = findProjectFUItemRow(root, item.id);
    if (!row) continue;
    if (row.querySelector(`.${PILL_CLASS}[data-ace-actor-uuid="${escapeSelectorValue(actor.uuid)}"]`)) continue;

    const nameTarget = findProjectFUNameTarget(row);
    if (!nameTarget) {
      reportMissingNameTarget(actor, item);
      continue;
    }

    nameTarget.insertAdjacentElement("afterend", createPill(actor, item));
    missingTargetReports.delete(`${actor.uuid}:${item.id}`);
  }
}

export function registerActorSheetAccess() {
  Hooks.on("renderActorSheet", injectActorSheetAccess);
  Hooks.on("renderActorSheetV2", injectActorSheetAccess);
  Hooks.on("renderProjectFUCharacterSheet", injectActorSheetAccess);
}
