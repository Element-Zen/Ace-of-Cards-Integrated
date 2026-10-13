import { getStyle } from "../cards/style-registry.mjs";
import { DECK_STATUS } from "../constants.mjs";
import { availableCardIds } from "../cards/deck-runtime.mjs";
import { projectFUAdapter } from "../integrations/projectfu-adapter.mjs";

export function normalizeDeckConfiguration(input = {}) {
  const styleId = input.styleId || input.lookId || input.skinId || "placeholder";
  if (!getStyle(styleId)) throw new Error(`Unknown Ace card Style: ${styleId}.`);
  return { styleId };
}

export function summarizeDeckState(actor, source, requester, container = null) {
  const zones = source?.zones ?? { hand: [], discard: [], vanguard: [] };
  const configuration = source?.configuration ?? { styleId: "placeholder" };
  const available = availableCardIds(zones).length;
  return {
    actorUuid: actor.uuid,
    actorName: actor.name,
    actorImg: actor.img,
    magicCardsLevel: projectFUAdapter.getSkillLevel(actor, "magic-cards"),
    status: container?.status ?? source?.status ?? DECK_STATUS.READY,
    revision: Number(container?.revision ?? source?.revision ?? 0),
    configuration: foundry.utils.deepClone(configuration),
    counts: {
      deck: available,
      hand: zones.hand?.length ?? 0,
      discard: zones.discard?.length ?? 0,
      vanguard: zones.vanguard?.length ?? 0,
      total: available + (zones.hand?.length ?? 0) + (zones.discard?.length ?? 0) + (zones.vanguard?.length ?? 0),
    },
    recoveryStatus: (container?.status ?? source?.status) === DECK_STATUS.CORRUPT ? "needs-review" : "clean",
    needsReview: (container?.status ?? source?.status) === DECK_STATUS.CORRUPT,
    encounterCount: container?.configuration?.crossEncounterDeck
      ? 0
      : Object.keys(container?.encounters ?? {}).length,
    canConfigure: projectFUAdapter.canUserManageActor(actor, requester),
  };
}
