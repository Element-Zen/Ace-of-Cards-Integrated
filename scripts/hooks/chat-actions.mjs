import { projectFUAdapter } from "../integrations/projectfu-adapter.mjs";
import { FORBIDDEN_RITE_EXPLANATION, MODULE_ID } from "../constants.mjs";
import { socketService } from "../services/socket-service.mjs";
import { Log } from "../util/log.mjs";

function escape(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function cardLabel(card) {
  if (card?.label) return card.label;
  if (card?.joker) return "Joker";
  const suit = String(card?.suit ?? "");
  return `${suit.charAt(0).toUpperCase() + suit.slice(1)} ${card?.value ?? ""}`.trim();
}

function containingMessageId(button) {
  return String(
    button.dataset.triggerMessageId
      ?? button.closest("[data-message-id]")?.dataset.messageId
      ?? button.closest("li.message")?.dataset.messageId
      ?? "",
  );
}


function actionContext(button) {
  const triggerMessageId = containingMessageId(button);
  const message = game.messages?.get?.(triggerMessageId);
  const flags = message?.flags?.[MODULE_ID] ?? {};
  const magicResult = message?.flags?.projectfu?.Check?.additionalData?.[MODULE_ID]?.magicCardsResult ?? {};
  const vanguard = flags.vanguard ?? {};
  const discardAction = flags.discardAction ?? {};
  const drawAction = flags.drawAction ?? {};
  return {
    combatUuid: String(button.dataset.combatUuid ?? flags.combatUuid ?? magicResult.combatUuid ?? vanguard.combatUuid ?? discardAction.combatUuid ?? drawAction.combatUuid ?? ""),
    sceneUuid: String(button.dataset.sceneUuid ?? flags.sceneUuid ?? magicResult.sceneUuid ?? vanguard.sceneUuid ?? discardAction.sceneUuid ?? drawAction.sceneUuid ?? ""),
  };
}

async function resolveOwnedActor(actorUuid) {
  const actor = await projectFUAdapter.resolveActor(actorUuid);
  if (!actor) throw new Error("Unable to resolve the acting Actor.");
  if (!projectFUAdapter.canUserManageActor(actor, game.user) && !game.user.isGM) throw new Error("You do not own this Actor.");
  return actor;
}

function cardChoiceHtml(cards, { maximum = 1, radio = false, description = "", formClass = "", limitLabel = "" } = {}) {
  const type = radio ? "radio" : "checkbox";
  const classes = ["ace-skill-dialog", "ace-card-choice-dialog", formClass].filter(Boolean).join(" ");
  const guidance = description ? `<p class="ace-skill-dialog__description">${escape(description)}</p>` : "";
  const limit = limitLabel || (radio ? "Choose one" : `Up to ${maximum}`);
  return `<div class="${classes}">
    ${guidance}
    <div class="ace-skill-dialog__limit">${escape(limit)}</div>
    <div class="ace-card-choice-scroll">
      <div class="ace-card-choice-grid">${cards.map((card) => {
        const label = cardLabel(card);
        return `<label class="ace-card-choice-tile" aria-label="${escape(label)}"><input class="ace-card-choice-input" type="${type}" name="cards" value="${escape(card.id)}" aria-label="${escape(label)}"><img src="${escape(card.face)}" alt="" aria-hidden="true"></label>`;
      }).join("")}</div>
    </div>
  </div>`;
}

async function chooseCards(cards, { title, maximum = 1, radio = false, confirm = "Confirm", description = "", formClass = "", limitLabel = "" } = {}) {
  if (!cards.length) throw new Error("No eligible cards are available.");
  return foundry.applications.api.DialogV2.wait({
    window: { title },
    position: { width: 460 },
    content: cardChoiceHtml(cards, { maximum, radio, description, formClass, limitLabel }),
    buttons: [
      { action: "cancel", label: "Cancel", callback: () => null },
      {
        action: "confirm",
        label: confirm,
        default: true,
        callback: (_event, actionButton) => {
          const selected = Array.from(actionButton.form.querySelectorAll('input[name="cards"]:checked')).map((input) => input.value);
          if (!selected.length) throw new Error("Choose at least one card.");
          if (selected.length > maximum) throw new Error(`Choose no more than ${maximum} cards.`);
          return selected;
        },
      },
    ],
  });
}

async function useForbiddenRite(button) {
  const actorUuid = String(button.dataset.actorUuid ?? "");
  await resolveOwnedActor(actorUuid);
  const expectedRevision = Number(button.dataset.expectedRevision);
  const context = actionContext(button);
  const triggerMessageId = containingMessageId(button);
  const options = await socketService.request("hero.getForbiddenRiteOptions", {
    actorUuid,
    expectedRevision,
    triggerMessageId,
    ...context,
  });
  const cardIds = await chooseCards(options, {
    title: "Forbidden Rite",
    maximum: options.length,
    confirm: "Shuffle Selected",
    description: FORBIDDEN_RITE_EXPLANATION,
    formClass: "ace-forbidden-rite-dialog",
    limitLabel: "Choose any number",
  });
  if (cardIds?.length) await socketService.request("hero.forbiddenRiteRecycle", {
    actorUuid,
    expectedRevision,
    triggerMessageId,
    cardIds,
    ...context,
  });
}

async function setResolutionVanguard(button) {
  const actor = await resolveOwnedActor(button.dataset.actorUuid);
  const cardId = String(button.dataset.cardId ?? "");
  const cardLabelText = String(button.dataset.cardLabel ?? cardId);
  const section = button.closest(".ace-magic-cards-chat");
  const currentCardId = String(section?.dataset?.vanguardCardId ?? "");
  const currentLabel = section?.querySelector("figure.is-vanguard img")?.title ?? "the current Vanguard card";
  const prompt = currentCardId
    ? `Move Vanguard from <strong>${escape(currentLabel)}</strong> to <strong>${escape(cardLabelText)}</strong>?`
    : `Set <strong>${escape(cardLabelText)}</strong> as the Vanguard card for this resolved Magic Cards play?`;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: currentCardId ? "Change Card Vanguard" : "Set Card Vanguard" },
    content: `<p>${prompt}</p><p>This changes only the stored card choice and rerenders the original result. It does not resolve Magic Cards again.</p>`,
    defaultYes: false,
  });
  if (!confirmed) return;
  const result = await socketService.request("hero.reassignResolutionVanguard", {
    actorUuid: actor.uuid,
    triggerMessageId: containingMessageId(button),
    cardId,
    ...actionContext(button),
  });
  if (result?.actionNotice) ui.notifications.warn(result.actionNotice);
}

