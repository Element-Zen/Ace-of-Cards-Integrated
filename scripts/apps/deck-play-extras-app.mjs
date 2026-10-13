import { MODULE_ID, PLAY_STATE_CHANGED_HOOK, SETTINGS } from "../constants.mjs";
import { projectFUAdapter } from "../integrations/projectfu-adapter.mjs";
import { socketService } from "../services/socket-service.mjs";
import { actorIsInCombat, combatStarted, combatantActors, findCombatByUuid, resolveEncounterContext } from "../services/encounter-context-service.mjs";
import { Log } from "../util/log.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
function persistentMode() {
  return game.settings.get(MODULE_ID, SETTINGS.CROSS_ENCOUNTER_DECK) === true;
}

function eligiblePersistentActor(actor) {
  return Boolean(actor && projectFUAdapter.hasMagicCards(actor) && projectFUAdapter.canUserViewActor(actor, game.user));
}


function actorFromUuid(actorUuid) {
  const uuid = String(actorUuid ?? "");
  if (!uuid) return null;
  try {
    const document = globalThis.fromUuidSync?.(uuid);
    if (document?.documentName === "Actor") return document;
  } catch (_) {}
  const id = uuid.startsWith("Actor.") ? uuid.slice("Actor.".length) : uuid;
  return game.actors?.get?.(id) ?? null;
}

function livePilesActors(combat) {
  return combatantActors(combat)
    .filter((actor) => actor?.type === "character")
    .filter((actor) => projectFUAdapter.hasMagicCards(actor))
    .filter((actor) => projectFUAdapter.canUserViewActor(actor, game.user));
}

function resolveLivePilesContext(currentActorUuid = "") {
  if (persistentMode()) {
    const current = actorFromUuid(currentActorUuid);
    if (eligiblePersistentActor(current)) return { actorUuid: current.uuid, combatUuid: "", sceneUuid: "" };
    const controlled = Array.from(globalThis.canvas?.tokens?.controlled ?? [])
      .map((token) => token?.actor ?? token?.document?.actor)
      .find(eligiblePersistentActor);
    if (controlled) return { actorUuid: controlled.uuid, combatUuid: "", sceneUuid: "" };
    const character = game.user?.character;
    if (eligiblePersistentActor(character)) return { actorUuid: character.uuid, combatUuid: "", sceneUuid: "" };
    const candidates = Array.from(game.actors ?? []).filter(eligiblePersistentActor);
    return candidates.length === 1 ? { actorUuid: candidates[0].uuid, combatUuid: "", sceneUuid: "" } : null;
  }

  const context = resolveEncounterContext();
  const combat = context.combatUuid ? findCombatByUuid(context.combatUuid) : null;
  if (!combatStarted(combat)) return null;
  const eligible = (actor) => Boolean(actor && actorIsInCombat(actor, combat) && projectFUAdapter.hasMagicCards(actor) && projectFUAdapter.canUserViewActor(actor, game.user));
  const controlled = Array.from(globalThis.canvas?.tokens?.controlled ?? []).map((token) => token?.actor ?? token?.document?.actor).find(eligible);
  if (controlled) return { actorUuid: controlled.uuid, ...context };
  const character = game.user?.character;
  if (eligible(character)) return { actorUuid: character.uuid, ...context };
  const current = actorFromUuid(currentActorUuid);
  if (eligible(current)) return { actorUuid: current.uuid, ...context };
  const candidates = livePilesActors(combat);
  return candidates.length === 1 ? { actorUuid: candidates[0].uuid, ...context } : null;
}

function validWindowRect(value) {
  if (!value || typeof value !== "object") return null;
  const rect = {};
  for (const key of ["left", "top", "width", "height"]) {
    const numeric = Number(value[key]);
    if (Number.isFinite(numeric)) rect[key] = numeric;
  }
  return Object.keys(rect).length ? rect : null;
}

function dragPayload(event) {
  const raw = event.dataTransfer?.getData("application/x-ace-card") || event.dataTransfer?.getData("text/plain") || "";
  try { return JSON.parse(raw); } catch (_) { return null; }
}

