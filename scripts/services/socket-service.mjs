import {
  STYLES_CHANGED_HOOK,
  MODULE_ID,
  PLAY_STATE_CHANGED_HOOK,
  SETTINGS,
  SOCKET_CHANNEL,
  SOCKET_EVENTS,
} from "../constants.mjs";
import { validateSocketEnvelope } from "../data/socket-envelope.mjs";
import { Log } from "../util/log.mjs";
import { actorDeckStore } from "./actor-deck-store.mjs";

function stateSignal(operation, payload, result, sourceUserId) {
  const actorUuid = String(result?.actorUuid ?? payload?.actorUuid ?? "");
  if (!actorUuid) return null;
  return {
    actorUuid,
    rootRevision: Number.isFinite(Number(result?.rootRevision)) ? Number(result.rootRevision) : null,
    revision: Number.isFinite(Number(result?.revision)) ? Number(result.revision) : null,
    status: String(result?.status ?? ""),
    openingComplete: result?.openingComplete === true,
    crossEncounterDeck: result?.crossEncounterDeck === true || result?.configuration?.crossEncounterDeck === true,
    combatUuid: String(result?.combatUuid ?? result?.conflict?.combatUuid ?? payload?.combatUuid ?? ""),
    sceneUuid: String(result?.sceneUuid ?? result?.conflict?.sceneUuid ?? payload?.sceneUuid ?? ""),
    operation: String(operation ?? ""),
    sourceUserId: String(sourceUserId ?? ""),
  };
}

export class AceSocketService {
  #pending = new Map();
  #initialized = false;
  #operations = new Map();

  constructor() {
    this.registerOperation("ping", async () => ({ authorityUserId: game.user.id, timestamp: Date.now() }));
    this.registerOperation("diagnostics.storage", async () => actorDeckStore.diagnose());
  }

