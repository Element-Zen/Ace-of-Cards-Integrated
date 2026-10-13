import { getCardDefinition } from "../cards/card-catalog.mjs";
import { drawCards } from "../cards/deck-runtime.mjs";
import { exchangeLimit, trapSpellMaximumMp } from "../cards/class-skill-rules.mjs";
import { resolveCardFace } from "../cards/style-registry.mjs";
import { ACTOR_DECK_SCHEMA_VERSION, DECK_STATUS, MODULE_ID, PROJECTFU_FUIDS } from "../constants.mjs";
import {
  DISCARD_ACTION_REVERSE_ACTION,
  discardActionRecord,
  isDiscardActionReverted,
} from "../integrations/projectfu-discard-action.mjs";
import { projectFUAdapter } from "../integrations/projectfu-adapter.mjs";
import { deckPlayService } from "./deck-play-service.mjs";
import { stateCommitService } from "./state-commit-service.mjs";
import { actorDeckStore } from "./actor-deck-store.mjs";
import { transactionService } from "./transaction-service.mjs";

function titleCase(value) {
  const text = String(value ?? "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function discardedCardViews(cardIds, styleId) {
  return cardIds.map((cardId) => {
    const card = getCardDefinition(cardId);
    if (!card) return null;
    const label = card.joker ? "Joker" : `${titleCase(card.suit)} ${card.value}`;
    return { id: cardId, label, face: resolveCardFace(cardId, styleId) };
  }).filter(Boolean);
}


function validateSelectedHandCards(current, payload, maximum) {
  const cardIds = Array.isArray(payload.cardIds) ? payload.cardIds.map(String) : [];
  if (!cardIds.length) throw new Error("Choose at least one card.");
  if (cardIds.length > maximum) throw new Error(`Choose no more than ${maximum} cards.`);
  if (new Set(cardIds).size !== cardIds.length || cardIds.some((id) => !current.zones.hand.includes(id))) {
    throw new Error("Every selected card must be a unique card currently in hand.");
  }
  return cardIds;
}

function exchangeCards(current, cardIds) {
  const zones = foundry.utils.deepClone(current.zones);
  const movements = [];
  for (const cardId of cardIds) {
    const index = zones.hand.indexOf(cardId);
    zones.hand.splice(index, 1);
    zones.discard.push(cardId);
    movements.push({ cardId, from: "hand", to: "discard", faceUp: true });
  }
  const drawn = drawCards(zones, cardIds.length);
  movements.push(...drawn.movements);
  const drawnCount = drawn.movements.filter((movement) => movement.to === "hand").length;
  if (drawnCount !== cardIds.length) throw new Error("The deck could not provide all replacement cards.");
  return { zones: drawn.zones, movements, drawnCount };
}

function nextState(current, zones) {
  return {
    ...foundry.utils.deepClone(current),
    schemaVersion: ACTOR_DECK_SCHEMA_VERSION,
    revision: Number(current.revision) + 1,
    zones,
  };
}

function requireActive(current) {
  if (current.status !== DECK_STATUS.ACTIVE || !current.conflict?.active) throw new Error("This Ace deck has no active conflict.");
}


function requireEncounterMatch(record = {}, payload = {}) {
  const combatUuid = String(record.combatUuid ?? "");
  const sceneUuid = String(record.sceneUuid ?? "");
  if (combatUuid && payload.combatUuid && combatUuid !== String(payload.combatUuid)) throw new Error("This discard result belongs to a different Encounter.");
  if (sceneUuid && payload.sceneUuid && sceneUuid !== String(payload.sceneUuid)) throw new Error("This discard result belongs to a different Scene.");
}

function resolveDiscardActionMessage(messageId, actorUuid) {
  const message = game.messages?.get?.(String(messageId ?? ""));
  if (!message) throw new Error("The discard result is no longer available.");
  const flags = message.flags?.[MODULE_ID] ?? {};
  const record = discardActionRecord(message);
  if (flags.kind !== "discard-action" || !record || String(flags.actorUuid ?? record.actorUuid ?? "") !== String(actorUuid ?? "")) {
    throw new Error("This message is not a Mulligan or Trap Card result for that Actor.");
  }
  if (isDiscardActionReverted(message)) throw new Error("This discard action has already been reversed.");
  return { message, record };
}

async function postDiscardAction(actor, result) {
  const fuid = result.mode === "trap-card" ? PROJECTFU_FUIDS.TRAP_CARD : PROJECTFU_FUIDS.MULLIGAN;
  const item = projectFUAdapter.getItemByFuid(actor, fuid);
  if (!item) throw new Error(`The Actor no longer has ${result.mode === "trap-card" ? "Trap Card" : "Mulligan"}.`);
  await projectFUAdapter.displayItem(actor, item, (check) => {
    check.additionalData ??= {};
    check.additionalData[MODULE_ID] = {
      ...(check.additionalData[MODULE_ID] ?? {}),
      discardActionResult: foundry.utils.deepClone(result),
    };
  });
}

export class ClassSkillService {
  async #discardAction(payload, senderUserId, { mode, fuid }) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!projectFUAdapter.canUserManageActor(actor, requester) && !requester.isGM) throw new Error("You do not own this Actor.");
    const skillLevel = projectFUAdapter.getSkillLevel(actor, fuid);
    if (!skillLevel) throw new Error(`This Actor does not possess ${mode === "trap-card" ? "Trap Card" : "Mulligan"}.`);

    return transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.source;
      requireActive(current);
      if (Number(payload.expectedRevision) !== Number(current.revision)) throw new Error("This Ace deck changed. Refresh and try again.");
      const maximum = exchangeLimit(skillLevel);
      const cardIds = validateSelectedHandCards(current, payload, maximum);
      const preZones = foundry.utils.deepClone(current.zones);
      const exchanged = exchangeCards(current, cardIds);
      const next = nextState(current, exchanged.zones);
      const label = mode === "trap-card" ? "Trap Card" : "Mulligan";
      const maximumSpellMp = mode === "trap-card" ? trapSpellMaximumMp(skillLevel) : 0;
      const event = {
        kind: "play",
        conflictId: current.conflict.id,
        combatUuid: current.conflict.combatUuid,
        sceneUuid: current.conflict.sceneUuid,
        sourceFuid: fuid,
        summary: `${label} discarded and replaced ${cardIds.length} card(s).`,
        public: true,
        cardIds,
        movements: exchanged.movements,
        details: { mode, skillLevel, maximum, cardsDrawn: exchanged.drawnCount },
      };
      const committed = await stateCommitService.commit({ ...tx, current, next, userId: senderUserId, event });
      const result = {
        mode,
        actorUuid: actor.uuid,
        actorName: actor.name,
        expectedRevision: committed.state.revision,
        combatUuid: current.conflict.combatUuid,
        sceneUuid: current.conflict.sceneUuid,
        skillLevel,
        maximum,
        maximumSpellMp,
        count: cardIds.length,
        cardsDrawn: exchanged.drawnCount,
        cardIds,
        cards: discardedCardViews(cardIds, current.configuration.styleId),
        preZones,
      };
      await postDiscardAction(actor, result);
      return deckPlayService.viewState(actor, committed.state, requester);
    }, payload);
  }

  mulligan(payload, senderUserId) {
    return this.#discardAction(payload, senderUserId, { mode: "mulligan", fuid: PROJECTFU_FUIDS.MULLIGAN });
  }

  trapCard(payload, senderUserId) {
    return this.#discardAction(payload, senderUserId, { mode: "trap-card", fuid: PROJECTFU_FUIDS.TRAP_CARD });
  }

  async reverseDiscardAction(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!projectFUAdapter.canUserManageActor(actor, requester) && !requester.isGM) throw new Error("You do not own this Actor.");
    const { message, record } = resolveDiscardActionMessage(payload.triggerMessageId, actor.uuid);
    requireEncounterMatch(record, payload);
    return transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.source;
      requireActive(current);
      if (Number(record.expectedRevision) !== Number(current.revision)) {
        throw new Error("This discard action can only be reversed before the Ace deck changes again.");
      }
      if (!record.preZones || typeof record.preZones !== "object") throw new Error("This discard result does not contain a reversible deck snapshot.");
      const zones = foundry.utils.deepClone(record.preZones);
      const next = nextState(current, zones);
      const event = {
        kind: "discard-action-reverse",
        conflictId: current.conflict.id,
        combatUuid: current.conflict.combatUuid,
        sceneUuid: current.conflict.sceneUuid,
        sourceFuid: record.mode === "trap-card" ? PROJECTFU_FUIDS.TRAP_CARD : PROJECTFU_FUIDS.MULLIGAN,
        summary: `Reversed ${record.mode === "trap-card" ? "Trap Card" : "Mulligan"} and restored the previous card zones.`,
        public: true,
        cardIds: Array.isArray(record.cardIds) ? record.cardIds.map(String) : [],
        movements: [],
        details: { mode: String(record.mode ?? ""), triggerMessageId: message.id },
      };
      const committed = await stateCommitService.commit({ ...tx, current, next, userId: senderUserId, event });
      const reverted = message.getFlag?.("projectfu", "RevertedAction") ?? message.flags?.projectfu?.RevertedAction ?? [];
      await message.setFlag("projectfu", "RevertedAction", Array.from(new Set([...(Array.isArray(reverted) ? reverted : []), DISCARD_ACTION_REVERSE_ACTION])));
      return deckPlayService.viewState(actor, committed.state, requester);
    }, payload);
  }

}

export const classSkillService = new ClassSkillService();
