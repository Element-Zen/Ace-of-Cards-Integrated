import { PROJECTFU_FUIDS } from "../constants.mjs";

function actorItemByFuid(actor, fuid) {
  if (!actor) return undefined;
  if (typeof actor.getSingleItemByFuid === "function") return actor.getSingleItemByFuid(fuid);
  return actor.items?.find?.((item) => item.system?.fuid === fuid);
}

export class ProjectFUAdapter {
  get active() {
    return game.system?.id === "projectfu";
  }

  async resolveActor(actorUuid) {
    const actor = await fromUuid(actorUuid);
    return actor?.documentName === "Actor" ? actor : null;
  }

  getItemByFuid(actor, fuid) {
    return actorItemByFuid(actor, fuid);
  }

  hasMagicCards(actor) {
    return Boolean(this.getItemByFuid(actor, PROJECTFU_FUIDS.MAGIC_CARDS));
  }

  getSkillLevel(actor, fuid) {
    const item = this.getItemByFuid(actor, fuid);
    const level = Number(item?.system?.level?.value ?? item?.system?.level ?? 0);
    return Number.isFinite(level) ? level : 0;
  }

  canUserViewActor(actor, user) {
    const observer = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER ?? 2;
    return Boolean(user?.isGM || actor?.testUserPermission?.(user, observer));
  }

  canUserManageActor(actor, user) {
    return Boolean(user?.isGM || actor?.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
  }

  getActorLevel(actor) {
    const level = Number(actor?.system?.level?.value ?? actor?.system?.level ?? 1);
    return Number.isFinite(level) ? level : 1;
  }

  getMindPoints(actor) {
    const value = Number(actor?.system?.resources?.mp?.value ?? 0);
    const max = Number(actor?.system?.resources?.mp?.max ?? value);
    return { value: Number.isFinite(value) ? value : 0, max: Number.isFinite(max) ? max : 0 };
  }

  getMagicCardsLimits(actor) {
    const skillLevel = this.getSkillLevel(actor, PROJECTFU_FUIDS.MAGIC_CARDS);
    const maximumMp = Math.min(25, 10 + (skillLevel * 5));
    return { skillLevel, minimumMp: 10, maximumMp, minimumCards: 2, maximumCards: maximumMp / 5 };
  }

  async displayItem(actor, item, initialConfigCallback = undefined) {
    if (!actor || !item) throw new Error("Unable to resolve the ProjectFU Actor or Item.");
    const display = game.projectfu?.Checks?.display;
    if (typeof display !== "function") throw new Error("This ProjectFU version does not expose Checks.display.");
    return display(actor, item, initialConfigCallback);
  }

  getSpells(actor) {
    return Array.from(actor?.items ?? []).filter((item) => item.type === "spell");
  }

  getSpellBaseCost(item) {
    const amount = Number(item?.system?.cost?.amount ?? item?.system?.cost?.value ?? 0);
    return Number.isFinite(amount) ? amount : Number.POSITIVE_INFINITY;
  }

  async launchSpell(item) {
    if (!item || item.type !== "spell" || typeof item.roll !== "function") throw new Error("Unable to resolve the selected ProjectFU spell.");
    return item.roll();
  }

  getEligibleActors({ user = game.user } = {}) {
    if (!this.active) return [];
    return game.actors
      .filter((actor) => actor.type === "character")
      .filter((actor) => this.canUserViewActor(actor, user))
      .map((actor) => {
        if (!this.hasMagicCards(actor)) return null;
        return {
          actor,
          actorUuid: actor.uuid,
          name: actor.name,
          img: actor.img,
          magicCardsLevel: this.getSkillLevel(actor, PROJECTFU_FUIDS.MAGIC_CARDS),
          skills: Object.fromEntries(
            Object.entries(PROJECTFU_FUIDS).map(([key, fuid]) => [key, Boolean(this.getItemByFuid(actor, fuid))]),
          ),
        };
      })
      .filter(Boolean);
  }
}

export const projectFUAdapter = new ProjectFUAdapter();
