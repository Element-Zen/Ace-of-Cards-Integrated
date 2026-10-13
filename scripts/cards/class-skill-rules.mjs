import { getCardDefinition } from "./card-catalog.mjs";

export function cardValues(cardIds, jokerAssignments = {}) {
  return cardIds.map((id) => {
    const card = getCardDefinition(id);
    if (!card) throw new Error(`Unknown card: ${id}`);
    if (!card.joker) return Number(card.value);
    const value = Number(jokerAssignments[id]?.value);
    if (!Number.isInteger(value) || value < 1 || value > 7) throw new Error(`Joker ${id} requires a value from 1 to 7.`);
    return value;
  });
}

export function evaluateHighOrLow(cardIds, jokerAssignments = {}) {
  const cards = cardIds.map((id) => {
    const card = getCardDefinition(id);
    if (!card) throw new Error(`Unknown card: ${id}`);
    const value = card.joker ? Number(jokerAssignments[id]?.value) : Number(card.value);
    if (!Number.isInteger(value) || value < 1 || value > 7) throw new Error(`Joker ${id} requires a value from 1 to 7.`);
    return { value, originalJoker: Boolean(card.joker) };
  });
  const values = cards.map((card) => card.value);
  const hasJoker = cards.some((card) => card.originalJoker);
  return {
    values,
    hasJoker,
    high: hasJoker || values.includes(7),
    low: hasJoker || values.includes(1),
    recovery: !hasJoker && !values.includes(1) && !values.includes(7),
  };
}

export function exchangeLimit(skillLevel) {
  return Math.max(1, Math.min(6, Number(skillLevel || 0) + 1));
}

export function trapSpellMaximumMp(skillLevel) {
  return Math.max(0, Number(skillLevel || 0) * 5);
}

