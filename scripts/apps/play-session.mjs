import { getCardDefinition } from "../cards/card-catalog.mjs";

const DEFAULT_CHOICES = Object.freeze({ damageType: "", statusOne: "", statusTwo: "" });
const sessions = new Map();

function clone(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return structuredClone(value);
}

function sameMembers(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export class AcePlaySession {
  actorUuid;
  selectedIds = new Set();
  selectionOrder = [];
  jokerAssignments = {};
  handOrder = [];
  serverRevision = -1;
  conflictId = "";
  serverStatus = "";
  resolution = {
    active: false,
    effectId: "",
    choices: clone(DEFAULT_CHOICES),
    discardOrder: [],
    vanguardCardId: "",
  };

  #listeners = new Set();

  constructor(actorUuid) {
    this.actorUuid = String(actorUuid ?? "");
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(reason, source = null) {
    for (const listener of this.#listeners) listener({ actorUuid: this.actorUuid, reason, source });
  }


  reconcileState(state, { source = null, notify = false } = {}) {
    const nextStatus = String(state?.status ?? "");
    const nextConflictId = String(state?.conflict?.id ?? "");
    const initialized = this.serverRevision >= 0 || this.serverStatus || this.conflictId;
    const lifecycleChanged = initialized && (nextStatus !== this.serverStatus || nextConflictId !== this.conflictId);

    if (lifecycleChanged) {
      this.selectedIds.clear();
      this.selectionOrder = [];
      this.jokerAssignments = {};
      this.handOrder = [];
      this.resolution = {
        active: false,
        effectId: "",
        choices: clone(DEFAULT_CHOICES),
        discardOrder: [],
        vanguardCardId: "",
      };
    }

    this.serverRevision = Number.isFinite(Number(state?.revision)) ? Number(state.revision) : this.serverRevision;
    this.serverStatus = nextStatus;
    this.conflictId = nextConflictId;
    this.reconcileHand(state?.hand ?? [], { source, notify: false });
    if (notify) this.#emit(lifecycleChanged ? "lifecycle" : "state-reconciled", source);
    return { lifecycleChanged };
  }

  reconcileHand(hand, { source = null, notify = false } = {}) {
    const currentIds = hand.map((card) => String(card.id));
    const currentSet = new Set(currentIds);
    const known = this.handOrder.filter((cardId) => currentSet.has(cardId));
    const knownSet = new Set(known);
    const newCards = currentIds.filter((cardId) => !knownSet.has(cardId));
    this.handOrder = [...newCards, ...known];

    let changed = false;
    for (const cardId of [...this.selectedIds]) {
      if (currentSet.has(cardId)) continue;
      this.selectedIds.delete(cardId);
      changed = true;
    }
    const nextSelectionOrder = this.selectionOrder.filter((cardId) => this.selectedIds.has(cardId) && currentSet.has(cardId));
    for (const cardId of this.selectedCardIds()) {
      if (!nextSelectionOrder.includes(cardId)) nextSelectionOrder.push(cardId);
    }
    if (!sameMembers(this.selectionOrder, nextSelectionOrder) || this.selectionOrder.some((cardId, index) => cardId !== nextSelectionOrder[index])) {
      this.selectionOrder = nextSelectionOrder;
      changed = true;
    }
    for (const cardId of Object.keys(this.jokerAssignments)) {
      if (currentSet.has(cardId)) continue;
      delete this.jokerAssignments[cardId];
      changed = true;
    }
    if (!sameMembers(this.resolution.discardOrder, this.selectedCardIds())) {
      this.resolution.discardOrder = this.selectedCardIds();
      this.resolution.vanguardCardId = "";
      changed = true;
    }
    if (changed) this.invalidateResolution({ source, notify: false, preserveOrder: true });
    if (notify) this.#emit("hand-reconciled", source);
  }

  orderedHand(hand) {
    const byId = new Map(hand.map((card) => [String(card.id), card]));
    return this.handOrder.map((cardId) => byId.get(cardId)).filter(Boolean);
  }

  selectedCardIds() {
    return this.handOrder.filter((cardId) => this.selectedIds.has(cardId));
  }

  selectionAnchorId() {
    return this.selectionOrder.find((cardId) => this.selectedIds.has(cardId)) ?? this.selectedCardIds()[0] ?? "";
  }

  selectedJokerAssignments() {
    return Object.fromEntries(this.selectedCardIds()
      .filter((cardId) => getCardDefinition(cardId)?.joker && this.jokerAssignments[cardId])
      .map((cardId) => [cardId, clone(this.jokerAssignments[cardId])]));
  }

  setHandOrder(cardIds, source = null) {
    const normalized = cardIds.map(String).filter(Boolean);
    if (normalized.length !== new Set(normalized).size) return;
    this.handOrder = [...normalized];
    if (!this.resolution.active) this.resolution.discardOrder = this.selectedCardIds();
    this.#emit("hand-order", source);
  }

  arrangeAbilitySelection(cardIds, source = null) {
    const available = new Set(this.handOrder);
    const selected = [...new Set(cardIds.map(String).filter(Boolean))].filter((cardId) => available.has(cardId));
    const selectedSet = new Set(selected);
    const remaining = this.handOrder.filter((cardId) => !selectedSet.has(cardId));
    this.handOrder = [...selected, ...remaining];
    if (!this.resolution.active) this.resolution.discardOrder = this.selectedCardIds();
    this.#emit("ability-hand-order", source);
  }

  toggleSelection(cardId, source = null) {
    const id = String(cardId ?? "");
    if (!id) return;
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
      this.selectionOrder = this.selectionOrder.filter((cardId) => cardId !== id);
    } else {
      this.selectedIds.add(id);
      this.selectionOrder = [...this.selectionOrder.filter((cardId) => cardId !== id), id];
    }
    this.invalidateResolution({ source, notify: false });
    this.#emit("selection", source);
  }

  setSelection(cardIds, jokerAssignments = {}, source = null) {
    const normalized = [...new Set(cardIds.map(String).filter(Boolean))];
    this.selectedIds = new Set(normalized);
    this.selectionOrder = normalized;
    for (const cardId of Object.keys(this.jokerAssignments)) {
      if (!this.selectedIds.has(cardId)) delete this.jokerAssignments[cardId];
    }
    for (const [cardId, assignment] of Object.entries(jokerAssignments ?? {})) {
      this.jokerAssignments[cardId] = clone(assignment);
    }
    this.invalidateResolution({ source, notify: false });
    this.#emit("selection", source);
  }

  clearSelection(source = null) {
    this.selectedIds.clear();
    this.selectionOrder = [];
    this.jokerAssignments = {};
    this.resetResolution({ source, notify: false });
    this.#emit("selection-cleared", source);
  }

  setJokerAssignment(cardId, assignment, source = null) {
    const id = String(cardId ?? "");
    if (!id) return;
    const suit = String(assignment?.suit ?? "");
    const number = Number(assignment?.value);
    const value = Number.isInteger(number) && number > 0 ? number : 0;
    if (suit || value) {
      this.jokerAssignments[id] = { suit, value };
    } else {
      delete this.jokerAssignments[id];
    }
    this.invalidateResolution({ source, notify: false });
    this.#emit("joker-assignment", source);
  }

  invalidateResolution({ source = null, notify = true, preserveOrder = false } = {}) {
    this.resolution.active = false;
    this.resolution.effectId = "";
    this.resolution.choices = clone(DEFAULT_CHOICES);
    this.resolution.vanguardCardId = "";
    if (!preserveOrder) this.resolution.discardOrder = this.selectedCardIds();
    if (notify) this.#emit("resolution-invalidated", source);
  }

  beginResolution(evaluation, source = null) {
    const cardIds = this.selectedCardIds();
    this.resolution.active = true;
    if (!sameMembers(this.resolution.discardOrder, cardIds)) this.resolution.discardOrder = [...cardIds];
    const effects = evaluation?.effects ?? [];
    if (!effects.includes(this.resolution.effectId)) this.resolution.effectId = effects.length === 1 ? effects[0] : "";
    this.#emit("resolution-begun", source);
  }

  setEffect(effectId, source = null) {
    this.resolution.active = true;
    this.resolution.effectId = String(effectId ?? "");
    this.#emit("effect", source);
  }

  setChoice(name, value, source = null) {
    if (!Object.hasOwn(DEFAULT_CHOICES, name)) return;
    this.resolution.active = true;
    this.resolution.choices[name] = String(value ?? "");
    this.#emit("choice", source);
  }

  setStatusChoices(statuses, source = null) {
    const normalized = [...new Set((Array.isArray(statuses) ? statuses : []).map(String).filter(Boolean))].slice(0, 2);
    this.resolution.active = true;
    this.resolution.choices.statusOne = normalized[0] ?? "";
    this.resolution.choices.statusTwo = normalized[1] ?? "";
    this.#emit("choice", source);
  }

  setVanguardCard(cardId, source = null) {
    const id = String(cardId ?? "");
    if (!id || !this.selectedIds.has(id)) return false;
    this.resolution.vanguardCardId = this.resolution.vanguardCardId === id ? "" : id;
    this.#emit("vanguard", source);
    return true;
  }

  clearVanguardCard(source = null) {
    if (!this.resolution.vanguardCardId) return false;
    this.resolution.vanguardCardId = "";
    this.#emit("vanguard", source);
    return true;
  }

  setDiscardOrder(order, source = null) {
    const selected = this.selectedCardIds();
    this.resolution.active = true;
    const normalized = order.map(String);
    if (!sameMembers(normalized, selected) || new Set(normalized).size !== normalized.length) return;
    this.resolution.discardOrder = normalized;
    this.#emit("discard-order", source);
  }

  moveDiscard(cardId, targetId, source = null) {
    const order = [...this.resolution.discardOrder];
    const from = order.indexOf(String(cardId));
    const to = order.indexOf(String(targetId));
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    this.setDiscardOrder(order, source);
  }

  moveDiscardBy(cardId, offset, source = null) {
    const order = [...this.resolution.discardOrder];
    const index = order.indexOf(String(cardId));
    const destination = index + Number(offset);
    if (index < 0 || destination < 0 || destination >= order.length) return;
    [order[index], order[destination]] = [order[destination], order[index]];
    this.setDiscardOrder(order, source);
  }

  resetResolution({ source = null, notify = true } = {}) {
    this.resolution = {
      active: false,
      effectId: "",
      choices: clone(DEFAULT_CHOICES),
      discardOrder: this.selectedCardIds(),
      vanguardCardId: "",
    };
    if (notify) this.#emit("resolution-reset", source);
  }

  buildPayload() {
    const cardIds = this.selectedCardIds();
    const discardOrder = sameMembers(this.resolution.discardOrder, cardIds)
      ? [...this.resolution.discardOrder]
      : [...cardIds];
    return {
      cardIds,
      discardOrder,
      jokerAssignments: this.selectedJokerAssignments(),
      effectId: String(this.resolution.effectId ?? ""),
      vanguardCardId: String(this.resolution.vanguardCardId ?? ""),
      choices: clone(this.resolution.choices),
    };
  }
}

export function getPlaySession(actorUuid, encounterKey = "") {
  const actorKey = String(actorUuid ?? "");
  if (!actorKey) return null;
  const key = `${actorKey}::${String(encounterKey ?? "")}`;
  if (!sessions.has(key)) sessions.set(key, new AcePlaySession(actorKey));
  return sessions.get(key);
}
