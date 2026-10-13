import { getCardDefinition } from "./card-catalog.mjs";
import { evaluateSet, SET_EFFECTS } from "./set-resolver.mjs";
import { SUITS } from "../constants.mjs";

export const CARD_ABILITY_ORDER = Object.freeze([
  SET_EFFECTS.FORBIDDEN_MONARCH,
  SET_EFFECTS.MAGIC_PAIR,
  SET_EFFECTS.DOUBLE_TROUBLE,
  SET_EFFECTS.TRIPLE_SUPPORT,
  SET_EFFECTS.FULL_STATUS,
  SET_EFFECTS.BLINDING_FLUSH,
  SET_EFFECTS.MAGIC_FLUSH,
  SET_EFFECTS.JACKPOT,
]);

export const CARD_ABILITY_CARD_COUNTS = Object.freeze({
  [SET_EFFECTS.JACKPOT]: 4,
  [SET_EFFECTS.MAGIC_FLUSH]: 4,
  [SET_EFFECTS.BLINDING_FLUSH]: 4,
  [SET_EFFECTS.FULL_STATUS]: 5,
  [SET_EFFECTS.TRIPLE_SUPPORT]: 3,
  [SET_EFFECTS.DOUBLE_TROUBLE]: 4,
  [SET_EFFECTS.MAGIC_PAIR]: 2,
  [SET_EFFECTS.FORBIDDEN_MONARCH]: 5,
});

const VALUES = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
const SORTED_SUITS = Object.freeze([...SUITS].sort((left, right) => left.localeCompare(right)));
const LANES = Object.freeze(["natural", "joker"]);

function normalizedAssignments(assignments = {}) {
  return Object.fromEntries(Object.entries(assignments)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cardId, assignment]) => [String(cardId), {
      suit: String(assignment?.suit ?? ""),
      value: Number(assignment?.value ?? 0),
    }]));
}

export function abilityCandidateKey(candidate) {
  const cards = [...(candidate?.cardIds ?? [])].map(String).sort().join(",");
  const assignments = Object.entries(normalizedAssignments(candidate?.jokerAssignments))
    .map(([cardId, assignment]) => `${cardId}:${assignment.suit}:${assignment.value}`)
    .join("|");
  return `${cards}::${assignments}`;
}

function candidateUsesJoker(candidate) {
  return (candidate?.cardIds ?? []).some((cardId) => getCardDefinition(String(cardId))?.joker);
}

function physicalCombinationKey(candidate) {
  return [...(candidate?.cardIds ?? [])].map(String).sort().join(",");
}

function evaluatedCandidateCards(candidate) {
  return evaluateSet(candidate?.cardIds ?? [], candidate?.jokerAssignments ?? {}, { allowForbiddenMonarch: true }).cards;
}

export function meaningfulAbilityActivationKey(effectId, candidate) {
  const physical = physicalCombinationKey(candidate);
  if (!candidateUsesJoker(candidate)) return physical;

  const cards = evaluatedCandidateCards(candidate);
  const suits = [...new Set(cards.map((card) => String(card.suit)))].sort().join(",");
  const highestValue = Number(candidate?.highestValue ?? Math.max(...cards.map((card) => Number(card.value))));
  const totalValue = Number(candidate?.totalValue ?? cards.reduce((sum, card) => sum + Number(card.value), 0));

  switch (effectId) {
    case SET_EFFECTS.MAGIC_PAIR:
      return `${physical}::${highestValue}:${suits}`;
    case SET_EFFECTS.DOUBLE_TROUBLE:
      return `${physical}::${highestValue}:${suits}`;
    case SET_EFFECTS.TRIPLE_SUPPORT:
      return `${physical}::${totalValue}`;
    case SET_EFFECTS.FULL_STATUS:
      return `${physical}::${highestValue % 2}`;
    case SET_EFFECTS.BLINDING_FLUSH:
      return `${physical}::${totalValue}:${highestValue % 2}`;
    case SET_EFFECTS.MAGIC_FLUSH:
      return `${physical}::${totalValue}:${suits}`;
    case SET_EFFECTS.FORBIDDEN_MONARCH:
    case SET_EFFECTS.JACKPOT:
    default:
      return physical;
  }
}

