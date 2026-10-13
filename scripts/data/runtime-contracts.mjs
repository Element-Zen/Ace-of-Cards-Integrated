import { createBundledStyleSource, validateStyle } from "../cards/style-registry.mjs";
import { createDefaultActorDeckState, validateActorDeckState } from "../services/actor-deck-store.mjs";
import { validateSocketEnvelope } from "./socket-envelope.mjs";

export function validateRuntimeContracts() {
  const state = createDefaultActorDeckState();
  validateActorDeckState(state);
  const style = createBundledStyleSource();
  validateStyle(style);
  const socket = validateSocketEnvelope({
    kind: "request",
    requestId: "contract-request",
    operation: "ping",
    senderUserId: "contract-user",
    targetUserId: "",
    timestamp: Date.now(),
    ok: true,
    payload: {},
    result: null,
    error: "",
  });
  return { state: true, style: true, socket: Boolean(socket.requestId) };
}
