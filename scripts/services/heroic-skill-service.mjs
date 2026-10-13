import { getCardDefinition } from "../cards/card-catalog.mjs";
import {
  planResolutionVanguardAdjustment,
  reconcileMagicCardsVanguardResult,
  updateMagicCardsVanguardResult,
} from "../cards/vanguard-adjustment.mjs";
import { availableCardIds, drawCards } from "../cards/deck-runtime.mjs";
import { resolveCardFace } from "../cards/style-registry.mjs";
import { ACTOR_DECK_SCHEMA_VERSION, DECK_STATUS, MODULE_ID, PROJECTFU_FUIDS } from "../constants.mjs";
import {
  CARD_VANGUARD_REVERSE_ACTION,
  resolveVanguardDamageType,
} from "../integrations/projectfu-card-vanguard.mjs";
import { projectFUAdapter } from "../integrations/projectfu-adapter.mjs";
import { getProjectFUCheck } from "../integrations/projectfu-chat-rules.mjs";
import {
  deckPlayService,
  isLatestMagicCardsResultMessage,
  restoreMagicCardsResultMessage,
  updateMagicCardsResultMessage,
} from "./deck-play-service.mjs";
import { stateCommitService } from "./state-commit-service.mjs";
import { actorDeckStore } from "./actor-deck-store.mjs";
import { transactionService } from "./transaction-service.mjs";

