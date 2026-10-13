import { DECK_STATUS, MODULE_ID, PLAY_STATE_CHANGED_HOOK, SETTINGS } from "../constants.mjs";
import { projectFUAdapter } from "../integrations/projectfu-adapter.mjs";
import {
  actorDeckStore,
  encounterStorageKey,
  setCrossEncounterDeckMode,
} from "./actor-deck-store.mjs";
import {
  actorIsInCombat,
  combatantActors,
  encounterContextFromCombat,
  startedCombats,
} from "./encounter-context-service.mjs";
import { deckPlayService } from "./deck-play-service.mjs";
import { Log } from "../util/log.mjs";

let initialized = false;
let applyingSetting = false;
let currentMode = false;
let hooksRegistered = false;

class PersistentMigrationCancelledError extends Error {
  constructor() {
    super("Cross-Encounter Deck change canceled. No deck state was changed.");
    this.name = "PersistentMigrationCancelledError";
  }
}

function activeGmIsSelf() {
  return globalThis.game?.users?.activeGM?.isSelf === true;
}

function uniformStoredMode() {
  const modes = new Set(actorDeckStore.actorsWithDecks()
    .map((actor) => actorDeckStore.getContainer(actor)?.configuration?.crossEncounterDeck === true));
  return modes.size === 1 ? Array.from(modes)[0] : null;
}

async function restoreWorldSetting(value) {
  applyingSetting = true;
  try {
    await game.settings.set(MODULE_ID, SETTINGS.CROSS_ENCOUNTER_DECK, value === true);
  } finally {
    applyingSetting = false;
  }
}

function escape(value) {
  const text = String(value ?? "");
  return globalThis.foundry?.utils?.escapeHTML?.(text)
    ?? text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function sceneNameForUuid(sceneUuid) {
  const uuid = String(sceneUuid ?? "");
  if (!uuid) return "Unknown Scene";
  let scene = null;
  try { scene = globalThis.fromUuidSync?.(uuid) ?? null; } catch (_) {}
  const sceneId = uuid.startsWith("Scene.") ? uuid.slice("Scene.".length) : uuid;
  scene ??= globalThis.game?.scenes?.get?.(sceneId) ?? null;
  return String(scene?.name ?? uuid);
}

function combatNameForUuid(combatUuid) {
  const uuid = String(combatUuid ?? "");
  if (!uuid) return "Unknown Encounter";
  let combat = null;
  try { combat = globalThis.fromUuidSync?.(uuid) ?? null; } catch (_) {}
  combat ??= globalThis.game?.combats?.get?.(encounterStorageKey(uuid)) ?? null;
  return String(combat?.name ?? combat?.title ?? uuid);
}

function encounterChoices(container) {
  return Object.values(container?.encounters ?? {}).map((record) => ({
    combatUuid: String(record.conflict?.combatUuid ?? ""),
    combatName: combatNameForUuid(record.conflict?.combatUuid),
    sceneUuid: String(record.conflict?.sceneUuid ?? record.sceneUuid ?? ""),
    sceneName: sceneNameForUuid(record.conflict?.sceneUuid ?? record.sceneUuid),
  }));
}

function activeEncounterChoices(actor, container) {
  const records = container?.encounters ?? {};
  const choices = new Map();
  for (const combat of startedCombats()) {
    if (!actorIsInCombat(actor, combat)) continue;
    const context = encounterContextFromCombat(combat);
    const storageKey = encounterStorageKey(context.combatUuid);
    const record = storageKey ? records[storageKey] : null;
    if (!record) continue;
    const combatUuid = String(context.combatUuid ?? record.conflict?.combatUuid ?? "");
    const sceneUuid = String(context.sceneUuid ?? record.conflict?.sceneUuid ?? record.sceneUuid ?? "");
    if (!combatUuid || choices.has(combatUuid)) continue;
    choices.set(combatUuid, {
      combatUuid,
      combatName: String(combat?.name ?? combat?.title ?? combatNameForUuid(combatUuid)),
      sceneUuid,
      sceneName: sceneNameForUuid(sceneUuid),
    });
  }
  return Array.from(choices.values());
}

async function chooseMigrationSource(actor, encounters) {
  if (!encounters.length) return "";
  if (encounters.length === 1) {
    const source = encounters[0];
    const content = `<p><strong>${escape(actor.name ?? actor.uuid)}</strong> has an active encounter deck in <strong>${escape(source.sceneName)}</strong>.</p>
      <p>Migrate that exact state into the persistent deck, or start the persistent deck fresh when it is first opened?</p>`;
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: "Create Persistent Deck" },
      content,
      buttons: [
        { action: "cancel", label: "Cancel", callback: () => null },
        { action: "fresh", label: "Start Fresh", callback: () => "" },
        { action: "migrate", label: `Migrate ${source.sceneName}`, default: true, callback: () => source.combatUuid },
      ],
    });
    if (choice === null || choice === undefined) throw new PersistentMigrationCancelledError();
    return String(choice);
  }

  const duplicateScenes = new Set(encounters
    .map((entry) => entry.sceneName)
    .filter((name, index, names) => names.indexOf(name) !== index));
  const options = [
    '<option value="">Start Fresh</option>',
    ...encounters.map((entry) => {
      const label = duplicateScenes.has(entry.sceneName)
        ? `${entry.sceneName} — ${entry.combatName}`
        : entry.sceneName;
      return `<option value="${escape(entry.combatUuid)}">Migrate ${escape(label)}</option>`;
    }),
  ].join("");
  const content = `<form class="ace-persistent-migration-dialog">
    <p><strong>${escape(actor.name ?? actor.uuid)}</strong> has multiple active encounter decks. Choose one state to migrate, or start fresh.</p>
    <label><span>Persistent Deck Source</span><select name="combatUuid">${options}</select></label>
  </form>`;
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: "Create Persistent Deck" },
    content,
    buttons: [
      { action: "cancel", label: "Cancel", callback: () => null },
      {
        action: "choose",
        label: "Continue",
        default: true,
        callback: (_event, actionButton) => String(actionButton.form.elements.combatUuid?.value ?? ""),
      },
    ],
  });
  if (choice === null || choice === undefined) throw new PersistentMigrationCancelledError();
  return String(choice);
}

