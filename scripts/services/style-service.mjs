import { CARD_IDS } from "../cards/card-catalog.mjs";
import { getStyle, listStyles, STANDARD_STYLE_ID, isBundledStyleId } from "../cards/style-registry.mjs";
import { styleSettingsStore } from "./style-settings-store.mjs";

function requesterFor(userId) {
  const user = game.users.get(userId);
  if (!user) throw new Error("The requesting user no longer exists.");
  return user;
}
function requireGM(userId) {
  const user = requesterFor(userId);
  if (!user.isGM) throw new Error("Only a GM may manage the Ace card Style library.");
  return user;
}
function slug(name) {
  return String(name ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom-style";
}
function normalizedPayload(payload = {}) {
  if (!payload || typeof payload !== "object") throw new Error("Invalid card Style request.");
  const name = String(payload.name ?? "").trim();
  if (!name || name.length > 80) throw new Error("A Style name must be between 1 and 80 characters.");
  if (!payload.faces || typeof payload.faces !== "object") throw new Error("A Style requires all 30 card images.");
  return { name, cardBack: payload.cardBack, faces: Object.fromEntries(CARD_IDS.map((id) => [id, payload.faces[id]])) };
}
function libraryResponse(userId) {
  const library = styleSettingsStore.read();
  return {
    styles: listStyles(), activeStyleId: library.activeStyleId,
    myStyleId: styleSettingsStore.selectionFor(userId),
    // Assignments are private to the GM configuration menu.
    ...(game.users.get(userId)?.isGM ? { assignments: library.assignments } : {}),
  };
}

export class AceStyleService {
  async list(_payload, senderUserId) {
    requesterFor(senderUserId);
    styleSettingsStore.hydrate();
    return libraryResponse(senderUserId);
  }
  async create(payload, senderUserId) {
    const creator = requireGM(senderUserId);
    const fields = normalizedPayload(payload);
    const now = Date.now();
    const list = styleSettingsStore.read().styles;
    let id = slug(fields.name), suffix = 2;
    if (isBundledStyleId(id) || id === "placeholder" || id === "world") id += "-custom";
    const base = id;
    while (Object.hasOwn(list, id)) id = `${base}-${suffix++}`;
    return styleSettingsStore.create({ ...fields, styleId: id, builtin: false, createdByUserId: creator.id, createdAt: now, updatedAt: now });
  }
  async update(payload, senderUserId) {
    requireGM(senderUserId);
    const id = String(payload?.styleId ?? "");
    const previous = styleSettingsStore.read().styles[id];
    if (!previous || id === STANDARD_STYLE_ID) throw new Error("Choose an existing custom Style to save.");
    const fields = normalizedPayload(payload);
    return styleSettingsStore.update({ ...previous, ...fields, builtin: false, updatedAt: Date.now() });
  }
  async activate(payload, senderUserId) {
    requireGM(senderUserId);
    const styleId = String(payload?.styleId ?? "");
    await styleSettingsStore.activate(styleId);
    return { styleId, activeStyleId: styleId };
  }
  async delete(payload, senderUserId) {
    requireGM(senderUserId);
    const id = String(payload?.styleId ?? "");
    return styleSettingsStore.remove(id);
  }
  async assign(payload, senderUserId) {
    const sender = requesterFor(senderUserId);
    const userId = String(payload?.userId ?? senderUserId);
    if (userId !== senderUserId && !sender.isGM) throw new Error("Players may only change their own card Style.");
    if (!game.users.get(userId)) throw new Error("Unknown Foundry user for card Style assignment.");
    return styleSettingsStore.assign(userId, String(payload?.styleId ?? ""));
  }
}
export const styleService = new AceStyleService();
