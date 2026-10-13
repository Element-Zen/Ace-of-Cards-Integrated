import { MODULE_ID, PLAY_STATE_CHANGED_HOOK, SETTINGS } from "../constants.mjs";
import {
  closeDeckPlay,
  closeDeckPlayForEncounter,
  isDeckPlayOpen,
  openDeckPlay,
} from "../apps/deck-play-app.mjs";
import { projectFUAdapter } from "../integrations/projectfu-adapter.mjs";
import {
  actorDeckHasEncounter,
  actorDeckStore,
} from "../services/actor-deck-store.mjs";
import {
  actorIsInCombat,
  combatStarted,
  combatantActors,
  encounterContextFromCombat,
  findCombatByUuid,
  resolveEncounterContext,
  startedCombats,
} from "../services/encounter-context-service.mjs";
import { encounterOpeningComplete } from "../services/encounter-opening-state.mjs";
import { socketService } from "../services/socket-service.mjs";
import { Log } from "../util/log.mjs";

const knownStarted = new Map();
const startingCombats = new Set();
const combatQueues = new Map();
const drawerWaits = new Map();

function actorUuid(actor) {
  return String(actor?.uuid ?? "");
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function eligibleActors(combat) {
  return combatantActors(combat)
    .filter((actor) => actor?.type === "character")
    .filter((actor) => projectFUAdapter.hasMagicCards(actor));
}

function isAuthority() {
  return Boolean(game.users?.activeGM?.isSelf);
}

function persistentMode() {
  return game.settings.get(MODULE_ID, SETTINGS.CROSS_ENCOUNTER_DECK) === true;
}

async function startActorEncounter(actor, combat) {
  const context = encounterContextFromCombat(combat);
  return socketService.request("play.startEncounter", { actorUuid: actor.uuid, ...context });
}

async function endActorEncounter(actor, context) {
  return socketService.request("play.endEncounter", { actorUuid: actor.uuid, ...context });
}

async function waitForStartedCombat(combatUuid, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const combat = findCombatByUuid(combatUuid);
    if (combatStarted(combat)) return combat;
    await pause(50);
  }
  return findCombatByUuid(combatUuid);
}

async function cleanupEncounter(context) {
  if (persistentMode() || !context.combatUuid) return;
  for (const actor of actorDeckStore.actorsWithDecks()) {
    const container = actorDeckStore.getContainer(actor);
    if (!actorDeckHasEncounter(container, context.combatUuid)) continue;
    await endActorEncounter(actor, context);
  }
}

async function synchronizeCombat(combat, { autoOpen = false, requireStarted = false } = {}) {
  if (!isAuthority() || !combat?.uuid) return [];

  const combatUuid = String(combat.uuid);
  const liveCombat = requireStarted
    ? await waitForStartedCombat(combatUuid)
    : findCombatByUuid(combatUuid) ?? combat;
  const context = encounterContextFromCombat(liveCombat ?? combat);
  if (!context.combatUuid) return [];

  if (persistentMode()) {
    if (combatStarted(liveCombat) && autoOpen) void enqueueDrawerOpen(liveCombat);
    return [];
  }

  if (!combatStarted(liveCombat)) {
    startingCombats.delete(combatUuid);
    if (requireStarted) {
      knownStarted.set(combatUuid, false);
      return [];
    }
    await cleanupEncounter(context);
    await closeDeckPlayForEncounter(context.combatUuid);
    return [];
  }

  startingCombats.delete(combatUuid);
  const actors = eligibleActors(liveCombat);
  const participantUuids = new Set(actors.map(actorUuid));
  const startedStates = [];

  // Preserve the alpha.61 engagement rule: each startEncounter call completes its
  // opening five-card draw before any drawer is allowed to render.
  for (const actor of actors) {
    const state = await startActorEncounter(actor, liveCombat);
    if (!encounterOpeningComplete(state, context.combatUuid)) {
      throw new Error(`Ace Encounter opening did not complete for ${actor.name}.`);
    }
    startedStates.push(state);
    Log.debug("Ace Encounter opening committed.", {
      actorUuid: actor.uuid,
      combatUuid: context.combatUuid,
      handCount: Number(state.counts?.hand ?? 0),
      deckCount: Number(state.counts?.deck ?? 0),
      openingComplete: state.openingComplete === true,
    });
  }

  for (const actor of actorDeckStore.actorsWithDecks()) {
    const container = actorDeckStore.getContainer(actor);
    if (!actorDeckHasEncounter(container, context.combatUuid)) continue;
    if (participantUuids.has(actorUuid(actor))) continue;
    await endActorEncounter(actor, context);
  }

  if (autoOpen) {
    void enqueueDrawerOpen(liveCombat);
  }

  return startedStates;
}

