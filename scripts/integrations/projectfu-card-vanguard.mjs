import { DAMAGE_TYPES, MODULE_ID } from "../constants.mjs";

export const CARD_VANGUARD_REVERSE_ACTION = "reverseVanguard";

const EFFECT_UUIDS = Object.freeze({
  air: "Compendium.projectfu.heroic-skills.Item.yiXDxlkj7bhQyRyt",
  earth: "Compendium.projectfu.heroic-skills.Item.WXh8k8YTJeGtdzLg",
  fire: "Compendium.projectfu.heroic-skills.Item.rb2CVOWvXQDOvUVw",
  ice: "Compendium.projectfu.heroic-skills.Item.CeJ6JpsXwWRUDz1k",
});

function escape(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function titleCase(value) {
  const text = String(value ?? "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

export function resolveVanguardDamageType(card, requestedDamageType = "") {
  if (!card) throw new Error("The selected Vanguard card is no longer available.");
  const requested = String(requestedDamageType ?? "").toLowerCase();
  if (card.joker) {
    if (!DAMAGE_TYPES.includes(requested)) throw new Error("Choose the damage type dealt by the triggering source.");
    return requested;
  }
  const elementalSuit = String(card.suit ?? "").toLowerCase();
  if (!DAMAGE_TYPES.includes(elementalSuit)) throw new Error("This Vanguard card does not have a valid elemental suit.");
  return elementalSuit;
}

export function cardVanguardEffectControl(damageType) {
  const type = String(damageType ?? "").toLowerCase();
  const uuid = EFFECT_UUIDS[type];
  if (!uuid) throw new Error("Card Vanguard does not provide an effect for that damage type.");
  return `@EFFECT[${uuid}]{Card Vanguard (${titleCase(type)})}`;
}

export function buildCardVanguardChatContent(result = {}) {
  const card = result.card ?? {};
  const damageType = String(result.damageType ?? "").toLowerCase();
  const resistance = titleCase(damageType);
  return `<section class="ace-card-vanguard-chat">
    <div class="ace-card-vanguard-chat__card"><figure><img src="${escape(card.face)}" alt="${escape(card.label)}" title="${escape(card.label)}"></figure></div>
    <h3>Card Vanguard</h3>
    <p><strong>Revealed:</strong> ${escape(card.label)}</p>
    <p><strong>Effect:</strong> You and every ally you can see gain Resistance to ${escape(damageType)} until the end of the current turn.</p>
    <p><strong>You &amp; Allies Receive:</strong> ${cardVanguardEffectControl(damageType)}</p>
    <section style="margin-top: 4px; display: flex; justify-content: space-between; ">
      <div>
        <a data-action="${CARD_VANGUARD_REVERSE_ACTION}" data-ace-action="reverse-vanguard" data-actor-uuid="${escape(result.actorUuid)}" data-combat-uuid="${escape(result.combatUuid)}" data-scene-uuid="${escape(result.sceneUuid)}" data-tooltip="Reverse Card Vanguard">
          <span class='fu-tag button flex-group-center' style="font-size: 1rem;"><i class="icon fas fa-undo"></i></span>
        </a>
      </div>
    </section>
  </section>`;
}

export function isCardVanguardReverted(message) {
  const actions = message?.getFlag?.("projectfu", "RevertedAction")
    ?? message?.flags?.projectfu?.RevertedAction
    ?? [];
  return Array.isArray(actions) && actions.includes(CARD_VANGUARD_REVERSE_ACTION);
}

export function applyCardVanguardReversePresentation(message, root) {
  const reverse = root?.querySelector?.(`a[data-action="${CARD_VANGUARD_REVERSE_ACTION}"]`);
  if (!reverse) return;
  const migrationClosed = Boolean(message?.flags?.[MODULE_ID]?.migrationClosed);
  if (migrationClosed) {
    reverse.classList.add("action-disabled");
    reverse.removeAttribute("data-ace-action");
    reverse.setAttribute("data-tooltip", "This historical Card Vanguard result was closed during the elemental suit migration.");
    return;
  }
  if (!isCardVanguardReverted(message)) return;
  reverse.classList.add("action-disabled");
  (root.querySelector?.(".message-content") ?? root)?.classList?.add("strikethrough");
}