  initialize() {
    if (this.#initialized) return;
    game.socket.on(SOCKET_CHANNEL, (message) => this.#onMessage(message));
    this.#initialized = true;
  }

  registerOperation(name, handler, { stateChange = false, styleChange = false } = {}) {
    if (!name || typeof handler !== "function") throw new Error("Socket operations require a name and handler.");
    if (this.#operations.has(name)) throw new Error(`Socket operation ${name} is already registered.`);
    this.#operations.set(name, { handler, stateChange: Boolean(stateChange), styleChange: Boolean(styleChange) });
  }

  async pingAuthority() {
    return this.request("ping");
  }

  async request(operation, payload = {}) {
    const activeGM = game.users.activeGM;
    if (!activeGM) throw new Error(game.i18n.localize("ACEOC.Notifications.GmRequired"));

    if (activeGM.isSelf) {
      const result = await this.#execute(operation, payload, game.user.id);
      this.#publishStateChange(operation, payload, result, game.user.id);
      this.#publishStyleChange(operation, payload, result, game.user.id);
      return result;
    }

    const requestId = foundry.utils.randomID();
    const timeoutMs = Number(game.settings.get(MODULE_ID, SETTINGS.AUTHORITY_TIMEOUT)) || 5000;
    const envelope = this.#validateEnvelope({
      kind: "request",
      requestId,
      operation,
      senderUserId: game.user.id,
      targetUserId: activeGM.id,
      timestamp: Date.now(),
      ok: true,
      payload,
      result: null,
      error: "",
      errorCode: "",
      errorExpected: false,
    });

    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`GM authority request timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timeout });
    });

    game.socket.emit(SOCKET_CHANNEL, envelope);
    const result = await promise;
    this.#notifyLocalStateChange(operation, payload, result, game.user.id);
    this.#notifyLocalStyleChange(operation, payload, result, game.user.id);
    return result;
  }

  #validateEnvelope(source) {
    return validateSocketEnvelope(source);
  }

  #operation(name) {
    const entry = this.#operations.get(name);
    if (!entry) throw new Error(`Unknown GM authority operation: ${name}`);
    return entry;
  }

  async #execute(operation, payload, senderUserId) {
    return this.#operation(operation).handler(payload, { senderUserId });
  }

  #notifyLocalStateChange(operation, payload, result, sourceUserId) {
    const entry = this.#operations.get(operation);
    if (!entry?.stateChange) return;
    const signal = stateSignal(operation, payload, result, sourceUserId);
    if (!signal) return;
    Hooks.callAll(PLAY_STATE_CHANGED_HOOK, signal.actorUuid, signal);
  }

  #publishStateChange(operation, payload, result, sourceUserId) {
    const entry = this.#operations.get(operation);
    if (!entry?.stateChange) return;
    const signal = stateSignal(operation, payload, result, sourceUserId);
    if (!signal) return;

    Hooks.callAll(PLAY_STATE_CHANGED_HOOK, signal.actorUuid, signal);
    const event = this.#validateEnvelope({
      kind: "event",
      requestId: foundry.utils.randomID(),
      operation: SOCKET_EVENTS.STATE_CHANGED,
      senderUserId: game.user.id,
      targetUserId: "",
      timestamp: Date.now(),
      ok: true,
      payload: signal,
      result: null,
      error: "",
      errorCode: "",
      errorExpected: false,
    });
    game.socket.emit(SOCKET_CHANNEL, event);
  }


  #styleSignal(operation, payload, result, sourceUserId) {
    return {
      styleId: String(result?.styleId ?? payload?.styleId ?? ""),
      operation: String(operation ?? ""),
      sourceUserId: String(sourceUserId ?? ""),
    };
  }

  #notifyLocalStyleChange(operation, payload, result, sourceUserId) {
    const entry = this.#operations.get(operation);
    if (!entry?.styleChange) return;
    Hooks.callAll(STYLES_CHANGED_HOOK, this.#styleSignal(operation, payload, result, sourceUserId));
  }

  #publishStyleChange(operation, payload, result, sourceUserId) {
    const entry = this.#operations.get(operation);
    if (!entry?.styleChange) return;
    const signal = this.#styleSignal(operation, payload, result, sourceUserId);
    Hooks.callAll(STYLES_CHANGED_HOOK, signal);
    const event = this.#validateEnvelope({
      kind: "event",
      requestId: foundry.utils.randomID(),
      operation: SOCKET_EVENTS.STYLES_CHANGED,
      senderUserId: game.user.id,
      targetUserId: "",
      timestamp: Date.now(),
      ok: true,
      payload: signal,
      result: null,
      error: "",
      errorCode: "",
      errorExpected: false,
    });
    game.socket.emit(SOCKET_CHANNEL, event);
  }

  #receiveStyleChange(message) {
    if (message.operation !== SOCKET_EVENTS.STYLES_CHANGED) return false;
    const activeGM = game.users.activeGM;
    if (!activeGM || message.senderUserId !== activeGM.id) return true;
    const signal = message.payload ?? {};
    if (message.senderUserId === game.user.id || signal.sourceUserId === game.user.id) return true;
    Hooks.callAll(STYLES_CHANGED_HOOK, signal);
    return true;
  }

  #receiveStateChange(message) {
    if (message.operation !== SOCKET_EVENTS.STATE_CHANGED) return;
    const activeGM = game.users.activeGM;
    if (!activeGM || message.senderUserId !== activeGM.id) return;
    const signal = message.payload ?? {};
    if (!signal.actorUuid) return;
    if (message.senderUserId === game.user.id || signal.sourceUserId === game.user.id) return;
    Hooks.callAll(PLAY_STATE_CHANGED_HOOK, String(signal.actorUuid), signal);
  }

  async #onMessage(raw) {
    let message;
    try {
      message = this.#validateEnvelope(raw);
    } catch (error) {
      Log.warn("Rejected an invalid socket envelope.", error);
      return;
    }

    if (message.kind === "event") {
      if (!this.#receiveStyleChange(message)) this.#receiveStateChange(message);
      return;
    }

    if (message.kind === "response") {
      if (message.targetUserId !== game.user.id) return;
      const pending = this.#pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else {
        const error = new Error(message.error || "GM authority rejected the request.");
        if (message.errorCode) error.code = message.errorCode;
        if (message.errorExpected) {
          error.name = "AceDeckLaunchError";
          error.expected = true;
        }
        pending.reject(error);
      }
      return;
    }

    const activeGM = game.users.activeGM;
    if (!game.user.isGM || !activeGM?.isSelf || message.targetUserId !== game.user.id) return;

    let result = null;
    let error = "";
    let errorCode = "";
    let errorExpected = false;
    let ok = true;
    try {
      result = await this.#execute(message.operation, message.payload, message.senderUserId);
    } catch (caught) {
      ok = false;
      error = caught instanceof Error ? caught.message : String(caught);
      errorCode = String(caught?.code ?? "");
      errorExpected = caught?.expected === true || caught?.name === "AceDeckLaunchError";
      if (errorExpected) Log.warn(`Authority operation ${message.operation} was unavailable.`, caught);
      else Log.error(`Authority operation ${message.operation} failed.`, caught);
    }

    const response = this.#validateEnvelope({
      kind: "response",
      requestId: message.requestId,
      operation: message.operation,
      senderUserId: game.user.id,
      targetUserId: message.senderUserId,
      timestamp: Date.now(),
      ok,
      payload: {},
      result,
      error,
      errorCode,
      errorExpected,
    });
    game.socket.emit(SOCKET_CHANNEL, response);
    if (ok) {
      this.#publishStateChange(message.operation, message.payload, result, message.senderUserId);
      this.#publishStyleChange(message.operation, message.payload, result, message.senderUserId);
    }
  }
}

export const socketService = new AceSocketService();