function enqueueCombatSync(combat, options = {}) {
  if (!isAuthority() || !combat?.uuid) return Promise.resolve([]);
  const key = String(combat.uuid);
  const previous = combatQueues.get(key) ?? Promise.resolve();
  const queued = previous
    .catch(() => undefined)
    .then(() => synchronizeCombat(combat, options))
    .catch((error) => {
      Log.error("Unable to synchronize Ace encounter state with Foundry Combat.", error);
      ui.notifications.error(error.message);
      return [];
    })
    .finally(() => {
      if (combatQueues.get(key) === queued) combatQueues.delete(key);
    });
  combatQueues.set(key, queued);
  return queued;
}

function enqueueDeletedEncounterCleanup(combat) {
  if (!isAuthority() || !combat?.uuid) return Promise.resolve();
  const key = String(combat.uuid);
  const context = encounterContextFromCombat(combat);
  const previous = combatQueues.get(key) ?? Promise.resolve();
  const queued = previous
    .catch(() => undefined)
    .then(() => cleanupEncounter(context))
    .catch((error) => {
      Log.error("Unable to close a deleted Ace encounter instance.", error);
      ui.notifications.error(error.message);
    })
    .finally(() => {
      if (combatQueues.get(key) === queued) combatQueues.delete(key);
    });
  combatQueues.set(key, queued);
  return queued;
}

function manageableEncounterActors(combat) {
  return eligibleActors(combat).filter((actor) => projectFUAdapter.canUserManageActor(actor, game.user));
}

function controlledEncounterActor(combat) {
  return Array.from(canvas?.tokens?.controlled ?? [])
    .map((token) => token?.actor ?? token?.document?.actor)
    .find((actor) => actor && actorIsInCombat(actor, combat) && projectFUAdapter.hasMagicCards(actor))
    ?? null;
}

export function resolveEncounterDrawerActor(combat) {
  if (!combatStarted(combat)) return null;
  const controlled = controlledEncounterActor(combat);
  if (controlled && projectFUAdapter.canUserViewActor(controlled, game.user)) return controlled;

  const character = game.user?.character;
  if (character && actorIsInCombat(character, combat) && projectFUAdapter.hasMagicCards(character)) return character;

  const manageable = manageableEncounterActors(combat);
  return manageable.length === 1 ? manageable[0] : null;
}

export function resolveEncounterAutoOpenActor(combat) {
  if (!combatStarted(combat)) return null;
  if (!game.user?.isGM) return resolveEncounterDrawerActor(combat);

  const selectedUuid = String(game.settings.get(MODULE_ID, SETTINGS.ENCOUNTER_AUTO_OPEN_ACTOR) ?? "");
  if (!selectedUuid) return null;
  const actor = Array.from(game.actors ?? []).find((candidate) => String(candidate?.uuid ?? candidate?.id ?? "") === selectedUuid) ?? null;
  if (!actor || !actorIsInCombat(actor, combat) || !projectFUAdapter.hasMagicCards(actor)) return null;
  return projectFUAdapter.canUserViewActor(actor, game.user) ? actor : null;
}

