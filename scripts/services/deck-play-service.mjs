import { getCardDefinition } from "../cards/card-catalog.mjs";
import { recoverPendingPersistentDeck } from "./cross-encounter-world-service.mjs";
import { availableCardIds, beginConflictZones, drawCards, moveCard } from "../cards/deck-runtime.mjs";
import { evaluateSet, resolveSetEffect } from "../cards/set-resolver.mjs";
import { magicCardsMpCost } from "../cards/magic-cards-cost.mjs";
import { evaluateHighOrLow, exchangeLimit, trapSpellMaximumMp } from "../cards/class-skill-rules.mjs";
import { resolveCardBack, resolveCardFace, resolveBackForStyle, resolveFaceForStyle } from "../cards/style-registry.mjs";
import { styleSettingsStore } from "./style-settings-store.mjs";
import { ACTOR_DECK_SCHEMA_VERSION, DECK_STATUS, FORBIDDEN_RITE_EXPLANATION, MODULE_ID, PROJECTFU_FUIDS, SETTINGS } from "../constants.mjs";
import { projectFUAdapter } from "../integrations/projectfu-adapter.mjs";
import {
  buildCardsDrawnLine,
  buildDrawActionChatContent,
  DRAW_ACTION_REVERSE_ACTION,
  drawActionRecord,
  isDrawActionReverted,
} from "../integrations/draw-action.mjs";
import {
  buildMagicCardsReverseControl,
  MAGIC_CARDS_REVERSE_ACTION,
  magicCardsResultRecord,
} from "../integrations/projectfu-magic-cards-reversal.mjs";
import { DUEL_MASTER_WEAPON_CATEGORIES, getProjectFUCheck } from "../integrations/projectfu-chat-rules.mjs";
import { Log } from "../util/log.mjs";
import { stateCommitService } from "./state-commit-service.mjs";
import {
  actorDeckStore,
  createDefaultActorDeckState,
  prepareActorDeckState,
} from "./actor-deck-store.mjs";
import {
  createEncounterOpeningState,
  encounterOpeningComplete,
} from "./encounter-opening-state.mjs";
import { actorIsInCombat, combatStarted, encounterContextFromCombat, findCombatByUuid, resolveEncounterContext } from "./encounter-context-service.mjs";
import { transactionService } from "./transaction-service.mjs";


function persistentMode() {
  return globalThis.game?.settings?.get?.(MODULE_ID, SETTINGS.CROSS_ENCOUNTER_DECK) === true;
}

function expectedDeckLaunchError(message, code) {
  const error = new Error(message);
  error.name = "AceDeckLaunchError";
  error.code = code;
  error.expected = true;
  return error;
}

function createPersistentOpeningState({ configuration = {}, rootRevision = 0, revision = 1 } = {}) {
  return prepareActorDeckState({
    rootRevision,
    revision,
    status: DECK_STATUS.ACTIVE,
    configuration: { ...configuration, crossEncounterDeck: true },
    conflict: { active: true, id: "persistent", combatUuid: "", sceneUuid: "" },
    openingComplete: true,
    zones: beginConflictZones(),
    encounterCount: 0,
  });
}

const EFFECT_REQUIREMENTS = Object.freeze({
  jackpot: "4 cards of the same value, none of which is a Joker.",
  "magic-flush": "4 cards of consecutive values and of the same suit.",
  "blinding-flush": "4 cards of consecutive values.",
  "full-status": "3 cards of the same value and 2 cards of another value.",
  "triple-support": "3 cards of the same value.",
  "double-trouble": "2 cards of the same value and 2 cards of another value.",
  "magic-pair": "2 cards of the same value.",
  "forbidden-monarch": "4 cards of the same value, none of which is a Joker, and 1 Joker.",
  none: "The resolved cards do not match a listed effect.",
});

const HIGH_OR_LOW_CONTROLS = Object.freeze({
  damage: '@EFFECT[Compendium.projectfu.skills.Item.do8NdI13icFfJflO]{High or Low (Damage)}',
  reduction: '@EFFECT[Compendium.projectfu.skills.Item.pM2eTYvKrmR3wATD]{High or Low (Reduction)}',
  recovery: '@GAIN[&sl("high-or-low")*2 hp]{SL × 2 HP}',
});

