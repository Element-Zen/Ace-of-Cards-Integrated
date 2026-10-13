import { MODULE_ID } from "../constants.mjs";
import {
  hasLegacyCardReferences,
  isLegacyCardId,
  migrateLegacyCardId,
  migrateLegacyCardMarkup,
  migrateLegacyMagicCardsResult,
} from "../cards/elemental-suit-migration.mjs";
import { getProjectFUCheck } from "../integrations/projectfu-chat-rules.mjs";
import { projectFUAdapter } from "../integrations/projectfu-adapter.mjs";
import { updateMagicCardsResultMessage } from "./deck-play-service.mjs";

function aceFlags(message) {
  return message?.flags?.[MODULE_ID] ?? {};
}

function migratedCheckWithResult(check, key, value) {
  const updated = foundry.utils.deepClone(check);
  updated.additionalData ??= {};
  updated.additionalData[MODULE_ID] ??= {};
  updated.additionalData[MODULE_ID][key] = value;
  return updated;
}

async function migrateMagicCardsMessage(message, check, result) {
  const actor = await projectFUAdapter.resolveActor(result.actorUuid ?? aceFlags(message).actorUuid);
  if (!actor) return false;
  const migrated = migrateLegacyMagicCardsResult(result);
  await updateMagicCardsResultMessage(message, check, migrated, actor);
  return true;
}

async function migrateCardVanguardMessage(message, check, result) {
  const migratedResult = foundry.utils.deepClone(result);
  migratedResult.cardId = migrateLegacyCardId(migratedResult.cardId);
  if (migratedResult.card && typeof migratedResult.card === "object") {
    migratedResult.card.id = migrateLegacyCardId(migratedResult.card.id);
    migratedResult.card.suit = String(migratedResult.damageType ?? migratedResult.card.suit ?? "").toLowerCase();
    migratedResult.card.face = migrateLegacyCardMarkup(migratedResult.card.face);
    migratedResult.card.label = migrateLegacyCardMarkup(migratedResult.card.label);
  }
  const flags = aceFlags(message);
  await message.update({
    content: migrateLegacyCardMarkup(message.content),
    "flags.projectfu.Check": migratedCheckWithResult(check, "vanguardResult", migratedResult),
    [`flags.${MODULE_ID}.vanguard.cardId`]: migratedResult.cardId,
    [`flags.${MODULE_ID}.migrationClosed`]: true,
    [`flags.${MODULE_ID}.migrationReason`]: "elemental-suit-migration",
    [`flags.${MODULE_ID}.actorUuid`]: flags.actorUuid,
  });
  return true;
}

async function migrateOtherAceMessage(message) {
  const flags = foundry.utils.deepClone(aceFlags(message));
  let changed = false;
  for (const key of ["previousVanguardCardId", "vanguardCardId", "cardId"]) {
    if (!isLegacyCardId(flags[key])) continue;
    flags[key] = migrateLegacyCardId(flags[key]);
    changed = true;
  }
  const content = migrateLegacyCardMarkup(message.content);
  if (content !== String(message.content ?? "")) changed = true;
  if (!changed) return false;
  await message.update({ content, [`flags.${MODULE_ID}`]: flags });
  return true;
}

export async function migrateLegacyInteractiveChatMessages() {
  if (!game.users.activeGM?.isSelf) return { migrated: 0, closed: 0, failed: [] };
  let migrated = 0;
  let closed = 0;
  const failed = [];
  for (const message of Array.from(game.messages ?? [])) {
    const flags = aceFlags(message);
    if (!Object.keys(flags).length) continue;
    try {
      const check = getProjectFUCheck(message);
      const aceData = check?.additionalData?.[MODULE_ID] ?? {};
      const magicCardsResult = aceData.magicCardsResult;
      if (magicCardsResult && hasLegacyCardReferences(magicCardsResult)) {
        if (await migrateMagicCardsMessage(message, check, magicCardsResult)) {
          migrated += 1;
          closed += 1;
        }
        continue;
      }
      const vanguardResult = aceData.vanguardResult;
      if (vanguardResult && hasLegacyCardReferences(vanguardResult)) {
        if (await migrateCardVanguardMessage(message, check, vanguardResult)) {
          migrated += 1;
          closed += 1;
        }
        continue;
      }
      if (await migrateOtherAceMessage(message)) migrated += 1;
    } catch (error) {
      failed.push({ messageId: message.id, error: error.message });
    }
  }
  return { migrated, closed, failed };
}
