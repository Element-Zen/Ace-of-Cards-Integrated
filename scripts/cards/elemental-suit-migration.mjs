export const LEGACY_SUIT_TO_ELEMENT = Object.freeze({
  clubs: "earth",
  diamonds: "air",
  hearts: "fire",
  spades: "ice",
});

export const LEGACY_DEFAULT_SUIT_MAPPING = LEGACY_SUIT_TO_ELEMENT;

const LEGACY_CARD_ID = /^(clubs|diamonds|hearts|spades)-([1-7])$/;

export function isLegacyCardId(cardId) {
  return LEGACY_CARD_ID.test(String(cardId ?? ""));
}

export function migrateLegacySuit(suit) {
  const normalized = String(suit ?? "").toLowerCase();
  return LEGACY_SUIT_TO_ELEMENT[normalized] ?? normalized;
}

export function migrateLegacyCardId(cardId) {
  const value = String(cardId ?? "");
  const match = LEGACY_CARD_ID.exec(value);
  return match ? `${LEGACY_SUIT_TO_ELEMENT[match[1]]}-${match[2]}` : value;
}

export function migrateLegacyCardIds(cardIds = []) {
  return (Array.isArray(cardIds) ? cardIds : []).map(migrateLegacyCardId);
}

export function migrateLegacyJokerAssignments(assignments = {}) {
  return Object.fromEntries(Object.entries(assignments ?? {}).map(([cardId, assignment]) => [
    migrateLegacyCardId(cardId),
    {
      ...(assignment && typeof assignment === "object" ? assignment : {}),
      suit: migrateLegacySuit(assignment?.suit),
    },
  ]));
}

export function migrateLegacyFaceMap(faces = {}) {
  const migrated = {};
  for (const [cardId, path] of Object.entries(faces ?? {})) {
    migrated[migrateLegacyCardId(cardId)] = path;
  }
  return migrated;
}


export function legacySuitMappingIsCustom(mapping = {}) {
  if (!mapping || typeof mapping !== "object") return false;
  return Object.entries(LEGACY_DEFAULT_SUIT_MAPPING).some(([suit, element]) => (
    String(mapping[suit] ?? element).toLowerCase() !== element
  ));
}

export function hasLegacyFaceKeys(faces = {}) {
  return Object.keys(faces ?? {}).some(isLegacyCardId);
}

export function hasLegacyCardReferences(value) {
  if (typeof value === "string") return isLegacyCardId(value);
  if (Array.isArray(value)) return value.some(hasLegacyCardReferences);
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some(isLegacyCardId) || Object.values(value).some(hasLegacyCardReferences);
}

export function migrateLegacyMagicCardsResult(source = {}) {
  const result = structuredClone(source ?? {});
  result.cardIds = migrateLegacyCardIds(result.cardIds);
  result.vanguardEligibleCardIds = migrateLegacyCardIds(result.vanguardEligibleCardIds);
  result.jokerAssignments = migrateLegacyJokerAssignments(result.jokerAssignments);
  if (result.details && typeof result.details === "object") {
    result.details.vanguardCardId = migrateLegacyCardId(result.details.vanguardCardId);
    result.details.previousVanguardCardId = migrateLegacyCardId(result.details.previousVanguardCardId);
    result.details.discardOrder = migrateLegacyCardIds(result.details.discardOrder);
    result.details.jokerAssignments = migrateLegacyJokerAssignments(result.details.jokerAssignments);
    if (result.details.effectDetails && typeof result.details.effectDetails === "object") {
      result.details.effectDetails.forbiddenRiteEligibleCardIds = migrateLegacyCardIds(
        result.details.effectDetails.forbiddenRiteEligibleCardIds,
      );
      result.details.effectDetails.damageTypes = (result.details.effectDetails.damageTypes ?? []).map(migrateLegacySuit);
    }
  }
  result.vanguardAdjustmentOpen = false;
  result.vanguardEligibleCardIds = [];
  if (result.details?.effectDetails) {
    result.details.effectDetails.forbiddenRiteRecycleEligible = false;
    result.details.effectDetails.forbiddenRiteEligibleCardIds = [];
  }
  return result;
}

export function migrateLegacyCardMarkup(content = "") {
  let migrated = String(content ?? "");
  for (const [legacy, element] of Object.entries(LEGACY_SUIT_TO_ELEMENT)) {
    migrated = migrated
      .replaceAll(`/cards/${legacy}-`, `/cards/${element}-`)
      .replaceAll(`>${legacy}<`, `>${element}<`)
      .replace(new RegExp(`\\b${legacy}\\b`, "gi"), (match) => {
        if (match === match.toUpperCase()) return element.toUpperCase();
        if (match === match.charAt(0).toUpperCase() + match.slice(1).toLowerCase()) {
          return element.charAt(0).toUpperCase() + element.slice(1);
        }
        return element;
      });
  }
  return migrated;
}
