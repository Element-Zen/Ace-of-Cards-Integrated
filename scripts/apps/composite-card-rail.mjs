export function partitionHandCards(cards = []) {
  return { hand: Array.isArray(cards) ? [...cards] : [] };
}

export function buildVanguardCards(cards = [], { enabled = false, revealable = false } = {}) {
  if (!enabled) return [];
  return cards
    .filter((card) => card?.id)
    .map((card, index) => ({ ...card, zone: "vanguard", slot: index + 1, revealable: Boolean(revealable) }));
}