function* combinations(values, size, start = 0, current = []) {
  if (current.length === size) {
    yield [...current];
    return;
  }
  const remaining = size - current.length;
  for (let index = start; index <= values.length - remaining; index += 1) {
    current.push(values[index]);
    yield* combinations(values, size, index + 1, current);
    current.pop();
  }
}

function* iterateJokerAssignmentVariants(cardIds) {
  const jokerIds = (cardIds ?? [])
    .filter((cardId) => getCardDefinition(String(cardId))?.joker)
    .map(String)
    .sort((left, right) => left.localeCompare(right));
  if (!jokerIds.length) {
    yield {};
    return;
  }

  const current = {};
  function* walk(index) {
    if (index >= jokerIds.length) {
      yield normalizedAssignments(current);
      return;
    }
    const cardId = jokerIds[index];
    for (const suit of SORTED_SUITS) {
      for (const value of VALUES) {
        current[cardId] = { suit, value };
        yield* walk(index + 1);
      }
    }
    delete current[cardId];
  }
  yield* walk(0);
}

export function jokerAssignmentVariants(cardIds) {
  return [...iterateJokerAssignmentVariants(cardIds)];
}

function valueCountsFor(cardIds) {
  const counts = new Map();
  for (const cardId of cardIds) {
    const definition = getCardDefinition(String(cardId));
    if (!definition || definition.joker) continue;
    counts.set(definition.value, (counts.get(definition.value) ?? 0) + 1);
  }
  return [...counts.values()].sort((left, right) => right - left);
}

function naturalDefinitionsFor(cardIds) {
  return cardIds
    .map((cardId) => getCardDefinition(String(cardId)))
    .filter((definition) => definition && !definition.joker);
}

function fitsConsecutiveWindow(values) {
  const unique = [...new Set(values)].sort((left, right) => left - right);
  return Array.from({ length: 4 }, (_unused, offset) => offset + 1)
    .some((start) => unique.every((value) => value >= start && value <= start + 3));
}

function physicalCombinationMayMatch(effectId, cardIds) {
  const definitions = cardIds.map((cardId) => getCardDefinition(String(cardId))).filter(Boolean);
  const jokers = definitions.filter((definition) => definition.joker).length;
  const natural = definitions.filter((definition) => !definition.joker);
  const counts = valueCountsFor(cardIds);
  const naturalValues = natural.map((definition) => definition.value);

  switch (effectId) {
    case SET_EFFECTS.JACKPOT:
      return jokers === 0 && counts.length === 1;
    case SET_EFFECTS.MAGIC_PAIR:
    case SET_EFFECTS.TRIPLE_SUPPORT:
      return counts.length <= 1;
    case SET_EFFECTS.DOUBLE_TROUBLE:
      return (jokers === 0 && counts.join(",") === "2,2")
        || (jokers === 1 && counts.join(",") === "2,1")
        || (jokers === 2 && (counts.join(",") === "2" || counts.join(",") === "1,1"));
    case SET_EFFECTS.FULL_STATUS:
      return (jokers === 0 && counts.join(",") === "3,2")
        || (jokers === 1 && ["3,1", "2,2"].includes(counts.join(",")))
        || (jokers === 2 && ["3", "2,1"].includes(counts.join(",")));
    case SET_EFFECTS.BLINDING_FLUSH:
      return new Set(naturalValues).size === naturalValues.length && fitsConsecutiveWindow(naturalValues);
    case SET_EFFECTS.MAGIC_FLUSH:
      return new Set(naturalValues).size === naturalValues.length
        && new Set(natural.map((definition) => definition.suit)).size <= 1
        && fitsConsecutiveWindow(naturalValues);
    case SET_EFFECTS.FORBIDDEN_MONARCH:
      return jokers === 1 && natural.length === 4 && counts.length === 1;
    default:
      return false;
  }
}

function buildCandidate(effectId, cardIds, jokerAssignments, allowForbiddenMonarch) {
  const evaluation = evaluateSet(cardIds, jokerAssignments, { allowForbiddenMonarch });
  if (!evaluation.effects.includes(effectId)) return null;
  const candidate = {
    cardIds: [...cardIds],
    jokerAssignments: normalizedAssignments(jokerAssignments),
    effects: [...evaluation.effects],
    totalValue: evaluation.totalValue,
    highestValue: evaluation.highestValue,
    effectId,
  };
  candidate.key = abilityCandidateKey(candidate);
  return candidate;
}