function escape(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function titleCase(value) {
  const text = String(value ?? "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

async function enrichHtml(content) {
  const editor = globalThis.foundry?.applications?.ux?.TextEditor?.implementation;
  return typeof editor?.enrichHTML === "function" ? editor.enrichHTML(content, { async: true }) : content;
}

function replaceMagicCardsSection(messageContent, replacementContent) {
  const documentRef = globalThis.document;
  if (!documentRef?.createElement) throw new Error("The Magic Cards message cannot be rerendered in this client.");
  const currentRoot = documentRef.createElement("div");
  currentRoot.innerHTML = String(messageContent ?? "");
  const currentSection = currentRoot.querySelector(".ace-magic-cards-chat");
  if (!currentSection) throw new Error("The Magic Cards result section is no longer present in this message.");

  const replacementRoot = documentRef.createElement("div");
  replacementRoot.innerHTML = String(replacementContent ?? "");
  const replacementSection = replacementRoot.querySelector(".ace-magic-cards-chat");
  if (!replacementSection) throw new Error("The updated Magic Cards result could not be rendered.");
  currentSection.replaceWith(replacementSection);
  return currentRoot.innerHTML;
}

export async function updateMagicCardsResultMessage(message, check, result, actor) {
  const updatedCheck = foundry.utils.deepClone(check);
  updatedCheck.additionalData ??= {};
  updatedCheck.additionalData[MODULE_ID] ??= {};
  updatedCheck.additionalData[MODULE_ID].magicCardsResult = foundry.utils.deepClone(result);
  const rendered = await enrichHtml(buildMagicCardsChatContent(actor, result, result.expectedRevision));
  const content = replaceMagicCardsSection(message.content, rendered);
  await message.update({
    content,
    "flags.projectfu.Check": updatedCheck,
    [`flags.${MODULE_ID}.expectedRevision`]: Number(result.expectedRevision),
  });
}

export async function restoreMagicCardsResultMessage(message, snapshot) {
  await message.update({
    content: snapshot.content,
    "flags.projectfu.Check": snapshot.check,
    [`flags.${MODULE_ID}.expectedRevision`]: Number(snapshot.expectedRevision),
  });
}

function worldMessages() {
  const collection = game.messages;
  if (!collection) return [];
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return [];
}

function magicCardsMessageResult(message) {
  const flags = message?.flags?.[MODULE_ID] ?? {};
  if (flags.kind !== "magic-cards") return null;
  return getProjectFUCheck(message)?.additionalData?.[MODULE_ID]?.magicCardsResult ?? null;
}

function messageOrder(message) {
  const timestamp = Number(message?.timestamp ?? message?._source?.timestamp ?? 0);
  return { timestamp: Number.isFinite(timestamp) ? timestamp : 0, id: String(message?.id ?? "") };
}

function messageIsNewer(candidate, source) {
  const a = messageOrder(candidate);
  const b = messageOrder(source);
  return a.timestamp > b.timestamp || (a.timestamp === b.timestamp && a.id > b.id);
}

export function isLatestMagicCardsResultMessage(message, actorUuid, conflictId) {
  return !worldMessages().some((candidate) => {
    if (!candidate || candidate.id === message?.id || !messageIsNewer(candidate, message)) return false;
    const result = magicCardsMessageResult(candidate);
    return result
      && String(result.actorUuid ?? "") === String(actorUuid ?? "")
      && String(result.conflictId ?? "") === String(conflictId ?? "");
  });
}

function editableMagicCardsResults(actorUuid, conflictId) {
  return worldMessages().flatMap((message) => {
    const result = magicCardsMessageResult(message);
    if (!result
      || String(result.actorUuid ?? "") !== String(actorUuid ?? "")
      || String(result.conflictId ?? "") !== String(conflictId ?? "")
      || (result.vanguardAdjustmentOpen === false && result.reverseOpen === false)) return [];
    return [{ message, check: getProjectFUCheck(message), result }];
  });
}

function resolveMagicCardsReverseMessage(messageId, actorUuid) {
  const message = game.messages?.get?.(String(messageId ?? ""));
  if (!message) throw new Error("The Magic Cards result is no longer available.");
  const flags = message.flags?.[MODULE_ID] ?? {};
  const result = magicCardsResultRecord(message);
  if (flags.kind !== "magic-cards" || String(flags.actorUuid ?? result?.actorUuid ?? "") !== String(actorUuid ?? "")) {
    throw new Error("This message is not a Magic Cards result for that Actor.");
  }
  if (!result?.preZones || !Number.isFinite(Number(result.reverseRevision))) {
    throw new Error("This Magic Cards result does not contain reversible card state.");
  }
  if (result.reverseOpen === false) throw new Error("This Magic Cards result can no longer be reversed.");
  const reverted = message.getFlag?.("projectfu", "RevertedAction") ?? message.flags?.projectfu?.RevertedAction ?? [];
  if (Array.isArray(reverted) && reverted.includes(MAGIC_CARDS_REVERSE_ACTION)) {
    throw new Error("This Magic Cards play has already been reversed.");
  }
  return { message, result };
}

function resolveDrawReverseMessage(messageId, actorUuid) {
  const message = game.messages?.get?.(String(messageId ?? ""));
  if (!message) throw new Error("The Draw result is no longer available.");
  const flags = message.flags?.[MODULE_ID] ?? {};
  const result = drawActionRecord(message);
  if (flags.kind !== "draw-action" || String(flags.actorUuid ?? result?.actorUuid ?? "") !== String(actorUuid ?? "")) {
    throw new Error("This message is not a Draw result for that Actor.");
  }
  if (!result?.preZones || !Number.isFinite(Number(result.reverseRevision))) {
    throw new Error("This Draw result does not contain reversible card state.");
  }
  if (result.reverseOpen === false) throw new Error("This Draw can no longer be reversed.");
  if (isDrawActionReverted(message)) throw new Error("This Draw has already been reversed.");
  return { message, result };
}

function requireResultEncounter(record = {}, payload = {}, label = "This result") {
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

function cardLabel(cardId, assignment = null) {
  const card = getCardDefinition(cardId);
  if (!card) return String(cardId);
  if (card.joker) {
    const suit = String(assignment?.suit ?? "");
    const value = Number(assignment?.value);
    return suit && Number.isInteger(value) ? `Joker — ${titleCase(suit)} ${value}` : "Joker";
  }
  return `${titleCase(card.suit)} ${card.value}`;
}

function cardView(cardId, viewerStyleId) {
  const card = getCardDefinition(cardId);
  return {
    id: cardId,
    label: cardLabel(cardId),
    suit: card?.suit ?? "joker",
    value: card?.value ?? 0,
    joker: Boolean(card?.joker),
    face: resolveFaceForStyle(cardId, viewerStyleId),
  };
}

function publicView(actor, source, requester) {
  const canView = projectFUAdapter.canUserViewActor(actor, requester);
  const canManage = projectFUAdapter.canUserManageActor(actor, requester);
  const viewerStyleId = styleSettingsStore.selectionFor(requester.id);
  const limits = projectFUAdapter.getMagicCardsLimits(actor);
  const mindPoints = projectFUAdapter.getMindPoints(actor);
  return {
    actorUuid: actor.uuid,
    actorName: actor.name,
    actorImg: actor.img,
    actorLevel: projectFUAdapter.getActorLevel(actor),
    magicCardsLevel: limits.skillLevel,
    magicCards: { ...limits, mindPoints },
    rootRevision: source.rootRevision,
    revision: source.revision,
    status: source.status,
    openingComplete: source.openingComplete === true,
    conflict: foundry.utils.deepClone(source.conflict),
    combatUuid: String(source.conflict?.combatUuid ?? ""),
    sceneUuid: String(source.conflict?.sceneUuid ?? ""),
    configuration: foundry.utils.deepClone(source.configuration),
    crossEncounterDeck: source.configuration?.crossEncounterDeck === true,
    encounterCount: Number(source.encounterCount ?? 0),
    canView,
    canManage,
    readOnly: canView && !canManage,
    isGM: requester.isGM,
    hasCardVanguard: Boolean(projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.CARD_VANGUARD)),
    classSkills: {
      mulligan: Boolean(projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.MULLIGAN)),
      trapCard: Boolean(projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.TRAP_CARD)),
      mulliganLevel: projectFUAdapter.getSkillLevel(actor, PROJECTFU_FUIDS.MULLIGAN),
      trapCardLevel: projectFUAdapter.getSkillLevel(actor, PROJECTFU_FUIDS.TRAP_CARD),
      mulliganLimit: exchangeLimit(projectFUAdapter.getSkillLevel(actor, PROJECTFU_FUIDS.MULLIGAN)),
      trapCardLimit: exchangeLimit(projectFUAdapter.getSkillLevel(actor, PROJECTFU_FUIDS.TRAP_CARD)),
      trapCardSpellMaximumMp: trapSpellMaximumMp(projectFUAdapter.getSkillLevel(actor, PROJECTFU_FUIDS.TRAP_CARD)),
    },
    heroicSkills: {
      blackWhite: Boolean(projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.BLACK_WHITE)),
      forbiddenRite: Boolean(projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.FORBIDDEN_RITE)),
    },
    cardBack: resolveBackForStyle(viewerStyleId),
    counts: {
      deck: availableCardIds(source.zones).length,
      hand: source.zones.hand.length,
      discard: source.zones.discard.length,
      vanguard: source.zones.vanguard.length,
    },
    hand: canView ? source.zones.hand.map((id) => cardView(id, viewerStyleId)) : [],
    discard: source.zones.discard.map((id) => cardView(id, viewerStyleId)),
    vanguard: canView ? source.zones.vanguard.map((id) => cardView(id, viewerStyleId)) : [],
  };
}

