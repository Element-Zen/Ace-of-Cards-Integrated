import { beginConflictZones } from "../cards/deck-runtime.mjs";
import { ACTOR_DECK_SCHEMA_VERSION, DECK_STATUS } from "../constants.mjs";
import {
  createDefaultActorDeckState,
  prepareActorDeckState,
} from "./actor-deck-store.mjs";

function text(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || String(fallback ?? "").trim();
}

export function encounterOpeningComplete(state, expectedCombatUuid = "") {
  const combatUuid = text(expectedCombatUuid || state?.conflict?.combatUuid || state?.combatUuid);
  return Boolean(
    combatUuid
    && state?.status === DECK_STATUS.ACTIVE
    && state?.conflict?.active
    && text(state?.conflict?.combatUuid || state?.combatUuid) === combatUuid
    && state?.openingComplete === true
  );
}

export function createEncounterOpeningState({
  configuration = {},
  context = {},
  rootRevision = 1,
  revision = 1,
  random = Math.random,
} = {}) {
  const combatUuid = text(context.combatUuid);
  if (!combatUuid) throw new Error("An Encounter opening state requires a Combat UUID.");
  const sceneUuid = text(context.sceneUuid);
  const conflictId = text(context.conflictId, combatUuid);
  const base = createDefaultActorDeckState(configuration, context);

  return prepareActorDeckState({
    ...base,
    schemaVersion: ACTOR_DECK_SCHEMA_VERSION,
    rootRevision,
    revision,
    status: DECK_STATUS.ACTIVE,
    openingComplete: true,
    conflict: {
      active: true,
      id: conflictId,
      combatUuid,
      sceneUuid,
    },
    zones: beginConflictZones(random),
  });
}
