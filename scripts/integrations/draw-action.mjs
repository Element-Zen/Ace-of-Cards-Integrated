import { MODULE_ID } from "../constants.mjs";

export const DRAW_ACTION_REVERSE_ACTION = "ace-draw-action-reverse";

function escape(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

export function cardsDrawnText(count) {
  const value = Math.max(0, Number(count) || 0);
  return `${value} ${value === 1 ? "Card" : "Cards"} Drawn.`;
}

export function buildCardsDrawnLine(count, className = "ace-cards-drawn") {
  const value = Math.max(0, Number(count) || 0);
  if (!value) return "";
  return `<p class="${escape(className)} ace-cards-drawn">${escape(cardsDrawnText(value))}</p>`;
}

export function buildDrawActionChatContent(result = {}) {
  const showReverse = result.reverseOpen !== false;
  const resetLine = result.reset === true
    ? `<p class="ace-draw-action-chat__reset">${escape(result.resetActorName || result.actorName || "Actor")} reset the deck.</p>`
    : "";
  return `<section class="ace-draw-action-chat" data-ace-draw-action>
    ${resetLine}
    ${buildCardsDrawnLine(result.cardsDrawn, "ace-draw-action-chat__count")}
    ${showReverse ? `<section class="ace-draw-action-chat__reverse" style="margin-top: 4px; display: flex; justify-content: space-between;">
      <div>
        <a data-action="${DRAW_ACTION_REVERSE_ACTION}" data-ace-action="reverse-draw-action" data-actor-uuid="${escape(result.actorUuid)}" data-combat-uuid="${escape(result.combatUuid)}" data-scene-uuid="${escape(result.sceneUuid)}" data-tooltip="Reverse Draw">
          <span class='fu-tag button flex-group-center' style="font-size: 1rem;"><i class="icon fas fa-undo"></i></span>
        </a>
      </div>
    </section>` : ""}
  </section>`;
}

export function drawActionRecord(message) {
  return message?.getFlag?.(MODULE_ID, "drawAction")
    ?? message?.flags?.[MODULE_ID]?.drawAction
    ?? null;
}

export function isDrawActionReverted(message) {
  const actions = message?.getFlag?.("projectfu", "RevertedAction")
    ?? message?.flags?.projectfu?.RevertedAction
    ?? [];
  return Array.isArray(actions) && actions.includes(DRAW_ACTION_REVERSE_ACTION);
}

export function applyDrawActionPresentation(message, root) {
  const record = drawActionRecord(message);
  if (!record) return;
  const section = root?.querySelector?.("[data-ace-draw-action]");
  const reverse = section?.querySelector?.(`a[data-action="${DRAW_ACTION_REVERSE_ACTION}"]`);
  if (!section) return;
  if (!reverse) return;
  if (record.reverseOpen === false) {
    reverse.classList.add("action-disabled");
    reverse.removeAttribute("data-ace-action");
    reverse.setAttribute("data-tooltip", "This Draw can no longer be reversed.");
  }
  if (!isDrawActionReverted(message)) return;
  section.classList.add("is-reverted");
  reverse.classList.add("action-disabled");
  reverse.removeAttribute("data-ace-action");
  (root.querySelector?.(".message-content") ?? root)?.classList?.add("strikethrough");
}
