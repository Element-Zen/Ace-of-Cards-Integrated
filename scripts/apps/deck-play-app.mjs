import { getCardDefinition } from "../cards/card-catalog.mjs";
import {
  abilityLaneForSelection,
  CARD_ABILITY_ORDER,
  createAbilityCandidateIndex,
  recognizeAbilitySelection,
} from "../cards/ability-candidates.mjs";
import { evaluateSet, effectLabel } from "../cards/set-resolver.mjs";
import { magicCardsMpCost } from "../cards/magic-cards-cost.mjs";
import { DAMAGE_TYPES, STYLES_CHANGED_HOOK, MODULE_ID, PLAY_ACTOR_CHANGED_HOOK, PLAY_CARD_SCALE_CHANGED_HOOK, PLAY_STATE_CHANGED_HOOK, SETTINGS, SUITS } from "../constants.mjs";
import { resolveEncounterContext } from "../services/encounter-context-service.mjs";
import { projectFUAdapter } from "../integrations/projectfu-adapter.mjs";
import { socketService } from "../services/socket-service.mjs";
import { Log } from "../util/log.mjs";
import { openDeckManager } from "./deck-manager-app.mjs";
import { openDeckExtras } from "./deck-play-extras-app.mjs";
import { buildAbilityControlModel } from "./ability-control-model.mjs";
import { updateAbilityControlState } from "./ability-control-state.mjs";
import { CARD_ABILITY_DISPLAY_ORDER } from "./ability-display-order.mjs";
import { updateClearSetControl } from "./selection-controls.mjs";
import {
  DRAG_EDGE_NAVIGATION,
  terminalInsertionSlotDirection,
  insertionGapForPointer,
  mergeGroupOrder,
  nextCardIdAfterVisibleGroup,
  reflowTranslations,
  reorderCardAtGap,
} from "./hand-reorder.mjs";
import { getPlaySession } from "./play-session.mjs";
import { calculateResultRailLayout } from "./result-rail-layout.mjs";
import { FULL_STATUS_OPTIONS, resolutionChoiceState } from "./resolution-choices.mjs";
import { buildVanguardCards, partitionHandCards } from "./composite-card-rail.mjs";
import { cardControlMetrics, normalizeCardScale } from "./card-scale.mjs";
import {
  CARD_WINDOW_DEFAULTS,
  calculateWholeCardCapacity,
  cardWindowRange,
  cardWindowStartForSelection,
  shiftCardWindow,
  shiftCardWindowWithinGroup,
} from "./card-window.mjs";
import {
  DRAWER_TOP_GAP,
  calculateSidebarInset,
  clampDrawerHeight,
  minimumDrawerHeightForContent,
  normalizeDrawerDirection,
  oppositeDrawerDirection,
} from "./drawer-layout.mjs";