async function collectMigrationSelections(target, { prompt = false } = {}) {
  const selections = new Map();
  if (!target) return selections;
  for (const actor of actorDeckStore.actorsWithDecks()) {
    const container = actorDeckStore.getContainer(actor);
    if (!container) continue;
    const pending = container.status === DECK_STATUS.MIGRATION_PENDING;
    if (container.configuration?.crossEncounterDeck === true && !pending) continue;
    const encounters = activeEncounterChoices(actor, container);
    if (!encounters.length) {
      selections.set(String(actor.uuid ?? ""), "");
      continue;
    }
    if (!prompt) throw new Error(`A GM must choose whether to migrate ${actor.name ?? actor.uuid}'s active encounter deck.`);
    selections.set(String(actor.uuid ?? ""), await chooseMigrationSource(actor, encounters));
  }
  return selections;
}

function conversionPlan(target, selections = new Map()) {
  const changes = [];
  for (const actor of actorDeckStore.actorsWithDecks()) {
    const current = actorDeckStore.getContainer(actor);
    if (!current) continue;
    const pending = current.status === DECK_STATUS.MIGRATION_PENDING;
    if (current.configuration?.crossEncounterDeck === target && !(target && pending)) continue;
    const migrationCombatUuid = target ? String(selections.get(String(actor.uuid ?? "")) ?? "") : "";
    const next = setCrossEncounterDeckMode(current, target, { migrationCombatUuid });
    const migrated = migrationCombatUuid
      ? encounterChoices(current).find((entry) => entry.combatUuid === migrationCombatUuid) ?? null
      : null;
    changes.push({ actor, current, next, migrated });
  }
  return changes;
}

function publishModeChange(actor, stored, target, operation = "settings.crossEncounterDeck") {
  Hooks.callAll(PLAY_STATE_CHANGED_HOOK, actor.uuid, {
    actorUuid: actor.uuid,
    rootRevision: Number(stored.revision ?? 0),
    revision: null,
    status: String(stored.status ?? ""),
    openingComplete: Boolean(stored.persistent?.openingComplete),
    crossEncounterDeck: target === true,
    combatUuid: "",
    sceneUuid: "",
    operation,
    sourceUserId: String(globalThis.game?.user?.id ?? ""),
  });
}