function selectedAssignments(payload) {
  const result = {};
  for (const [cardId, assignment] of Object.entries(payload.jokerAssignments ?? {})) {
    result[cardId] = { suit: String(assignment?.suit ?? ""), value: Number(assignment?.value) };
  }
  return result;
}

function orderedSelection(cardIds, requestedOrder) {
  const order = Array.isArray(requestedOrder) && requestedOrder.length ? requestedOrder.map(String) : [...cardIds];
  if (order.length !== cardIds.length || new Set(order).size !== order.length || order.some((id) => !cardIds.includes(id))) {
    throw new Error("Discard order must contain each resolved card exactly once.");
  }
  return order;
}

function movementFor(cardId, to) {
  return { cardId, from: "hand", to, faceUp: to === "discard" };
}

function damageControl(effect) {
  const amount = Number(effect.damage);
  const damageType = String(effect.damageType ?? "").toLowerCase();
  const traits = [];
  if (effect.ignoreResistances) traits.push("ignore-resistances");
  if (effect.ignoreImmunities) traits.push("ignore-immunities");
  const traitText = traits.length ? `|${traits.join(",")}|` : "";
  return `@DMG[${amount} ${escape(damageType)}${traitText}]{${amount} ${titleCase(damageType)} damage}`;
}

function statusControl(status) {
  return `@EFFECT[${escape(status)}]{${titleCase(status)}}`;
}

function statusText(statuses) {
  return statuses.map((status) => `<span class="ace-status-chip">${escape(titleCase(status))}</span>`).join(" and ");
}

function duelMasterGuidance(effect) {
  if (!effect.duelMasterEligible) return "";
  const commonValue = Number(effect.commonValue ?? 0);
  const categories = DUEL_MASTER_WEAPON_CATEGORIES.join(", ").replace(/, ([^,]+)$/, ", or $1");
  return ` <span class="ace-magic-pair__duel ace-magic-pair__duel--guidance"><strong>Duel Master:</strong> If the attack uses an ${escape(categories)} weapon, manually add ${commonValue} damage and recover ${commonValue * 2} MP.</span>`;
}

function effectHtml(details) {
  const effect = details.effectDetails ?? {};
  switch (details.chosenEffect) {
    case "jackpot":
      return `Any Player Character who has surrendered but is still narratively present regains consciousness; then, you and every ally you can see recover @GAIN[777 hp]{777 HP} and @GAIN[777 mp]{777 MP}.`;
    case "magic-flush":
    case "blinding-flush":
    case "double-trouble":
    case "forbidden-monarch":
      return `${damageControl(effect)} to ${effect.targets === "up-to-two-visible-enemies" ? "each of up to two different enemies you can see" : "every enemy you can see"}.`;
    case "full-status":
      return effect.mode === "inflict"
        ? `Every enemy you can see suffers ${effect.statuses.map(statusControl).join(" and ")}.`
        : `You and every ally you can see recover from ${statusText(effect.statuses ?? [])}.`;
    case "triple-support":
      return `You and every ally you can see recover @GAIN[${Number(effect.recoveryHP)} hp]{${Number(effect.recoveryHP)} HP}.`;
    case "magic-pair": {
      const types = Array.from(new Set(effect.damageTypes ?? [])).map(titleCase);
      const typeChoice = types.length ? types.join(" or ") : "one resolved elemental type";
      return `You perform a free attack with a weapon you have equipped. If it deals damage, choose ${escape(typeChoice)} and convert all damage dealt by the attack to that type.${duelMasterGuidance(effect)}`;
    }
    default:
      return "The set resolves without an effect.";
  }
}

function highOrLowHtml(details) {
  const level = Number(details.highOrLowLevel ?? 0);
  const result = details.highOrLow ?? {};
  if (!level || (!result.high && !result.low && !result.recovery)) return "";

  const explanations = [];
  const controls = [];
  if (result.high) {
    explanations.push(`you deal ${level} extra damage until the start of your next turn`);
    controls.push(HIGH_OR_LOW_CONTROLS.damage);
  }
  if (result.low) {
    explanations.push(`all damage you suffer is reduced by ${level} until the start of your next turn, before Affinities`);
    controls.push(HIGH_OR_LOW_CONTROLS.reduction);
  }
  if (result.recovery) {
    explanations.push(`you recover ${level * 2} Hit Points`);
    controls.push(HIGH_OR_LOW_CONTROLS.recovery);
  }

  return `<div class="ace-magic-cards-chat__rider">
    <p><strong>High or Low:</strong> ${explanations.join("; ")}.</p>
    <p><strong>You Receive:</strong> ${controls.join(" and ")}</p>
  </div>`;
}

function resolvedCardFigure(actor, cardId, details, canChooseVanguard) {
  const assignment = details.jokerAssignments?.[cardId];
  const label = cardLabel(cardId, assignment);
  const face = resolveCardFace(cardId, details.styleId);
  const isVanguard = cardId === details.vanguardCardId;
  const vanguard = isVanguard ? `<span class="ace-card-destination" title="Vanguard"><i class="fa-solid fa-shield-halved"></i></span>` : "";
  const figure = `<figure class="${isVanguard ? "is-vanguard" : ""}"><img src="${escape(face)}" alt="${escape(label)}" title="${escape(label)}">${vanguard}</figure>`;
  if (!canChooseVanguard || isVanguard) return figure;
  const actionLabel = details.vanguardCardId ? `Move Vanguard to ${label}` : `Set ${label} as Vanguard`;
  return `<button type="button" class="ace-magic-cards-chat__vanguard-choice" data-ace-action="set-resolution-vanguard" data-actor-uuid="${escape(actor.uuid)}" data-combat-uuid="${escape(details.combatUuid ?? "")}" data-scene-uuid="${escape(details.sceneUuid ?? "")}" data-card-id="${escape(cardId)}" data-card-label="${escape(label)}" aria-label="${escape(actionLabel)}" title="${escape(actionLabel)}">${figure}</button>`;
}

