import { getCardDefinition } from "../cards/card-catalog.mjs";
import { MODULE_ID } from "../constants.mjs";
import { buildCardsDrawnLine } from "./draw-action.mjs";

export const DISCARD_ACTION_REVERSE_ACTION = "ace-discard-action-reverse";

const TRAP_ACTIONS = Object.freeze([
  Object.freeze({ suit: "ice", label: "Attack" }),
  Object.freeze({ suit: "fire", label: "Objective" }),
  Object.freeze({ suit: "earth", label: "Skill" }),
  Object.freeze({ suit: "air", label: "Spell" }),
]);

function escape(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function cardFigures(cards = []) {
  return cards.map((card) => `<figure><img src="${escape(card.face)}" alt="${escape(card.label)}" title="${escape(card.label)}"></figure>`).join("");
}

function cardDefinition(card) {
  return getCardDefinition(String(card?.id ?? "")) ?? card ?? null;
}

export function trapActionTypeLabels(cards = []) {
  const definitions = cards.map(cardDefinition).filter(Boolean);
  if (definitions.some((card) => Boolean(card.joker))) return TRAP_ACTIONS.map(({ label }) => label);
  const suits = new Set(definitions.map((card) => String(card.suit ?? "").toLowerCase()).filter(Boolean));
  return TRAP_ACTIONS.filter(({ suit }) => suits.has(suit)).map(({ label }) => label);
}

function trapCardInformation(result = {}, classPrefix = "ace-discard-action-chat") {
  if (String(result.mode ?? result.kind ?? "") !== "trap-card") return "";
  const actionTypes = trapActionTypeLabels(result.cards);
  const actionLine = actionTypes.length
    ? `<p class="${classPrefix}__action-types">${actionTypes.map(escape).join(" · ")}</p>`
    : "";
  const maximumSpellMp = Number(result.maximumSpellMp ?? 0);
  const spellRule = actionTypes.includes("Spell") && maximumSpellMp > 0
    ? `<p class="${classPrefix}__spell-rule">A Spell action must cost ${maximumSpellMp} MP or less to be used.</p>`
    : "";
  return actionLine || spellRule
    ? `<div class="${classPrefix}__trap-info">${actionLine}${spellRule}</div>`
    : "";
}


export function discardActionLabel(mode) {
  return String(mode ?? "") === "trap-card" ? "Trap Card" : "Mulligan";
}

export function buildDiscardActionChatContent(result = {}) {
  const label = discardActionLabel(result.mode);
  return `<section class="ace-discard-action-chat" data-ace-discard-action>
    <div class="ace-discard-action-chat__cards">${cardFigures(result.cards)}</div>
    <p class="ace-discard-action-chat__status">Discarded.</p>
    ${trapCardInformation(result)}
    ${buildCardsDrawnLine(result.cardsDrawn ?? result.count, "ace-discard-action-chat__drawn")}
    <section style="margin-top: 4px; display: flex; justify-content: space-between; ">
      <div>
        <a data-action="${DISCARD_ACTION_REVERSE_ACTION}" data-ace-action="reverse-discard-action" data-actor-uuid="${escape(result.actorUuid)}" data-combat-uuid="${escape(result.combatUuid)}" data-scene-uuid="${escape(result.sceneUuid)}" data-tooltip="Reverse ${escape(label)}">
          <span class='fu-tag button flex-group-center' style="font-size: 1rem;"><i class="icon fas fa-undo"></i></span>
        </a>
      </div>
    </section>
  </section>`;
}

export function discardActionRecord(message) {
  return message?.getFlag?.(MODULE_ID, "discardAction")
    ?? message?.flags?.[MODULE_ID]?.discardAction
    ?? null;
}

export function isDiscardActionReverted(message) {
  const actions = message?.getFlag?.("projectfu", "RevertedAction")
    ?? message?.flags?.projectfu?.RevertedAction
    ?? [];
  return Array.isArray(actions) && actions.includes(DISCARD_ACTION_REVERSE_ACTION);
}

function refreshLegacyContent(record, root) {
  const existing = root?.querySelector?.("[data-ace-discard-action]");
  if (!existing) return existing;
  const needsRefresh = !existing.querySelector(".ace-cards-drawn")
    || existing.querySelector("h3")
    || existing.querySelector('[data-ace-action="trap-spell"]')
    || existing.textContent?.includes("Drew:");
  if (!needsRefresh) return existing;
  const template = document.createElement("template");
  template.innerHTML = buildDiscardActionChatContent(record).trim();
  const replacement = template.content.firstElementChild;
  if (!replacement) return existing;
  existing.replaceWith(replacement);
  return replacement;
}

export function applyDiscardActionPresentation(message, root) {
  const record = discardActionRecord(message);
  if (!record) return;
  const section = refreshLegacyContent(record, root);
  const reverse = section?.querySelector?.(`a[data-action="${DISCARD_ACTION_REVERSE_ACTION}"]`)
    ?? root?.querySelector?.(`a[data-action="${DISCARD_ACTION_REVERSE_ACTION}"]`);
  if (!reverse) return;
  if (!isDiscardActionReverted(message)) return;
  reverse.classList.add("action-disabled");
  reverse.removeAttribute("data-ace-action");
  (root.querySelector?.(".message-content") ?? root)?.classList?.add("strikethrough");
}
