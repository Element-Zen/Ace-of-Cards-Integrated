function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.values === "function") return Array.from(collection.values());
  return [];
}

function text(value) {
  return String(value ?? "").trim();
}

export function combatStarted(combat) {
  if (!combat) return false;
  if (typeof combat.started === "boolean") return combat.started;
  return Number(combat.round ?? 0) > 0;
}

export function combatSceneUuid(combat) {
  if (!combat) return "";
  const direct = text(combat.scene?.uuid ?? combat.sceneUuid);
  if (direct) return direct;
  const sceneId = text(combat.scene?.id ?? combat.sceneId ?? combat._source?.scene);
  return sceneId ? `Scene.${sceneId}` : "";
}

export function encounterContextFromCombat(combat) {
  return {
    combatUuid: text(combat?.uuid),
    sceneUuid: combatSceneUuid(combat),
    conflictId: text(combat?.uuid),
  };
}

export function allCombats() {
  return collectionValues(globalThis.game?.combats);
}

export function findCombatByUuid(combatUuid) {
  const uuid = text(combatUuid);
  if (!uuid) return null;
  const combats = globalThis.game?.combats;
  const id = uuid.startsWith("Combat.") ? uuid.slice("Combat.".length) : uuid;
  return combats?.get?.(id)
    ?? combats?.get?.(uuid)
    ?? allCombats().find((combat) => text(combat?.uuid) === uuid || text(combat?.id) === id)
    ?? null;
}

export function currentSceneUuid() {
  return text(globalThis.canvas?.scene?.uuid ?? globalThis.game?.scenes?.current?.uuid);
}

export function startedCombats() {
  return allCombats().filter(combatStarted);
}

export function resolveEncounterContext(input = {}) {
  const requestedCombatUuid = text(input?.combatUuid ?? input?.conflictId);
  const requestedSceneUuid = text(input?.sceneUuid);
  if (requestedCombatUuid) {
    const combat = findCombatByUuid(requestedCombatUuid);
    return {
      combatUuid: requestedCombatUuid,
      sceneUuid: requestedSceneUuid || combatSceneUuid(combat),
      conflictId: text(input?.conflictId) || requestedCombatUuid,
    };
  }

  const sceneUuid = requestedSceneUuid || currentSceneUuid();
  const currentCombat = globalThis.game?.combat;
  if (combatStarted(currentCombat) && (!sceneUuid || combatSceneUuid(currentCombat) === sceneUuid)) {
    return encounterContextFromCombat(currentCombat);
  }

  const combat = startedCombats().find((candidate) => !sceneUuid || combatSceneUuid(candidate) === sceneUuid);
  if (combat) return encounterContextFromCombat(combat);
  return { combatUuid: "", sceneUuid, conflictId: "" };
}

export function combatantActors(combat) {
  const combatants = collectionValues(combat?.combatants);
  const seen = new Set();
  return combatants.flatMap((combatant) => {
    const actor = combatant?.actor ?? combatant?.token?.actor ?? null;
    const uuid = text(actor?.uuid);
    if (!actor || !uuid || seen.has(uuid)) return [];
    seen.add(uuid);
    return [actor];
  });
}

export function actorIsInCombat(actor, combat) {
  const actorUuid = text(actor?.uuid);
  return Boolean(actorUuid && combatantActors(combat).some((candidate) => text(candidate?.uuid) === actorUuid));
}
