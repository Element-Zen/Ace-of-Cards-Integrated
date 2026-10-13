export function buildAbilityControlModel({ naturalCount = 0, jokerCount = 0, canUse = false } = {}) {
  const natural = Math.max(0, Number(naturalCount) || 0);
  const joker = Math.max(0, Number(jokerCount) || 0);
  const hasNatural = natural > 0;
  const hasJoker = joker > 0;
  const hasAny = hasNatural || hasJoker;
  const actionable = Boolean(canUse && hasAny);
  const separateJokerControl = Boolean(actionable && hasNatural && hasJoker);
  const primaryLane = hasNatural ? "natural" : hasJoker ? "joker" : "";

  return Object.freeze({
    hasNatural,
    hasJoker,
    hasAny,
    actionable,
    separateJokerControl,
    jokerOnly: Boolean(hasJoker && !hasNatural),
    primaryLane,
    showJokerIcon: hasJoker,
  });
}