const VALUES = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
const BASE_CARD_WIDTH = 110;
const BASE_CARD_HEIGHT = 160;
function titleCase(value) {
  const text = String(value ?? "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function escape(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

async function resolveVanguardRevealDamageType(card) {
  const definition = getCardDefinition(card?.id);
  if (!definition) throw new Error("The selected Vanguard card is no longer available.");
  if (!definition.joker) return String(definition.suit ?? "").toLowerCase();

  const damageOptions = DAMAGE_TYPES.map((type) => `<option value="${escape(type)}">${escape(titleCase(type))}</option>`).join("");
  const content = `<form class="ace-vanguard-reveal-dialog ace-vanguard-reveal-dialog--type-only">
    <figure aria-label="${escape(card.label)}"><img src="${escape(card.face)}" alt="" aria-hidden="true"></figure>
    <label class="ace-vanguard-reveal-dialog__type"><span>Damage type dealt by the triggering source</span><select name="damageType">${damageOptions}</select></label>
  </form>`;
  return foundry.applications.api.DialogV2.wait({
    window: { title: "Card Vanguard — Choose Damage Type" },
    content,
    buttons: [
      { action: "cancel", label: "Cancel", callback: () => null },
      {
        action: "choose",
        label: "Choose",
        default: true,
        callback: (_event, actionButton) => String(actionButton.form.elements.damageType?.value ?? ""),
      },
    ],
  });
}


function cssPixels(value, fallback = 0) {
  const numeric = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function revealCardImageWhenReady(image, readyImageUrls) {
  if (!image || image.dataset.aceImageReveal) return;
  const imageUrl = String(image.currentSrc || image.src || image.getAttribute?.("src") || "");
  if (imageUrl && readyImageUrls?.has(imageUrl)) {
    image.dataset.aceImageReveal = "ready";
    image.classList.add("is-image-ready");
    return;
  }
  image.dataset.aceImageReveal = "pending";

  const reveal = () => {
    if (imageUrl) readyImageUrls?.add(imageUrl);
    image.dataset.aceImageReveal = "ready";
    image.classList.add("is-image-ready");
  };
  const decodeThenReveal = () => {
    if (typeof image.decode !== "function") {
      reveal();
      return;
    }
    Promise.resolve(image.decode()).catch(() => {}).finally(reveal);
  };

  if (image.complete) {
    if (image.naturalWidth > 0) decodeThenReveal();
    else reveal();
    return;
  }
  image.addEventListener("load", decodeThenReveal, { once: true });
  image.addEventListener("error", reveal, { once: true });
}

function requestDrawerExclusivity(drawer, direction) {
  const normalizedDirection = normalizeDrawerDirection(direction);
  const manager = globalThis.ZenBladesDrawerManager;
  const request = manager?.requestOpen
    ? manager.requestOpen({
      drawer,
      id: "ace-of-cards-integrated",
      direction: normalizedDirection,
      allowStack: false,
      closeMs: 170,
    })
    : null;
  return Promise.resolve(request).catch((error) => {
    Log.error(`Unable to coordinate ${normalizedDirection}-drawer exclusivity.`, error);
  });
}

export class AceDeckPlayDrawer {

  #actorUuid = "";
  #combatUuid = "";
  #sceneUuid = "";
  #state = null;
  #error = "";
  #session = null;
  #unsubscribeSession = null;
  #preview = null;
  #abilityCandidateIndex = createAbilityCandidateIndex([], 2, 5);
  #abilitySignature = "";
  #abilityCandidatesDirty = true;
  #deferredAbilityCandidateRefresh = null;
  #activeAbilityId = "";
  #activeAbilityLane = "";
  #armedAbilityId = "";
  #armedAbilityLane = "";
  #discardMode = "";
  #scale = 1;
  #stateHook = null;
  #actorHook = null;
  #scaleHook = null;
  #styleHook = null;
  #refreshTimer = null;
  #interactionActive = false;
  #refreshPending = false;
  #pendingRootRevision = 0;
  #resultResizeObserver = null;
  #cardWindowResizeObserver = null;
  #cardWindowStart = 0;
  #cardWindowCapacity = 0;
  #cardWindowFrozen = false;
  #wheelAccumulator = 0;
  #wheelResetTimer = null;
  #drawerResizeObserver = null;
  #drawerMutationObserver = null;
  #drawerWindowResizeHandler = null;
  #drawerOpened = false;
  #closing = false;
  #root = null;
  #surface = null;
  #content = null;
  #renderGeneration = 0;
  #domObserver = null;
  #beforeUnloadHandler = null;
  #actionCleanup = null;
  #handGestureCleanup = null;
  #direction = "bottom";
  #orientationChanging = false;
  #readyImageUrls = new Set();

  constructor() {
    this.#scale = normalizeCardScale(game.settings.get(MODULE_ID, SETTINGS.PLAY_CARD_SCALE));
    this.#direction = normalizeDrawerDirection(game.settings.get(MODULE_ID, SETTINGS.PLAY_DRAWER_DIRECTION));
    this.#stateHook = Hooks.on(PLAY_STATE_CHANGED_HOOK, (actorUuid, signal = {}) => {
      if (actorUuid !== this.#actorUuid) return;
      if (!signal.crossEncounterDeck && signal.combatUuid && this.#combatUuid && signal.combatUuid !== this.#combatUuid) return;
      const rootRevision = signal.rootRevision === null || signal.rootRevision === undefined
        ? Number.NaN
        : Number(signal.rootRevision);
      if (Number.isFinite(rootRevision)) {
        if (Number(this.#state?.rootRevision) >= rootRevision) return;
        this.#pendingRootRevision = Math.max(this.#pendingRootRevision, rootRevision);
      }
      this.#queueRefresh({ immediate: true });
    });
    this.#actorHook = Hooks.on(PLAY_ACTOR_CHANGED_HOOK, (actorUuid, { source = null } = {}) => {
      if (source === this || actorUuid === this.#actorUuid) return;
      this.selectActor(actorUuid);
      this.#queueRefresh({ immediate: true });
    });
    this.#scaleHook = Hooks.on(PLAY_CARD_SCALE_CHANGED_HOOK, (change) => {
      this.#applyCardScale(change?.value ?? change);
    });
    this.#styleHook = Hooks.on(STYLES_CHANGED_HOOK, () => {
      this.#readyImageUrls.clear();
      this.#queueRefresh({ immediate: true });
    });
  }

  get rendered() { return Boolean(this.#root?.isConnected && !this.#closing); }
  get element() { return this.#surface; }
  get shellEl() { return this.#root; }
  get direction() { return this.#direction; }
  get encounterContext() {
    return {
      actorUuid: this.#actorUuid,
      combatUuid: this.#combatUuid,
      sceneUuid: this.#sceneUuid,
    };
  }

  async render(options = {}) {
    if (this.#closing) return this;
    const generation = ++this.#renderGeneration;
    const context = await this.#prepareContext({
      suppliedState: options?.state ?? null,
      deferAbilityCandidates: options?.deferAbilityCandidates === true,
    });
    const renderer = foundry.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
    if (typeof renderer !== "function") throw new Error("Foundry Handlebars renderer is unavailable.");
    const html = await renderer(`modules/${MODULE_ID}/templates/deck-play.hbs`, context);
    if (generation !== this.#renderGeneration || this.#closing) return this;
    this.#ensureShell();
    this.#content.innerHTML = html;
    this.#wireCardImageReveal(this.#content);
    this.#onRender(context);
    return this;
  }

  #ensureShell() {
    if (this.#root?.isConnected && this.#surface?.isConnected && this.#content?.isConnected) return;
    const document = globalThis.document;
    if (!document?.body) throw new Error("Ace of Cards Integrated cannot mount before the Foundry interface is ready.");

    this.#root?.remove?.();
    const shell = document.createElement("section");
    shell.id = "ace-of-cards-integrated-play";
    shell.className = "ace-of-cards-integrated ace-hand-dom-shell";
    shell.dataset.zbManaged = "true";
    shell.dataset.zbDir = this.#direction;
    shell.dataset.open = "true";

    const surface = document.createElement("div");
    surface.className = `ace-hand-dom-surface ace-${this.#direction}-drawer`;
    const content = document.createElement("div");
    content.className = "ace-hand-dom-content";
    surface.appendChild(content);
    shell.appendChild(surface);
    document.body.appendChild(shell);

    this.#root = shell;
    this.#surface = surface;
    this.#content = content;
    this.#closing = false;

    this.#domObserver?.disconnect();
    if (typeof MutationObserver === "function") {
      this.#domObserver = new MutationObserver(() => {
        if (this.#closing) return;
        if (this.#root?.isConnected) return;
        this.#root = null;
        this.#surface = null;
        this.#content = null;
        setTimeout(() => { if (!this.#closing) void this.render({ force: true }); }, 0);
      });
      this.#domObserver.observe(document.body, { childList: true });
    }
    this.#beforeUnloadHandler ??= () => this.#destroy();
    globalThis.window?.addEventListener?.("beforeunload", this.#beforeUnloadHandler, { once: true });
  }

  #wireActions(root) {
    this.#actionCleanup?.();
    const controller = new AbortController();
    this.#actionCleanup = () => controller.abort();
    root.addEventListener("click", (event) => {
      const target = event.target?.closest?.("[data-action]");
      if (!target || !root.contains(target) || target.disabled) return;
      const action = String(target.dataset.action ?? "");
      const handler = {
        cycleAbility: this.cycleAbility,
        resolveAbility: this.resolveAbility,
        toggleResolutionStatus: this.toggleResolutionStatus,
        selectResolutionDamageType: this.selectResolutionDamageType,
        toggleVanguard: this.toggleVanguard,
        revealVanguard: this.revealVanguard,
        toggleDiscardMode: this.toggleDiscardMode,
        draw: this.draw,
        clearSet: this.clearSet,
        refresh: this.refresh,
        openDeckManager: this.openDeckManager,
        openPiles: this.openPiles,
        toggleDrawerDirection: this.toggleDrawerDirection,
        closeDrawer: () => this.close(),
      }[action];
      if (typeof handler !== "function") return;
      event.preventDefault();
      event.stopPropagation();
      Promise.resolve(handler.call(this, event, target)).catch((error) => {
        Log.error(`Drawer action ${action} failed.`, error);
        ui.notifications.error(error.message);
      });
    }, { signal: controller.signal });
  }

  selectActor(actorUuid, { announce = false } = {}) {
    const nextActorUuid = String(actorUuid || this.#actorUuid || "");
    if (!nextActorUuid) return this;
    if (nextActorUuid !== this.#actorUuid || !this.#session) {
      this.#unsubscribeSession?.();
      this.#actorUuid = nextActorUuid;
      this.#session = getPlaySession(nextActorUuid, this.#combatUuid || "none");
      this.#unsubscribeSession = this.#session?.subscribe(({ source }) => {
        if (source === this) return;
        this.#queueRefresh();
      }) ?? null;
      this.#preview = null;
      this.#abilitySignature = "";
      this.#abilityCandidatesDirty = true;
      this.#activeAbilityId = "";
      this.#activeAbilityLane = "";
      this.#armedAbilityId = "";
      this.#armedAbilityLane = "";
      this.#discardMode = "";
      this.#cardWindowStart = 0;
      this.#cardWindowCapacity = 0;
    }
    if (announce && nextActorUuid) Hooks.callAll(PLAY_ACTOR_CHANGED_HOOK, nextActorUuid, { source: this });
    return this;
  }

  selectEncounter(context = {}) {
    const resolved = game.settings.get(MODULE_ID, SETTINGS.CROSS_ENCOUNTER_DECK) === true
      ? { combatUuid: "", sceneUuid: "" }
      : resolveEncounterContext(context);
    const changed = resolved.combatUuid !== this.#combatUuid || resolved.sceneUuid !== this.#sceneUuid;
    this.#combatUuid = resolved.combatUuid;
    this.#sceneUuid = resolved.sceneUuid;
    if (changed) {
      this.#preview = null;
      this.#abilitySignature = "";
      this.#abilityCandidatesDirty = true;
      this.#activeAbilityId = "";
      this.#activeAbilityLane = "";
      this.#armedAbilityId = "";
      this.#armedAbilityLane = "";
      this.#discardMode = "";
      this.#cardWindowStart = 0;
      this.#cardWindowCapacity = 0;
      this.#unsubscribeSession?.();
      this.#session = getPlaySession(this.#actorUuid, this.#combatUuid || "none");
      this.#unsubscribeSession = this.#session?.subscribe(({ source }) => {
        if (source === this) return;
        this.#queueRefresh();
      }) ?? null;
    }
    return this;
  }

  #queueRefresh({ immediate = false } = {}) {
    if (!this.rendered) return;
    if (this.#interactionActive) {
      this.#refreshPending = true;
      return;
    }
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      if (!this.rendered) return;
      void this.render({ force: true });
    }, immediate ? 0 : 35);
  }

  #beginInteraction() {
    this.#interactionActive = true;
  }

  #endInteraction() {
    this.#interactionActive = false;
    if (!this.#refreshPending) return;
    this.#refreshPending = false;
    this.#queueRefresh({ immediate: true });
  }

  #clearDraft() {
    this.#session?.clearSelection(this);
    this.#preview = null;
    this.#activeAbilityId = "";
    this.#activeAbilityLane = "";
    this.#armedAbilityId = "";
    this.#armedAbilityLane = "";
  }

  #orderedHand() {
    return this.#session?.orderedHand(this.#state?.hand ?? []) ?? [];
  }

  #selectedCardIds() {
    return this.#session?.selectedCardIds() ?? [];
  }

  #reorderHandDom(root) {
    const group = root?.querySelector?.('[data-hand-card-group="hand"]');
    if (!group) return false;
    const cardsById = new Map([...group.querySelectorAll('[data-card-zone="hand"][data-card-id]')]
      .map((card) => [String(card.dataset.cardId ?? ""), card]));
    for (const card of this.#orderedHand()) {
      const element = cardsById.get(String(card.id ?? ""));
      if (element) group.appendChild(element);
    }
    return true;
  }

  #missingJokerAssignment(cardIds) {
    return cardIds.find((cardId) => {
      if (!getCardDefinition(cardId)?.joker) return false;
      const assignment = this.#session?.jokerAssignments?.[cardId];
      return !SUITS.includes(String(assignment?.suit ?? "")) || !VALUES.includes(Number(assignment?.value));
    }) ?? "";
  }

  #evaluateSelection() {
    const cardIds = this.#selectedCardIds();
    const active = this.#state?.status === "active";
    if (!active) return { cardIds, valid: false, message: game.i18n.localize("ACEOC.Play.Idle") };
    if (!cardIds.length) return { cardIds, valid: false, message: game.i18n.localize("ACEOC.Play.NoCardsSelected") };

    if (this.#discardMode) {
      const limit = Number(this.#discardMode === "trap-card"
        ? this.#state?.classSkills?.trapCardLimit
        : this.#state?.classSkills?.mulliganLimit) || 0;
      const label = this.#discardMode === "trap-card" ? "Trap Card" : "Mulligan";
      if (!limit) return { cardIds, valid: false, message: `${label} is unavailable.` };
      if (cardIds.length > limit) {
        return {
          cardIds,
          valid: false,
          message: game.i18n.format("ACEOC.Play.DiscardSelectionRange", { ability: label, maximum: limit, count: cardIds.length }),
        };
      }
      return {
        cardIds,
        valid: true,
        mode: this.#discardMode,
        maximum: limit,
        message: game.i18n.format("ACEOC.Play.DiscardSelectionReady", { ability: label, count: cardIds.length }),
      };
    }

    const limits = this.#state?.magicCards;
    if (!limits) return { cardIds, valid: false, message: game.i18n.localize("ACEOC.Play.Idle") };
    if (cardIds.length < limits.minimumCards || cardIds.length > limits.maximumCards) {
      return {
        cardIds,
        valid: false,
        message: game.i18n.format("ACEOC.Play.SelectionRange", { minimum: limits.minimumCards, maximum: limits.maximumCards, count: cardIds.length }),
      };
    }
    if (this.#missingJokerAssignment(cardIds)) {
      return { cardIds, valid: false, message: game.i18n.format("ACEOC.Play.JokerRequired", { cost: magicCardsMpCost(cardIds) }) };
    }
    try {
      const evaluation = evaluateSet(cardIds, this.#session?.selectedJokerAssignments() ?? {}, { allowForbiddenMonarch: Boolean(this.#state?.heroicSkills?.forbiddenRite) });
      const labels = evaluation.effects.map(effectLabel);
      const effectText = labels.length ? labels.join(" / ") : game.i18n.localize("ACEOC.Play.NoMatchingEffectShort");
      return { cardIds, valid: true, evaluation, message: `${effectText} · ${magicCardsMpCost(cardIds)} MP` };
    } catch (error) {
      return { cardIds, valid: false, message: error.message };
    }
  }


  #abilityAvailabilityFor(effectId = this.#activeAbilityId) {
    return this.#abilityCandidateIndex.availability(String(effectId ?? ""));
  }

  #selectedAbilityCandidate(effectId = this.#activeAbilityId, lane = this.#activeAbilityLane) {
    return this.#abilityCandidateIndex.candidateForSelection(
      effectId,
      lane,
      this.#selectedCardIds(),
      this.#session?.selectedJokerAssignments() ?? {},
    );
  }

  #syncArmedAbility() {
    if (this.#discardMode) {
      this.#armedAbilityId = "";
      this.#armedAbilityLane = "";
      return null;
    }
    const recognized = recognizeAbilitySelection(
      this.#preview?.cardIds ?? [],
      this.#preview?.valid ? this.#preview?.evaluation?.effects : [],
      {
        preferredEffectId: this.#armedAbilityId || this.#activeAbilityId,
        preferredLane: this.#armedAbilityLane || this.#activeAbilityLane,
      },
    );
    this.#armedAbilityId = recognized?.effectId ?? "";
    this.#armedAbilityLane = recognized?.lane ?? "";
    return recognized;
  }

  #vanguardDesignationAvailable() {
    return Boolean(
      !this.#discardMode
      && this.#state?.status === "active"
      && this.#state?.canManage
      && this.#state?.hasCardVanguard
      && Number(this.#state?.counts?.vanguard ?? 0) < 3
      && this.#syncArmedAbility()
    );
  }

  #abilitySignatureForState() {
    const abilityMembership = (this.#state?.hand ?? []).map((card) => String(card.id)).sort().join(",");
    return this.#state?.status === "active"
      ? `${abilityMembership}::${this.#state.magicCards.minimumCards}:${this.#state.magicCards.maximumCards}:${Boolean(this.#state.heroicSkills?.forbiddenRite)}`
      : "inactive";
  }

  #rebuildAbilityCandidates(orderedHand = this.#orderedHand(), abilitySignature = this.#abilitySignatureForState()) {
    this.#abilityCandidateIndex = this.#state?.status === "active"
      ? createAbilityCandidateIndex(orderedHand, this.#state.magicCards.minimumCards, this.#state.magicCards.maximumCards, { allowForbiddenMonarch: Boolean(this.#state.heroicSkills?.forbiddenRite) })
      : createAbilityCandidateIndex([], 2, 5);
    if (this.#activeAbilityId && !this.#abilityCandidateIndex.hasCandidate(this.#activeAbilityId, this.#activeAbilityLane)) {
      this.#activeAbilityId = "";
      this.#activeAbilityLane = "";
    }
    this.#abilitySignature = abilitySignature;
    this.#abilityCandidatesDirty = false;
  }

  #cancelDeferredAbilityCandidateRefresh() {
    const pending = this.#deferredAbilityCandidateRefresh;
    if (!pending) return;
    if (pending.kind === "idle" && typeof globalThis.cancelIdleCallback === "function") {
      globalThis.cancelIdleCallback(pending.id);
    } else {
      clearTimeout(pending.id);
    }
    this.#deferredAbilityCandidateRefresh = null;
  }

  #scheduleDeferredAbilityCandidateRefresh() {
    this.#cancelDeferredAbilityCandidateRefresh();
    const refresh = async () => {
      this.#deferredAbilityCandidateRefresh = null;
      if (this.#closing || !this.rendered || this.#discardMode || !this.#abilityCandidatesDirty || !this.#state) return;
      try {
        const root = this.element;
        const context = await this.#prepareContext({ suppliedState: this.#state });
        const renderer = foundry.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
        if (typeof renderer !== "function") throw new Error("Foundry Handlebars renderer is unavailable.");
        const html = await renderer(`modules/${MODULE_ID}/templates/deck-play.hbs`, context);
        if (this.#closing || !root?.isConnected || root !== this.element) return;
        const scratch = globalThis.document.createElement("div");
        scratch.innerHTML = html;
        const replacement = scratch.querySelector("[data-ability-stack]");
        const current = root.querySelector("[data-ability-stack]");
        if (!replacement || !current) return;
        current.replaceWith(replacement);
        this.#wireDrawer(root);
        this.#refreshLiveDom(root);
      } catch (error) {
        Log.error("Deferred Magic Cards candidate refresh failed.", error);
      }
    };

    if (typeof globalThis.requestIdleCallback === "function") {
      const id = globalThis.requestIdleCallback(() => { void refresh(); }, { timeout: 250 });
      this.#deferredAbilityCandidateRefresh = { kind: "idle", id };
      return;
    }
    const id = setTimeout(() => { void refresh(); }, 0);
    this.#deferredAbilityCandidateRefresh = { kind: "timeout", id };
  }

  #consumeMutationState(state) {
    const rootRevision = Number(state?.rootRevision);
    const coversPendingSignal = Number.isFinite(rootRevision)
      && this.#pendingRootRevision > 0
      && rootRevision >= this.#pendingRootRevision;
    if (coversPendingSignal && this.#refreshTimer) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    if (coversPendingSignal) {
      this.#refreshPending = false;
      this.#pendingRootRevision = 0;
    }
    this.#state = state;
  }

  async #prepareContext({ suppliedState = null, deferAbilityCandidates = false } = {}) {
    const actors = projectFUAdapter.getEligibleActors();
    this.selectActor(this.#actorUuid || actors[0]?.actorUuid || "");
    this.selectEncounter({ combatUuid: this.#combatUuid, sceneUuid: this.#sceneUuid });
    this.#error = "";
    if (suppliedState) {
      this.#consumeMutationState(suppliedState);
    } else {
      this.#state = null;
      if (this.#actorUuid) {
        try {
          const operation = game.settings.get(MODULE_ID, SETTINGS.CROSS_ENCOUNTER_DECK) === true ? "play.ensureDeck" : "play.getState";
          this.#state = await socketService.request(operation, { actorUuid: this.#actorUuid, combatUuid: this.#combatUuid, sceneUuid: this.#sceneUuid });
        } catch (error) {
          this.#error = error.message;
        }
      }
    }

    if (this.#state) {
      if (Number(this.#state.rootRevision) >= this.#pendingRootRevision) this.#pendingRootRevision = 0;
      this.#session?.reconcileState(this.#state, { source: this, notify: false });
    }
    const orderedHand = this.#orderedHand();
    const abilitySignature = this.#abilitySignatureForState();
    if (abilitySignature !== this.#abilitySignature) this.#abilityCandidatesDirty = true;
    if (!this.#discardMode && this.#abilityCandidatesDirty && !deferAbilityCandidates) {
      this.#rebuildAbilityCandidates(orderedHand, abilitySignature);
    }
    this.#preview = this.#evaluateSelection();
    const armedAbility = this.#syncArmedAbility();
    if (this.#session?.resolution.vanguardCardId && !this.#vanguardDesignationAvailable()) {
      this.#session.clearVanguardCard(this);
    }

    const cards = orderedHand.map((card) => {
      const assignment = this.#session?.jokerAssignments?.[card.id] ?? { suit: "", value: "" };
      const assigned = Boolean(assignment.suit && assignment.value);
      return {
        ...card,
        joker: Boolean(getCardDefinition(card.id)?.joker),
        showJokerControls: Boolean(getCardDefinition(card.id)?.joker) && !this.#discardMode,
        selected: this.#session?.selectedIds.has(card.id),
        vanguardSelected: this.#session?.resolution.vanguardCardId === card.id,
        assigned,
        assignmentLabel: assigned ? `${titleCase(assignment.suit)} ${assignment.value}` : game.i18n.localize("ACEOC.Play.AssignJoker"),
        suitOptions: [
          { id: "", label: "—", selected: !assignment.suit },
          ...SUITS.map((id) => ({ id, label: titleCase(id), selected: assignment.suit === id })),
        ],
        valueOptions: [
          { value: "", label: "—", selected: !assignment.value },
          ...VALUES.map((value) => ({ value, label: String(value), selected: Number(assignment.value) === value })),
        ],
      };
    });
    const handGroups = partitionHandCards(cards);
    const active = this.#state?.status === "active";
    const vanguardCards = buildVanguardCards(this.#state?.vanguard ?? [], {
      enabled: Boolean(this.#state?.hasCardVanguard),
      revealable: Boolean(active && this.#state?.canManage),
    });

    const canManageAbilities = Boolean(active && this.#state?.canManage);
    const abilities = CARD_ABILITY_DISPLAY_ORDER.map((id) => {
      const availability = this.#abilityAvailabilityFor(id);
      const naturalCount = availability.natural ? 1 : 0;
      const jokerCount = availability.joker ? 1 : 0;
      const label = effectLabel(id);
      const control = buildAbilityControlModel({ naturalCount, jokerCount, canUse: canManageAbilities });
      const activeNatural = armedAbility?.effectId === id && armedAbility?.lane === "natural";
      const activeJoker = armedAbility?.effectId === id && armedAbility?.lane === "joker";
      const naturalTitle = game.i18n.format("ACEOC.Play.AbilityNaturalHint", { ability: label });
      const jokerTitle = game.i18n.format("ACEOC.Play.AbilityJokerHint", { ability: label });
      return {
        id,
        label,
        naturalCount,
        jokerCount,
        ...control,
        activeNatural,
        activeJoker,
        activePrimary: control.primaryLane === "joker" ? activeJoker : activeNatural,
        naturalTitle,
        jokerTitle,
        primaryTitle: control.primaryLane === "joker" ? jokerTitle : naturalTitle,
        displayIcon: id === "jackpot" ? "🎰" : "",
      };
    }).filter((ability) => ability.hasNatural || ability.hasJoker);

    const controlMetrics = cardControlMetrics(this.#scale);
    const mulliganMaximum = Number(this.#state?.classSkills?.mulliganLimit ?? 0);
    const trapCardMaximum = Number(this.#state?.classSkills?.trapCardLimit ?? 0);
    const trapCardSpellMaximum = Number(this.#state?.classSkills?.trapCardSpellMaximumMp ?? 0);
    const discardModes = [
      {
        id: "mulligan",
        label: "Mulligan",
        icon: "♻️",
        visible: Boolean(this.#state?.classSkills?.mulligan),
        actionable: Boolean(active && this.#state?.canManage && this.#state?.classSkills?.mulligan),
        active: this.#discardMode === "mulligan",
        maximum: mulliganMaximum,
        rules: game.i18n.format("ACEOC.Play.MulliganRules", { maximum: mulliganMaximum }),
      },
      {
        id: "trap-card",
        label: "Trap Card",
        icon: "♻️",
        visible: Boolean(this.#state?.classSkills?.trapCard),
        actionable: Boolean(active && this.#state?.canManage && this.#state?.classSkills?.trapCard),
        active: this.#discardMode === "trap-card",
        maximum: trapCardMaximum,
        spellMaximum: trapCardSpellMaximum,
        rules: game.i18n.format("ACEOC.Play.TrapCardRules", { maximum: trapCardMaximum, spellMaximum: trapCardSpellMaximum }),
      },
    ].filter((mode) => mode.visible);

    return {
      error: this.#error,
      hasActors: actors.length > 0,
      state: this.#state ? {
        ...this.#state,
        hand: cards,
        vanguardCards,
        handCards: handGroups.hand,
        hasHandCards: cards.length > 0,
      } : null,
      cardWidth: BASE_CARD_WIDTH * this.#scale,
      cardHeight: BASE_CARD_HEIGHT * this.#scale,
      controlMetrics,
      abilities,
      discardModes,
      showDiscardModes: discardModes.length > 0,
      activeDiscardMode: this.#discardMode,
      resolutionStatuses: FULL_STATUS_OPTIONS.map((id) => ({ id, label: titleCase(id) })),
      resolutionDamageTypes: [...DAMAGE_TYPES, "light", "dark"].map((id) => ({ id, label: titleCase(id) })),
      canUseAbilities: canManageAbilities,
      showAbilityStack: true,
      canDraw: Boolean(active && this.#state?.canManage),
      drawerDirection: this.#direction,
      drawerDirectionIcon: this.#direction === "top" ? "fa-chevron-up" : "fa-chevron-down",
      drawerDirectionLabel: game.i18n.localize(this.#direction === "top" ? "ACEOC.Play.MoveDrawerBottom" : "ACEOC.Play.MoveDrawerTop"),
      readOnly: Boolean(this.#state?.readOnly),
    };
  }

  #wireCardImageReveal(root) {
    for (const image of root?.querySelectorAll?.(".ace-hand-card > img") ?? []) {
      revealCardImageWhenReady(image, this.#readyImageUrls);
    }
  }

  #onRender(context) {
    const root = this.element;
    if (!root) return;
    root.dataset.mode = this.#discardMode || "standard";
    this.#wireDrawer(root);
    this.#wireActions(root);
    this.#wireCardWindow(root);
    this.#teardownHandWiring();
    if (!context.readOnly) {
      this.#wireJokers(root);
      this.#wireHand(root);
    }
    this.#wireResultRail(root);
    this.#refreshLiveDom(root);
  }

  #applyCardScale(value) {
    const scale = normalizeCardScale(value);
    this.#scale = scale;
    const root = this.element;
    const shell = root?.querySelector?.(".ace-hand-shell");
    if (!root || !shell) return scale;
    const controls = cardControlMetrics(scale);
    shell.style.setProperty("--ace-hand-card-width", `${BASE_CARD_WIDTH * scale}px`);
    shell.style.setProperty("--ace-hand-card-height", `${BASE_CARD_HEIGHT * scale}px`);
    shell.style.setProperty("--ace-ability-width", `${controls.abilityWidth}px`);
    shell.style.setProperty("--ace-control-row-height", `${controls.rowHeight}px`);
    shell.style.setProperty("--ace-control-gutter", `${controls.gutter}px`);
    shell.style.setProperty("--ace-control-font-size", `${controls.fontSize}px`);
    shell.style.setProperty("--ace-joker-size", `${controls.jokerSize}px`);
    shell.style.setProperty("--ace-control-rail-width", `${controls.railWidth}px`);
    this.#applyDrawerGeometry(root);
    this.#applyCardWindow(root, { force: true });
    return scale;
  }

  #minimumDrawerHeight(root = this.element) {
    const abilityStack = root?.querySelector?.("[data-ability-stack]");
    const cardStage = root?.querySelector?.("[data-card-stage]");
    const handStrip = root?.querySelector?.("[data-hand-strip]");
    const stageStyle = cardStage ? globalThis.getComputedStyle?.(cardStage) : null;
    const stripStyle = handStrip ? globalThis.getComputedStyle?.(handStrip) : null;
    const contentGap = Math.max(12,
      cssPixels(stageStyle?.paddingTop)
      + cssPixels(stageStyle?.paddingBottom)
      + cssPixels(stripStyle?.paddingTop)
      + cssPixels(stripStyle?.paddingBottom));
    return minimumDrawerHeightForContent({
      baseCardHeight: BASE_CARD_HEIGHT,
      scale: this.#scale,
      abilityStackHeight: abilityStack?.scrollHeight ?? 0,
      contentGap,
    });
  }

  #sidebarInset() {
    const sidebar = globalThis.document?.querySelector?.("#sidebar");
    if (!sidebar) return 0;
    const style = globalThis.getComputedStyle?.(sidebar);
    const visible = style?.display !== "none" && style?.visibility !== "hidden" && Number(style?.opacity ?? 1) !== 0;
    return calculateSidebarInset({
      viewportWidth: globalThis.window?.innerWidth ?? 0,
      sidebarRect: sidebar.getBoundingClientRect?.() ?? null,
      visible,
    });
  }

  #applyDrawerGeometry(root) {
    if (!root) return;
    const viewportHeight = globalThis.window?.innerHeight ?? 900;
    const contentHeight = this.#minimumDrawerHeight(root);
    const automaticHeight = clampDrawerHeight(contentHeight, {
      viewportHeight,
      topGap: DRAWER_TOP_GAP,
      minimum: Math.min(contentHeight, Math.max(120, viewportHeight - DRAWER_TOP_GAP)),
    });
    root.style.setProperty("--ace-drawer-height", `${automaticHeight}px`);
    root.style.setProperty("--ace-drawer-sidebar-inset", `${this.#sidebarInset()}px`);
    this.#positionResultRail(root);
  }

  #teardownDrawerWiring() {
    this.#drawerResizeObserver?.disconnect();
    this.#drawerResizeObserver = null;
    this.#drawerMutationObserver?.disconnect();
    this.#drawerMutationObserver = null;
    if (this.#drawerWindowResizeHandler) globalThis.window?.removeEventListener?.("resize", this.#drawerWindowResizeHandler);
    this.#drawerWindowResizeHandler = null;
  }

  #wireDrawer(root) {
    this.#teardownDrawerWiring();
    root.classList.toggle("ace-bottom-drawer", this.#direction === "bottom");
    root.classList.toggle("ace-top-drawer", this.#direction === "top");
    if (this.#root) this.#root.dataset.zbDir = this.#direction;
    this.#applyDrawerGeometry(root);

    const refreshGeometry = () => {
      this.#applyDrawerGeometry(root);
      this.#applyCardWindow(root);
    };
    const sidebar = globalThis.document?.querySelector?.("#sidebar");
    const geometryTargets = [
      sidebar,
      root.querySelector("[data-ability-stack]"),
    ].filter(Boolean);
    if (geometryTargets.length && typeof ResizeObserver === "function") {
      this.#drawerResizeObserver = new ResizeObserver(refreshGeometry);
      for (const target of geometryTargets) this.#drawerResizeObserver.observe(target);
    }
    if (sidebar && typeof MutationObserver === "function") {
      this.#drawerMutationObserver = new MutationObserver(refreshGeometry);
      this.#drawerMutationObserver.observe(sidebar, { attributes: true, attributeFilter: ["class", "style", "hidden"] });
    }
    this.#drawerWindowResizeHandler = refreshGeometry;
    globalThis.window?.addEventListener?.("resize", refreshGeometry);

    if (!this.#drawerOpened) {
      this.#drawerOpened = true;
      root.classList.add("is-opening");
      setTimeout(() => root.classList.remove("is-opening"), 220);
    }
  }

  #cardWindowCards(root) {
    const cardWindow = root.querySelector("[data-card-window]") ?? root.querySelector("[data-hand-strip]");
    return cardWindow ? [...cardWindow.querySelectorAll('.ace-hand-card[data-card-zone="hand"][data-card-id]')] : [];
  }

  #applyCardWindow(root, {
    requestedStart = this.#cardWindowStart,
    force = false,
    preserveCapacity = false,
  } = {}) {
    const strip = root?.querySelector?.("[data-hand-strip]");
    if (!strip) return false;
    if (this.#cardWindowFrozen && !force) return false;
    const cards = this.#cardWindowCards(root);
    const cardWindow = root.querySelector("[data-card-window]") ?? strip;
    const fixedCards = [...cardWindow.querySelectorAll("[data-card-window-fixed]")];
    const zones = [...cardWindow.querySelectorAll(".ace-hand-zone")];
    const fixedCardGapCount = zones
      .filter((zone) => zone.hasAttribute("data-card-window-fixed-zone"))
      .reduce((total, zone) => Math.max(0, zone.querySelectorAll("[data-card-window-fixed]").length - 1) + total, 0);
    const stripStyle = globalThis.getComputedStyle?.(cardWindow);
    const zoneStyles = zones.map((zone) => globalThis.getComputedStyle?.(zone)).filter(Boolean);
    const stripPadding = stripStyle
      ? cssPixels(stripStyle.paddingLeft) + cssPixels(stripStyle.paddingRight)
      : CARD_WINDOW_DEFAULTS.stripPadding;
    const cardGap = zoneStyles.length
      ? cssPixels(zoneStyles[0].columnGap || zoneStyles[0].gap, CARD_WINDOW_DEFAULTS.cardGap)
      : CARD_WINDOW_DEFAULTS.cardGap;
    const zoneChrome = zoneStyles.length
      ? Math.max(...zoneStyles.map((style) => cssPixels(style.paddingLeft) + cssPixels(style.paddingRight)))
      : CARD_WINDOW_DEFAULTS.zoneChrome;
    const capacity = preserveCapacity && this.#cardWindowCapacity > 0
      ? Math.min(cards.length, this.#cardWindowCapacity)
      : calculateWholeCardCapacity({
        viewportWidth: cardWindow.clientWidth,
        cardWidth: BASE_CARD_WIDTH * this.#scale,
        totalCards: cards.length,
        zoneCount: zones.length,
        cardGap,
        stripPadding,
        zoneChrome,
        reservedWidth: fixedCards.length * BASE_CARD_WIDTH * this.#scale + fixedCardGapCount * cardGap,
      });
    const range = cardWindowRange({
      requestedStart,
      totalCards: cards.length,
      capacity,
    });
    this.#cardWindowStart = range.start;
    this.#cardWindowCapacity = range.capacity;
    cards.forEach((card, index) => {
      const visible = index >= range.start && index < range.end;
      card.hidden = !visible;
      card.classList.toggle("is-window-visible", visible);
    });
    for (const zone of zones) {
      if (zone.hasAttribute("data-card-window-fixed-zone")) {
        zone.hidden = false;
        continue;
      }
      zone.hidden = !zone.querySelector(".ace-hand-card[data-card-id]:not([hidden])");
    }
    strip.dataset.windowStart = String(range.start);
    strip.dataset.windowCapacity = String(range.capacity);
    strip.dataset.windowTotal = String(range.total);
    this.#positionResultRail(root);
    return range.capacity > 0;
  }

  #shiftCardWindow(root, direction) {
    const cards = this.#cardWindowCards(root);
    const next = shiftCardWindow({
      start: this.#cardWindowStart,
      direction,
      totalCards: cards.length,
      capacity: this.#cardWindowCapacity,
    });
    if (next === this.#cardWindowStart) return false;
    this.#applyCardWindow(root, { requestedStart: next });
    return true;
  }

  #teardownCardWindowWiring() {
    this.#cardWindowResizeObserver?.disconnect();
    this.#cardWindowResizeObserver = null;
    if (this.#wheelResetTimer) clearTimeout(this.#wheelResetTimer);
    this.#wheelResetTimer = null;
    this.#wheelAccumulator = 0;
  }

  #wireCardWindow(root) {
    this.#teardownCardWindowWiring();
    const strip = root.querySelector("[data-hand-strip]");
    if (!strip) return;
    this.#applyCardWindow(root);
    const settleWindow = () => {
      if (root.isConnected) this.#applyCardWindow(root);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(settleWindow);
    else setTimeout(settleWindow, 0);

    const stage = root.querySelector("[data-card-stage]");
    const abilityStack = root.querySelector("[data-ability-stack]");
    if (typeof ResizeObserver === "function") {
      this.#cardWindowResizeObserver = new ResizeObserver(() => this.#applyCardWindow(root));
      if (stage) this.#cardWindowResizeObserver.observe(stage);
    }

    strip.addEventListener("wheel", (event) => {
      if (strip.classList.contains("is-reordering")) {
        event.preventDefault();
        return;
      }
      if (event.ctrlKey || event.metaKey || this.#cardWindowCapacity >= this.#cardWindowCards(root).length) return;
      event.preventDefault();
      const primaryDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!primaryDelta) return;
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, strip.clientWidth) : 1;
      this.#wheelAccumulator += primaryDelta * multiplier;
      if (this.#wheelResetTimer) clearTimeout(this.#wheelResetTimer);
      this.#wheelResetTimer = setTimeout(() => {
        this.#wheelAccumulator = 0;
        this.#wheelResetTimer = null;
      }, 160);
      if (Math.abs(this.#wheelAccumulator) < 36) return;
      const direction = Math.sign(this.#wheelAccumulator);
      this.#wheelAccumulator = 0;
      if (!this.#shiftCardWindow(root, direction)) return;
    }, { passive: false });
  }

  #wireJokers(root) {
    for (const select of root.querySelectorAll("[data-joker-card-id] select")) {
      select.addEventListener("mousedown", (event) => {
        event.stopPropagation();
      });
      select.addEventListener("click", (event) => event.stopPropagation());
      select.addEventListener("change", (event) => {
        const controls = event.currentTarget.closest("[data-joker-card-id]");
        const cardId = String(controls?.dataset.jokerCardId ?? "");
        if (!cardId) return;
        const suit = String(controls.querySelector('[data-joker-field="suit"]')?.value ?? "");
        const value = Number(controls.querySelector('[data-joker-field="value"]')?.value ?? 0);
        const validSuit = SUITS.includes(suit);
        const validValue = VALUES.includes(value);
        const valid = validSuit && validValue;
        this.#session?.setJokerAssignment(cardId, {
          suit: validSuit ? suit : "",
          value: validValue ? value : 0,
        }, this);
        const label = controls.querySelector(":scope > span");
        if (label) label.textContent = valid ? `${titleCase(suit)} ${value}` : game.i18n.localize("ACEOC.Play.AssignJoker");
        this.#refreshLiveDom(root);
      });
    }
  }

  #teardownHandWiring() {
    this.#handGestureCleanup?.();
    this.#handGestureCleanup = null;
  }

  #wireHand(root) {
    const strip = root.querySelector("[data-hand-strip]");
    if (!strip) return;
    const groups = [...strip.querySelectorAll("[data-hand-card-group]")];
    if (!groups.length) return;
    const dragThreshold = 5;
    const controller = new AbortController();
    let gesture = null;
    let handInteractionActive = false;
    let edgeNavigationTimer = null;
    let edgeNavigationDirection = 0;

    const cardOrder = (scope = strip) => [...scope.querySelectorAll('[data-card-zone="hand"][data-card-id]')]
      .map((element) => String(element.dataset.cardId ?? ""))
      .filter(Boolean);

    const reflowCardRects = (activeGesture) => [...strip.querySelectorAll('.ace-hand-card[data-card-id]')]
      .filter((card) => card !== activeGesture.card && !card.hidden && card.classList.contains("is-window-visible"))
      .map((card) => ({
        card,
        cardId: String(card.dataset.cardId ?? ""),
        rect: card.getBoundingClientRect(),
      }));

    const targetCardRects = (activeGesture) => [...activeGesture.group.querySelectorAll('[data-card-zone="hand"][data-card-id]')]
      .filter((card) => card !== activeGesture.card && !card.hidden && card.classList.contains("is-window-visible"))
      .map((card) => ({
        cardId: String(card.dataset.cardId ?? ""),
        rect: card.getBoundingClientRect(),
      }));

    const cancelReflowAnimations = (activeGesture) => {
      for (const animation of activeGesture?.reflowAnimations ?? []) animation?.cancel?.();
      if (activeGesture) activeGesture.reflowAnimations = [];
    };

    const animateCardReflow = (activeGesture, beforeRects) => {
      cancelReflowAnimations(activeGesture);
      const afterRects = reflowCardRects(activeGesture);
      const cardsById = new Map(afterRects.map(({ card, cardId }) => [cardId, card]));
      const translations = reflowTranslations(beforeRects, afterRects);
      activeGesture.reflowAnimations = translations
        .map(({ cardId, translateX, translateY }) => cardsById.get(cardId)?.animate?.(
          [
            { transform: `translate(${translateX}px, ${translateY}px)` },
            { transform: "translate(0, 0)" },
          ],
          { duration: 145, easing: "cubic-bezier(.2,.72,.2,1)" },
        ))
        .filter(Boolean);
    };

    const clearEdgeNavigation = () => {
      if (edgeNavigationTimer) clearTimeout(edgeNavigationTimer);
      edgeNavigationTimer = null;
      edgeNavigationDirection = 0;
    };

    const groupIndexesForGesture = (activeGesture) => {
      const groupCardIds = new Set(activeGesture?.snapshotGroupOrder ?? []);
      return this.#cardWindowCards(root)
        .map((card, index) => groupCardIds.has(String(card.dataset.cardId ?? "")) ? index : -1)
        .filter((index) => index >= 0);
    };

    const nextEdgeWindowStart = (activeGesture, direction) => shiftCardWindowWithinGroup({
      start: this.#cardWindowStart,
      direction,
      totalCards: this.#cardWindowCards(root).length,
      capacity: this.#cardWindowCapacity,
      groupIndexes: groupIndexesForGesture(activeGesture),
    });

    const releaseCapture = (pointerId) => {
      if (!Number.isInteger(pointerId) || !strip.hasPointerCapture?.(pointerId)) return;
      try { strip.releasePointerCapture(pointerId); } catch (_) {}
    };

    const removeDragArtifacts = (activeGesture, { reorderedGroup = null } = {}) => {
      const beforeRects = reflowCardRects(activeGesture);
      cancelReflowAnimations(activeGesture);
      activeGesture?.preview?.remove?.();
      activeGesture?.slot?.remove?.();
      if (Array.isArray(reorderedGroup)) {
        const cardsById = new Map([...activeGesture.group.querySelectorAll('[data-card-zone="hand"][data-card-id]')]
          .map((element) => [String(element.dataset.cardId ?? ""), element]));
        for (const cardId of reorderedGroup) {
          const card = cardsById.get(cardId);
          if (card) activeGesture.group.appendChild(card);
        }
      }
      activeGesture?.card?.classList.remove("is-drag-source-collapsed");
      strip.classList.remove("is-reordering");
      this.#cardWindowFrozen = false;
      releaseCapture(activeGesture?.pointerId);
      animateCardReflow(activeGesture, beforeRects);
    };

    const gestureOrder = (activeGesture) => {
      const beforeCardId = String(activeGesture?.target?.beforeCardId ?? "");
      const reorderedGroup = reorderCardAtGap(
        activeGesture.snapshotGroupOrder,
        activeGesture.cardId,
        beforeCardId,
      );
      const nextOrder = mergeGroupOrder(
        activeGesture.snapshotOrder,
        activeGesture.snapshotGroupOrder,
        reorderedGroup,
      );
      const changed = nextOrder.some((cardId, index) => cardId !== activeGesture.snapshotOrder[index]);
      return { changed, nextOrder, reorderedGroup };
    };

    const settleGesture = ({ commit = false } = {}) => {
      const activeGesture = gesture;
      if (!activeGesture) return;
      clearEdgeNavigation();
      gesture = null;
      if (!activeGesture.dragging) {
        releaseCapture(activeGesture.pointerId);
        if (handInteractionActive) {
          handInteractionActive = false;
          this.#endInteraction();
        }
        return;
      }
      const order = commit && activeGesture.dragging && activeGesture.target
        ? gestureOrder(activeGesture)
        : null;
      const committedWindowStart = this.#cardWindowStart;
      removeDragArtifacts(activeGesture, { reorderedGroup: order?.reorderedGroup ?? null });
      if (order?.changed) this.#session?.setHandOrder(order.nextOrder, this);
      if (root.isConnected) {
        this.#applyCardWindow(root, {
          requestedStart: order ? committedWindowStart : activeGesture.snapshotWindowStart,
          force: true,
        });
        this.#refreshLiveDom(root);
      }
      if (handInteractionActive) {
        handInteractionActive = false;
        this.#endInteraction();
      }
    };

    const createDragPreview = (activeGesture) => {
      const sourceRect = activeGesture.card.getBoundingClientRect();
      const beforeRects = reflowCardRects(activeGesture);
      const preview = activeGesture.card.cloneNode(true);
      preview.classList.remove("is-drag-source-collapsed");
      preview.classList.add("ace-hand-drag-preview");
      preview.removeAttribute("id");
      preview.removeAttribute("title");
      preview.removeAttribute("data-card-id");
      preview.removeAttribute("data-card-zone");
      preview.setAttribute("aria-hidden", "true");
      preview.inert = true;
      preview.style.width = `${sourceRect.width}px`;
      preview.style.height = `${sourceRect.height}px`;
      const slot = activeGesture.card.cloneNode(true);
      slot.className = "ace-hand-card ace-hand-drop-preview";
      slot.removeAttribute("id");
      slot.removeAttribute("title");
      slot.removeAttribute("data-card-id");
      slot.removeAttribute("data-card-label");
      slot.removeAttribute("data-card-zone");
      slot.removeAttribute("data-hand-group");
      slot.querySelectorAll("button, select").forEach((element) => element.remove());
      slot.hidden = true;
      slot.setAttribute("aria-hidden", "true");
      slot.inert = true;
      activeGesture.group.appendChild(slot);
      globalThis.document.body.appendChild(preview);
      this.#cardWindowFrozen = true;
      activeGesture.card.classList.add("is-drag-source-collapsed");
      strip.classList.add("is-reordering");
      this.#positionResultRail(root);
      activeGesture.preview = preview;
      activeGesture.slot = slot;
      activeGesture.dragging = true;
      animateCardReflow(activeGesture, beforeRects);
    };

    const updateDropTarget = (
      activeGesture,
      clientX,
      clientY,
      { beforeRects = null, edgeDirection = 0 } = {},
    ) => {
      if (!activeGesture?.dragging) return;
      if (!activeGesture.slot.hidden) {
        const slotRect = activeGesture.slot.getBoundingClientRect();
        if (
          clientX >= slotRect.left
          && clientX <= slotRect.right
          && clientY >= slotRect.top
          && clientY <= slotRect.bottom
        ) return;
      }

      const currentGroupRect = activeGesture.group.getBoundingClientRect();
      const edgeAllowance = BASE_CARD_WIDTH * this.#scale;
      const groupRect = {
        left: Math.min(activeGesture.snapshotGroupRect.left, currentGroupRect.left)
          - (edgeDirection < 0 ? edgeAllowance : 0),
        right: Math.max(activeGesture.snapshotGroupRect.right, currentGroupRect.right)
          + (edgeDirection > 0 ? edgeAllowance : 0),
        top: Math.min(activeGesture.snapshotGroupRect.top, currentGroupRect.top),
        bottom: Math.max(activeGesture.snapshotGroupRect.bottom, currentGroupRect.bottom),
      };
      const cardRects = targetCardRects(activeGesture);
      const rawTarget = insertionGapForPointer({
        clientX,
        clientY,
        groupRect,
        cardRects,
      });
      const target = rawTarget && !rawTarget.beforeCardId
        ? {
          ...rawTarget,
          beforeCardId: nextCardIdAfterVisibleGroup({
            groupOrder: activeGesture.snapshotGroupOrder,
            draggedCardId: activeGesture.cardId,
            visibleCardIds: cardRects.map(({ cardId }) => cardId),
          }),
        }
        : rawTarget;
      const targetKey = target ? String(target.beforeCardId ?? "") : null;
      const currentKey = activeGesture.target ? String(activeGesture.target.beforeCardId ?? "") : null;
      if (targetKey === currentKey && activeGesture.slot.hidden === !target) return;
      const priorRects = beforeRects ?? reflowCardRects(activeGesture);
      activeGesture.target = target;
      if (!target) {
        activeGesture.slot.hidden = true;
      } else {
        const beforeCard = target.beforeCardId
          ? [...activeGesture.group.querySelectorAll('[data-card-zone="hand"][data-card-id]')]
            .find((card) => String(card.dataset.cardId ?? "") === target.beforeCardId)
          : null;
        if (beforeCard) activeGesture.group.insertBefore(activeGesture.slot, beforeCard);
        else activeGesture.group.appendChild(activeGesture.slot);
        activeGesture.slot.hidden = false;
      }
      animateCardReflow(activeGesture, priorRects);
    };

    const terminalSlotDirectionForGesture = (activeGesture) => {
      if (!activeGesture?.dragging || activeGesture.slot?.hidden) return 0;
      const slotRect = activeGesture.slot.getBoundingClientRect();
      const pointerInsideSlot = activeGesture.lastClientX >= slotRect.left
        && activeGesture.lastClientX <= slotRect.right
        && activeGesture.lastClientY >= slotRect.top
        && activeGesture.lastClientY <= slotRect.bottom;
      if (!pointerInsideSlot) return 0;
      const children = [...activeGesture.group.children];
      const slotIndex = children.indexOf(activeGesture.slot);
      const visibleIndexes = children
        .map((element, index) => (
          element.matches?.('[data-card-zone="hand"][data-card-id].is-window-visible')
          && element !== activeGesture.card
          && !element.hidden
            ? index
            : -1
        ))
        .filter((index) => index >= 0);
      return terminalInsertionSlotDirection({ pointerInsideSlot, slotIndex, visibleIndexes });
    };

    const advanceEdgeWindow = () => {
      edgeNavigationTimer = null;
      const activeGesture = gesture;
      const direction = edgeNavigationDirection;
      if (!activeGesture?.dragging || !direction) {
        clearEdgeNavigation();
        return;
      }
      const nextStart = nextEdgeWindowStart(activeGesture, direction);
      if (nextStart === this.#cardWindowStart) {
        clearEdgeNavigation();
        return;
      }

      const beforeRects = reflowCardRects(activeGesture);
      activeGesture.target = null;
      activeGesture.slot.hidden = true;
      this.#applyCardWindow(root, {
        requestedStart: nextStart,
        force: true,
        preserveCapacity: true,
      });
      updateDropTarget(
        activeGesture,
        activeGesture.lastClientX,
        activeGesture.lastClientY,
        { beforeRects, edgeDirection: direction },
      );
      if (
        terminalSlotDirectionForGesture(activeGesture) !== direction
        || nextEdgeWindowStart(activeGesture, direction) === this.#cardWindowStart
      ) {
        clearEdgeNavigation();
        return;
      }
      edgeNavigationTimer = setTimeout(advanceEdgeWindow, DRAG_EDGE_NAVIGATION.repeatMs);
    };

    const scheduleEdgeNavigation = (activeGesture) => {
      const direction = terminalSlotDirectionForGesture(activeGesture);
      if (!direction || nextEdgeWindowStart(activeGesture, direction) === this.#cardWindowStart) {
        clearEdgeNavigation();
        return;
      }
      if (direction === edgeNavigationDirection && edgeNavigationTimer) return;
      clearEdgeNavigation();
      edgeNavigationDirection = direction;
      edgeNavigationTimer = setTimeout(advanceEdgeWindow, DRAG_EDGE_NAVIGATION.dwellMs);
    };

    const updateDragPreview = (event) => {
      if (!gesture?.dragging) return;
      gesture.lastClientX = event.clientX;
      gesture.lastClientY = event.clientY;
      gesture.preview.style.left = `${event.clientX}px`;
      gesture.preview.style.top = `${event.clientY}px`;
      updateDropTarget(gesture, event.clientX, event.clientY);
      scheduleEdgeNavigation(gesture);
    };

    const pointerWithinCard = (event, card) => {
      const rect = card.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
    };

    strip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("[data-action], [data-joker-card-id]")) return;
      if (gesture) return;
      const card = event.target.closest('[data-card-zone="hand"][data-card-id]');
      const group = card?.closest?.("[data-hand-card-group]");
      if (!card || !group || !strip.contains(group)) return;
      this.#beginInteraction();
      handInteractionActive = true;
      gesture = {
        pointerId: event.pointerId,
        card,
        cardId: String(card.dataset.cardId ?? ""),
        group,
        startX: event.clientX,
        startY: event.clientY,
        dragging: false,
        target: null,
        preview: null,
        slot: null,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        reflowAnimations: [],
        snapshotGroupRect: group.getBoundingClientRect(),
        snapshotWindowStart: this.#cardWindowStart,
        snapshotOrder: cardOrder(),
        snapshotGroupOrder: cardOrder(group),
      };
      try { strip.setPointerCapture?.(event.pointerId); } catch (_) {}
    }, { signal: controller.signal });

    globalThis.window?.addEventListener?.("pointermove", (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      if (!gesture.dragging) {
        if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < dragThreshold) return;
        createDragPreview(gesture);
      }
      event.preventDefault();
      updateDragPreview(event);
    }, { signal: controller.signal });

    globalThis.window?.addEventListener?.("pointerup", (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const activeGesture = gesture;
      if (activeGesture.dragging) {
        event.preventDefault();
        updateDragPreview(event);
        settleGesture({ commit: Boolean(activeGesture.target) });
        return;
      }

      const shouldSelect = event.button === 0 && pointerWithinCard(event, activeGesture.card);
      settleGesture();
      if (!shouldSelect) return;
      const cardId = activeGesture.cardId;
      if (!root.isConnected || !cardId) return;
      this.#session?.toggleSelection(cardId, this);
      this.#refreshLiveDom(root);
    }, { signal: controller.signal });

    globalThis.window?.addEventListener?.("pointercancel", (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      settleGesture();
    }, { signal: controller.signal });

    globalThis.window?.addEventListener?.("blur", () => settleGesture(), { signal: controller.signal });

    strip.addEventListener("lostpointercapture", (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      settleGesture();
    }, { signal: controller.signal });

    this.#handGestureCleanup = () => {
      settleGesture();
      controller.abort();
    };
  }

  #scrollAbilitySelectionIntoView(root) {
    const cards = this.#cardWindowCards(root);
    const selectedIndexes = cards
      .map((card, index) => card.matches('[data-card-zone="hand"].is-selected') ? index : -1)
      .filter((index) => index >= 0);
    if (!selectedIndexes.length) return;
    const start = cardWindowStartForSelection({
      selectedIndexes,
      currentStart: this.#cardWindowStart,
      totalCards: cards.length,
      capacity: this.#cardWindowCapacity,
    });
    this.#applyCardWindow(root, { requestedStart: start });
  }

  #wireResultRail(root) {
    this.#resultResizeObserver?.disconnect();
    this.#resultResizeObserver = null;
    const layout = root.querySelector("[data-card-stage]");
    const strip = root.querySelector("[data-hand-strip]");
    if (!layout || !strip) return;
    if (typeof ResizeObserver === "function") {
      this.#resultResizeObserver = new ResizeObserver(() => this.#positionResultRail(root));
      this.#resultResizeObserver.observe(layout);
      this.#resultResizeObserver.observe(strip);
    }
  }

  #positionResultRail(root) {
    const rail = root.querySelector("[data-result-rail]");
    if (this.#cardWindowFrozen) {
      if (rail) rail.style.visibility = "hidden";
      return;
    }
    const message = root.querySelector("[data-result-activation]:not([hidden]), [data-result-message]:not([hidden])");
    const upperLine = root.querySelector('[data-result-line="upper"]');
    const lowerLine = root.querySelector('[data-result-line="lower"]');
    const upperMarkers = root.querySelector('[data-result-markers="upper"]');
    const lowerMarkers = root.querySelector('[data-result-markers="lower"]');
    const layout = root.querySelector("[data-card-stage]");
    const strip = root.querySelector("[data-hand-strip]");
    const selected = [...root.querySelectorAll('.ace-hand-card[data-card-zone="hand"].is-selected')];
    if (!rail || rail.hidden || !message || !upperLine || !lowerLine || !upperMarkers || !lowerMarkers || !layout || !strip || !selected.length) return;
    if (selected.some((card) => card.hidden || !card.classList.contains("is-window-visible"))) {
      rail.style.visibility = "hidden";
      return;
    }

    const geometry = calculateResultRailLayout({
      layoutRect: layout.getBoundingClientRect(),
      stripRect: strip.getBoundingClientRect(),
      selectedRects: selected.map((card) => card.getBoundingClientRect()),
      messageWidth: message.offsetWidth,
      messageHeight: message.offsetHeight,
      direction: this.#direction,
    });
    if (!geometry) {
      rail.style.visibility = "hidden";
      return;
    }

    rail.style.visibility = "visible";
    rail.dataset.placement = geometry.placement;
    message.style.left = `${geometry.messageCenter}px`;
    message.style.top = `${geometry.messageTop}px`;
    for (const [line, lineTop] of [
      [upperLine, geometry.upperLineTop],
      [lowerLine, geometry.lowerLineTop],
    ]) {
      line.style.left = `${geometry.lineLeft}px`;
      line.style.top = `${lineTop}px`;
      line.style.width = `${geometry.lineWidth}px`;
    }
    for (const [markers, markerTop] of [
      [upperMarkers, geometry.upperLineTop],
      [lowerMarkers, geometry.lowerLineTop],
    ]) {
      markers.replaceChildren(...geometry.markerCenters.map((center) => {
        const marker = globalThis.document.createElement("span");
        marker.className = "ace-hand-result-rail__diamond";
        marker.style.left = `${center}px`;
        marker.style.top = `${markerTop}px`;
        marker.setAttribute("aria-hidden", "true");
        return marker;
      }));
    }
  }

  #refreshLiveDom(root) {
    this.#preview = this.#evaluateSelection();
    const selectedIds = this.#session?.selectedIds ?? new Set();
    updateClearSetControl(root, { canManage: Boolean(this.#state?.status === "active" && this.#state?.canManage), selectedIds });
    const discardActive = Boolean(this.#discardMode);
    const discardLabel = this.#discardMode === "trap-card" ? "Trap Card" : "Mulligan";
    const armedAbility = this.#syncArmedAbility();
    const canManage = Boolean(this.#state?.status === "active" && this.#state?.canManage);
    const canActivate = Boolean(!discardActive && armedAbility && canManage);
    const canDiscard = Boolean(discardActive && canManage);
    const resolutionVisible = canActivate || canDiscard;
    const choiceState = resolutionChoiceState(
      armedAbility?.effectId,
      this.#preview?.evaluation,
      this.#state,
      this.#session?.resolution.choices,
    );
    const activationReady = discardActive
      ? Boolean(canDiscard && this.#preview.valid)
      : Boolean(canActivate && choiceState.ready);
    const canDesignateVanguard = Boolean(canActivate && this.#vanguardDesignationAvailable());
    for (const ability of root.querySelectorAll(".ace-card-ability")) {
      updateAbilityControlState(ability, armedAbility);
    }
    for (const mode of root.querySelectorAll(".ace-card-discard-mode[data-discard-mode]")) {
      const active = String(mode.dataset.discardMode ?? "") === this.#discardMode;
      mode.classList.toggle("is-active", active);
      const button = mode.querySelector('[data-action="toggleDiscardMode"]');
      button?.setAttribute("aria-pressed", active ? "true" : "false");
    }
    let vanguardCardId = String(this.#session?.resolution.vanguardCardId ?? "");
    if (vanguardCardId && (!canDesignateVanguard || !selectedIds.has(vanguardCardId))) {
      this.#session?.clearVanguardCard(this);
      vanguardCardId = "";
    }
    for (const card of root.querySelectorAll('[data-card-zone="hand"][data-card-id]')) {
      const cardId = String(card.dataset.cardId ?? "");
      card.classList.toggle("is-selected", selectedIds.has(cardId));
      const designated = Boolean(vanguardCardId && vanguardCardId === cardId);
      const eligible = Boolean(canDesignateVanguard && selectedIds.has(cardId));
      const label = String(card.dataset.cardLabel ?? card.title ?? "");
      const jokerControls = card.querySelector("[data-joker-card-id]");
      if (jokerControls) {
        const assignment = this.#session?.jokerAssignments?.[cardId] ?? {};
        const suit = SUITS.includes(String(assignment.suit ?? "")) ? String(assignment.suit) : "";
        const value = VALUES.includes(Number(assignment.value)) ? String(Number(assignment.value)) : "";
        const suitSelect = jokerControls.querySelector('[data-joker-field="suit"]');
        const valueSelect = jokerControls.querySelector('[data-joker-field="value"]');
        if (suitSelect) suitSelect.value = suit;
        if (valueSelect) valueSelect.value = value;
        const assignmentLabel = jokerControls.querySelector(":scope > span");
        if (assignmentLabel) assignmentLabel.textContent = suit && value ? `${titleCase(suit)} ${value}` : game.i18n.localize("ACEOC.Play.AssignJoker");
      }
      card.classList.toggle("is-pending-vanguard", designated);
      card.dataset.vanguardEligible = eligible ? "true" : "false";
      const marker = card.querySelector("[data-vanguard-marker]");
      if (marker) {
        marker.hidden = !eligible;
        marker.classList.toggle("is-active", designated);
        marker.setAttribute("aria-pressed", designated ? "true" : "false");
        marker.setAttribute("aria-label", designated
          ? game.i18n.format("ACEOC.Play.VanguardDesignated", { card: label })
          : game.i18n.format("ACEOC.Play.VanguardDesignationHint", { card: label }));
        marker.title = marker.getAttribute("aria-label");
      }
    }
    const rail = root.querySelector("[data-result-rail]");
    const message = root.querySelector("[data-result-message]");
    const activation = root.querySelector("[data-result-activation]");
    const activationButton = root.querySelector("[data-result-activate]");
    if (message) {
      message.hidden = resolutionVisible;
      message.textContent = selectedIds.size ? this.#preview.message : "";
    }
    if (activation) {
      activation.hidden = !resolutionVisible;
      activation.classList.toggle("is-discard-mode", discardActive);
      const abilityLabel = discardActive ? discardLabel : effectLabel(armedAbility?.effectId);
      const mpCost = magicCardsMpCost(this.#selectedCardIds());
      const cost = activation.querySelector("[data-result-mp-cost]");
      if (cost) {
        cost.hidden = discardActive;
        cost.textContent = discardActive ? "" : game.i18n.format("ACEOC.Play.MpCost", { cost: mpCost });
      }
      const label = activation.querySelector("[data-result-ability-label]");
      if (label) label.textContent = abilityLabel;
      activation.classList.toggle("requires-choice", !discardActive && choiceState.kind !== "none");
      activation.classList.toggle("is-ready", activationReady);
      const statusChoices = activation.querySelector("[data-result-status-choices]");
      if (statusChoices) statusChoices.hidden = discardActive || choiceState.kind !== "statuses";
      for (const button of activation.querySelectorAll("[data-status-id]")) {
        const status = String(button.dataset.statusId ?? "");
        const selected = choiceState.selectedStatuses.includes(status);
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", selected ? "true" : "false");
        button.disabled = !discardActive && choiceState.kind === "statuses" && choiceState.selectionLimitReached && !selected;
      }
      const damageChoices = activation.querySelector("[data-result-damage-choices]");
      if (damageChoices) damageChoices.hidden = discardActive || choiceState.kind !== "damage-type";
      const availableDamageTypes = new Set(choiceState.damageTypes.map((option) => option.id));
      for (const button of activation.querySelectorAll("[data-damage-type]")) {
        const damageType = String(button.dataset.damageType ?? "");
        const available = availableDamageTypes.has(damageType);
        const selected = choiceState.selectedDamageType === damageType;
        button.hidden = !discardActive && choiceState.kind === "damage-type" && !available;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", selected ? "true" : "false");
      }
      const word = activation.querySelector(".ace-hand-result-rail__activate-word");
      if (word) word.textContent = game.i18n.localize(discardActive ? "ACEOC.Play.Discard" : "ACEOC.Play.Activate");
    }
    if (activationButton) {
      const abilityLabel = discardActive ? discardLabel : effectLabel(armedAbility?.effectId);
      activationButton.disabled = !activationReady;
      activationButton.setAttribute("aria-disabled", activationReady ? "false" : "true");
      activationButton.setAttribute("aria-label", discardActive
        ? game.i18n.format("ACEOC.Play.DiscardAbility", { ability: abilityLabel })
        : game.i18n.format("ACEOC.Play.ActivateAbility", { ability: abilityLabel }));
    }
    if (rail) {
      const hasSelection = selectedIds.size > 0;
      rail.hidden = !hasSelection;
      rail.classList.toggle("is-valid", Boolean(hasSelection && this.#preview.valid));
      rail.classList.toggle("is-invalid", Boolean(hasSelection && !this.#preview.valid));
      rail.classList.toggle("is-activation", resolutionVisible);
      rail.classList.toggle("is-discard-mode", discardActive);
      rail.classList.toggle("is-ready", activationReady);
    }
    this.#positionResultRail(root);
  }

  toggleResolutionStatus(_event, target) {
    this.#preview = this.#evaluateSelection();
    const armedAbility = this.#syncArmedAbility();
    if (armedAbility?.effectId !== "full-status" || !this.#preview.valid) return;
    const status = String(target?.dataset?.statusId ?? "");
    const choiceState = resolutionChoiceState(
      armedAbility.effectId,
      this.#preview.evaluation,
      this.#state,
      this.#session?.resolution.choices,
    );
    if (!choiceState.statusOptions.some((option) => option.id === status)) return;
    const selected = [...choiceState.selectedStatuses];
    const index = selected.indexOf(status);
    if (index >= 0) selected.splice(index, 1);
    else if (selected.length < 2) selected.push(status);
    else return;
    this.#session?.beginResolution(this.#preview.evaluation, this);
    this.#session?.setEffect(armedAbility.effectId, this);
    this.#session?.setStatusChoices(selected, this);
    this.#refreshLiveDom(this.element);
  }

  selectResolutionDamageType(_event, target) {
    this.#preview = this.#evaluateSelection();
    const armedAbility = this.#syncArmedAbility();
    if (armedAbility?.effectId !== "double-trouble" || !this.#preview.valid) return;
    const damageType = String(target?.dataset?.damageType ?? "");
    const choiceState = resolutionChoiceState(
      armedAbility.effectId,
      this.#preview.evaluation,
      this.#state,
      this.#session?.resolution.choices,
    );
    if (!choiceState.damageTypes.some((option) => option.id === damageType)) return;
    this.#session?.beginResolution(this.#preview.evaluation, this);
    this.#session?.setEffect(armedAbility.effectId, this);
    this.#session?.setChoice(
      "damageType",
      choiceState.selectedDamageType === damageType ? "" : damageType,
      this,
    );
    this.#refreshLiveDom(this.element);
  }

  async toggleDiscardMode(_event, target) {
    const mode = String(target?.dataset?.discardMode ?? "");
    if (!["mulligan", "trap-card"].includes(mode)) return;
    const available = mode === "trap-card"
      ? Boolean(this.#state?.classSkills?.trapCard)
      : Boolean(this.#state?.classSkills?.mulligan);
    if (!available || this.#state?.status !== "active" || !this.#state?.canManage) return;
    const nextMode = this.#discardMode === mode ? "" : mode;
    this.#cancelDeferredAbilityCandidateRefresh();
    this.#clearDraft();
    this.#discardMode = nextMode;
    await this.render({ force: true });
  }

  async cycleAbility(_event, target) {
    const requiresStructuralRender = Boolean(this.#discardMode);
    if (requiresStructuralRender) {
      this.#discardMode = "";
      this.#clearDraft();
      this.#rebuildAbilityCandidates();
      this.#preview = this.#evaluateSelection();
    }

    const effectId = String(target.dataset.effectId ?? "");
    const lane = String(target.dataset.abilityLane ?? "");
    if (!CARD_ABILITY_ORDER.includes(effectId) || !["natural", "joker"].includes(lane)) return;
    if (!this.#state?.canManage || !this.#abilityCandidateIndex.hasCandidate(effectId, lane)) return;
    const currentArmed = this.#syncArmedAbility();
    const selectionLane = abilityLaneForSelection(this.#selectedCardIds());
    const selectionSupportsTarget = Boolean(
      this.#preview?.valid
      && selectionLane === lane
      && this.#preview?.evaluation?.effects?.includes(effectId)
    );
    if (selectionSupportsTarget && (
      currentArmed?.effectId !== effectId
      || currentArmed?.lane !== lane
    )) {
      this.#armedAbilityId = effectId;
      this.#armedAbilityLane = lane;
      this.#activeAbilityId = effectId;
      this.#activeAbilityLane = lane;
      if (requiresStructuralRender || !this.element?.isConnected) await this.render({ force: true });
      else this.#refreshLiveDom(this.element);
      return;
    }
    const currentCandidate = this.#activeAbilityId === effectId && this.#activeAbilityLane === lane
      ? this.#selectedAbilityCandidate(effectId, lane)
      : null;
    const candidate = this.#abilityCandidateIndex.nextCandidate(effectId, lane, currentCandidate);
    if (!candidate) return;
    this.#activeAbilityId = effectId;
    this.#activeAbilityLane = lane;
    this.#armedAbilityId = effectId;
    this.#armedAbilityLane = lane;
    this.#session?.setSelection(candidate.cardIds, candidate.jokerAssignments, this);
    this.#session?.arrangeAbilitySelection(candidate.cardIds, this);
    const root = this.element;
    if (requiresStructuralRender || !root?.isConnected || !this.#reorderHandDom(root)) {
      await this.render({ force: true });
      this.#scrollAbilitySelectionIntoView(this.element);
      return;
    }
    this.#refreshLiveDom(root);
    this.#scrollAbilitySelectionIntoView(root);
  }

  async resolveAbility() {
    this.#preview = this.#evaluateSelection();
    if (this.#discardMode) {
      if (!this.#preview.valid) {
        ui.notifications.warn(this.#preview.message || game.i18n.localize("ACEOC.Play.NoCardsSelected"));
        return;
      }
      const operation = this.#discardMode === "trap-card" ? "skill.trapCard" : "skill.mulligan";
      await this.#submit(operation, { cardIds: this.#selectedCardIds() }, { clearSelection: true, exitDiscardMode: true });
      return;
    }
    const armedAbility = this.#syncArmedAbility();
    const effectId = armedAbility?.effectId ?? "";
    if (!effectId) {
      ui.notifications.warn(game.i18n.localize("ACEOC.Play.SelectAbilityVariation"));
      return;
    }

    if (!this.#preview.valid || !this.#preview.evaluation?.effects?.includes(effectId)) {
      ui.notifications.warn(this.#preview.message || game.i18n.localize("ACEOC.Play.SelectAbilityVariation"));
      return;
    }

    const evaluation = this.#preview.evaluation;
    this.#session?.beginResolution(evaluation, this);
    this.#session?.setEffect(effectId, this);
    const choiceState = resolutionChoiceState(
      effectId,
      evaluation,
      this.#state,
      this.#session?.resolution.choices,
    );
    if (!choiceState.ready) {
      ui.notifications.warn(choiceState.kind === "statuses"
        ? game.i18n.localize("ACEOC.Play.ChooseTwoStatuses")
        : game.i18n.localize("ACEOC.Play.ChooseDamageType"));
      this.#refreshLiveDom(this.element);
      return;
    }
    const payload = this.#session.buildPayload();
    payload.effectId = effectId;
    await this.#submit("play.resolveMagicCards", payload, { clearSelection: true });
  }

  async revealVanguard(_event, target) {
    if (!this.#state?.canManage || this.#state?.status !== "active") return;
    const cardId = String(target?.dataset?.vanguardCardId ?? "");
    const card = (this.#state?.vanguard ?? []).find((entry) => String(entry.id) === cardId);
    if (!card) throw new Error("Choose a card currently in Vanguard.");
    const damageType = await resolveVanguardRevealDamageType(card);
    if (!damageType) return;
    await this.#submit("hero.revealVanguard", { cardId, damageType });
  }

  toggleVanguard(_event, target) {
    const cardId = String(target?.dataset?.vanguardCardId ?? "");
    if (!cardId || !this.#session?.selectedIds.has(cardId) || !this.#vanguardDesignationAvailable()) return;
    this.#session.setVanguardCard(cardId, this);
    this.#refreshLiveDom(this.element);
  }


  async toggleDrawerDirection() {
    if (this.#orientationChanging || this.#closing) return;
    const surface = this.element;
    if (!surface) return;

    this.#orientationChanging = true;
    const nextDirection = oppositeDrawerDirection(this.#direction);
    try {
      surface.classList.add("is-closing");
      await new Promise((resolve) => setTimeout(resolve, 170));
      await game.settings.set(MODULE_ID, SETTINGS.PLAY_DRAWER_DIRECTION, nextDirection);
      this.#direction = nextDirection;
      if (this.#root) this.#root.dataset.zbDir = nextDirection;
      surface.classList.remove("ace-top-drawer", "ace-bottom-drawer", "is-closing", "is-opening");
      surface.classList.add(`ace-${nextDirection}-drawer`);
      this.#drawerOpened = false;
      try { globalThis.ZenBladesDrawerManager?.notifyClosed?.(this); } catch (_) {}
      await requestDrawerExclusivity(this, nextDirection);
      await this.render({ force: true });
    } catch (error) {
      surface.classList.remove("is-closing");
      throw error;
    } finally {
      this.#orientationChanging = false;
    }
  }

  openDeckManager() { openDeckManager({ actorUuid: this.#actorUuid }); }

  openPiles() {
    if (!this.#state?.actorUuid) return;
    return openDeckExtras({
      actorUuid: this.#state.actorUuid,
      combatUuid: this.#combatUuid || this.#state.conflict?.combatUuid || "",
      sceneUuid: this.#sceneUuid || this.#state.conflict?.sceneUuid || "",
      mode: "piles",
    });
  }

  async draw() { await this.#submit("play.draw", { count: 1 }); }
  async clearSet() {
    this.#clearDraft();
    await this.render({ force: true });
  }
  async refresh() { this.#queueRefresh({ immediate: true }); }

  async #submit(operation, extra = {}, { clearSelection = false, exitDiscardMode = false } = {}) {
    if (!this.#state) return;
    try {
      if (this.#pendingRootRevision > Number(this.#state.rootRevision)) await this.render({ force: true });
      if (!this.#state) return;
      const actorUuid = this.#state.actorUuid;
      const mutationState = await socketService.request(operation, {
        actorUuid,
        expectedRevision: this.#state.revision,
        combatUuid: this.#combatUuid || this.#state.conflict?.combatUuid || "",
        sceneUuid: this.#sceneUuid || this.#state.conflict?.sceneUuid || "",
        ...extra,
      });
      this.#consumeMutationState(mutationState);
      if (clearSelection) this.#clearDraft();
      if (exitDiscardMode) {
        this.#discardMode = "";
        this.#abilityCandidateIndex = createAbilityCandidateIndex([], 2, 5);
        this.#abilityCandidatesDirty = true;
      }
      await this.render({ force: true, state: mutationState, deferAbilityCandidates: exitDiscardMode });
      if (exitDiscardMode) this.#scheduleDeferredAbilityCandidateRefresh();
    } catch (error) {
      Log.error(`${operation} failed.`, error);
      ui.notifications.error(error.message);
      if (/changed|refresh/i.test(String(error.message ?? ""))) await this.render({ force: true });
    }
  }

  #unmountSurface() {
    this.#resultResizeObserver?.disconnect();
    this.#resultResizeObserver = null;
    this.#teardownCardWindowWiring();
    this.#teardownHandWiring();
    this.#teardownDrawerWiring();
    this.#actionCleanup?.();
    this.#actionCleanup = null;
    this.#root?.remove?.();
    this.#root = null;
    this.#surface = null;
    this.#content = null;
  }

  async close(options = {}) {
    if (this.#closing) return this;
    this.#closing = true;
    const surface = this.element;
    if (surface?.isConnected && options?.animate !== false) {
      surface.classList.add("is-closing");
      await new Promise((resolve) => setTimeout(resolve, 170));
    }
    this.#destroy();
    try { globalThis.ZenBladesDrawerManager?.notifyClosed?.(this); } catch (_) {}
    app = null;
    return this;
  }

  #destroy() {
    this.#cancelDeferredAbilityCandidateRefresh();
    this.#readyImageUrls.clear();
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
    this.#unmountSurface();
    this.#domObserver?.disconnect();
    this.#domObserver = null;
    if (this.#beforeUnloadHandler) globalThis.window?.removeEventListener?.("beforeunload", this.#beforeUnloadHandler);
    this.#beforeUnloadHandler = null;
    if (this.#stateHook !== null) Hooks.off(PLAY_STATE_CHANGED_HOOK, this.#stateHook);
    if (this.#actorHook !== null) Hooks.off(PLAY_ACTOR_CHANGED_HOOK, this.#actorHook);
    if (this.#scaleHook !== null) Hooks.off(PLAY_CARD_SCALE_CHANGED_HOOK, this.#scaleHook);
    if (this.#styleHook !== null) Hooks.off(STYLES_CHANGED_HOOK, this.#styleHook);
    this.#stateHook = null;
    this.#actorHook = null;
    this.#scaleHook = null;
    this.#styleHook = null;
    this.#unsubscribeSession?.();
    this.#unsubscribeSession = null;
  }

}

let app;
export function isDeckPlayOpen() {
  return Boolean(app?.rendered);
}

export function closeDeckPlay(options = {}) {
  return app?.close(options) ?? Promise.resolve();
}

export function closeDeckPlayForEncounter(combatUuid, { actorUuid = "", ...closeOptions } = {}) {
  const requestedCombatUuid = String(combatUuid ?? "");
  const requestedActorUuid = String(actorUuid ?? "");
  const context = app?.encounterContext;
  if (!requestedCombatUuid || context?.combatUuid !== requestedCombatUuid) return Promise.resolve();
  if (requestedActorUuid && context?.actorUuid !== requestedActorUuid) return Promise.resolve();
  return app.close(closeOptions);
}

export function toggleDeckPlay({ actorUuid = "", combatUuid = "", sceneUuid = "" } = {}) {
  if (app?.rendered) return app.close();
  return openDeckPlay({ actorUuid, combatUuid, sceneUuid });
}

export function openDeckPlay({ actorUuid = "", combatUuid = "", sceneUuid = "" } = {}) {
  if (!app) app = new AceDeckPlayDrawer();
  app.selectActor(actorUuid, { announce: Boolean(actorUuid) });
  app.selectEncounter({ combatUuid, sceneUuid });
  return requestDrawerExclusivity(app, app.direction).then(() => app?.render({ force: true }));
}