function* iterateAbilityCandidates({ cardIds, effectId, lane, allowForbiddenMonarch }) {
  const size = CARD_ABILITY_CARD_COUNTS[effectId];
  const seenMeaningful = lane === "joker" ? new Set() : null;
  for (const selectedCardIds of combinations(cardIds, size)) {
    const usesJoker = selectedCardIds.some((cardId) => getCardDefinition(cardId)?.joker);
    if ((lane === "joker") !== usesJoker) continue;
    if (!physicalCombinationMayMatch(effectId, selectedCardIds)) continue;

    for (const assignments of iterateJokerAssignmentVariants(selectedCardIds)) {
      const candidate = buildCandidate(effectId, selectedCardIds, assignments, allowForbiddenMonarch);
      if (!candidate) continue;
      if (seenMeaningful) {
        const meaningfulKey = meaningfulAbilityActivationKey(effectId, candidate);
        if (seenMeaningful.has(meaningfulKey)) continue;
        seenMeaningful.add(meaningfulKey);
      }
      yield candidate;
    }
  }
}

function valuesInWindow(valueCounts, start) {
  let available = 0;
  for (let value = start; value <= start + 3; value += 1) {
    if ((valueCounts.get(value) ?? 0) > 0) available += 1;
  }
  return available;
}

function hasConsecutiveAvailability(index, naturalRequired, { sameSuit = false } = {}) {
  if (sameSuit) {
    for (const suit of SUITS) {
      const values = index.valuesBySuit.get(suit) ?? new Set();
      for (let start = 1; start <= 4; start += 1) {
        let available = 0;
        for (let value = start; value <= start + 3; value += 1) {
          if (values.has(value)) available += 1;
        }
        if (available >= naturalRequired) return true;
      }
    }
    return false;
  }

  for (let start = 1; start <= 4; start += 1) {
    if (valuesInWindow(index.valueCounts, start) >= naturalRequired) return true;
  }
  return false;
}

function effectAllowedByLimits(effectId, minimumCards, maximumCards, allowForbiddenMonarch) {
  const size = CARD_ABILITY_CARD_COUNTS[effectId];
  if (!Number.isInteger(size) || size < minimumCards || size > maximumCards) return false;
  return effectId !== SET_EFFECTS.FORBIDDEN_MONARCH || allowForbiddenMonarch;
}

function naturalAvailability(effectId, index) {
  const counts = [...index.valueCounts.values()];
  switch (effectId) {
    case SET_EFFECTS.JACKPOT:
      return counts.some((count) => count >= 4);
    case SET_EFFECTS.MAGIC_PAIR:
      return counts.some((count) => count >= 2);
    case SET_EFFECTS.TRIPLE_SUPPORT:
      return counts.some((count) => count >= 3);
    case SET_EFFECTS.DOUBLE_TROUBLE:
      return counts.filter((count) => count >= 2).length >= 2;
    case SET_EFFECTS.FULL_STATUS:
      return counts.some((count, indexOfCount) => count >= 3 && counts.some((other, otherIndex) => otherIndex !== indexOfCount && other >= 2));
    case SET_EFFECTS.BLINDING_FLUSH:
      return hasConsecutiveAvailability(index, 4);
    case SET_EFFECTS.MAGIC_FLUSH:
      return hasConsecutiveAvailability(index, 4, { sameSuit: true });
    case SET_EFFECTS.FORBIDDEN_MONARCH:
    default:
      return false;
  }
}