export function buildMagicCardsChatContent(actor, event, revision) {
  const details = event?.details ?? {};
  const canAdjustVanguard = Boolean(
    event?.vanguardAdjustmentOpen !== false
    && projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.CARD_VANGUARD),
  );
  const eligibleVanguardCardIds = Array.isArray(event?.vanguardEligibleCardIds)
    ? new Set(event.vanguardEligibleCardIds.map(String))
    : null;
  const cardRow = (event?.cardIds ?? []).map((id) => resolvedCardFigure(
    actor,
    id,
    details,
    canAdjustVanguard && (!eligibleVanguardCardIds || eligibleVanguardCardIds.has(String(id))),
  )).join("");
  const requirements = EFFECT_REQUIREMENTS[details.chosenEffect] ?? "";
  const requirementsHtml = requirements ? `<p><strong>Requirements:</strong> ${escape(requirements)}</p>` : "";
  const forbiddenRiteResolvedCount = Number(details.effectDetails?.forbiddenRiteResolvedCount ?? 0);
  const forbiddenRite = details.effectDetails?.forbiddenRiteRecycleEligible
    ? `<section class="ace-magic-cards-chat__actions ace-forbidden-rite-prompt">
        <header><i class="fa-solid fa-rotate"></i><strong>Forbidden Rite available</strong></header>
        <p>${escape(FORBIDDEN_RITE_EXPLANATION)}</p>
        <button type="button" class="ace-chat-action" data-ace-action="forbidden-rite" data-actor-uuid="${escape(actor.uuid)}" data-expected-revision="${Number(revision)}" data-combat-uuid="${escape(event?.combatUuid ?? event?.conflict?.combatUuid ?? "")}" data-scene-uuid="${escape(event?.sceneUuid ?? event?.conflict?.sceneUuid ?? "")}"><i class="fa-solid fa-rotate"></i> Choose Cards</button>
      </section>`
    : forbiddenRiteResolvedCount > 0
      ? `<section class="ace-magic-cards-chat__actions ace-forbidden-rite-prompt is-resolved"><span class="ace-forbidden-rite-resolved"><i class="fa-solid fa-rotate"></i> Forbidden Rite · ${forbiddenRiteResolvedCount} shuffled</span></section>`
      : "";
  return `<section class="ace-magic-cards-chat" data-vanguard-card-id="${escape(details.vanguardCardId ?? "")}">
    <div class="ace-magic-cards-chat__cards">${cardRow}</div>
    <h3>${escape(details.effectLabel ?? "No Matching Effect")}</h3>
    ${requirementsHtml}
    <p><strong>Effect:</strong> ${effectHtml(details)}</p>
    <p><strong>Cost:</strong> @LOSS[${Number(details.mpCost)} mp]{${Number(details.mpCost)} MP}</p>
    ${highOrLowHtml(details)}
    ${forbiddenRite}
    ${buildCardsDrawnLine(details.cardsDrawn, "ace-magic-cards-chat__drawn")}
    ${buildMagicCardsReverseControl(event)}
  </section>`;
}

async function postResolutionChat(actor, event, revision, preZones) {
  try {
    const item = projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.MAGIC_CARDS);
    if (!item) throw new Error("The Actor no longer has the Magic Cards class ability.");

    const result = {
      actorUuid: String(actor.uuid ?? ""),
      expectedRevision: Number(revision),
      reverseRevision: Number(revision),
      reverseOpen: true,
      preZones: foundry.utils.deepClone(preZones),
      kind: "magic-cards",
      resultId: foundry.utils.randomID(),
      conflictId: String(event?.conflictId ?? ""),
      combatUuid: String(event?.combatUuid ?? event?.conflict?.combatUuid ?? ""),
      sceneUuid: String(event?.sceneUuid ?? event?.conflict?.sceneUuid ?? ""),
      vanguardAdjustmentOpen: true,
      cardIds: Array.from(event?.cardIds ?? [], String),
      vanguardEligibleCardIds: Array.from(event?.details?.discardOrder ?? [], String),
      details: foundry.utils.deepClone(event?.details ?? {}),
    };
    const previousResults = editableMagicCardsResults(result.actorUuid, result.conflictId);

    await projectFUAdapter.displayItem(actor, item, (check) => {
      check.additionalData ??= {};
      check.additionalData[MODULE_ID] = {
        ...(check.additionalData[MODULE_ID] ?? {}),
        magicCardsResult: result,
      };
    });

    for (const previous of previousResults) {
      try {
        const closedResult = foundry.utils.deepClone(previous.result);
        closedResult.vanguardAdjustmentOpen = false;
        closedResult.reverseOpen = false;
        closedResult.supersededByResultId = result.resultId;
        await updateMagicCardsResultMessage(previous.message, previous.check, closedResult, actor);
      } catch (error) {
        Log.warn("A previous Magic Cards result could not be visually closed after a newer play.", error);
      }
    }
  } catch (error) {
    Log.warn("Unable to create the Magic Cards chat result.", error);
  }
}

async function postHandRevealChat(actor, source) {
  try {
    const styleId = source.configuration.styleId;
    const cards = source.zones.hand.map((id) => {
      const label = cardLabel(id);
      return `<figure><img src="${escape(resolveCardFace(id, styleId))}" alt="${escape(label)}" title="${escape(label)}"></figure>`;
    }).join("");
    const content = `<section class="ace-hand-reveal-chat"><h3>${escape(actor.name)} reveals their hand</h3><div>${cards}</div></section>`;
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content });
  } catch (error) {
    Log.warn("Unable to reveal the Ace hand in chat.", error);
  }
}

async function postDrawChat(actor, result, options = {}) {
  const kind = String(options.kind ?? "draw-action");
  try {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: buildDrawActionChatContent(result),
      flags: {
        [MODULE_ID]: {
          actorUuid: String(result.actorUuid ?? actor.uuid ?? ""),
          kind,
          combatUuid: String(result.combatUuid ?? ""),
          sceneUuid: String(result.sceneUuid ?? ""),
          drawAction: foundry.utils.deepClone(result),
        },
      },
    });
  } catch (error) {
    Log.warn("Unable to create the Draw chat result.", error);
  }
}

export class AceDeckPlayService {
  viewState(actor, source, requester) { return publicView(actor, source, requester); }

