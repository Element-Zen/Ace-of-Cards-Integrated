export const PROJECTFU_FLAG_SCOPE = "projectfu";
export const PROJECTFU_CHECK_FLAG = "Check";

export const DUEL_MASTER_WEAPON_CATEGORIES = Object.freeze([
  "arcane",
  "dagger",
  "firearm",
  "sword",
  "thrown",
]);

export function getProjectFUCheck(message) {
  if (!message) return null;
  return message.getFlag?.(PROJECTFU_FLAG_SCOPE, PROJECTFU_CHECK_FLAG)
    ?? message.flags?.[PROJECTFU_FLAG_SCOPE]?.[PROJECTFU_CHECK_FLAG]
    ?? null;
}