function jokerAvailabilityForCount(effectId, index, jokerCount) {
  const counts = [...index.valueCounts.values()];
  const naturalCount = index.naturalCardCount;
  if (jokerCount > index.jokerIds.length || naturalCount < CARD_ABILITY_CARD_COUNTS[effectId] - jokerCount) return false;

  switch (effectId) {
    case SET_EFFECTS.JACKPOT:
      return false;
    case SET_EFFECTS.MAGIC_PAIR:
      return jokerCount === 1 ? naturalCount >= 1 : jokerCount === 2;
    case SET_EFFECTS.TRIPLE_SUPPORT:
      return (jokerCount === 1 && counts.some((count) => count >= 2))
        || (jokerCount === 2 && naturalCount >= 1);
    case SET_EFFECTS.DOUBLE_TROUBLE:
      return (jokerCount === 1 && counts.some((count) => count >= 2 && naturalCount - count >= 1))
        || (jokerCount === 2 && naturalCount >= 2);
    case SET_EFFECTS.FULL_STATUS:
      return (jokerCount === 1 && (
        counts.some((count) => count >= 3 && naturalCount - count >= 1)
        || counts.filter((count) => count >= 2).length >= 2
      )) || (jokerCount === 2 && (
        counts.some((count) => count >= 3)
        || counts.some((count) => count >= 2 && naturalCount - count >= 1)
      ));
    case SET_EFFECTS.BLINDING_FLUSH:
      return hasConsecutiveAvailability(index, 4 - jokerCount);
    case SET_EFFECTS.MAGIC_FLUSH:
      return hasConsecutiveAvailability(index, 4 - jokerCount, { sameSuit: true });
    case SET_EFFECTS.FORBIDDEN_MONARCH:
      return jokerCount === 1 && counts.some((count) => count >= 4);
    default:
      return false;
  }
}

function jokerAvailability(effectId, index) {
  const maximumJokers = Math.min(index.jokerIds.length, CARD_ABILITY_CARD_COUNTS[effectId]);
  for (let jokerCount = 1; jokerCount <= maximumJokers; jokerCount += 1) {
    if (jokerAvailabilityForCount(effectId, index, jokerCount)) return true;
  }
  return false;
}

function laneKey(effectId, lane) {
  return `${String(effectId)}::${String(lane)}`;
}

export class AbilityCandidateIndex {
  #cardIds;
  #minimumCards;
  #maximumCards;
  #allowForbiddenMonarch;
  #handIndex;
  #availability;
  #cursors = new Map();