async function applyPlan(changes, target) {
  const applied = [];
  try {
    for (const entry of changes) {
      const stored = await actorDeckStore.set(entry.actor, entry.next);
      applied.push(entry);
      publishModeChange(entry.actor, stored, target);
    }
  } catch (error) {
    for (const entry of applied.reverse()) {
      try {
        const restored = await actorDeckStore.set(entry.actor, entry.current);
        publishModeChange(entry.actor, restored, entry.current.configuration?.crossEncounterDeck === true, "settings.crossEncounterDeck.rollback");
      } catch (rollbackError) {
        Log.error(`Unable to roll back the deck mode for ${entry.actor.name ?? entry.actor.uuid}.`, rollbackError);
      }
    }
    throw error;
  }
}

function reportMigrations(changes) {
  const report = changes.map((entry) => ({
    actorUuid: String(entry.actor.uuid ?? ""),
    actorName: String(entry.actor.name ?? entry.actor.uuid ?? "Unknown Actor"),
    source: entry.migrated ?? "fresh-on-first-open",
  }));
  if (report.length) console.info(`${MODULE_ID} | Persistent Deck migration`, report);
  return changes
    .filter((entry) => entry.migrated)
    .map((entry) => `${entry.actor.name ?? entry.actor.uuid}: ${entry.migrated.sceneName}`);
}

async function initializeActiveEncounterDecks() {
  if (!activeGmIsSelf()) return;
  for (const combat of startedCombats()) {
    const context = encounterContextFromCombat(combat);
    for (const actor of combatantActors(combat)) {
      if (actor?.type !== "character" || !projectFUAdapter.hasMagicCards(actor)) continue;
      await deckPlayService.startEncounter({ actorUuid: actor.uuid, ...context }, game.user.id);
    }
  }
}

async function reconcileWorldMode(target, { notify = false, prompt = false } = {}) {
  if (!activeGmIsSelf()) return { changed: 0, migrated: [] };
  const selections = await collectMigrationSelections(target, { prompt });
  const changes = conversionPlan(target, selections);
  await applyPlan(changes, target);
  const migrated = reportMigrations(changes);
  if (!target) await initializeActiveEncounterDecks();

  if (notify) {
    if (target && migrated.length) {
      ui.notifications.info(`Cross-Encounter Deck enabled. Migrated: ${migrated.join("; ")}.`);
    } else if (target) {
      ui.notifications.info("Cross-Encounter Deck enabled. Actor decks will initialize when opened.");
    } else {
      ui.notifications.info("Cross-Encounter Deck disabled. Active encounters now use encounter-scoped decks.");
    }
  }
  return { changed: changes.length, migrated };
}

export function registerCrossEncounterWorldHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
}

export async function initializeCrossEncounterWorldSetting() {
  const target = Boolean(game.settings.get(MODULE_ID, SETTINGS.CROSS_ENCOUNTER_DECK));
  currentMode = target;
  initialized = true;
  if (!activeGmIsSelf()) return;
  const fallback = uniformStoredMode();
  try {
    const result = await reconcileWorldMode(target, { notify: false, prompt: true });
    if (result.changed) Log.info(`Reconciled ${result.changed} Actor deck(s) to the world-wide deck mode.`);
  } catch (error) {
    if (error instanceof PersistentMigrationCancelledError) {
      Log.warn(error.message);
      if (fallback !== null && fallback !== target) {
        await restoreWorldSetting(fallback);
        currentMode = fallback;
      }
      return;
    }
    Log.error("Unable to reconcile the world-wide deck mode.", error);
    ui.notifications.warn(error.message);
    if (fallback !== null && fallback !== target) {
      await restoreWorldSetting(fallback);
      currentMode = fallback;
    }
  }
}

export function handleCrossEncounterWorldSettingChange(value) {
  const target = value === true;
  if (!initialized || applyingSetting || !activeGmIsSelf()) {
    if (!initialized) currentMode = target;
    return;
  }
  if (target === currentMode) return;

  const previous = currentMode;
  void (async () => {
    applyingSetting = true;
    try {
      await reconcileWorldMode(target, { notify: true, prompt: true });
      currentMode = target;
    } catch (error) {
      if (error instanceof PersistentMigrationCancelledError) {
        Log.warn(error.message);
        ui.notifications.warn(error.message);
      } else {
        Log.error("World-wide deck mode change failed.", error);
        ui.notifications.error(error.message);
      }
      await game.settings.set(MODULE_ID, SETTINGS.CROSS_ENCOUNTER_DECK, previous);
      currentMode = previous;
    } finally {
      applyingSetting = false;
    }
  })();
}
