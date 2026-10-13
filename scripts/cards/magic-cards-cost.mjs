export const MAGIC_CARDS_MP_PER_CARD = 5;

export function magicCardsMpCost(cardIds = []) {
  const count = Array.isArray(cardIds)
    ? cardIds.length
    : Math.max(0, Number(cardIds) || 0);
  return count * MAGIC_CARDS_MP_PER_CARD;
}