  constructor(hand = [], minimumCards = 2, maximumCards = 5, { allowForbiddenMonarch = false } = {}) {
    this.#cardIds = [...new Set((hand ?? [])
      .map((card) => String(card?.id ?? card ?? ""))
      .filter((cardId) => getCardDefinition(cardId)))]
      .sort((left, right) => left.localeCompare(right));
    this.#minimumCards = Math.max(2, Number(minimumCards) || 2);
    this.#maximumCards = Math.min(5, Number(maximumCards) || 5);
    this.#allowForbiddenMonarch = Boolean(allowForbiddenMonarch);

    const natural = naturalDefinitionsFor(this.#cardIds);
    const valueCounts = new Map();
    const valuesBySuit = new Map(SUITS.map((suit) => [suit, new Set()]));
    for (const definition of natural) {
      valueCounts.set(definition.value, (valueCounts.get(definition.value) ?? 0) + 1);
      valuesBySuit.get(definition.suit)?.add(definition.value);
    }
    this.#handIndex = Object.freeze({
      valueCounts,
      valuesBySuit,
      naturalCardCount: natural.length,
      jokerIds: Object.freeze(this.#cardIds.filter((cardId) => getCardDefinition(cardId)?.joker)),
    });

    this.#availability = Object.fromEntries(CARD_ABILITY_ORDER.map((effectId) => {
      if (!effectAllowedByLimits(effectId, this.#minimumCards, this.#maximumCards, this.#allowForbiddenMonarch)) {
        return [effectId, Object.freeze({ natural: false, joker: false })];
      }
      return [effectId, Object.freeze({
        natural: naturalAvailability(effectId, this.#handIndex),
        joker: jokerAvailability(effectId, this.#handIndex),
      })];
    }));
  }

  availability(effectId) {
    return this.#availability[String(effectId ?? "")] ?? { natural: false, joker: false };
  }

  hasCandidate(effectId, lane) {
    return Boolean(this.availability(effectId)[String(lane ?? "")]);
  }

  #newIterator(effectId, lane) {
    return iterateAbilityCandidates({
      cardIds: this.#cardIds,
      effectId,
      lane,
      allowForbiddenMonarch: this.#allowForbiddenMonarch,
    });
  }

  #resetCursor(effectId, lane) {
    const iterator = this.#newIterator(effectId, lane);
    const first = iterator.next().value ?? null;
    const cursor = { iterator, first, last: first };
    this.#cursors.set(laneKey(effectId, lane), cursor);
    return cursor;
  }

  nextCandidate(effectId, lane, currentCandidate = null) {
    const normalizedEffectId = String(effectId ?? "");
    const normalizedLane = String(lane ?? "");
    if (!CARD_ABILITY_ORDER.includes(normalizedEffectId) || !LANES.includes(normalizedLane)) return null;
    if (!this.hasCandidate(normalizedEffectId, normalizedLane)) return null;

    if (!currentCandidate) return this.#resetCursor(normalizedEffectId, normalizedLane).first;

    const key = laneKey(normalizedEffectId, normalizedLane);
    const currentKey = abilityCandidateKey(currentCandidate);
    let cursor = this.#cursors.get(key);
    if (cursor?.last && abilityCandidateKey(cursor.last) === currentKey) {
      const next = cursor.iterator.next();
      if (!next.done) {
        cursor.last = next.value;
        return next.value;
      }
      return this.#resetCursor(normalizedEffectId, normalizedLane).first;
    }

    cursor = this.#resetCursor(normalizedEffectId, normalizedLane);
    if (cursor.first && abilityCandidateKey(cursor.first) === currentKey) {
      const next = cursor.iterator.next();
      if (!next.done) {
        cursor.last = next.value;
        return next.value;
      }
      return this.#resetCursor(normalizedEffectId, normalizedLane).first;
    }

    for (let step = cursor.iterator.next(); !step.done; step = cursor.iterator.next()) {
      cursor.last = step.value;
      if (abilityCandidateKey(step.value) !== currentKey) continue;
      const next = cursor.iterator.next();
      if (!next.done) {
        cursor.last = next.value;
        return next.value;
      }
      return this.#resetCursor(normalizedEffectId, normalizedLane).first;
    }
    return this.#resetCursor(normalizedEffectId, normalizedLane).first;
  }

  candidateForSelection(effectId, lane, selectedCardIds, jokerAssignments = {}) {
    const normalizedEffectId = String(effectId ?? "");
    const normalizedLane = String(lane ?? "");
    const cardIds = [...new Set((selectedCardIds ?? []).map(String))].sort((left, right) => left.localeCompare(right));
    if (!this.hasCandidate(normalizedEffectId, normalizedLane)) return null;
    if (cardIds.length !== CARD_ABILITY_CARD_COUNTS[normalizedEffectId]) return null;
    if (abilityLaneForSelection(cardIds) !== normalizedLane) return null;
    if (cardIds.some((cardId) => !this.#cardIds.includes(cardId))) return null;
    try {
      return buildCandidate(normalizedEffectId, cardIds, jokerAssignments, this.#allowForbiddenMonarch);
    } catch (_error) {
      return null;
    }
  }
}

export function createAbilityCandidateIndex(hand, minimumCards, maximumCards, options = {}) {
  return new AbilityCandidateIndex(hand, minimumCards, maximumCards, options);
}

export function candidateMatchesSelection(candidate, selectedCardIds, jokerAssignments = {}) {
  const selected = [...(selectedCardIds ?? [])].map(String).sort();
  const candidateCards = [...(candidate?.cardIds ?? [])].map(String).sort();
  if (selected.length !== candidateCards.length || selected.some((cardId, index) => cardId !== candidateCards[index])) return false;

  const expected = normalizedAssignments(candidate?.jokerAssignments);
  const actual = normalizedAssignments(Object.fromEntries(Object.entries(jokerAssignments ?? {})
    .filter(([cardId]) => candidateCards.includes(String(cardId)) && getCardDefinition(String(cardId))?.joker)));
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function abilityLaneForSelection(cardIds) {
  return (cardIds ?? []).some((cardId) => getCardDefinition(String(cardId))?.joker) ? "joker" : "natural";
}

export function recognizedAbilityOptions(cardIds, effects) {
  const effectSet = new Set((effects ?? []).map(String));
  const lane = abilityLaneForSelection(cardIds);
  return CARD_ABILITY_ORDER
    .filter((effectId) => effectSet.has(effectId))
    .map((effectId) => ({ effectId, lane }));
}

export function recognizeAbilitySelection(cardIds, effects, {
  preferredEffectId = "",
  preferredLane = "",
} = {}) {
  const options = recognizedAbilityOptions(cardIds, effects);
  if (!options.length) return null;
  return options.find((option) => (
    option.effectId === String(preferredEffectId ?? "")
    && option.lane === String(preferredLane ?? "")
  )) ?? options[0];
}
