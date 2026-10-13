import { createCanonicalDeckIds } from "./card-catalog.mjs";

const STORED_ZONES = Object.freeze(["hand", "discard", "vanguard"]);

function cloneZones(zones = {}) {
  return Object.fromEntries(STORED_ZONES.map((zone) => [zone, [...(zones?.[zone] ?? [])]]));
}

export function availableCardIds(zones = {}) {
  const occupied = new Set(STORED_ZONES.flatMap((zone) => Array.isArray(zones?.[zone]) ? zones[zone] : []));
  return createCanonicalDeckIds().filter((cardId) => !occupied.has(cardId));
}

export function shuffleCardIds(cardIds, random = Math.random) {
  const cards = [...cardIds];
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [cards[index], cards[swap]] = [cards[swap], cards[index]];
  }
  return cards;
}

export function beginConflictZones(random = Math.random, handSize = 5) {
  const shuffled = shuffleCardIds(createCanonicalDeckIds(), random);
  return {
    hand: shuffled.slice(0, handSize),
    discard: [],
    vanguard: [],
  };
}

export function resetZones() {
  return { hand: [], discard: [], vanguard: [] };
}

export function drawCards(zones, count = 1, random = Math.random) {
  const next = cloneZones(zones);
  const movements = [];
  for (let index = 0; index < count; index += 1) {
    let available = availableCardIds(next);
    if (!available.length && next.discard.length) {
      const recycled = [...next.discard];
      next.discard = [];
      movements.push(...recycled.map((cardId) => ({ cardId, from: "discard", to: "deck" })));
      available = recycled;
    }
    if (!available.length) break;
    const drawIndex = Math.floor(random() * available.length);
    const cardId = available[Math.max(0, Math.min(drawIndex, available.length - 1))];
    if (!cardId) break;
    next.hand.push(cardId);
    movements.push({ cardId, from: "deck", to: "hand" });
  }
  return { zones: next, movements };
}

export function moveCard(zones, cardId, from, to) {
  const next = cloneZones(zones);
  const sourceIndex = next[from]?.indexOf(cardId) ?? -1;
  if (sourceIndex < 0) throw new Error(`Card ${cardId} is not in ${from}.`);
  if (to === "vanguard" && next.vanguard.length >= 3) throw new Error("The Vanguard zone already contains three cards.");
  next[from].splice(sourceIndex, 1);
  next[to].push(cardId);
  return { zones: next, movement: { cardId, from, to } };
}