export class AceDeckExtrasApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "ace-of-cards-integrated-piles",
    classes: ["ace-of-cards-integrated", "ace-deck-extras"],
    position: { width: 430, height: 620 },
    window: { title: "ACEOC.Play.Piles", icon: "fa-solid fa-layer-group", resizable: true, minimizable: true },
    actions: { revealHand: AceDeckExtrasApplication.revealHand, resetEncounter: AceDeckExtrasApplication.resetEncounter },
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/deck-play-extras.hbs` } };

  #actorUuid = "";
  #combatUuid = "";
  #sceneUuid = "";
  #state = null;
  #error = "";
  #stateHook = null;
  #refreshTimer = null;
  #interactionActive = false;
  #refreshPending = false;
  #contextHooks = [];
  #contextTimer = null;
  #contextSyncing = false;

  constructor(options = {}) {
    super(options);
    this.#stateHook = Hooks.on(PLAY_STATE_CHANGED_HOOK, (actorUuid, signal = {}) => {
      if (actorUuid !== this.#actorUuid || !this.rendered) return;
      if (!signal.crossEncounterDeck && signal.combatUuid && this.#combatUuid && signal.combatUuid !== this.#combatUuid) return;
      if (Number.isFinite(Number(signal.rootRevision)) && Number(this.#state?.rootRevision) >= Number(signal.rootRevision)) return;
      this.#queueRefresh();
    });
    for (const hookName of ["canvasReady", "createCombat", "updateCombat", "deleteCombat", "createCombatant", "updateCombatant", "deleteCombatant", "controlToken"]) {
      this.#contextHooks.push([hookName, Hooks.on(hookName, () => this.#queueContextSync())]);
    }
  }

  selectActor(actorUuid) { this.#actorUuid = String(actorUuid || this.#actorUuid || ""); return this; }
  selectEncounter(context = {}) {
    const resolved = persistentMode() ? { combatUuid: "", sceneUuid: "" } : resolveEncounterContext(context);
    this.#combatUuid = resolved.combatUuid;
    this.#sceneUuid = resolved.sceneUuid;
    return this;
  }
  setMode() { return this; }

  #queueRefresh({ immediate = false } = {}) {
    if (!this.rendered) return;
    if (this.#interactionActive) { this.#refreshPending = true; return; }
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => { this.#refreshTimer = null; if (this.rendered) void this.render({ force: true }); }, immediate ? 0 : 35);
  }

  #queueContextSync() {
    if (!this.rendered) return;
    if (this.#contextTimer) clearTimeout(this.#contextTimer);
    this.#contextTimer = setTimeout(() => { this.#contextTimer = null; void this.#synchronizeLiveContext(); }, 35);
  }

  async #synchronizeLiveContext() {
    if (this.#contextSyncing || !this.rendered) return;
    this.#contextSyncing = true;
    try {
      const next = resolveLivePilesContext(this.#actorUuid);
      if (!next) { await this.close(); return; }
      if (next.actorUuid === this.#actorUuid && next.combatUuid === this.#combatUuid && next.sceneUuid === this.#sceneUuid) return;
      this.selectActor(next.actorUuid).selectEncounter(next);
      await this.render({ force: true });
    } catch (error) { Log.error("Unable to update Piles for the active Encounter.", error); }
    finally { this.#contextSyncing = false; }
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    this.#error = "";
    const live = resolveLivePilesContext(this.#actorUuid);
    if (live) this.selectActor(live.actorUuid).selectEncounter(live);
    this.#state = null;
    if (this.#actorUuid) {
      try {
        const operation = persistentMode() ? "play.ensureDeck" : "play.getState";
        this.#state = await socketService.request(operation, { actorUuid: this.#actorUuid, combatUuid: this.#combatUuid, sceneUuid: this.#sceneUuid });
      }
      catch (error) { this.#error = error.message; }
    }
    const active = this.#state?.status === "active";
    return {
      ...context,
      error: this.#error,
      state: this.#state,
      active,
      canRevealHand: Boolean(active && (this.#state?.canManage || this.#state?.isGM) && this.#state?.hand?.length),
      canEditPiles: Boolean(active && this.#state?.isGM),
      canResetEncounter: Boolean(active && (this.#state?.isGM || (this.#state?.crossEncounterDeck && this.#state?.canManage))),
      resetLabel: game.i18n.localize(this.#state?.crossEncounterDeck ? "ACEOC.Play.ResetDeck" : "ACEOC.Play.ResetEncounterState"),
      isGM: this.#state?.isGM === true,
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    if (!root || !this.#state?.isGM) return;
    for (const card of root.querySelectorAll("[data-ace-pile-card]")) {
      card.addEventListener("dragstart", (event) => {
        this.#interactionActive = true;
        const payload = JSON.stringify({ cardId: card.dataset.cardId, fromZone: card.dataset.zone });
        event.dataTransfer?.setData("application/x-ace-card", payload);
        event.dataTransfer?.setData("text/plain", payload);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        card.classList.add("is-dragging");
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("is-dragging");
        this.#interactionActive = false;
        if (this.#refreshPending) { this.#refreshPending = false; this.#queueRefresh({ immediate: true }); }
      });
    }
    for (const zone of root.querySelectorAll("[data-ace-drop-zone]")) {
      zone.addEventListener("dragover", (event) => { const payload = dragPayload(event); if (!payload || payload.fromZone === zone.dataset.aceDropZone) return; event.preventDefault(); zone.classList.add("is-drop-target"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("is-drop-target"));
      zone.addEventListener("drop", async (event) => {
        event.preventDefault();
        zone.classList.remove("is-drop-target");
        const payload = dragPayload(event);
        if (!payload || payload.fromZone === zone.dataset.aceDropZone) return;
        await this.#submit("play.gmMoveCard", { ...payload, toZone: zone.dataset.aceDropZone });
      });
    }
  }

  static async revealHand() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("ACEOC.Play.ShowHandTitle") },
      content: `<p>${game.i18n.localize("ACEOC.Play.ShowHandWarning")}</p>`,
      defaultYes: false,
    });
    if (confirmed) await this.#submit("play.revealHand");
  }

  static async resetEncounter() {
    const allowed = this.#state?.status === "active"
      && (this.#state?.isGM || (this.#state?.crossEncounterDeck && this.#state?.canManage));
    if (!allowed) return;
    const persistent = this.#state?.crossEncounterDeck === true;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize(persistent ? "ACEOC.Play.ResetDeckTitle" : "ACEOC.Play.ResetEncounterTitle") },
      content: `<p>${game.i18n.localize(persistent ? "ACEOC.Play.ResetDeckWarning" : "ACEOC.Play.ResetEncounterWarning")}</p>`,
      defaultYes: false,
    });
    if (confirmed) await this.#submit("play.resetEncounter");
  }

  async #submit(operation, extra = {}) {
    if (!this.#state) return;
    try {
      const mutationState = await socketService.request(operation, {
        actorUuid: this.#state.actorUuid,
        expectedRevision: this.#state.revision,
        combatUuid: this.#combatUuid || this.#state.conflict?.combatUuid || "",
        sceneUuid: this.#sceneUuid || this.#state.conflict?.sceneUuid || "",
        ...extra,
      });
      this.#state = mutationState;
      await this.render({ force: true });
      return mutationState;
    } catch (error) {
      Log.error(`${operation} failed.`, error);
      ui.notifications.error(error.message);
      if (/changed|refresh/i.test(String(error.message ?? ""))) this.#queueRefresh({ immediate: true });
    }
  }

  async close(options) {
    try {
      const rect = {};
      for (const key of ["left", "top", "width", "height"]) if (Number.isFinite(Number(this.position?.[key]))) rect[key] = Number(this.position[key]);
      await game.settings.set(MODULE_ID, SETTINGS.PLAY_EXTRAS_WINDOW_RECT, rect);
    } catch (error) { Log.error("Unable to save the Piles window position.", error); }
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    if (this.#contextTimer) clearTimeout(this.#contextTimer);
    if (this.#stateHook !== null) Hooks.off(PLAY_STATE_CHANGED_HOOK, this.#stateHook);
    for (const [hookName, hookId] of this.#contextHooks) Hooks.off(hookName, hookId);
    extrasApp = null;
    return super.close(options);
  }
}

let extrasApp;
export function openDeckExtras({ actorUuid = "", combatUuid = "", sceneUuid = "" } = {}) {
  if (!extrasApp) {
    const storedRect = validWindowRect(game.settings.get(MODULE_ID, SETTINGS.PLAY_EXTRAS_WINDOW_RECT));
    extrasApp = new AceDeckExtrasApplication(storedRect ? { position: { width: 430, height: 620, ...storedRect } } : {});
  }
  extrasApp.selectActor(actorUuid).selectEncounter({ combatUuid, sceneUuid });
  return extrasApp.render({ force: true });
}
