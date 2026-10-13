import { CARD_IDS } from "./card-catalog.mjs";
import { STYLE_SCHEMA_VERSION, MODULE_ID } from "../constants.mjs";
import { migrateLegacyFaceMap } from "./elemental-suit-migration.mjs";

const ROOT = `modules/${MODULE_ID}/assets/looks/default`;
const PIXEL_ROOT = `modules/${MODULE_ID}/assets/looks/pixel-by-kami`;
const DEFAULT_CARD_BACK = `${ROOT}/backs/default.webp`;
const PIXEL_CARD_BACK = `${PIXEL_ROOT}/backs/default.webp`;
export const WORLD_STYLE_ID = "world"; // Legacy-only alpha.110 migration ID; never expose as a selectable Style.
export const STANDARD_STYLE_ID = "standard";
export const PIXEL_STYLE_ID = "pixel-by-kami";

const faceMap = Object.freeze(Object.fromEntries(CARD_IDS.map((cardId) => [cardId, `${ROOT}/cards/${cardId}.webp`])));
const pixelFaceMap = Object.freeze(Object.fromEntries(CARD_IDS.map((cardId) => [
  cardId,
  cardId === "joker-a" || cardId === "joker-b" ? `${PIXEL_ROOT}/cards/joker.webp` : `${PIXEL_ROOT}/cards/${cardId}.webp`,
])));
export const DEFAULT_ELEMENT_BADGES = Object.freeze({
  air: `${ROOT}/elements/air.svg`, earth: `${ROOT}/elements/earth.svg`,
  fire: `${ROOT}/elements/fire.svg`, ice: `${ROOT}/elements/ice.svg`,
});

export const BUNDLED_DEFAULT_STYLE = Object.freeze({
  schemaVersion: STYLE_SCHEMA_VERSION,
  styleId: "placeholder", name: "Flair by Zenfyre", builtin: true,
  createdByUserId: "system", createdAt: 0, updatedAt: 0,
  cardBack: DEFAULT_CARD_BACK, faces: faceMap,
});
export const STANDARD_STYLE = Object.freeze({
  ...BUNDLED_DEFAULT_STYLE, styleId: STANDARD_STYLE_ID, name: "Flair by Zenfyre",
});
export const PIXEL_STYLE = Object.freeze({
  ...BUNDLED_DEFAULT_STYLE,
  styleId: PIXEL_STYLE_ID,
  name: "Pixel by Kami",
  cardBack: PIXEL_CARD_BACK,
  faces: pixelFaceMap,
});
export const BUNDLED_STYLES = Object.freeze([STANDARD_STYLE, PIXEL_STYLE]);
export const BUNDLED_STYLE_IDS = Object.freeze(BUNDLED_STYLES.map((style) => style.styleId));
export function isBundledStyleId(styleId) { return BUNDLED_STYLE_IDS.includes(String(styleId ?? "")); }

function bundledStyleMap() {
  return new Map(BUNDLED_STYLES.map((style) => [style.styleId, style]));
}

function validateImagePath(path, label) {
  const value = String(path ?? "").trim();
  if (!value) throw new Error(label);
  if (/^javascript:/i.test(value) || /[<>\u0000-\u001f]/.test(value)) throw new Error(`${label} contains an invalid image path.`);
  return value;
}

export function validateStyle(style) {
  if (!style?.styleId || !String(style.name ?? "").trim()) throw new Error("A card Style requires an ID and name.");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(style.styleId))) throw new Error("A card Style ID must use lowercase letters, numbers, and hyphens.");
  validateImagePath(style.cardBack, `Card Style ${style.styleId} requires a card back.`);
  if (!style.faces || typeof style.faces !== "object") throw new Error(`Card Style ${style.styleId} requires card faces.`);
  const faceKeys = Object.keys(style.faces);
  if (faceKeys.length !== CARD_IDS.length || faceKeys.some((cardId) => !CARD_IDS.includes(cardId))) {
    throw new Error(`Card Style ${style.styleId} must contain exactly the 30 canonical card identities.`);
  }
  for (const cardId of CARD_IDS) validateImagePath(style.faces[cardId], `Card Style ${style.styleId} is missing ${cardId}.`);
  return true;
}