export async function synchronizeDrawerToCurrentEncounter({ autoOpen = false, expectedCombatUuid = "" } = {}) {
  if (persistentMode()) return null;
  const context = resolveEncounterContext();
  if (expectedCombatUuid && context.combatUuid !== expectedCombatUuid) return null;
  const combat = context.combatUuid ? findCombatByUuid(context.combatUuid) : null;
  if (!combatStarted(combat)) {
    if (isDeckPlayOpen()) await closeDeckPlay();
    return null;
  }

  const actor = resolveEncounterDrawerActor(combat);
  if (!actor) {
    if (isDeckPlayOpen()) await closeDeckPlay();
    return null;
  }

  if (autoOpen || isDeckPlayOpen()) {
    const state = await socketService.request("play.getState", { actorUuid: actor.uuid, ...context });
    if (!encounterOpeningComplete(state, context.combatUuid)) {
      Log.debug("Ace drawer did not open because the Encounter opening is incomplete.", {
        actorUuid: actor.uuid,
        combatUuid: context.combatUuid,
        handCount: Number(state?.counts?.hand ?? 0),
        deckCount: Number(state?.counts?.deck ?? 0),
        openingComplete: state?.openingComplete === true,
      });
      return null;
    }
    return openDeckPlay({ actorUuid: actor.uuid, ...context });
  }
  return null;
}

async function waitForEncounterStateAndOpen(combat) {
  const key = String(combat?.uuid ?? "");
  if (!key) return null;
  let observedCurrentContext = false;
  let observedDrawerActor = false;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const liveCombat = findCombatByUuid(key);
    if (!combatStarted(liveCombat)) {
      await pause(100);
      continue;
    }

    const currentContext = resolveEncounterContext();
    if (currentContext.combatUuid !== key) {
      await pause(100);
      continue;
    }
    observedCurrentContext = true;

    const actor = resolveEncounterAutoOpenActor(liveCombat);
    if (!actor) {
      if (game.user?.isGM) return null;
      await pause(100);
      continue;
    }
    observedDrawerActor = true;

    try {
      if (persistentMode()) {
        const state = await socketService.request("play.ensureDeck", { actorUuid: actor.uuid });
        if (state?.status === "active") return openDeckPlay({ actorUuid: actor.uuid, combatUuid: "", sceneUuid: "" });
      } else {
        const state = await socketService.request("play.getState", {
          actorUuid: actor.uuid,
          ...currentContext,
        });
        if (encounterOpeningComplete(state, key)) {
          return openDeckPlay({ actorUuid: actor.uuid, ...currentContext });
        }
      }
    } catch (error) {
      Log.debug(persistentMode() ? "Ace drawer is waiting for the persistent deck." : "Ace drawer is waiting for the Encounter opening hand.", error);
    }

    await pause(100);
  }

  if (observedCurrentContext && observedDrawerActor) {
    Log.warn(`Ace encounter ${key} did not publish an opening hand before the drawer wait expired.`);
  }
  return null;
}

function enqueueDrawerOpen(combat) {
  const key = String(combat?.uuid ?? "");
  if (!key) return Promise.resolve(null);
  const existing = drawerWaits.get(key);
  if (existing) return existing;
  const waiting = waitForEncounterStateAndOpen(combat)
    .catch((error) => {
      Log.error("Unable to open the Ace drawer for the started Encounter.", error);
      ui.notifications.error(error.message);
      return null;
    })
    .finally(() => {
      if (drawerWaits.get(key) === waiting) drawerWaits.delete(key);
    });
  drawerWaits.set(key, waiting);
  return waiting;
}

function rememberCombat(combat) {
  if (!combat?.uuid) return { began: false, ended: false, started: false };
  const key = String(combat.uuid);
  const wasStarted = knownStarted.get(key) ?? false;
  const started = combatStarted(combat);
  knownStarted.set(key, started);
  return {
    began: !wasStarted && started,
    ended: wasStarted && !started,
    started,
  };
}

function forgetCombat(combat) {
  const key = String(combat?.uuid ?? "");
  if (key) {
    knownStarted.delete(key);
    startingCombats.delete(key);
  }
}

function beginEncounterLifecycle(combat) {
  if (!combat?.uuid) return;
  const key = String(combat.uuid);
  knownStarted.set(key, true);

  // Opening the drawer is part of the Encounter start transition on every client.
  // The waiter mounts only after the authoritative five-card opening is readable.
  void enqueueDrawerOpen(combat);

  if (!isAuthority() || startingCombats.has(key)) return;
  startingCombats.add(key);
  void enqueueCombatSync(combat, { autoOpen: true, requireStarted: true });
}

