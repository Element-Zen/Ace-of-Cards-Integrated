const KINDS = new Set(["request", "response", "event"]);

function text(value) {
  return String(value ?? "").trim();
}

export function validateSocketEnvelope(source = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("A socket envelope must be an object.");
  const envelope = {
    kind: text(source.kind),
    requestId: text(source.requestId),
    operation: text(source.operation),
    senderUserId: text(source.senderUserId),
    targetUserId: text(source.targetUserId),
    timestamp: Math.trunc(Number(source.timestamp) || 0),
    ok: source.ok !== false,
    payload: structuredClone(source.payload ?? {}),
    result: structuredClone(source.result ?? null),
    error: text(source.error),
    errorCode: text(source.errorCode),
    errorExpected: source.errorExpected === true,
  };
  if (!KINDS.has(envelope.kind)) throw new Error("Socket envelope kind is invalid.");
  if (!envelope.requestId || !envelope.operation || !envelope.senderUserId) throw new Error("Socket envelopes require request, operation, and sender IDs.");
  if (envelope.timestamp < 1) throw new Error("Socket envelopes require a valid timestamp.");
  if (envelope.kind === "response" && !envelope.targetUserId) throw new Error("A socket response requires a target user ID.");
  if (envelope.ok && envelope.error) throw new Error("A successful socket envelope cannot include an error.");
  return envelope;
}