export function normalizeStyleSource(source = {}) {
  const faces = migrateLegacyFaceMap(source.faces ?? {});
  const normalized = {
    schemaVersion: STYLE_SCHEMA_VERSION,
    styleId: String(source.styleId ?? source.lookId ?? "").trim(),
    name: String(source.name ?? "").trim(),
    builtin: Boolean(source.builtin),
    createdByUserId: String(source.createdByUserId ?? "").trim(),
    createdAt: Math.max(0, Math.trunc(Number(source.createdAt) || 0)),
    updatedAt: Math.max(0, Math.trunc(Number(source.updatedAt) || 0)),
    cardBack: String(source.cardBack ?? source.back ?? DEFAULT_CARD_BACK).trim() || DEFAULT_CARD_BACK,
    faces: Object.fromEntries(CARD_IDS.map((cardId) => [cardId, String(faces?.[cardId] ?? "").trim()])),
  };
  validateStyle(normalized);
  return normalized;
}

export function createBundledStyleSource() { return structuredClone(BUNDLED_DEFAULT_STYLE); }

let STYLES = bundledStyleMap();
let ACTIVE_STYLE_ID = STANDARD_STYLE_ID;

// Client hydration is synchronous; authoritative writes still go through the GM.
export function replaceHydratedStyles(sources = [], activeStyleId = null) {
  const next = bundledStyleMap();
  for (const source of sources ?? []) {
    const value = normalizeStyleSource(source);
    if (value.styleId === "placeholder" || value.styleId === WORLD_STYLE_ID || value.builtin || isBundledStyleId(value.styleId)) continue;
    next.set(value.styleId, Object.freeze(value));
  }
  STYLES = next;
  const desired = activeStyleId === WORLD_STYLE_ID ? STANDARD_STYLE_ID : (activeStyleId ?? (next.has(ACTIVE_STYLE_ID) ? ACTIVE_STYLE_ID : STANDARD_STYLE_ID));
  ACTIVE_STYLE_ID = next.has(desired) ? desired : STANDARD_STYLE_ID;
  return listStyles();
}
export function hydrateStyleRegistry(sources = [], activeStyleId = null) { return replaceHydratedStyles(sources, activeStyleId); }
export function activeStyleId() { return ACTIVE_STYLE_ID; }
export function getStyle(styleId = null) {
  const id = styleId === "placeholder" || styleId == null ? ACTIVE_STYLE_ID : String(styleId);
  return structuredClone(STYLES.get(id) ?? STYLES.get(ACTIVE_STYLE_ID) ?? STANDARD_STYLE);
}
export function listStyles() { return Array.from(STYLES.values(), (style) => structuredClone(style)); }

// Legacy callers still resolve the active world preset through these helpers.
// Actor configuration.styleId is intentionally ignored; player-specific artwork
// is resolved separately from the requesting user's Style assignment.
export function resolveCardFace(cardId, _actorStyleId = WORLD_STYLE_ID) {
  return STYLES.get(ACTIVE_STYLE_ID)?.faces?.[cardId] ?? STANDARD_STYLE.faces[cardId] ?? "icons/svg/card-joker.svg";
}
export function resolveCardBack(_actorStyleId = WORLD_STYLE_ID) {
  return STYLES.get(ACTIVE_STYLE_ID)?.cardBack ?? STANDARD_STYLE.cardBack;
}

// These explicit presentation-only resolvers must not interpret Actor deck
// configuration.styleId. The requesting user's assignment is passed by the
// authoritative play-state builder, not stored in the Actor's state.
export function resolveFaceForStyle(cardId, selectedStyleId) {
  return STYLES.get(selectedStyleId)?.faces?.[cardId] ?? STANDARD_STYLE.faces[cardId] ?? "icons/svg/card-joker.svg";
}
export function resolveBackForStyle(selectedStyleId) {
  return STYLES.get(selectedStyleId)?.cardBack ?? STANDARD_STYLE.cardBack;
}
