import { CARD_IDS } from "../cards/card-catalog.mjs";
import {
  ACTOR_DECK_SCHEMA_VERSION,
  ACTOR_FLAGS,
  CARD_ZONES,
  DECK_STATUS,
  MODULE_ID,
  SETTINGS,
} from "../constants.mjs";
import {
  legacySuitMappingIsCustom,
  migrateLegacyCardIds,
} from "../cards/elemental-suit-migration.mjs";
import {
  combatStarted,
  findCombatByUuid,
  resolveEncounterContext,
} from "./encounter-context-service.mjs";

function clone(value) {
  return structuredClone(value ?? {});
}

function text(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function integer(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : fallback;
}

const COMBAT_UUID_PREFIX = "Combat.";
const MALFORMED_COMBAT_CONTAINER_FIELDS = new Set([
  "revision",
  "sceneUuid",
  "conflict",
  "zones",
  "reactions",
  "openingComplete",
  "configuration",
  "status",
  "schemaVersion",
  "rootRevision",
  "encounterCount",
]);

export function encounterStorageKey(value) {
  const raw = text(value?.uuid ?? value?.combatUuid ?? value);
  if (!raw) return "";
  if (raw.startsWith(COMBAT_UUID_PREFIX)) return text(raw.slice(COMBAT_UUID_PREFIX.length));
  const separator = raw.lastIndexOf(".");
  return separator >= 0 ? text(raw.slice(separator + 1)) : raw;
}

export function encounterCombatUuid(value) {
  const key = encounterStorageKey(value);
  return key ? `${COMBAT_UUID_PREFIX}${key}` : "";
}

function normalizeZones(zones = {}) {
  return Object.fromEntries(CARD_ZONES.map((zone) => [
    zone,
    migrateLegacyCardIds(Array.isArray(zones?.[zone]) ? zones[zone] : [])
      .map((entry) => text(entry))
      .filter(Boolean),
  ]));
}

function emptyZones() {
  return { hand: [], discard: [], vanguard: [] };
}

function normalizeConfiguration(configuration = {}) {
  return {
    styleId: text(configuration.styleId ?? configuration.lookId ?? configuration.skinId, "placeholder"),
    crossEncounterDeck: configuration.crossEncounterDeck === true,
  };
}

function normalizeConflict(conflict = {}, context = {}) {
  const combatUuid = text(conflict.combatUuid ?? context.combatUuid);
  const sceneUuid = text(conflict.sceneUuid ?? context.sceneUuid);
  const persistent = context.allowPersistent === true;
  const active = Boolean(conflict.active && (persistent || combatUuid));
  return {
    active,
    id: active ? text(conflict.id, persistent ? "persistent" : combatUuid) : "",
    combatUuid: active && !persistent ? combatUuid : "",
    sceneUuid: active && !persistent ? sceneUuid : "",
  };
}

export function prepareActorDeckState(source = {}) {
  const configuration = normalizeConfiguration(source.configuration);
  const conflict = normalizeConflict(source.conflict, { ...source, allowPersistent: configuration.crossEncounterDeck === true });
  const status = source.status === DECK_STATUS.CORRUPT
    ? DECK_STATUS.CORRUPT
    : source.status === DECK_STATUS.MIGRATION_PENDING
      ? DECK_STATUS.MIGRATION_PENDING
      : conflict.active ? DECK_STATUS.ACTIVE : DECK_STATUS.READY;
  const zones = normalizeZones(source.zones);
  const movedCardCount = CARD_ZONES.reduce((count, zone) => count + zones[zone].length, 0);
  const openingComplete = status === DECK_STATUS.ACTIVE
    ? (source.openingComplete === true || movedCardCount > 0)
    : false;
  const prepared = {
    schemaVersion: ACTOR_DECK_SCHEMA_VERSION,
    rootRevision: integer(source.rootRevision ?? source.revision),
    revision: integer(source.revision),
    status,
    openingComplete,
    configuration,
    conflict,
    zones,
    encounterCount: integer(source.encounterCount, conflict.active ? 1 : 0),
  };
  validateActorDeckState(prepared);
  return prepared;
}

export function validateActorDeckState(data = {}) {
  if (Number(data.schemaVersion) !== ACTOR_DECK_SCHEMA_VERSION) throw new Error("Actor deck schema version is invalid.");
  if (![DECK_STATUS.READY, DECK_STATUS.ACTIVE, DECK_STATUS.CORRUPT, DECK_STATUS.MIGRATION_PENDING].includes(data.status)) throw new Error("Actor deck status is invalid.");
  const ids = CARD_ZONES.flatMap((zone) => Array.isArray(data.zones?.[zone]) ? data.zones[zone] : []);
  if (data.status !== DECK_STATUS.CORRUPT) {
    if (new Set(ids).size !== ids.length) throw new Error("A card identity may exist in only one Actor card zone.");
    if (ids.some((cardId) => !CARD_IDS.includes(cardId))) throw new Error("Actor card zones contain an unknown canonical card identity.");
    if (ids.length > CARD_IDS.length) throw new Error("Actor card zones cannot contain more than the canonical 30 cards.");
    if ((data.zones?.vanguard?.length ?? 0) > 3) throw new Error("The Vanguard zone cannot contain more than three cards.");
  }
  if (Boolean(data.conflict?.active) !== (data.status === DECK_STATUS.ACTIVE)) {
    throw new Error("Actor deck and encounter states must agree.");
  }
  if (data.status === DECK_STATUS.MIGRATION_PENDING && data.configuration?.crossEncounterDeck !== true) {
    throw new Error("A pending persistent migration requires Cross-Encounter Deck mode.");
  }
  if (data.conflict?.active && !data.configuration?.crossEncounterDeck && !data.conflict.combatUuid) throw new Error("An encounter-scoped Actor deck requires a Combat UUID.");
  if (data.conflict?.active && !data.conflict.id) throw new Error("An active Actor deck requires an instance ID.");
  if (data.configuration?.crossEncounterDeck && data.conflict?.active && data.conflict.combatUuid) throw new Error("A persistent Actor deck cannot be tied to a Combat UUID.");
  if (!data.conflict?.active && data.openingComplete) throw new Error("An inactive Actor deck cannot report a completed Encounter opening.");
  if (data.conflict?.active && !data.openingComplete && ids.length) throw new Error("An incomplete Encounter opening cannot own moved cards.");
  return true;
}

function normalizeEncounterRecord(record = {}, key = "") {
  const combatUuid = encounterCombatUuid(record?.conflict?.combatUuid ?? record?.combatUuid ?? key);
  if (!combatUuid) throw new Error("Stored encounter records require a Combat UUID.");
  const sourceConflict = record?.conflict && typeof record.conflict === "object" ? record.conflict : {};
  const conflict = normalizeConflict({
    ...sourceConflict,
    active: sourceConflict.active ?? true,
    id: sourceConflict.id ?? record.id ?? combatUuid,
    combatUuid,
    sceneUuid: sourceConflict.sceneUuid ?? record.sceneUuid,
  }, { combatUuid, sceneUuid: record.sceneUuid });
  if (!conflict.active) throw new Error("Stored encounter records must be active.");
  const runtime = prepareActorDeckState({
    schemaVersion: ACTOR_DECK_SCHEMA_VERSION,
    rootRevision: record.rootRevision,
    revision: record.revision,
    status: DECK_STATUS.ACTIVE,
    configuration: record.configuration,
    conflict,
    openingComplete: record.openingComplete,
    zones: record.zones,
    encounterCount: 1,
  });
  return {
    revision: runtime.revision,
    sceneUuid: runtime.conflict.sceneUuid,
    conflict: runtime.conflict,
    openingComplete: runtime.openingComplete,
    zones: runtime.zones,
  };
}

function encounterRecordScore(record = {}) {
  const movedCards = CARD_ZONES.reduce((count, zone) => count + (record.zones?.[zone]?.length ?? 0), 0);
  return [integer(record.revision), record.openingComplete === true ? 1 : 0, movedCards];
}

function preferredEncounterRecord(current, candidate) {
  if (!current) return candidate;
  const currentScore = encounterRecordScore(current);
  const candidateScore = encounterRecordScore(candidate);
  for (let index = 0; index < currentScore.length; index += 1) {
    if (candidateScore[index] > currentScore[index]) return candidate;
    if (candidateScore[index] < currentScore[index]) return current;
  }
  return current;
}

function looksLikeEncounterRecord(record) {
  return Boolean(
    record
    && typeof record === "object"
    && !Array.isArray(record)
    && (record.conflict || record.zones || Object.hasOwn(record, "openingComplete"))
  );
}

function normalizeEncounterContainer(encounters = {}, configuration = {}) {
  const normalized = {};
  const addRecord = (record, key) => {
    if (!looksLikeEncounterRecord(record)) return;
    const combatUuid = encounterCombatUuid(record?.conflict?.combatUuid ?? record?.combatUuid ?? key);
    const storageKey = encounterStorageKey(combatUuid);
    if (!storageKey || storageKey === "Combat") return;
    const candidate = normalizeEncounterRecord({ ...record, configuration }, combatUuid);
    normalized[storageKey] = preferredEncounterRecord(normalized[storageKey], candidate);
  };

  for (const [key, record] of Object.entries(encounters ?? {})) {
    if (key === "Combat" && record && typeof record === "object" && !Array.isArray(record)) {
      for (const [nestedKey, nestedRecord] of Object.entries(record)) {
        if (MALFORMED_COMBAT_CONTAINER_FIELDS.has(nestedKey)) continue;
        addRecord(nestedRecord, `${COMBAT_UUID_PREFIX}${nestedKey}`);
      }
      continue;
    }
    addRecord(record, key);
  }

  return normalized;
}

function normalizePersistentRecord(record = null, configuration = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const runtime = prepareActorDeckState({
    rootRevision: record.rootRevision,
    revision: record.revision,
    status: DECK_STATUS.ACTIVE,
    configuration: { ...configuration, crossEncounterDeck: true },
    conflict: { active: true, id: "persistent", combatUuid: "", sceneUuid: "" },
    openingComplete: record.openingComplete,
    zones: record.zones,
    encounterCount: 0,
  });
  return {
    revision: runtime.revision,
    openingComplete: runtime.openingComplete,
    zones: runtime.zones,
  };
}

function actorDeckInstanceCount(container = {}) {
  return container?.configuration?.crossEncounterDeck
    ? (container?.persistent ? 1 : 0)
    : Object.keys(container?.encounters ?? {}).length;
}

function containerFromLegacyRuntime(source = {}) {
  const configuration = normalizeConfiguration(source.configuration);
  const legacyConflict = normalizeConflict(source.conflict, { ...source, allowPersistent: false });
  const encounters = {};
  if (legacyConflict.active && legacyConflict.combatUuid) {
    const storageKey = encounterStorageKey(legacyConflict.combatUuid);
    encounters[storageKey] = normalizeEncounterRecord({
      revision: source.revision,
      sceneUuid: legacyConflict.sceneUuid,
      conflict: legacyConflict,
      openingComplete: source.openingComplete,
      zones: source.zones,
      configuration: { ...configuration, crossEncounterDeck: false },
    }, legacyConflict.combatUuid);
  }
  return {
    schemaVersion: ACTOR_DECK_SCHEMA_VERSION,
    revision: integer(source.revision),
    status: source.status === DECK_STATUS.CORRUPT
      ? DECK_STATUS.CORRUPT
      : Object.keys(encounters).length ? DECK_STATUS.ACTIVE : DECK_STATUS.READY,
    configuration,
    encounters,
    persistent: null,
  };
}

export function prepareActorDeckContainer(source = {}) {
  const configuration = normalizeConfiguration(source.configuration);
  const hasEncounterContainer = source.encounters && typeof source.encounters === "object" && !Array.isArray(source.encounters);
  if (!hasEncounterContainer && source.zones) {
    prepareActorDeckState(source);
  }
  const normalizedEncounters = hasEncounterContainer
    ? normalizeEncounterContainer(source.encounters, { ...configuration, crossEncounterDeck: false })
    : containerFromLegacyRuntime(source).encounters;
  const legacyPersistent = source.persistent ?? source.crossEncounter ?? (configuration.crossEncounterDeck && source.zones ? source : null);
  const persistent = configuration.crossEncounterDeck
    ? normalizePersistentRecord(legacyPersistent, configuration)
    : null;
  const pendingMigration = configuration.crossEncounterDeck
    && !persistent
    && Object.keys(normalizedEncounters).length > 0
    && source.status !== DECK_STATUS.CORRUPT;
  const encounters = configuration.crossEncounterDeck
    ? (pendingMigration ? normalizedEncounters : {})
    : normalizedEncounters;

  const instanceCount = configuration.crossEncounterDeck ? (persistent ? 1 : 0) : Object.keys(encounters).length;
  const status = source.status === DECK_STATUS.CORRUPT
    ? DECK_STATUS.CORRUPT
    : pendingMigration
      ? DECK_STATUS.MIGRATION_PENDING
      : instanceCount ? DECK_STATUS.ACTIVE : DECK_STATUS.READY;
  const prepared = {
    schemaVersion: ACTOR_DECK_SCHEMA_VERSION,
    revision: integer(source.revision),
    status,
    configuration,
    encounters,
    persistent,
  };
  validateActorDeckContainer(prepared);
  return prepared;
}

export function validateActorDeckContainer(data = {}) {
  if (Number(data.schemaVersion) !== ACTOR_DECK_SCHEMA_VERSION) throw new Error("Actor deck container schema version is invalid.");
  if (![DECK_STATUS.READY, DECK_STATUS.ACTIVE, DECK_STATUS.CORRUPT, DECK_STATUS.MIGRATION_PENDING].includes(data.status)) throw new Error("Actor deck container status is invalid.");
  if (!data.configuration?.styleId) throw new Error("Actor deck configuration requires a Style identity.");
  const encounterEntries = Object.entries(data.encounters ?? {});
  if (data.status !== DECK_STATUS.CORRUPT) {
    if (data.configuration.crossEncounterDeck && encounterEntries.length && data.status !== DECK_STATUS.MIGRATION_PENDING) {
      throw new Error("Persistent Deck storage cannot also contain encounter states.");
    }
    if (!data.configuration.crossEncounterDeck && data.persistent) throw new Error("Encounter-scoped storage cannot contain a persistent deck state.");
    for (const [storageKey, record] of encounterEntries) {
      if (!storageKey || storageKey.includes(".")) throw new Error("Encounter storage keys must be dot-free Combat IDs.");
      const runtime = prepareActorDeckState({
        rootRevision: data.revision,
        revision: record.revision,
        status: DECK_STATUS.ACTIVE,
        configuration: { ...data.configuration, crossEncounterDeck: false },
        conflict: record.conflict,
        openingComplete: record.openingComplete,
        zones: record.zones,
        encounterCount: encounterEntries.length,
      });
      if (encounterStorageKey(runtime.conflict.combatUuid) !== storageKey) throw new Error("Encounter storage keys must match their Combat ID.");
    }
    if (data.persistent) {
      prepareActorDeckState({
        rootRevision: data.revision,
        revision: data.persistent.revision,
        status: DECK_STATUS.ACTIVE,
        configuration: { ...data.configuration, crossEncounterDeck: true },
        conflict: { active: true, id: "persistent", combatUuid: "", sceneUuid: "" },
        openingComplete: data.persistent.openingComplete,
        zones: data.persistent.zones,
        encounterCount: 0,
      });
    }
  }
  const instanceCount = data.configuration?.crossEncounterDeck ? (data.persistent ? 1 : 0) : encounterEntries.length;
  if (data.status === DECK_STATUS.ACTIVE && !instanceCount) throw new Error("Active Actor deck storage requires a deck instance.");
  if (data.status === DECK_STATUS.READY && instanceCount) throw new Error("Ready Actor deck storage cannot contain a deck instance.");
  if (data.status === DECK_STATUS.MIGRATION_PENDING) {
    if (!data.configuration?.crossEncounterDeck) throw new Error("Pending migration storage requires Cross-Encounter Deck mode.");
    if (data.persistent) throw new Error("Pending migration storage cannot already contain a persistent deck.");
    if (!encounterEntries.length) throw new Error("Pending migration storage requires preserved encounter states.");
  }
  return true;
}

export function createDefaultActorDeckState(configuration = {}, context = {}) {
  return prepareActorDeckState({
    rootRevision: 0,
    revision: 0,
    status: DECK_STATUS.READY,
    configuration: normalizeConfiguration(configuration),
    conflict: { active: false, id: "", combatUuid: "", sceneUuid: "" },
    openingComplete: false,
    zones: emptyZones(),
    encounterCount: 0,
    ...context,
  });
}

export function createDefaultActorDeckContainer(configuration = {}) {
  return prepareActorDeckContainer({
    revision: 0,
    status: DECK_STATUS.READY,
    configuration: normalizeConfiguration(configuration),
    encounters: {},
    persistent: null,
  });
}

export function createConfiguredActorDeckState(current, configuration) {
  if (current?.encounters && typeof current.encounters === "object") {
    return prepareActorDeckContainer({
      ...clone(current),
      revision: Number(current?.revision ?? 0) + 1,
      configuration: normalizeConfiguration(configuration),
    });
  }
  return prepareActorDeckState({
    ...clone(current),
    rootRevision: Number(current?.rootRevision ?? current?.revision ?? 0) + 1,
    revision: Number(current?.revision ?? 0) + 1,
    configuration: normalizeConfiguration(configuration),
  });
}


export function projectActorDeckState(container, context = {}) {
  const root = prepareActorDeckContainer(container);
  const encounterCount = root.configuration.crossEncounterDeck ? 0 : Object.keys(root.encounters).length;
  if (root.status === DECK_STATUS.CORRUPT || root.status === DECK_STATUS.MIGRATION_PENDING) {
    return prepareActorDeckState({
      rootRevision: root.revision,
      revision: root.revision,
      status: root.status,
      configuration: root.configuration,
      conflict: { active: false },
      openingComplete: false,
      zones: emptyZones(),
      encounterCount,
    });
  }

  if (root.configuration.crossEncounterDeck) {
    if (!root.persistent) {
      return prepareActorDeckState({
        rootRevision: root.revision,
        revision: root.revision,
        status: DECK_STATUS.READY,
        configuration: root.configuration,
        conflict: { active: false },
        openingComplete: false,
        zones: emptyZones(),
        encounterCount: 0,
      });
    }
    return prepareActorDeckState({
      rootRevision: root.revision,
      revision: root.persistent.revision,
      status: DECK_STATUS.ACTIVE,
      configuration: root.configuration,
      conflict: { active: true, id: "persistent", combatUuid: "", sceneUuid: "" },
      openingComplete: root.persistent.openingComplete,
      zones: root.persistent.zones,
      encounterCount: 0,
    });
  }

  const resolved = resolveEncounterContext(context);
  const storageKey = encounterStorageKey(resolved.combatUuid);
  const record = storageKey ? root.encounters[storageKey] : null;
  if (!record) {
    return prepareActorDeckState({
      rootRevision: root.revision,
      revision: root.revision,
      status: DECK_STATUS.READY,
      configuration: root.configuration,
      conflict: { active: false },
      openingComplete: false,
      zones: emptyZones(),
      encounterCount,
    });
  }
  return prepareActorDeckState({
    rootRevision: root.revision,
    revision: record.revision,
    status: DECK_STATUS.ACTIVE,
    configuration: root.configuration,
    conflict: record.conflict,
    openingComplete: record.openingComplete,
    zones: record.zones,
    encounterCount,
  });
}

export function mergeActorDeckEncounter(container, state, { remove = false } = {}) {
  const root = prepareActorDeckContainer(container);
  const runtime = prepareActorDeckState(state);
  const next = clone(root);
  next.revision = Math.max(Number(root.revision) + 1, Number(runtime.rootRevision ?? 0));

  if (root.configuration.crossEncounterDeck) {
    next.encounters = {};
    // Encounter cleanup cannot remove an Actor-level persistent deck. The world
    // mode switch is the only operation that discards this storage record.
    next.persistent = remove
      ? clone(root.persistent)
      : {
          revision: runtime.revision,
          openingComplete: runtime.openingComplete,
          zones: clone(runtime.zones),
        };
  } else {
    const combatUuid = encounterCombatUuid(runtime.conflict?.combatUuid);
    const storageKey = encounterStorageKey(combatUuid);
    if (remove) {
      if (storageKey) delete next.encounters[storageKey];
    } else {
      if (!runtime.conflict.active || !combatUuid || !storageKey) throw new Error("An active encounter state is required for encounter storage.");
      next.encounters[storageKey] = {
        revision: runtime.revision,
        sceneUuid: runtime.conflict.sceneUuid,
        conflict: clone(runtime.conflict),
        openingComplete: runtime.openingComplete,
        zones: clone(runtime.zones),
      };
    }
    next.persistent = null;
  }
  next.status = actorDeckInstanceCount(next) ? DECK_STATUS.ACTIVE : DECK_STATUS.READY;
  return prepareActorDeckContainer(next);
}

export function setCrossEncounterDeckMode(container, enabled, { migrationCombatUuid = "" } = {}) {
  const root = prepareActorDeckContainer(container);
  const target = enabled === true;
  const pending = root.status === DECK_STATUS.MIGRATION_PENDING;
  if (root.configuration.crossEncounterDeck === target && !(target && pending)) return root;
  const next = clone(root);
  next.revision = Number(root.revision) + 1;
  if (target) {
    const selectedKey = encounterStorageKey(migrationCombatUuid);
    const selected = selectedKey ? root.encounters[selectedKey] : null;
    if (migrationCombatUuid && !selected) throw new Error("The selected Encounter deck is no longer available for migration.");
    next.configuration.crossEncounterDeck = true;
    next.encounters = {};
    next.persistent = selected
      ? {
          revision: selected.revision,
          openingComplete: selected.openingComplete,
          zones: clone(selected.zones),
        }
      : null;
  } else {
    next.configuration.crossEncounterDeck = false;
    next.encounters = pending ? clone(root.encounters) : {};
    next.persistent = null;
  }
  next.status = actorDeckInstanceCount(next) ? DECK_STATUS.ACTIVE : DECK_STATUS.READY;
  return prepareActorDeckContainer(next);
}

export function actorDeckHasEncounter(container, combatUuid) {
  const root = prepareActorDeckContainer(container);
  if (root.configuration.crossEncounterDeck) return false;
  const storageKey = encounterStorageKey(combatUuid);
  return Boolean(storageKey && root.encounters[storageKey]);
}

function rawActorDeck(actor) {
  return actor?.getFlag?.(MODULE_ID, ACTOR_FLAGS.DECK) ?? actor?.flags?.[MODULE_ID]?.[ACTOR_FLAGS.DECK] ?? null;
}

function corruptActorDeckContainer(source = {}) {
  return {
    schemaVersion: ACTOR_DECK_SCHEMA_VERSION,
    revision: integer(source.revision),
    status: DECK_STATUS.CORRUPT,
    configuration: normalizeConfiguration(source.configuration),
    encounters: {},
    persistent: null,
  };
}

function isEmptyCorruptMigrationArtifact(source = {}) {
  if (Number(source?.schemaVersion) !== 9) return false;
  if (source?.status !== DECK_STATUS.CORRUPT) return false;
  if (normalizeConfiguration(source?.configuration).crossEncounterDeck !== true) return false;
  const encounters = source?.encounters && typeof source.encounters === "object" && !Array.isArray(source.encounters)
    ? Object.keys(source.encounters)
    : [];
  return encounters.length === 0
    && !source?.persistent
    && !source?.crossEncounter
    && !source?.zones;
}

function repairEmptyCorruptMigrationArtifact(source = {}) {
  return prepareActorDeckContainer({
    revision: integer(source.revision),
    status: DECK_STATUS.READY,
    configuration: { ...normalizeConfiguration(source.configuration), crossEncounterDeck: true },
    encounters: {},
    persistent: null,
  });
}

function liveEncounter(combatUuid) {
  const combats = globalThis.game?.combats;
  if (!combats) return true;
  const combat = findCombatByUuid(combatUuid);
  return Boolean(combat && combatStarted(combat));
}

export class ActorDeckStore {
  getContainer(actor) {
    if (!actor) return null;
    const stored = rawActorDeck(actor);
    if (!stored) return null;
    if (isEmptyCorruptMigrationArtifact(stored)) return repairEmptyCorruptMigrationArtifact(stored);
    try { return prepareActorDeckContainer(stored); }
    catch (_error) { return corruptActorDeckContainer(stored); }
  }

  get(actor, context = {}) {
    const container = this.getContainer(actor);
    return container ? projectActorDeckState(container, context) : null;
  }

  async ensure(actor) {
    if (!globalThis.game?.users?.activeGM?.isSelf) throw new Error("Only the active GM may initialize Actor card state.");
    const existing = this.getContainer(actor);
    const target = globalThis.game?.settings?.get?.(MODULE_ID, SETTINGS.CROSS_ENCOUNTER_DECK) === true;
    let container = existing ?? createDefaultActorDeckContainer({ crossEncounterDeck: target });
    if (existing && container.configuration?.crossEncounterDeck !== target) {
      if (Object.keys(container.encounters ?? {}).length || container.persistent) {
        throw new Error("The world-wide deck mode is still reconciling for this Actor.");
      }
      container = setCrossEncounterDeckMode(container, target);
      await this.set(actor, container);
    }
    return container;
  }

  async migrateExisting() {
    if (!globalThis.game?.users?.activeGM?.isSelf) return { migrated: 0, customMappingActors: [], reviewActors: [] };
    let migrated = 0;
    const customMappingActors = [];
    const reviewActors = [];
    for (const actor of Array.from(globalThis.game?.actors ?? [])) {
      const raw = rawActorDeck(actor);
      if (!raw) continue;
      if (legacySuitMappingIsCustom(raw.configuration?.suitDamageTypes)) customMappingActors.push(actor.name || actor.uuid);
      if (raw?.status === DECK_STATUS.CORRUPT && !isEmptyCorruptMigrationArtifact(raw)) {
        reviewActors.push(actor.name || actor.uuid);
        continue;
      }
      let prepared;
      try {
        prepared = isEmptyCorruptMigrationArtifact(raw)
          ? repairEmptyCorruptMigrationArtifact(raw)
          : prepareActorDeckContainer(raw);
      } catch (_error) {
        reviewActors.push(actor.name || actor.uuid);
        continue;
      }
      if (prepared.status !== DECK_STATUS.CORRUPT) {
        if (!prepared.configuration.crossEncounterDeck) {
          for (const [storageKey, record] of Object.entries(prepared.encounters)) {
            if (!liveEncounter(record.conflict.combatUuid)) delete prepared.encounters[storageKey];
          }
        }
        if (prepared.status !== DECK_STATUS.MIGRATION_PENDING) {
          prepared.status = actorDeckInstanceCount(prepared) ? DECK_STATUS.ACTIVE : DECK_STATUS.READY;
        }
        prepared = prepareActorDeckContainer(prepared);
      }
      const currentSerialized = JSON.stringify(raw);
      const preparedSerialized = JSON.stringify(prepared);
      if (Number(raw.schemaVersion) === ACTOR_DECK_SCHEMA_VERSION && currentSerialized === preparedSerialized) continue;
      await this.set(actor, prepared);
      migrated += 1;
    }
    return { migrated, customMappingActors, reviewActors };
  }

  async set(actor, source) {
    if (!globalThis.game?.users?.activeGM?.isSelf) throw new Error("Only the active GM may write Actor card state.");
    if (!actor?.uuid) throw new Error("A valid Actor is required for card storage.");
    const prepared = source?.encounters
      ? prepareActorDeckContainer(source)
      : prepareActorDeckContainer(containerFromLegacyRuntime(source));
    if (typeof actor.setFlag === "function") {
      await actor.setFlag(MODULE_ID, ACTOR_FLAGS.DECK, prepared);
    } else if (typeof actor.update === "function") {
      await actor.update({ [`flags.${MODULE_ID}.${ACTOR_FLAGS.DECK}`]: prepared });
    } else {
      actor.flags ??= {};
      actor.flags[MODULE_ID] ??= {};
      actor.flags[MODULE_ID][ACTOR_FLAGS.DECK] = clone(prepared);
    }
    return prepared;
  }

  actorsWithDecks() {
    return Array.from(globalThis.game?.actors ?? []).filter((actor) => Boolean(this.getContainer(actor)));
  }

  actorsUsingStyle(styleId) {
    return Array.from(globalThis.game?.actors ?? []).filter((actor) => this.getContainer(actor)?.configuration?.styleId === styleId);
  }

  diagnose() {
    const containers = Array.from(globalThis.game?.actors ?? []).map((actor) => this.getContainer(actor)).filter(Boolean);
    return {
      backend: "actor-flags",
      actorFlagCount: containers.length,
      activeCount: containers.reduce((count, state) => count + actorDeckInstanceCount(state), 0),
      corruptCount: containers.filter((state) => state.status === DECK_STATUS.CORRUPT).length,
    };
  }
}

export const actorDeckStore = new ActorDeckStore();
