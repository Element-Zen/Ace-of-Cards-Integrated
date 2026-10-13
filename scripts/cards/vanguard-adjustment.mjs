function copyZones(zones = {}) {
  return {
    hand: Array.from(zones.hand ?? [], String),
    discard: Array.from(zones.discard ?? [], String),
    vanguard: Array.from(zones.vanguard ?? [], String),
  };
}

export function planResolutionVanguardAdjustment(zones, {
  resultCardIds = [],
  currentVanguardCardId = "",
  newVanguardCardId = "",
  maximumVanguardCards = 3,
} = {}) {
  const resultIds = Array.from(new Set((resultCardIds ?? []).map(String).filter(Boolean)));
  const previousCardId = String(currentVanguardCardId ?? "");
  const selectedCardId = String(newVanguardCardId ?? "");
  if (!selectedCardId || !resultIds.includes(selectedCardId)) {
    throw new Error("Choose a card from this Magic Cards result.");
  }
  if (selectedCardId === previousCardId) {
    throw new Error("That card is already the Vanguard choice for this result.");
  }

  const nextZones = copyZones(zones);
  const selectedDiscardIndex = nextZones.discard.indexOf(selectedCardId);
  if (selectedDiscardIndex < 0) {
    throw new Error("The selected result card is no longer in the discard pile.");
  }

  if (!previousCardId) {
    if (nextZones.vanguard.length >= Number(maximumVanguardCards)) {
      throw new Error("The Vanguard zone already contains three cards.");
    }
    nextZones.discard.splice(selectedDiscardIndex, 1);
    const vanguardIndex = nextZones.vanguard.length;
    nextZones.vanguard.push(selectedCardId);
    return {
      mode: "selected",
      previousCardId: "",
      selectedCardId,
      vanguardIndex,
      discardIndex: selectedDiscardIndex,
      zones: nextZones,
      movements: [{ cardId: selectedCardId, from: "discard", to: "vanguard", faceUp: false }],
    };
  }

  if (!resultIds.includes(previousCardId)) {
    throw new Error("The recorded Vanguard card does not belong to this Magic Cards result.");
  }
  const previousVanguardIndex = nextZones.vanguard.indexOf(previousCardId);
  if (previousVanguardIndex < 0) {
    throw new Error("The current Vanguard card has already been revealed or moved.");
  }

  nextZones.discard.splice(selectedDiscardIndex, 1, previousCardId);
  nextZones.vanguard.splice(previousVanguardIndex, 1, selectedCardId);
  return {
    mode: "changed",
    previousCardId,
    selectedCardId,
    vanguardIndex: previousVanguardIndex,
    discardIndex: selectedDiscardIndex,
    zones: nextZones,
    movements: [
      { cardId: previousCardId, from: "vanguard", to: "discard", faceUp: true },
      { cardId: selectedCardId, from: "discard", to: "vanguard", faceUp: false },
    ],
  };
}

export function updateMagicCardsVanguardResult(result, { previousCardId = "", selectedCardId = "", revision = 0 } = {}) {
  const updated = structuredClone(result ?? {});
  updated.expectedRevision = Number(revision);
  updated.details ??= {};
  updated.details.vanguardCardId = String(selectedCardId ?? "");

  const discardOrder = Array.from(updated.details.discardOrder ?? [], String);
  const selectedIndex = discardOrder.indexOf(String(selectedCardId ?? ""));
  if (selectedIndex >= 0) {
    if (previousCardId) discardOrder.splice(selectedIndex, 1, String(previousCardId));
    else discardOrder.splice(selectedIndex, 1);
  }
  updated.details.discardOrder = discardOrder;

  const effectDetails = updated.details.effectDetails;
  if (effectDetails?.forbiddenRiteEligibleCardIds) {
    effectDetails.forbiddenRiteEligibleCardIds = Array.from(effectDetails.forbiddenRiteEligibleCardIds, String)
      .filter((cardId) => cardId !== String(selectedCardId ?? ""));
    if (!effectDetails.forbiddenRiteEligibleCardIds.length) effectDetails.forbiddenRiteRecycleEligible = false;
  }
  return updated;
}

export function reconcileMagicCardsVanguardResult(result, zones = {}, { revision = null } = {}) {
  const updated = structuredClone(result ?? {});
  updated.details ??= {};
  const resultIds = Array.from(new Set((updated.cardIds ?? []).map(String).filter(Boolean)));
  const discard = new Set(Array.from(zones.discard ?? [], String));
  const vanguard = new Set(Array.from(zones.vanguard ?? [], String));
  const recordedCardId = String(updated.details.vanguardCardId ?? "");
  const actualVanguardIds = resultIds.filter((cardId) => vanguard.has(cardId));

  let currentVanguardCardId = "";
  if (recordedCardId && vanguard.has(recordedCardId)) currentVanguardCardId = recordedCardId;
  else if (actualVanguardIds.length === 1) currentVanguardCardId = actualVanguardIds[0];

  updated.details.vanguardCardId = currentVanguardCardId;
  updated.vanguardEligibleCardIds = resultIds.filter((cardId) => discard.has(cardId));
  if (revision !== null && Number.isFinite(Number(revision))) updated.expectedRevision = Number(revision);

  // A previously selected Vanguard card leaving the Vanguard zone means it was revealed or moved.
  // The reveal card's native Reverse action is then the correction surface, not the old Magic Cards result.
  if (recordedCardId && !currentVanguardCardId) updated.vanguardAdjustmentOpen = false;
  if (actualVanguardIds.length > 1 && !currentVanguardCardId) updated.vanguardAdjustmentOpen = false;
  return updated;
}