function endEncounterLifecycle(combat) {
  if (persistentMode()) return;
  const combatUuid = String(combat?.uuid ?? "");
  if (!combatUuid) return;
  void closeDeckPlayForEncounter(combatUuid);
  if (isAuthority()) void enqueueCombatSync(combat, { autoOpen: false });
}

export function initializeEncounterLifecycle() {
  if (persistentMode()) return;
  for (const combat of startedCombats()) {
    knownStarted.set(String(combat.uuid), true);
    void enqueueCombatSync(combat, { autoOpen: false });
  }
  void synchronizeDrawerToCurrentEncounter({ autoOpen: false })
    .catch((error) => Log.debug("Ace drawer context did not change during startup.", error));
}

export function registerEncounterLifecycleHooks() {
  Hooks.on("combatStart", (combat) => beginEncounterLifecycle(combat));

  Hooks.on("createCombat", (combat) => {
    const transition = rememberCombat(combat);
    if (transition.began) beginEncounterLifecycle(combat);
    else if (isAuthority()) void enqueueCombatSync(combat);
  });

  Hooks.on("updateCombat", (combat) => {
    const transition = rememberCombat(combat);
    if (transition.began) {
      beginEncounterLifecycle(combat);
      return;
    }
    if (transition.started) return;
    const key = String(combat?.uuid ?? "");
    if (transition.ended && !startingCombats.has(key) && !drawerWaits.has(key)) endEncounterLifecycle(combat);
  });

  Hooks.on("deleteCombat", (combat) => {
    const combatUuid = String(combat?.uuid ?? "");
    forgetCombat(combat);
    if (!persistentMode()) void closeDeckPlayForEncounter(combatUuid);
    if (isAuthority() && !persistentMode()) void enqueueDeletedEncounterCleanup(combat);
  });

  Hooks.on("createCombatant", (combatant) => {
    const combat = combatant?.parent ?? findCombatByUuid(combatant?.combat?.uuid ?? combatant?.combatUuid);
    if (!combatStarted(combat)) return;
    const addedActor = combatant?.actor ?? combatant?.token?.actor ?? null;
    const drawerActor = resolveEncounterAutoOpenActor(combat);
    const autoOpen = Boolean(addedActor?.uuid && drawerActor?.uuid === addedActor.uuid);
    if (isAuthority()) void enqueueCombatSync(combat, { autoOpen });
    else if (autoOpen) void enqueueDrawerOpen(combat);
  });

  const combatantChanged = (combatant) => {
    const combat = combatant?.parent ?? findCombatByUuid(combatant?.combat?.uuid ?? combatant?.combatUuid);
    if (!combat) return;
    if (isAuthority()) void enqueueCombatSync(combat);
    if (!persistentMode() && !combatStarted(combat)) void closeDeckPlayForEncounter(String(combat.uuid ?? ""));
  };
  Hooks.on("updateCombatant", combatantChanged);
  Hooks.on("deleteCombatant", combatantChanged);

  Hooks.on(PLAY_STATE_CHANGED_HOOK, (actorUuid, signal = {}) => {
    if (persistentMode()) return;
    const combatUuid = String(signal.combatUuid ?? "");
    if (!combatUuid) return;
    if (signal.operation === "play.endEncounter") {
      void closeDeckPlayForEncounter(combatUuid, { actorUuid });
      return;
    }
    if (signal.operation !== "play.startEncounter" || isAuthority() || !drawerWaits.has(combatUuid)) return;
    const combat = findCombatByUuid(combatUuid);
    const drawerActor = resolveEncounterAutoOpenActor(combat);
    if (drawerActor?.uuid !== actorUuid) return;
    void enqueueDrawerOpen(combat);
  });

  Hooks.on("canvasReady", () => {
    void synchronizeDrawerToCurrentEncounter({ autoOpen: false })
      .catch((error) => Log.debug("Ace drawer context did not change with the viewed Scene.", error));
  });
}
