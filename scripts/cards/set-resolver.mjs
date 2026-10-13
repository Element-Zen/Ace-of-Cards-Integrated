import { getCardDefinition } from "./card-catalog.mjs";
import { SUITS } from "../constants.mjs";

export const SET_EFFECTS = Object.freeze({
  JACKPOT: "jackpot",
  MAGIC_FLUSH: "magic-flush",
  BLINDING_FLUSH: "blinding-flush",
  FULL_STATUS: "full-status",
  TRIPLE_SUPPORT: "triple-support",
  DOUBLE_TROUBLE: "double-trouble",
  MAGIC_PAIR: "magic-pair",
  FORBIDDEN_MONARCH: "forbidden-monarch",
});

const STATUS_EFFECTS = Object.freeze(["dazed", "shaken", "slow", "weak"]);

function counts(values) {
  const map = new Map();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return [...map.values()].sort((a, b) => b - a);
}

function consecutive(values) {
  const unique = [...new Set(values)].sort((a, b) => a - b);
  return unique.length === values.length && unique.every((value, index) => index === 0 || value === unique[index - 1] + 1);
}

function normalizeAssignments(cardIds, assignments = {}) {
  return cardIds.map((cardId) => {
    const base = getCardDefinition(cardId);
    if (!base) throw new Error(`Unknown Ace card ${cardId}.`);
    if (!base.joker) return { ...base, originalJoker: false };
    const assignment = assignments[cardId] ?? {};
    const value = Number(assignment.value);
    const suit = String(assignment.suit ?? "");
    if (!Number.isInteger(value) || value < 1 || value > 7) throw new Error(`Choose a value from 1 to 7 for ${cardId}.`);
    if (!SUITS.includes(suit)) throw new Error(`Choose an elemental suit for ${cardId}.`);
    return { id: cardId, suit, value, joker: true, originalJoker: true };
  });
}

export function evaluateSet(cardIds, assignments = {}, { allowForbiddenMonarch = false } = {}) {
  if (!Array.isArray(cardIds) || cardIds.length < 2 || cardIds.length > 5) throw new Error("Magic Cards resolves a set of 2 to 5 cards.");
  if (new Set(cardIds).size !== cardIds.length) throw new Error("A card cannot appear twice in one set.");
  const cards = normalizeAssignments(cardIds, assignments);
  const values = cards.map((card) => card.value);
  const suits = cards.map((card) => card.suit);
  const groups = counts(values);
  const originalJokers = cards.filter((card) => card.originalJoker).length;
  const effects = [];

  if (cards.length === 4 && originalJokers === 0 && groups.length === 1) effects.push(SET_EFFECTS.JACKPOT);
  if (cards.length === 4 && consecutive(values) && new Set(suits).size === 1) effects.push(SET_EFFECTS.MAGIC_FLUSH);
  if (cards.length === 4 && consecutive(values)) effects.push(SET_EFFECTS.BLINDING_FLUSH);
  if (cards.length === 5 && groups.join(",") === "3,2") effects.push(SET_EFFECTS.FULL_STATUS);
  if (cards.length === 3 && groups.length === 1) effects.push(SET_EFFECTS.TRIPLE_SUPPORT);
  if (cards.length === 4 && groups.join(",") === "2,2") effects.push(SET_EFFECTS.DOUBLE_TROUBLE);
  if (cards.length === 2 && groups.length === 1) effects.push(SET_EFFECTS.MAGIC_PAIR);

  if (allowForbiddenMonarch && cards.length === 5 && originalJokers === 1) {
    const nonJokers = cards.filter((card) => !card.originalJoker);
    if (nonJokers.length === 4 && new Set(nonJokers.map((card) => card.value)).size === 1) effects.push(SET_EFFECTS.FORBIDDEN_MONARCH);
  }

  return { cards, effects, totalValue: values.reduce((sum, value) => sum + value, 0), highestValue: Math.max(...values) };
}

function levelBonus(level) {
  if (level >= 40) return 20;
  if (level >= 20) return 10;
  return 0;
}

