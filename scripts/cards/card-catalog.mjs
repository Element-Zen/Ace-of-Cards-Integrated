import { SUITS } from "../constants.mjs";

export const JOKER_IDS = Object.freeze(["joker-a", "joker-b"]);

export const CARD_DEFINITIONS = Object.freeze([
  ...SUITS.flatMap((suit) =>
    Array.from({ length: 7 }, (_unused, index) =>
      Object.freeze({ id: `${suit}-${index + 1}`, suit, value: index + 1, joker: false }),
    ),
  ),
  ...JOKER_IDS.map((id) => Object.freeze({ id, suit: "", value: 0, joker: true })),
]);

export const CARD_IDS = Object.freeze(CARD_DEFINITIONS.map((card) => card.id));
const CARD_BY_ID = new Map(CARD_DEFINITIONS.map((card) => [card.id, card]));

export function getCardDefinition(cardId) {
  return CARD_BY_ID.get(cardId) ?? null;
}

export function createCanonicalDeckIds() {
  return [...CARD_IDS];
}

export function validateCanonicalDeckComposition(cardIds) {
  if (!Array.isArray(cardIds)) throw new Error("Ace deck cards must be an array.");
  if (cardIds.length !== CARD_IDS.length) throw new Error("An Ace deck must contain exactly 30 cards.");
  if (new Set(cardIds).size !== CARD_IDS.length) throw new Error("Ace deck card identities must be unique.");

  const supplied = new Set(cardIds);
  for (const expected of CARD_IDS) {
    if (!supplied.has(expected)) throw new Error(`Ace deck is missing required card ${expected}.`);
  }
  for (const actual of supplied) {
    if (!CARD_BY_ID.has(actual)) throw new Error(`Ace deck contains unknown card ${actual}.`);
  }
  return true;
}