async function reverseCardVanguard(button) {
  const actor = await resolveOwnedActor(button.dataset.actorUuid);
  await socketService.request("hero.reverseVanguard", {
    actorUuid: actor.uuid,
    triggerMessageId: containingMessageId(button),
    ...actionContext(button),
  });
}

async function reverseDiscardAction(button) {
  const actor = await resolveOwnedActor(button.dataset.actorUuid);
  await socketService.request("skill.reverseDiscardAction", {
    actorUuid: actor.uuid,
    triggerMessageId: containingMessageId(button),
    ...actionContext(button),
  });
}

async function reverseDrawAction(button) {
  const actor = await resolveOwnedActor(button.dataset.actorUuid);
  await socketService.request("play.reverseDraw", {
    actorUuid: actor.uuid,
    triggerMessageId: containingMessageId(button),
    ...actionContext(button),
  });
}

async function reverseMagicCards(button) {
  const actor = await resolveOwnedActor(button.dataset.actorUuid);
  await socketService.request("play.reverseMagicCards", {
    actorUuid: actor.uuid,
    triggerMessageId: containingMessageId(button),
    ...actionContext(button),
  });
}

async function runAction(button) {
  switch (button.dataset.aceAction) {
    case "forbidden-rite": return useForbiddenRite(button);
    case "set-resolution-vanguard": return setResolutionVanguard(button);
    case "reverse-vanguard": return reverseCardVanguard(button);
    case "reverse-discard-action": return reverseDiscardAction(button);
    case "reverse-draw-action": return reverseDrawAction(button);
    case "reverse-magic-cards": return reverseMagicCards(button);
    default: return undefined;
  }
}

export function registerAceChatActions() {
  Hooks.on("renderChatMessageHTML", (_message, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || root.dataset.aceActionDelegation === "true") return;
    root.dataset.aceActionDelegation = "true";
    root.addEventListener("click", async (event) => {
      const button = event.target.closest?.("[data-ace-action]");
      if (!button || !root.contains(button) || button.classList.contains("action-disabled")) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        button.disabled = true;
        await runAction(button);
      } catch (error) {
        Log.error("Ace chat action failed.", error);
        ui.notifications.error(error.message);
      } finally {
        button.disabled = false;
      }
    });
  });
}
