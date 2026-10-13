import { openDeckManager } from "./apps/deck-manager-app.mjs";
import { MODULE_ID, SETTINGS } from "./constants.mjs";
import { isDeckPlayOpen, openDeckPlay, toggleDeckPlay } from "./apps/deck-play-app.mjs";
import { openDeckExtras } from "./apps/deck-play-extras-app.mjs";
import { inspectCoreCompatibility } from "./compat/core-compatibility.mjs";
import { CARD_DEFINITIONS, CARD_IDS, createCanonicalDeckIds, getCardDefinition } from "./cards/card-catalog.mjs";
import { getStyle, listStyles, replaceHydratedStyles, resolveCardBack, resolveCardFace } from "./cards/style-registry.mjs";
import { evaluateSet, resolveSetEffect, SET_EFFECTS } from "./cards/set-resolver.mjs";
import { validateRuntimeContracts } from "./data/runtime-contracts.mjs";
import { projectFUAdapter } from "./integrations/projectfu-adapter.mjs";
import { deckConfigurationService } from "./services/deck-configuration-service.mjs";
import { deckPlayService } from "./services/deck-play-service.mjs";
import { socketService } from "./services/socket-service.mjs";
import { actorDeckStore } from "./services/actor-deck-store.mjs";
import { AceDeckLaunchError } from "./services/deck-launch-feedback.mjs";
import {
  actorIsInCombat,
  combatStarted,
  combatantActors,
  findCombatByUuid,
  resolveEncounterContext,
} from "./services/encounter-context-service.mjs";


async function synchronizeStyles() {
  const library = await socketService.request("style.list");
  replaceHydratedStyles(library.styles, library.activeStyleId);
  return library;
}

async function mutateStyle(operation, payload) {
  const result = await socketService.request(operation, payload);
  await synchronizeStyles();
  return result;
}

function actorFromUuid(actorUuid) {
  const uuid = String(actorUuid ?? "");
  if (!uuid) return null;
  try {
    const document = globalThis.fromUuidSync?.(uuid);
    if (document?.documentName === "Actor") return document;
  } catch (_) {}
  const id = uuid.startsWith("Actor.") ? uuid.slice("Actor.".length) : uuid;
  return game.actors?.get?.(id) ?? null;
}

function explicitActor(actorOrUuid = null) {
  if (actorOrUuid?.documentName === "Actor") return actorOrUuid;
  if (actorOrUuid?.actor?.documentName === "Actor") return actorOrUuid.actor;
  if (typeof actorOrUuid === "string") return actorFromUuid(actorOrUuid);
  return null;
}

function launchableEncounterActors(combat) {
  return combatantActors(combat)
    .filter((actor) => actor?.type === "character")
    .filter((actor) => projectFUAdapter.hasMagicCards(actor))
    .filter((actor) => projectFUAdapter.canUserViewActor(actor, game.user));
}

function persistentMode() {
  return game.settings.get(MODULE_ID, SETTINGS.CROSS_ENCOUNTER_DECK) === true;
}

function eligiblePersistentActor(actor) {
  return Boolean(
    actor
    && actor?.type === "character"
    && projectFUAdapter.hasMagicCards(actor)
    && projectFUAdapter.canUserViewActor(actor, game.user)
  );
}

function resolvePersistentActor(actorOrUuid = null) {
  const requested = explicitActor(actorOrUuid);
  if (actorOrUuid && !requested) throw new AceDeckLaunchError("Unable to resolve the requested Actor.", "actor-unresolved");
  if (requested) {
    if (!projectFUAdapter.hasMagicCards(requested)) throw new AceDeckLaunchError("This Actor does not possess Magic Cards.", "missing-magic-cards");
    if (!projectFUAdapter.canUserViewActor(requested, game.user)) throw new AceDeckLaunchError("You do not have permission to view this Actor's Ace deck.", "permission-denied");
    return requested;
  }

  const controlled = Array.from(globalThis.canvas?.tokens?.controlled ?? [])
    .map((token) => token?.actor ?? token?.document?.actor)
    .find(eligiblePersistentActor);
  if (controlled) return controlled;

  const character = game.user?.character;
  if (eligiblePersistentActor(character)) return character;

  const candidates = Array.from(game.actors ?? []).filter(eligiblePersistentActor);
  if (candidates.length === 1) return candidates[0];
  throw new AceDeckLaunchError("Select an Actor with Magic Cards or assign one as your character.", "actor-selection-required");
}

