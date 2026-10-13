import { MODULE_ID } from "../constants.mjs";
import {
  applyCardVanguardReversePresentation,
  buildCardVanguardChatContent,
} from "../integrations/projectfu-card-vanguard.mjs";
import {
  applyDiscardActionPresentation,
  buildDiscardActionChatContent,
} from "../integrations/projectfu-discard-action.mjs";
import { applyMagicCardsReversePresentation } from "../integrations/projectfu-magic-cards-reversal.mjs";
import { applyDrawActionPresentation } from "../integrations/draw-action.mjs";
import { buildMagicCardsChatContent } from "../services/deck-play-service.mjs";

async function enrichHtml(content) {
  const editor = globalThis.foundry?.applications?.ux?.TextEditor?.implementation;
  return typeof editor?.enrichHTML === "function" ? editor.enrichHTML(content, { async: true }) : content;
}

const PROJECTFU_ITEM_DESCRIPTION_PARTIAL = "systems/projectfu/templates/chat/partials/chat-item-description.hbs";

export function suppressProjectFUItemDescription(sections = []) {
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (typeof section === "function") {
      sections[index] = async () => {
        const resolved = await section();
        return resolved?.partial === PROJECTFU_ITEM_DESCRIPTION_PARTIAL ? null : resolved;
      };
      continue;
    }
    if (section?.partial === PROJECTFU_ITEM_DESCRIPTION_PARTIAL) sections[index] = null;
  }
}

export function registerProjectFUTriggerHooks() {
  Hooks.on("projectfu.renderCheck", (data, check, actor, _item, additionalFlags) => {
    const aceData = check?.additionalData?.[MODULE_ID] ?? {};
    const magicCardsResult = aceData.magicCardsResult;
    if (magicCardsResult) {
      suppressProjectFUItemDescription(data.sections);
      additionalFlags[MODULE_ID] = {
        ...(additionalFlags[MODULE_ID] ?? {}),
        actorUuid: String(magicCardsResult.actorUuid ?? actor?.uuid ?? ""),
        expectedRevision: Number(magicCardsResult.expectedRevision),
        kind: "magic-cards",
        combatUuid: String(magicCardsResult.combatUuid ?? ""),
        sceneUuid: String(magicCardsResult.sceneUuid ?? ""),
      };
      const content = buildMagicCardsChatContent(actor, magicCardsResult, magicCardsResult.expectedRevision);
      data.sections.push(
        enrichHtml(content).then((enriched) => ({ order: 1000, content: enriched })),
      );
    }

    const vanguardResult = aceData.vanguardResult;
    if (vanguardResult) {
      suppressProjectFUItemDescription(data.sections);
      additionalFlags[MODULE_ID] = {
        ...(additionalFlags[MODULE_ID] ?? {}),
        actorUuid: String(vanguardResult.actorUuid ?? actor?.uuid ?? ""),
        kind: "card-vanguard",
        vanguard: {
          actorUuid: String(vanguardResult.actorUuid ?? actor?.uuid ?? ""),
          expectedRevision: Number(vanguardResult.expectedRevision),
          cardId: String(vanguardResult.cardId ?? ""),
          originalVanguardIndex: Number(vanguardResult.originalVanguardIndex),
          damageType: String(vanguardResult.damageType ?? ""),
          combatUuid: String(vanguardResult.combatUuid ?? ""),
          sceneUuid: String(vanguardResult.sceneUuid ?? ""),
        },
      };
      const content = buildCardVanguardChatContent(vanguardResult);
      data.sections.push(
        enrichHtml(content).then((enriched) => ({ order: 1000, content: enriched })),
      );
    }

    const discardActionResult = aceData.discardActionResult;
    if (discardActionResult) {
      additionalFlags[MODULE_ID] = {
        ...(additionalFlags[MODULE_ID] ?? {}),
        actorUuid: String(discardActionResult.actorUuid ?? actor?.uuid ?? ""),
        kind: "discard-action",
        combatUuid: String(discardActionResult.combatUuid ?? ""),
        sceneUuid: String(discardActionResult.sceneUuid ?? ""),
        discardAction: foundry.utils.deepClone(discardActionResult),
      };
      const content = buildDiscardActionChatContent(discardActionResult);
      data.sections.push(
        enrichHtml(content).then((enriched) => ({ order: 1000, content: enriched })),
      );
    }
  });

  Hooks.on("renderChatMessageHTML", (message, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    applyCardVanguardReversePresentation(message, root);
    applyDiscardActionPresentation(message, root);
    applyMagicCardsReversePresentation(message, root);
    applyDrawActionPresentation(message, root);
  });
}
