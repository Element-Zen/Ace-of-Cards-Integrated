export const FULL_STATUS_OPTIONS = Object.freeze(["dazed", "shaken", "slow", "weak"]);

function titleCase(value) {
  const text = String(value ?? "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

export function availableDamageTypes(evaluation, state) {
  const types = (evaluation?.cards ?? []).map((card) => card.suit).filter(Boolean);
  if (state?.heroicSkills?.blackWhite && evaluation?.effects?.includes("double-trouble")) {
    types.push("light", "dark");
  }
  return [...new Set(types.map(String))];
}

export function resolutionChoiceState(effectId, evaluation, state, choices = {}) {
  const id = String(effectId ?? "");
  if (id === "full-status") {
    const selectedStatuses = [...new Set([choices.statusOne, choices.statusTwo]
      .map(String)
      .filter((status) => FULL_STATUS_OPTIONS.includes(status)))];
    return {
      kind: "statuses",
      ready: selectedStatuses.length === 2,
      selectedStatuses,
      selectedDamageType: "",
      selectionLimitReached: selectedStatuses.length >= 2,
      statusOptions: FULL_STATUS_OPTIONS.map((status) => ({
        id: status,
        label: titleCase(status),
        selected: selectedStatuses.includes(status),
      })),
      damageTypes: [],
    };
  }

  if (id === "double-trouble") {
    const available = availableDamageTypes(evaluation, state);
    const selectedDamageType = available.includes(String(choices.damageType ?? ""))
      ? String(choices.damageType)
      : "";
    return {
      kind: "damage-type",
      ready: Boolean(selectedDamageType),
      selectedStatuses: [],
      selectedDamageType,
      selectionLimitReached: false,
      statusOptions: [],
      damageTypes: available.map((damageType) => ({
        id: damageType,
        label: titleCase(damageType),
        selected: selectedDamageType === damageType,
      })),
    };
  }

  return {
    kind: "none",
    ready: true,
    selectedStatuses: [],
    selectedDamageType: "",
    selectionLimitReached: false,
    statusOptions: [],
    damageTypes: [],
  };
}