export function resolveSetEffect(evaluation, effectId, { actorLevel = 1, choices = {}, allowBlackWhite = false } = {}) {
  if (!evaluation.effects.length) {
    if (effectId) throw new Error("This set does not match an effect.");
    return { id: "none", label: "No matching effect", summary: "The set resolves without an effect.", details: {} };
  }
  if (!evaluation.effects.includes(effectId)) throw new Error("Choose one of the effects matched by this set.");

  const { cards, totalValue, highestValue } = evaluation;
  const elementalTypes = [...new Set(cards.map((card) => card.suit).filter(Boolean))];
  const bonus = levelBonus(Number(actorLevel) || 1);

  switch (effectId) {
    case SET_EFFECTS.JACKPOT:
      return { id: effectId, label: "Jackpot", summary: "Narratively present surrendered Player Characters regain consciousness; visible allies recover 777 HP and 777 MP.", details: { recoveryHP: 777, recoveryMP: 777 } };
    case SET_EFFECTS.MAGIC_FLUSH:
      return { id: effectId, label: "Magic Flush", summary: `Deal ${25 + totalValue + bonus} ${elementalTypes[0]} damage to every visible enemy.`, details: { damage: 25 + totalValue + bonus, damageType: elementalTypes[0], targets: "visible-enemies" } };
    case SET_EFFECTS.BLINDING_FLUSH: {
      const damageType = highestValue % 2 === 0 ? "light" : "dark";
      return { id: effectId, label: "Blinding Flush", summary: `Deal ${15 + totalValue + bonus} ${damageType} damage to every visible enemy.`, details: { damage: 15 + totalValue + bonus, damageType, targets: "visible-enemies" } };
    }
    case SET_EFFECTS.FULL_STATUS: {
      const selected = [choices.statusOne, choices.statusTwo];
      if (new Set(selected).size !== 2 || selected.some((status) => !STATUS_EFFECTS.includes(status))) throw new Error("Choose two different status effects.");
      const beneficial = highestValue % 2 === 0;
      return {
        id: effectId,
        label: "Full Status",
        summary: beneficial ? `Visible allies recover from ${selected.join(" and ")}.` : `Visible enemies suffer ${selected.join(" and ")}.`,
        details: { statuses: selected, mode: beneficial ? "recover" : "inflict", targets: beneficial ? "visible-allies" : "visible-enemies" },
      };
    }
    case SET_EFFECTS.TRIPLE_SUPPORT:
      return { id: effectId, label: "Triple Support", summary: `You and visible allies recover ${totalValue * 3} HP.`, details: { recoveryHP: totalValue * 3, targets: "self-and-visible-allies" } };
    case SET_EFFECTS.DOUBLE_TROUBLE: {
      const damageType = String(choices.damageType ?? "");
      if (!elementalTypes.includes(damageType) && !(allowBlackWhite && ["light", "dark"].includes(damageType))) throw new Error("Choose a damage type represented by the resolved suits, or light/dark through Black & White.");
      return { id: effectId, label: "Double Trouble", summary: `Deal ${10 + highestValue + bonus} ${damageType} damage to each of up to two visible enemies.`, details: { damage: 10 + highestValue + bonus, damageType, targets: "up-to-two-visible-enemies" } };
    }
    case SET_EFFECTS.MAGIC_PAIR:
      return {
        id: effectId,
        label: "Magic Pair",
        summary: "Perform a free attack with an equipped weapon. If it deals damage, choose a resolved elemental suit and convert all damage dealt by the attack to that type.",
        details: { damageTypes: elementalTypes, freeAttack: true, commonValue: highestValue },
      };
    case SET_EFFECTS.FORBIDDEN_MONARCH: {
      const commonValue = cards.find((card) => !card.originalJoker)?.value ?? highestValue;
      const damageType = commonValue % 2 === 0 ? "light" : "dark";
      return { id: effectId, label: "Forbidden Monarch", summary: `Deal 777 ${damageType} damage to every visible enemy.`, details: { damage: 777, damageType, targets: "visible-enemies", commonValue } };
    }
    default:
      throw new Error("Unknown Magic Cards effect.");
  }
}

export function effectLabel(effectId) {
  return ({
    [SET_EFFECTS.JACKPOT]: "Jackpot",
    [SET_EFFECTS.MAGIC_FLUSH]: "Magic Flush",
    [SET_EFFECTS.BLINDING_FLUSH]: "Blinding Flush",
    [SET_EFFECTS.FULL_STATUS]: "Full Status",
    [SET_EFFECTS.TRIPLE_SUPPORT]: "Triple Support",
    [SET_EFFECTS.DOUBLE_TROUBLE]: "Double Trouble",
    [SET_EFFECTS.MAGIC_PAIR]: "Magic Pair",
    [SET_EFFECTS.FORBIDDEN_MONARCH]: "Forbidden Monarch",
  })[effectId] ?? effectId;
}
