export function updateAbilityControlState(ability, armedAbility = null) {
  const natural = ability?.querySelector?.('[data-ability-lane="natural"]') ?? null;
  const joker = ability?.querySelector?.('[data-ability-lane="joker"]') ?? null;
  const effectId = String(ability?.dataset?.effectId ?? natural?.dataset?.effectId ?? joker?.dataset?.effectId ?? "");
  const activeNatural = Boolean(effectId && armedAbility?.effectId === effectId && armedAbility?.lane === "natural");
  const activeJoker = Boolean(effectId && armedAbility?.effectId === effectId && armedAbility?.lane === "joker");

  ability?.classList?.toggle?.("is-active-natural", activeNatural);
  ability?.classList?.toggle?.("is-active-joker", activeJoker);
  natural?.setAttribute?.("aria-pressed", activeNatural ? "true" : "false");
  joker?.setAttribute?.("aria-pressed", activeJoker ? "true" : "false");

  return Object.freeze({ effectId, activeNatural, activeJoker });
}