function resolveActorDeckLaunch(actorOrUuid = null) {
  if (persistentMode()) {
    const actor = resolvePersistentActor(actorOrUuid);
    return { actorUuid: actor.uuid, combatUuid: "", sceneUuid: "" };
  }

  const requested = explicitActor(actorOrUuid);
  if (actorOrUuid && !requested) throw new AceDeckLaunchError("Unable to resolve the requested Actor.", "actor-unresolved");
  const context = resolveEncounterContext({ actorUuid: requested?.uuid });
  const combat = context.combatUuid ? findCombatByUuid(context.combatUuid) : null;
  if (!combatStarted(combat)) throw new AceDeckLaunchError("There is no started Encounter available for this Actor or Scene.", "no-started-encounter");
  if (requested) {
    if (!actorIsInCombat(requested, combat)) throw new AceDeckLaunchError("This Actor is not a combatant in the current Encounter.", "actor-not-in-encounter");
    if (!projectFUAdapter.hasMagicCards(requested)) throw new AceDeckLaunchError("This Actor does not possess Magic Cards.", "missing-magic-cards");
    if (!projectFUAdapter.canUserViewActor(requested, game.user)) throw new AceDeckLaunchError("You do not have permission to view this Actor's Ace deck.", "permission-denied");
    return { actorUuid: requested.uuid, ...context };
  }

  const controlled = Array.from(globalThis.canvas?.tokens?.controlled ?? [])
    .map((token) => token?.actor ?? token?.document?.actor)
    .find((actor) => actor && actorIsInCombat(actor, combat) && projectFUAdapter.hasMagicCards(actor) && projectFUAdapter.canUserViewActor(actor, game.user));
  if (controlled) return { actorUuid: controlled.uuid, ...context };

  const character = game.user?.character;
  if (character && actorIsInCombat(character, combat) && projectFUAdapter.hasMagicCards(character) && projectFUAdapter.canUserViewActor(character, game.user)) {
    return { actorUuid: character.uuid, ...context };
  }

  const candidates = launchableEncounterActors(combat);
  if (candidates.length === 1) return { actorUuid: candidates[0].uuid, ...context };
  throw new AceDeckLaunchError("Select an Ace combatant in the current Encounter or assign one as your character.", "actor-selection-required");
}

async function ensureLaunchState(launch) {
  await socketService.request("play.ensureDeck", launch);
  return launch;
}

export async function openActorDeck(actorOrUuid = null) {
  const launch = await ensureLaunchState(resolveActorDeckLaunch(actorOrUuid));
  return openDeckPlay(launch);
}

export async function toggleActorDeck(actorOrUuid = null) {
  if (isDeckPlayOpen()) return toggleDeckPlay();
  const launch = await ensureLaunchState(resolveActorDeckLaunch(actorOrUuid));
  return toggleDeckPlay(launch);
}

export async function openActorPiles(actorOrUuid = null) {
  const launch = await ensureLaunchState(resolveActorDeckLaunch(actorOrUuid));
  return openDeckExtras(launch);
}

export function createPublicApi() {
  return Object.freeze({
    openDeckManager,
    openDeckPlay,
    toggleDeckPlay,
    openActorDeck,
    toggleActorDeck,
    openActorPiles,
    macro: Object.freeze({ openDeck: openActorDeck, toggleDeck: toggleActorDeck, openPiles: openActorPiles }),
    inspectCoreCompatibility,
    projectFU: projectFUAdapter,
    storage: actorDeckStore,
    actorStorage: actorDeckStore,
    decks: deckConfigurationService,
    play: deckPlayService,
    socket: socketService,
    cards: Object.freeze({ CARD_DEFINITIONS, CARD_IDS, createCanonicalDeckIds, getCardDefinition }),
    styles: Object.freeze({
      get: getStyle,
      listCached: listStyles,
      list: synchronizeStyles,
      current: () => getStyle(),
      create: (payload) => mutateStyle("style.create", payload),
      update: (payload) => mutateStyle("style.update", payload),
      activate: (styleId) => mutateStyle("style.activate", { styleId }),
      selectMine: (styleId) => mutateStyle("style.assign", { styleId, userId: game.user.id }),
      assignUser: (userId, styleId) => mutateStyle("style.assign", { styleId, userId }),
      delete: (styleId) => mutateStyle("style.delete", { styleId }),
      resolveCardFace,
      resolveCardBack,
    }),
    resolver: Object.freeze({ evaluateSet, resolveSetEffect, SET_EFFECTS }),
    contracts: Object.freeze({ validate: validateRuntimeContracts }),
    models: Object.freeze({ validateContracts: validateRuntimeContracts }),
  });
}