  async getState(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    const source = actorDeckStore.get(actor, payload) ?? createDefaultActorDeckState({ crossEncounterDeck: persistentMode() });
    if (!projectFUAdapter.canUserViewActor(actor, requester)) throw new Error("You do not have permission to view this Actor's Ace deck.");
    return publicView(actor, source, requester);
  }

  async getActiveStates(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    if (!requester) throw new Error("The requesting user no longer exists.");
    const context = persistentMode() ? {} : resolveEncounterContext(payload);
    if (!persistentMode() && !context.combatUuid) return [];
    const results = [];
    for (const actor of actorDeckStore.actorsWithDecks()) {
      const source = actorDeckStore.get(actor, context);
      if (source?.status === DECK_STATUS.ACTIVE && projectFUAdapter.canUserViewActor(actor, requester)) {
        results.push(publicView(actor, source, requester));
      }
    }
    return results;
  }

  async ensureDeck(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!projectFUAdapter.canUserViewActor(actor, requester)) throw new Error("You do not have permission to view this Actor's Ace deck.");
    if (!projectFUAdapter.hasMagicCards(actor)) throw new Error("This Actor does not possess Magic Cards.");
    if (!persistentMode()) return this.getState(payload, senderUserId);

    // A prior interrupted mode change must never strand an existing hand behind
    // a retired migration screen. A sole source is restored automatically; an
    // ambiguous set of sources is resolved with the active GM before opening.
    if (actorDeckStore.getContainer(actor)?.status === DECK_STATUS.MIGRATION_PENDING) {
      await recoverPendingPersistentDeck(actor);
    }
    const outcome = await transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.source;
      if (current.status === DECK_STATUS.MIGRATION_PENDING) {
        throw expectedDeckLaunchError("This Ace deck is waiting for the GM to finish its persistent-deck migration.", "migration-pending");
      }
      if (current.status === DECK_STATUS.CORRUPT) {
        throw expectedDeckLaunchError("This Ace deck needs GM review before play can continue.", "storage-needs-review");
      }
      if (current.status === DECK_STATUS.ACTIVE) return { state: publicView(actor, current, requester), openingDraw: null };
      if (!projectFUAdapter.canUserManageActor(actor, requester) && !requester.isGM) {
        throw new Error("Only an Actor owner or GM may initialize its persistent Ace deck.");
      }
      const next = createPersistentOpeningState({
        configuration: tx.container.configuration,
        rootRevision: Number(tx.container.revision) + 1,
        revision: 1,
      });
      const event = {
        kind: "persistent-start",
        conflictId: "persistent",
        combatUuid: "",
        sceneUuid: "",
        summary: "Shuffled the persistent Ace deck and drew its opening five-card hand.",
        cardIds: [...next.zones.hand],
        movements: next.zones.hand.map((cardId) => ({ cardId, from: "deck", to: "hand" })),
        details: { openingComplete: true, persistent: true },
      };
      const committed = await stateCommitService.commit({ ...tx, current, next, userId: senderUserId, event });
      return {
        state: publicView(actor, committed.state, requester),
        openingDraw: {
          actorUuid: actor.uuid,
          actorName: actor.name,
          cardsDrawn: next.zones.hand.length,
          reverseOpen: false,
          conflictId: "persistent",
          combatUuid: "",
          sceneUuid: "",
          opening: true,
          persistent: true,
        },
      };
    }, {});
    if (outcome.openingDraw) await postDrawChat(actor, outcome.openingDraw, { kind: "draw-action" });
    return outcome.state;
  }

  async startEncounter(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!requester.isGM) throw new Error("Only a GM may initialize an Ace encounter instance.");
    if (!projectFUAdapter.hasMagicCards(actor)) throw new Error("This Actor does not possess Magic Cards.");
    if (persistentMode()) {
      const source = actorDeckStore.get(actor, {}) ?? createDefaultActorDeckState({ crossEncounterDeck: true });
      return publicView(actor, source, requester);
    }
    const requestedContext = resolveEncounterContext(payload);
    if (!requestedContext.combatUuid) throw new Error("A started Foundry Encounter is required.");
    const combat = findCombatByUuid(requestedContext.combatUuid);
    if (!combat || !combatStarted(combat)) throw new Error("The Foundry Encounter is not available or has not started.");
    if (!actorIsInCombat(actor, combat)) throw new Error("This Actor is not a combatant in that Encounter.");
    const context = encounterContextFromCombat(combat);

    const outcome = await transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.source;
      if (current.status === DECK_STATUS.CORRUPT) throw new Error("This Ace deck needs GM review before play can continue.");
      if (encounterOpeningComplete(current, context.combatUuid)) {
        return { state: publicView(actor, current, requester), openingDraw: null };
      }
      const repairingIncompleteOpening = current.status === DECK_STATUS.ACTIVE
        && current.conflict?.combatUuid === context.combatUuid;
      const next = createEncounterOpeningState({
        configuration: tx.container.configuration,
        context,
        rootRevision: Number(tx.container.revision) + 1,
        revision: repairingIncompleteOpening ? Number(current.revision) + 1 : 1,
      });
      if (repairingIncompleteOpening) {
        Log.warn(`Repairing incomplete Ace Encounter opening for ${actor.name} in ${context.combatUuid}.`);
      }
      const event = {
        kind: "encounter-start",
        conflictId: next.conflict.id,
        combatUuid: next.conflict.combatUuid,
        sceneUuid: next.conflict.sceneUuid,
        summary: repairingIncompleteOpening
          ? "Repaired the Encounter opening and drew the required five-card hand."
          : "Shuffled the Ace deck and drew the opening five-card hand for the Encounter.",
        cardIds: [...next.zones.hand],
        movements: next.zones.hand.map((cardId) => ({ cardId, from: "deck", to: "hand" })),
        details: { openingComplete: true, repaired: repairingIncompleteOpening },
      };
      const committed = await stateCommitService.commit({ ...tx, current, next, userId: senderUserId, event });
      return {
        state: publicView(actor, committed.state, requester),
        openingDraw: {
          actorUuid: actor.uuid,
          actorName: actor.name,
          cardsDrawn: next.zones.hand.length,
          reverseOpen: false,
          conflictId: next.conflict.id,
          combatUuid: next.conflict.combatUuid,
          sceneUuid: next.conflict.sceneUuid,
          opening: true,
        },
      };
    }, context);
    if (outcome.openingDraw) {
      await postDrawChat(actor, outcome.openingDraw, { kind: "draw-action" });
    }
    return outcome.state;
  }

  async endEncounter(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!requester.isGM) throw new Error("Only a GM may close an Ace encounter instance.");
    if (persistentMode()) {
      const source = actorDeckStore.get(actor, {}) ?? createDefaultActorDeckState({ crossEncounterDeck: true });
      return publicView(actor, source, requester);
    }
    const context = resolveEncounterContext(payload);
    if (!context.combatUuid) return publicView(actor, actorDeckStore.get(actor, context) ?? createDefaultActorDeckState(), requester);

    return transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.source;
      if (!current.conflict?.active) return publicView(actor, current, requester);
      const next = createDefaultActorDeckState(tx.container.configuration, context);
      next.rootRevision = Number(tx.container.revision) + 1;
      next.revision = Number(current.revision) + 1;
      const event = {
        kind: "encounter-end",
        conflictId: current.conflict.id,
        combatUuid: current.conflict.combatUuid,
        sceneUuid: current.conflict.sceneUuid,
        summary: "Returned all cards and closed the Ace encounter instance.",
        cardIds: Object.values(current.zones).flat(),
      };
      const committed = await stateCommitService.commit({ ...tx, current, next, userId: senderUserId, event });
      return publicView(actor, committed.state, requester);
    }, context);
  }

  async startConflict(payload, senderUserId) {
    return this.startEncounter(payload, senderUserId);
  }

  async endConflict(payload, senderUserId) {
    return this.endEncounter(payload, senderUserId);
  }

  async draw(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!projectFUAdapter.canUserManageActor(actor, requester) && !requester.isGM) throw new Error("You do not own this Actor.");
    if (!projectFUAdapter.hasMagicCards(actor)) throw new Error("This Actor does not possess Magic Cards.");

    const outcome = await transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.source;
      if (payload.expectedRevision !== undefined && Number(payload.expectedRevision) !== Number(current.revision)) throw new Error("This Ace deck changed. Refresh and try again.");
      this.#requireActive(current);
      const preZones = foundry.utils.deepClone(current.zones);
      const result = drawCards(current.zones, Math.max(1, Math.min(5, Number(payload.count) || 1)));
      const drawnMovements = result.movements.filter((movement) => movement.to === "hand");
      if (!drawnMovements.length) throw new Error("No card is available to draw.");
      const next = this.#nextState(current, result.zones);
      const event = {
        kind: "draw",
        conflictId: current.conflict.id,
        combatUuid: current.conflict.combatUuid,
        sceneUuid: current.conflict.sceneUuid,
        summary: `Drew ${drawnMovements.length} card(s).`,
        cardIds: drawnMovements.map((entry) => entry.cardId),
        movements: result.movements,
      };
      const committed = await stateCommitService.commit({ ...tx, current, next, userId: senderUserId, event });
      return {
        state: publicView(actor, committed.state, requester),
        result: {
          actorUuid: actor.uuid,
          actorName: actor.name,
          cardsDrawn: drawnMovements.length,
          expectedRevision: committed.state.revision,
          reverseRevision: committed.state.revision,
          reverseOpen: true,
          preZones,
          conflictId: current.conflict.id,
          combatUuid: current.conflict.combatUuid,
          sceneUuid: current.conflict.sceneUuid,
        },
      };
    }, payload);
    await postDrawChat(actor, outcome.result);
    return outcome.state;
  }


  async resetEncounter(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    const persistent = persistentMode();
    const canManage = projectFUAdapter.canUserManageActor(actor, requester);
    if (!requester.isGM && !(persistent && canManage)) {
      throw new Error(persistent ? "You do not own this Actor." : "Only a GM may reset an Ace encounter state.");
    }
    if (!projectFUAdapter.hasMagicCards(actor)) throw new Error("This Actor does not possess Magic Cards.");

    const outcome = await transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.source;
      if (payload.expectedRevision !== undefined && Number(payload.expectedRevision) !== Number(current.revision)) throw new Error("This Ace deck changed. Refresh and try again.");
      this.#requireActive(current);
      const zones = beginConflictZones();
      const returned = Object.entries(current.zones).flatMap(([from, cardIds]) => cardIds.map((cardId) => ({ cardId, from, to: "deck" })));
      const movements = [...returned, ...zones.hand.map((cardId) => ({ cardId, from: "deck", to: "hand" }))];
      const next = this.#nextState(current, zones);
      const event = {
        kind: persistent ? "deck-reset" : "encounter-reset",
        conflictId: current.conflict.id,
        combatUuid: current.conflict.combatUuid,
        sceneUuid: current.conflict.sceneUuid,
        summary: persistent
          ? `${actor.name} reset the persistent Ace deck, shuffled it, and drew five cards.`
          : "Reset the Ace encounter state, shuffled the deck, and drew five cards.",
        cardIds: [...new Set(movements.map((entry) => entry.cardId))],
        movements,
        public: true,
      };
      const committed = await stateCommitService.commit({ ...tx, current, next, userId: senderUserId, event });
      return {
        state: publicView(actor, committed.state, requester),
        draw: {
          actorUuid: actor.uuid,
          actorName: actor.name,
          cardsDrawn: zones.hand.length,
          reverseOpen: false,
          conflictId: current.conflict.id,
          combatUuid: current.conflict.combatUuid,
          sceneUuid: current.conflict.sceneUuid,
          reset: true,
          resetActorName: actor.name,
          persistent,
        },
      };
    }, payload);
    await postDrawChat(actor, outcome.draw, { kind: "draw-action" });
    return outcome.state;
  }

  async revealHand(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!projectFUAdapter.canUserManageActor(actor, requester) && !requester.isGM) throw new Error("You do not own this Actor.");
    const source = actorDeckStore.get(actor, payload) ?? createDefaultActorDeckState({ crossEncounterDeck: persistentMode() });
    this.#requireActive(source);
    if (payload.expectedRevision !== undefined && Number(payload.expectedRevision) !== Number(source.revision)) throw new Error("This Ace deck changed. Refresh and try again.");
    await postHandRevealChat(actor, source);
    return publicView(actor, source, requester);
  }

  async resolveMagicCards(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!projectFUAdapter.canUserManageActor(actor, requester) && !requester.isGM) throw new Error("You do not own this Actor.");
    if (!projectFUAdapter.hasMagicCards(actor)) throw new Error("This Actor does not possess Magic Cards.");

    return transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.source;
      this.#requireActive(current);
      if (Number(payload.expectedRevision) !== Number(current.revision)) throw new Error("This Ace deck changed. Refresh and try again.");

      const cardIds = Array.isArray(payload.cardIds) ? payload.cardIds.map(String) : [];
      const limits = projectFUAdapter.getMagicCardsLimits(actor);
      if (cardIds.length < limits.minimumCards || cardIds.length > limits.maximumCards) throw new Error(`Magic Cards must resolve between ${limits.minimumCards} and ${limits.maximumCards} cards at this Skill Level.`);
      if (new Set(cardIds).size !== cardIds.length || cardIds.some((id) => !current.zones.hand.includes(id))) throw new Error("Every resolved card must be a unique card currently in hand.");
      const discardOrder = orderedSelection(cardIds, payload.discardOrder);
      const mpCost = magicCardsMpCost(cardIds);

      const assignments = selectedAssignments(payload);
      const hasForbiddenRite = Boolean(projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.FORBIDDEN_RITE));
      const hasBlackWhite = Boolean(projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.BLACK_WHITE));
      const evaluation = evaluateSet(cardIds, assignments, { allowForbiddenMonarch: hasForbiddenRite });
      const resolution = resolveSetEffect(evaluation, String(payload.effectId ?? ""), {
        actorLevel: projectFUAdapter.getActorLevel(actor),
        choices: payload.choices ?? {},
        allowBlackWhite: hasBlackWhite,
      });

      const highOrLowLevel = projectFUAdapter.getSkillLevel(actor, PROJECTFU_FUIDS.HIGH_OR_LOW);
      const highOrLow = highOrLowLevel
        ? evaluateHighOrLow(cardIds, assignments)
        : { high: false, low: false, recovery: false, hasJoker: false, values: [] };

      const vanguardCardId = String(payload.vanguardCardId ?? "");
      const hasVanguard = Boolean(projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.CARD_VANGUARD));
      if (vanguardCardId) {
        if (!hasVanguard) throw new Error("This Actor does not possess Card Vanguard.");
        if (!cardIds.includes(vanguardCardId)) throw new Error("The Vanguard card must be part of the resolved set.");
        if (current.zones.vanguard.length >= 3) throw new Error("The Vanguard zone already contains three cards.");
      }

      const preZones = foundry.utils.deepClone(current.zones);
      const zones = foundry.utils.deepClone(current.zones);
      const movements = [];
      for (const cardId of discardOrder) {
        const index = zones.hand.indexOf(cardId);
        zones.hand.splice(index, 1);
        const to = cardId === vanguardCardId ? "vanguard" : "discard";
        zones[to].push(cardId);
        movements.push(movementFor(cardId, to));
      }

      const discardHasJokerAtResolution = zones.discard.some((id) => getCardDefinition(id)?.joker);
      const resolvedJokerToDiscard = cardIds.some((id) => getCardDefinition(id)?.joker && id !== vanguardCardId);
      const blackWhiteIgnoresAffinities = hasBlackWhite && discardHasJokerAtResolution && ["magic-flush", "blinding-flush", "double-trouble"].includes(resolution.id);
      const forbiddenMonarchIgnoresAffinities = resolution.id === "forbidden-monarch" && discardHasJokerAtResolution;
      resolution.details.ignoreResistances = blackWhiteIgnoresAffinities || forbiddenMonarchIgnoresAffinities;
      resolution.details.ignoreImmunities = blackWhiteIgnoresAffinities || forbiddenMonarchIgnoresAffinities;
      resolution.details.forbiddenRiteRecycleEligible = hasForbiddenRite && resolvedJokerToDiscard;
      resolution.details.forbiddenRiteEligibleCardIds = resolution.details.forbiddenRiteRecycleEligible
        ? zones.discard.filter((id) => !getCardDefinition(id)?.joker)
        : [];
      resolution.details.duelMasterEligible = Boolean(projectFUAdapter.getItemByFuid(actor, PROJECTFU_FUIDS.DUEL_MASTER)) && resolution.id === "magic-pair";

      const drawn = drawCards(zones, cardIds.length);
      movements.push(...drawn.movements);
      const cardsDrawn = drawn.movements.filter((entry) => entry.to === "hand").length;
      if (cardsDrawn !== cardIds.length) throw new Error("The deck could not provide all replacement cards.");

      const next = this.#nextState(current, drawn.zones);
      const event = {
        kind: "resolution",
        conflictId: current.conflict.id,
        combatUuid: current.conflict.combatUuid,
        sceneUuid: current.conflict.sceneUuid,
        sourceFuid: PROJECTFU_FUIDS.MAGIC_CARDS,
        summary: `Resolved ${resolution.label} with ${cardIds.length} cards.`,
        public: true,
        cardIds: discardOrder,
        movements,
        details: {
          mpCost,
          cardsDrawn,
          styleId: current.configuration.styleId,
          jokerAssignments: assignments,
          matchedEffects: evaluation.effects,
          chosenEffect: resolution.id,
          effectLabel: resolution.label,
          effectSummary: resolution.summary,
          effectDetails: resolution.details,
          vanguardCardId,
          highOrLow,
          highOrLowLevel,
          discardOrder: discardOrder.filter((id) => id !== vanguardCardId),
          combatUuid: current.conflict.combatUuid,
          sceneUuid: current.conflict.sceneUuid,
        },
      };

      const committed = await stateCommitService.commit({ ...tx, current, next, userId: senderUserId, event });
      await postResolutionChat(actor, event, committed.state.revision, preZones);
      return publicView(actor, committed.state, requester);
    }, payload);
  }

  async reverseDraw(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!projectFUAdapter.canUserManageActor(actor, requester) && !requester.isGM) throw new Error("You do not own this Actor.");
    const { message, result } = resolveDrawReverseMessage(payload.triggerMessageId, actor.uuid);
    requireResultEncounter(result, payload, "This Draw");

    return transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.source;
      this.#requireActive(current);
      if (!result.conflictId || String(result.conflictId) !== String(current.conflict.id)) {
        throw new Error("This Draw belongs to a different or completed conflict.");
      }
      if (Number(result.reverseRevision) !== Number(current.revision)) {
        throw new Error("This Draw can only be reversed before the Ace deck changes again.");
      }
      const zones = {
        hand: Array.from(result.preZones.hand ?? [], String),
        discard: Array.from(result.preZones.discard ?? [], String),
        vanguard: Array.from(result.preZones.vanguard ?? [], String),
      };
      const next = this.#nextState(current, zones);
      const event = {
        kind: "draw-reverse",
        conflictId: current.conflict.id,
        combatUuid: current.conflict.combatUuid,
        sceneUuid: current.conflict.sceneUuid,
        summary: `Reversed a Draw of ${Number(result.cardsDrawn) || 0} card(s).`,
        public: true,
        cardIds: [],
        movements: [],
        details: { triggerMessageId: message.id, cardsDrawn: Number(result.cardsDrawn) || 0 },
      };
      const committed = await stateCommitService.commit({ ...tx, current, next, userId: senderUserId, event });
      const reverted = message.getFlag?.("projectfu", "RevertedAction") ?? message.flags?.projectfu?.RevertedAction ?? [];
      await message.setFlag("projectfu", "RevertedAction", Array.from(new Set([...(Array.isArray(reverted) ? reverted : []), DRAW_ACTION_REVERSE_ACTION])));
      return publicView(actor, committed.state, requester);
    }, payload);
  }

  async reverseMagicCards(payload, senderUserId) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!projectFUAdapter.canUserManageActor(actor, requester) && !requester.isGM) throw new Error("You do not own this Actor.");
    const { message, result } = resolveMagicCardsReverseMessage(payload.triggerMessageId, actor.uuid);
    requireResultEncounter(result, payload, "This Magic Cards result");

    return transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.source;
      this.#requireActive(current);
      if (!result.conflictId || String(result.conflictId) !== String(current.conflict.id)) {
        throw new Error("This Magic Cards result belongs to a different or completed conflict.");
      }
      if (Number(result.reverseRevision) !== Number(current.revision)) {
        throw new Error("Magic Cards can only be reversed before the Ace deck changes again.");
      }
      const zones = {
        hand: Array.from(result.preZones.hand ?? [], String),
        discard: Array.from(result.preZones.discard ?? [], String),
        vanguard: Array.from(result.preZones.vanguard ?? [], String),
      };
      const next = this.#nextState(current, zones);
      const event = {
        kind: "magic-cards-reverse",
        conflictId: current.conflict.id,
        combatUuid: current.conflict.combatUuid,
        sceneUuid: current.conflict.sceneUuid,
        sourceFuid: PROJECTFU_FUIDS.MAGIC_CARDS,
        summary: "Reversed Magic Cards and restored the prior card zones.",
        public: true,
        cardIds: Array.from(result.cardIds ?? [], String),
        movements: [],
        details: { triggerMessageId: message.id, reversedResultId: String(result.resultId ?? "") },
      };
      const committed = await stateCommitService.commit({ ...tx, current, next, userId: senderUserId, event });
      const reverted = message.getFlag?.("projectfu", "RevertedAction") ?? message.flags?.projectfu?.RevertedAction ?? [];
      await message.setFlag("projectfu", "RevertedAction", Array.from(new Set([...(Array.isArray(reverted) ? reverted : []), MAGIC_CARDS_REVERSE_ACTION])));
      return publicView(actor, committed.state, requester);
    }, payload);
  }

  async discard(payload, senderUserId) { return this.#move(payload, senderUserId, "hand", "discard", "discard", "Discarded a card from hand."); }

  async gmMoveCard(payload, senderUserId) {
    return this.#mutate(payload, senderUserId, async ({ current, requester }) => {
      if (!requester.isGM) throw new Error("Only a GM may move cards between Piles.");
      this.#requireActive(current);
      const cardId = String(payload.cardId ?? "");
      const fromZone = String(payload.fromZone ?? "");
      const toZone = String(payload.toZone ?? "");
      const zonesAllowed = new Set(["hand", "discard", "vanguard"]);
      if (!zonesAllowed.has(fromZone) || !zonesAllowed.has(toZone) || fromZone === toZone) throw new Error("Choose two different valid card zones.");
      const zones = foundry.utils.deepClone(current.zones);
      const sourceIndex = zones[fromZone].indexOf(cardId);
      if (sourceIndex < 0) throw new Error(`Card ${cardId} is no longer in ${fromZone}.`);
      const movements = [];
      zones[fromZone].splice(sourceIndex, 1);
      if (toZone === "vanguard" && zones.vanguard.length >= 3) {
        const displaced = zones.vanguard.shift();
        zones[fromZone].splice(Math.min(sourceIndex, zones[fromZone].length), 0, displaced);
        movements.push({ cardId: displaced, from: "vanguard", to: fromZone });
      }
      zones[toZone].push(cardId);
      movements.unshift({ cardId, from: fromZone, to: toZone });
      return {
        next: this.#nextState(current, zones),
        event: {
          kind: "gm-piles-move",
          conflictId: current.conflict.id,
          summary: `GM moved ${cardLabel(cardId)} from ${fromZone} to ${toZone}.`,
          cardIds: movements.map((entry) => entry.cardId),
          movements,
          public: true,
        },
      };
    });
  }
  async #move(payload, senderUserId, from, to, kind, summary) {
    return this.#mutate(payload, senderUserId, async ({ current, requester }) => {
      this.#requireActive(current);
      const result = moveCard(current.zones, payload.cardId, from, to);
      return { next: this.#nextState(current, result.zones), event: { kind, conflictId: current.conflict.id, summary, cardIds: [payload.cardId], movements: [result.movement], public: to === "discard" } };
    });
  }

  #nextState(current, zones) {
    return { ...foundry.utils.deepClone(current), schemaVersion: ACTOR_DECK_SCHEMA_VERSION, revision: Number(current.revision) + 1, zones };
  }

  #requireActive(current) {
    if (current.status === DECK_STATUS.CORRUPT) {
      throw new Error("This Ace deck needs GM review before play can continue.");
    }
    if (current.status !== DECK_STATUS.ACTIVE || !current.conflict?.active) throw new Error("This Ace deck is not active.");
  }

  async #mutate(payload, senderUserId, prepare) {
    const requester = game.users.get(senderUserId);
    const actor = await projectFUAdapter.resolveActor(payload.actorUuid);
    if (!requester || !actor) throw new Error("Unable to resolve the Actor or requesting user.");
    if (!projectFUAdapter.canUserManageActor(actor, requester) && !requester.isGM) throw new Error("You do not own this Actor.");
    if (!projectFUAdapter.hasMagicCards(actor)) throw new Error("This Actor does not possess Magic Cards.");
    return transactionService.run(actor, senderUserId, async (tx) => {
      const current = tx.source;
      if (payload.expectedRevision !== undefined && Number(payload.expectedRevision) !== Number(current.revision)) throw new Error("This Ace deck changed. Refresh and try again.");
      const { next, event } = await prepare({ actor, requester, current, tx });
      event.combatUuid ??= current.conflict?.combatUuid ?? tx.context?.combatUuid ?? "";
      event.sceneUuid ??= current.conflict?.sceneUuid ?? tx.context?.sceneUuid ?? "";
      const committed = await stateCommitService.commit({ ...tx, current, next, userId: senderUserId, event });
      return publicView(actor, committed.state, requester);
    }, payload);
  }
}

export const deckPlayService = new AceDeckPlayService();
