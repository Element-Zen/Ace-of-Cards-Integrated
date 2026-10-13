import { MODULE_ID } from "../constants.mjs";
import { getProjectFUCheck } from "./projectfu-chat-rules.mjs";
import { buildCardsDrawnLine } from "./draw-action.mjs";

export const MAGIC_CARDS_REVERSE_ACTION = "ace-magic-cards-reverse";

function escape(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

export function buildMagicCardsReverseControl(result = {}) {
  if (!Number.isFinite(Number(result.reverseRevision)) || !result.preZones) return "";
  const disabled = result.reverseOpen === false;
  const disabledClass = disabled ? " action-disabled" : "";
  const aceAction = disabled ? "" : ' data-ace-action="reverse-magic-cards"';
  const tooltip = disabled ? "This Magic Cards result can no longer be reversed." : "Reverse Magic Cards";
  return `<section class="ace-magic-cards-chat__reverse" style="margin-top: 4px; display: flex; justify-content: space-between;">
    <div>
      <a data-action="${MAGIC_CARDS_REVERSE_ACTION}"${aceAction} class="${disabledClass.trim()}" data-actor-uuid="${escape(result.actorUuid)}" data-combat-uuid="${escape(result.combatUuid)}" data-scene-uuid="${escape(result.sceneUuid)}" data-tooltip="${escape(tooltip)}">
        <span class='fu-tag button flex-group-center' style="font-size: 1rem;"><i class="icon fas fa-undo"></i></span>
      </a>
    </div>
  </section>`;
}

export function magicCardsResultRecord(message) {
  return getProjectFUCheck(message)?.additionalData?.[MODULE_ID]?.magicCardsResult ?? null;
}

export function isMagicCardsReverted(message) {
  const actions = message?.getFlag?.("projectfu", "RevertedAction")
    ?? message?.flags?.projectfu?.RevertedAction
    ?? [];
  return Array.isArray(actions) && actions.includes(MAGIC_CARDS_REVERSE_ACTION);
}

function disableMagicCardsActions(section) {
  for (const action of section?.querySelectorAll?.("[data-ace-action]") ?? []) {
    action.classList.add("action-disabled");
    action.removeAttribute("data-ace-action");
  }
}

export function applyMagicCardsReversePresentation(message, root) {
  const section = root?.querySelector?.(".ace-magic-cards-chat");
  const reverse = section?.querySelector?.(`a[data-action="${MAGIC_CARDS_REVERSE_ACTION}"]`);
  if (!section || !reverse) return;
  const result = magicCardsResultRecord(message);
  if (result && !section.querySelector(".ace-cards-drawn") && Number(result.details?.cardsDrawn) > 0) {
    const holder = document.createElement("div");
    holder.innerHTML = buildCardsDrawnLine(result.details.cardsDrawn, "ace-magic-cards-chat__drawn");
    const line = holder.firstElementChild;
    if (line) reverse.closest(".ace-magic-cards-chat__reverse")?.before(line);
  }
  if (result?.reverseOpen === false) {
    reverse.classList.add("action-disabled");
    reverse.removeAttribute("data-ace-action");
    reverse.setAttribute("data-tooltip", "This Magic Cards result can no longer be reversed.");
  }
  if (!isMagicCardsReverted(message)) return;
  section.classList.add("is-reverted");
  disableMagicCardsActions(section);
  (root.querySelector?.(".message-content") ?? root)?.classList?.add("strikethrough");
}