function escape(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function titleCase(value) {
  const text = String(value ?? "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function activeSource(actor, context = {}) {
  const source = actorDeckStore.get(actor, context);
  if (!source || source.status !== DECK_STATUS.ACTIVE || !source.conflict?.active) {
    throw new Error("This Actor has no active Ace conflict.");
  }
  return source;
}

function validateForbiddenRiteResult(result, current) {
  const effectDetails = result?.details?.effectDetails ?? {};
  if (Number(result?.expectedRevision) !== Number(current.revision)
    || effectDetails.forbiddenRiteRecycleEligible !== true
    || !(effectDetails.forbiddenRiteEligibleCardIds?.length)) {
    throw new Error("Forbidden Rite must be used immediately after Magic Cards discarded a Joker.");
  }
  return {
    eligible: Array.from(new Set(effectDetails.forbiddenRiteEligibleCardIds.map(String))),
  };
}

function resolveMagicCardsMessage(triggerMessageId, actorUuid) {
  const message = game.messages?.get?.(String(triggerMessageId ?? ""));
  if (!message) throw new Error("The Magic Cards result is no longer available.");
  const flags = message.flags?.[MODULE_ID] ?? {};
  if (flags.kind !== "magic-cards" || String(flags.actorUuid ?? "") !== String(actorUuid ?? "")) {
    throw new Error("This action must be used from that Actor's Magic Cards result.");
  }
  return message;
}

function resolveMagicCardsResult(triggerMessageId, actorUuid) {
  const message = resolveMagicCardsMessage(triggerMessageId, actorUuid);
  const check = getProjectFUCheck(message);
  const result = check?.additionalData?.[MODULE_ID]?.magicCardsResult;
  if (!result || String(result.actorUuid ?? "") !== String(actorUuid ?? "")) {
    throw new Error("The structured Magic Cards result is no longer available.");
  }
  return { message, check, result };
}

function requireEncounterMatch(record = {}, payload = {}, label = "This result") {
  const recordCombatUuid = String(record.combatUuid ?? "");
  const recordSceneUuid = String(record.sceneUuid ?? "");
  const requestedCombatUuid = String(payload.combatUuid ?? "");
  const requestedSceneUuid = String(payload.sceneUuid ?? "");
  if (recordCombatUuid && requestedCombatUuid && recordCombatUuid !== requestedCombatUuid) {
    throw new Error(`${label} belongs to a different Encounter.`);
  }
  if (recordSceneUuid && requestedSceneUuid && recordSceneUuid !== requestedSceneUuid) {
    throw new Error(`${label} belongs to a different Scene.`);
  }
}

function cardView(cardId, styleId) {
  const card = getCardDefinition(cardId);
  const label = card?.joker ? "Joker" : `${titleCase(card?.suit)} ${card?.value ?? ""}`.trim();
  return {
    id: String(cardId ?? ""),
    label: label || String(cardId ?? ""),
    suit: card?.suit ?? "joker",
    value: card?.value ?? 0,
    joker: Boolean(card?.joker),
    face: resolveCardFace(cardId, styleId),
  };
}

async function postVanguardAdjustmentDeclaration(actor, sourceMessage, plan, styleId) {
  const selectedLabel = cardView(plan.selectedCardId, styleId)?.label ?? plan.selectedCardId;
  const previousLabel = plan.previousCardId ? (cardView(plan.previousCardId, styleId)?.label ?? plan.previousCardId) : "";
  const sentence = plan.mode === "changed"
    ? `Card Vanguard changed after resolution: <strong>${escape(previousLabel)}</strong> → <strong>${escape(selectedLabel)}</strong>.`
    : `Card Vanguard selected after resolution: <strong>${escape(selectedLabel)}</strong>.`;
  const content = `<section class="ace-vanguard-adjustment-chat"><header><i class="fa-solid fa-shield-halved"></i><strong>Card Vanguard</strong></header><p>${sentence}</p></section>`;
  const data = {
    speaker: foundry.utils.deepClone(sourceMessage.speaker ?? ChatMessage.getSpeaker({ actor })),
    content,
    flags: {
      [MODULE_ID]: {
        kind: "vanguard-adjustment",
        actorUuid: actor.uuid,
        originMessageId: sourceMessage.id,
        combatUuid: String(sourceMessage.flags?.[MODULE_ID]?.combatUuid ?? ""),
        sceneUuid: String(sourceMessage.flags?.[MODULE_ID]?.sceneUuid ?? ""),
        previousVanguardCardId: plan.previousCardId,
        vanguardCardId: plan.selectedCardId,
      },
    },
  };
  if (Array.isArray(sourceMessage.whisper) && sourceMessage.whisper.length) data.whisper = [...sourceMessage.whisper];
  if (sourceMessage.blind) data.blind = true;
  if (sourceMessage.style !== undefined) data.style = sourceMessage.style;
  await ChatMessage.create(data);
}

function resolveVanguardMessage(messageId, actorUuid) {
  const message = game.messages?.get?.(String(messageId ?? ""));
  if (!message) throw new Error("The Card Vanguard result is no longer available.");
  const flags = message.flags?.[MODULE_ID] ?? {};
  const vanguard = flags.vanguard ?? {};
  if (flags.kind !== "card-vanguard" || String(flags.actorUuid ?? "") !== String(actorUuid ?? "")) {
    throw new Error("This message is not a Card Vanguard result for that Actor.");
  }
  if (flags.migrationClosed) {
    throw new Error("This historical Card Vanguard result was closed during the elemental suit migration.");
  }
  const reverted = message.getFlag?.("projectfu", "RevertedAction") ?? message.flags?.projectfu?.RevertedAction ?? [];
  if (Array.isArray(reverted) && reverted.includes(CARD_VANGUARD_REVERSE_ACTION)) {
    throw new Error("This Card Vanguard reveal has already been reversed.");
  }
  return { message, vanguard };
}

async function postVanguardChat(actor, result) {
  const item = projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.CARD_VANGUARD);
  if (!item) throw new Error("The Actor no longer has Card Vanguard.");
  await projectFUAdapter.displayItem(actor, item, (check) => {
    check.additionalData ??= {};
    check.additionalData[MODULE_ID] = {
      ...(check.additionalData[MODULE_ID] ?? {}),
      vanguardResult: foundry.utils.deepClone(result),
    };
  });
}

export class HeroicSkillService {
  async getForbiddenRiteOptions(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!projectFUAdapter.canUserManageActor(actor, requester) && !requester.isGM) throw new Error("You do not own this Actor.");
    if (!projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.FORBIDDEN_RITE)) throw new Error("This Actor does not possess Forbidden Rite.");

    const source = activeSource(actor, payload);
    if (Number(payload.expectedRevision) !== Number(source.revision)) throw new Error("This Ace deck changed. Refresh and try again.");
    const { result } = resolveMagicCardsResult(payload.triggerMessageId, actor.uuid);
    requireEncounterMatch(result, payload, "This Magic Cards result");
    const { eligible } = validateForbiddenRiteResult(result, source);
    return eligible.map((id) => cardView(id, source.configuration.styleId)).filter((card) => card && !card.joker);
  }

  async forbiddenRiteRecycle(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!projectFUAdapter.canUserManageActor(actor, requester) && !requester.isGM) throw new Error("You do not own this Actor.");
    if (!projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.FORBIDDEN_RITE)) throw new Error("This Actor does not possess Forbidden Rite.");
    const { message, check, result } = resolveMagicCardsResult(payload.triggerMessageId, actor.uuid);
    requireEncounterMatch(result, payload, "This Magic Cards result");

    return transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.source;
      if (current.status !== DECK_STATUS.ACTIVE || !current.conflict?.active) throw new Error("This Ace deck has no active conflict.");
      if (Number(payload.expectedRevision) !== Number(current.revision)) throw new Error("This Ace deck changed. Refresh and try again.");
      const { eligible } = validateForbiddenRiteResult(result, current);
      const eligibleSet = new Set(eligible);
      const cardIds = Array.isArray(payload.cardIds) ? payload.cardIds.map(String) : [];
      if (!cardIds.length || new Set(cardIds).size !== cardIds.length) throw new Error("Choose one or more unique non-Joker cards.");
      if (cardIds.some((id) => !eligibleSet.has(id) || getCardDefinition(id)?.joker)) throw new Error("Forbidden Rite may only recycle non-Joker cards that were in the discard pile when it triggered.");
      if (cardIds.some((id) => current.zones.vanguard.includes(id))) throw new Error("A Vanguard card cannot be recycled by Forbidden Rite.");

      const zones = foundry.utils.deepClone(current.zones);
      const movements = [];
      let handReplacements = 0;
      for (const cardId of cardIds) {
        const discardIndex = zones.discard.indexOf(cardId);
        const handIndex = zones.hand.indexOf(cardId);
        if (discardIndex >= 0) {
          zones.discard.splice(discardIndex, 1);
          movements.push({ cardId, from: "discard", to: "deck", faceUp: false });
        } else if (handIndex >= 0) {
          zones.hand.splice(handIndex, 1);
          movements.push({ cardId, from: "hand", to: "deck", faceUp: false });
          handReplacements += 1;
        } else if (!availableCardIds(zones).includes(cardId)) {
          throw new Error("A selected Forbidden Rite card is no longer in a valid zone.");
        }
      }

      if (handReplacements) {
        const replacement = drawCards(zones, handReplacements);
        Object.assign(zones, replacement.zones);
        movements.push(...replacement.movements);
      }

      const next = { ...foundry.utils.deepClone(current), schemaVersion: ACTOR_DECK_SCHEMA_VERSION, revision: Number(current.revision) + 1, zones };
      const event = {
        kind: "play",
        conflictId: current.conflict.id,
        combatUuid: current.conflict.combatUuid,
        sceneUuid: current.conflict.sceneUuid,
        sourceFuid: PROJECTFU_FUIDS.FORBIDDEN_RITE,
        summary: `Forbidden Rite shuffled ${cardIds.length} card(s) into the deck.`,
        public: true,
        cardIds,
        movements,
        details: { recycled: cardIds.length, replacementDraws: handReplacements },
      };
      const committed = await stateCommitService.commit({ ...tx, current, next, userId: senderUserId, event });
      const synchronizedResult = reconcileMagicCardsVanguardResult(result, committed.state.zones, {
        revision: committed.state.revision,
      });
      synchronizedResult.details ??= {};
      synchronizedResult.details.effectDetails ??= {};
      synchronizedResult.details.effectDetails.forbiddenRiteRecycleEligible = false;
      synchronizedResult.details.effectDetails.forbiddenRiteEligibleCardIds = [];
      synchronizedResult.details.effectDetails.forbiddenRiteResolvedCount = cardIds.length;
      synchronizedResult.reverseOpen = false;
      await updateMagicCardsResultMessage(message, check, synchronizedResult, actor);
      return deckPlayService.viewState(actor, committed.state, requester);
    }, payload);
  }

  async reassignResolutionVanguard(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!projectFUAdapter.canUserManageActor(actor, requester) && !requester.isGM) throw new Error("You do not own this Actor.");
    if (!projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.CARD_VANGUARD)) throw new Error("This Actor does not possess Card Vanguard.");
    const { message, check, result } = resolveMagicCardsResult(payload.triggerMessageId, actor.uuid);
    requireEncounterMatch(result, payload, "This Magic Cards result");

    return transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.source;
      if (current.status !== DECK_STATUS.ACTIVE || !current.conflict?.active) throw new Error("This Ace deck has no active conflict.");
      if (!result.conflictId || String(result.conflictId) !== String(current.conflict.id)) {
        throw new Error("This Magic Cards result belongs to a different or completed conflict.");
      }
      if (result.vanguardAdjustmentOpen === false
        || !isLatestMagicCardsResultMessage(message, actor.uuid, result.conflictId)) {
        throw new Error("Only the most recent Magic Cards result may change its Vanguard choice.");
      }

      const synchronizedResult = reconcileMagicCardsVanguardResult(result, current.zones, {
        revision: current.revision,
      });
      const selectedCardId = String(payload.cardId ?? "");
      const eligibleCardIds = new Set(synchronizedResult.vanguardEligibleCardIds ?? []);
      if (synchronizedResult.vanguardAdjustmentOpen === false || !eligibleCardIds.has(selectedCardId)) {
        await updateMagicCardsResultMessage(message, check, synchronizedResult, actor);
        const view = deckPlayService.viewState(actor, current, requester);
        return {
          ...view,
          actionNotice: selectedCardId && selectedCardId === synchronizedResult.details?.vanguardCardId
            ? "That card is already the Vanguard choice for this result."
            : "That result card has moved and can no longer be selected as Vanguard.",
        };
      }

      const plan = planResolutionVanguardAdjustment(current.zones, {
        resultCardIds: synchronizedResult.cardIds,
        currentVanguardCardId: synchronizedResult.details?.vanguardCardId,
        newVanguardCardId: selectedCardId,
      });
      const next = {
        ...foundry.utils.deepClone(current),
        schemaVersion: ACTOR_DECK_SCHEMA_VERSION,
        revision: Number(current.revision) + 1,
        zones: plan.zones,
      };
      const event = {
        kind: "vanguard-adjustment",
        conflictId: current.conflict.id,
        combatUuid: current.conflict.combatUuid,
        sceneUuid: current.conflict.sceneUuid,
        sourceFuid: PROJECTFU_FUIDS.CARD_VANGUARD,
        summary: plan.mode === "changed"
          ? `Changed the post-resolution Vanguard choice from ${plan.previousCardId} to ${plan.selectedCardId}.`
          : `Selected ${plan.selectedCardId} as Vanguard after Magic Cards resolved.`,
        public: true,
        cardIds: plan.previousCardId ? [plan.previousCardId, plan.selectedCardId] : [plan.selectedCardId],
        movements: plan.movements,
        details: {
          triggerMessageId: message.id,
          postResolution: true,
          previousVanguardCardId: plan.previousCardId,
          vanguardCardId: plan.selectedCardId,
        },
      };

      const snapshot = {
        content: message.content,
        check: foundry.utils.deepClone(check),
        expectedRevision: Number(message.flags?.[MODULE_ID]?.expectedRevision),
      };
      let committed;
      let messageUpdated = false;
      try {
        committed = await stateCommitService.commit({ ...tx, current, next, userId: senderUserId, event });
        const updatedResult = reconcileMagicCardsVanguardResult(updateMagicCardsVanguardResult(synchronizedResult, {
          previousCardId: plan.previousCardId,
          selectedCardId: plan.selectedCardId,
          revision: committed.state.revision,
        }), committed.state.zones, { revision: committed.state.revision });
        updatedResult.reverseOpen = false;
        await updateMagicCardsResultMessage(message, check, updatedResult, actor);
        messageUpdated = true;
        const view = deckPlayService.viewState(actor, committed.state, requester);
        await postVanguardAdjustmentDeclaration(actor, message, plan, current.configuration.styleId);
        return view;
      } catch (error) {
        const rollbackFailures = [];
        if (messageUpdated) {
          try { await restoreMagicCardsResultMessage(message, snapshot); }
          catch (rollbackError) { rollbackFailures.push(`chat message: ${rollbackError.message}`); }
        }
        if (committed) {
          try { await actorDeckStore.set(actor, tx.container); }
          catch (rollbackError) { rollbackFailures.push(`Actor deck: ${rollbackError.message}`); }
        }
        if (rollbackFailures.length) {
          throw new Error(`${error.message} Rollback also failed for ${rollbackFailures.join(" and ")}.`);
        }
        throw error;
      }
    }, payload);
  }

  async revealVanguard(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!projectFUAdapter.canUserManageActor(actor, requester) && !requester.isGM) throw new Error("You do not own this Actor.");
    if (!projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.CARD_VANGUARD)) throw new Error("This Actor does not possess Card Vanguard.");

    return transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.source;
      if (current.status !== DECK_STATUS.ACTIVE || !current.conflict?.active) throw new Error("This Ace deck has no active conflict.");
      if (Number(payload.expectedRevision) !== Number(current.revision)) throw new Error("This Ace deck changed. Refresh and try again.");
      const cardId = String(payload.cardId ?? "");
      const originalVanguardIndex = current.zones.vanguard.indexOf(cardId);
      if (originalVanguardIndex < 0) throw new Error("Choose a card currently in Vanguard.");

      const card = getCardDefinition(cardId);
      const damageType = resolveVanguardDamageType(card, payload.damageType);
      const zones = foundry.utils.deepClone(current.zones);
      zones.vanguard.splice(originalVanguardIndex, 1);
      zones.discard.push(cardId);
      const next = { ...foundry.utils.deepClone(current), schemaVersion: ACTOR_DECK_SCHEMA_VERSION, revision: Number(current.revision) + 1, zones };
      const movement = { cardId, from: "vanguard", to: "discard", faceUp: true };
      const event = {
        kind: "vanguard",
        conflictId: current.conflict.id,
        combatUuid: current.conflict.combatUuid,
        sceneUuid: current.conflict.sceneUuid,
        sourceFuid: PROJECTFU_FUIDS.CARD_VANGUARD,
        summary: `Card Vanguard revealed ${cardId} for ${damageType} Resistance.`,
        public: true,
        cardIds: [cardId],
        movements: [movement],
        details: { cardId, damageType, originalVanguardIndex },
      };
      const committed = await stateCommitService.commit({ ...tx, current, next, userId: senderUserId, event });
      const result = {
        actorUuid: actor.uuid,
        expectedRevision: committed.state.revision,
        combatUuid: current.conflict.combatUuid,
        sceneUuid: current.conflict.sceneUuid,
        cardId,
        originalVanguardIndex,
        damageType,
        card: cardView(cardId, current.configuration.styleId),
      };
      await postVanguardChat(actor, result);
      return deckPlayService.viewState(actor, committed.state, requester);
    }, payload);
  }

  async reverseVanguard(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!projectFUAdapter.canUserManageActor(actor, requester) && !requester.isGM) throw new Error("You do not own this Actor.");
    const { message, vanguard } = resolveVanguardMessage(payload.triggerMessageId, actor.uuid);
    requireEncounterMatch(vanguard, payload, "This Card Vanguard result");

    return transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.source;
      if (current.status !== DECK_STATUS.ACTIVE || !current.conflict?.active) throw new Error("This Ace deck has no active conflict.");
      if (Number(vanguard.expectedRevision) !== Number(current.revision)) {
        throw new Error("Card Vanguard can only be reversed before the Ace deck changes again.");
      }
      const cardId = String(vanguard.cardId ?? "");
      const discardIndex = current.zones.discard.indexOf(cardId);
      if (discardIndex < 0) throw new Error("The revealed Vanguard card is no longer in the discard pile.");
      const originalVanguardIndex = Math.max(0, Number(vanguard.originalVanguardIndex) || 0);
      const zones = foundry.utils.deepClone(current.zones);
      zones.discard.splice(discardIndex, 1);
      zones.vanguard.splice(Math.min(originalVanguardIndex, zones.vanguard.length), 0, cardId);
      const next = { ...foundry.utils.deepClone(current), schemaVersion: ACTOR_DECK_SCHEMA_VERSION, revision: Number(current.revision) + 1, zones };
      const event = {
        kind: "vanguard-reverse",
        conflictId: current.conflict.id,
        combatUuid: current.conflict.combatUuid,
        sceneUuid: current.conflict.sceneUuid,
        sourceFuid: PROJECTFU_FUIDS.CARD_VANGUARD,
        summary: "Reversed Card Vanguard and restored the concealed card.",
        public: true,
        cardIds: [cardId],
        movements: [{ cardId, from: "discard", to: "vanguard", faceUp: false }],
        details: { cardId, originalVanguardIndex },
      };
      const committed = await stateCommitService.commit({ ...tx, current, next, userId: senderUserId, event });
      const reverted = message.getFlag?.("projectfu", "RevertedAction") ?? message.flags?.projectfu?.RevertedAction ?? [];
      await message.setFlag("projectfu", "RevertedAction", Array.from(new Set([...(Array.isArray(reverted) ? reverted : []), CARD_VANGUARD_REVERSE_ACTION])));
      return deckPlayService.viewState(actor, committed.state, requester);
    }, payload);
  }
}

export const heroicSkillService = new HeroicSkillService();
