import { normalizeStyleSource, replaceHydratedStyles, STANDARD_STYLE_ID, WORLD_STYLE_ID, isBundledStyleId } from "../cards/style-registry.mjs";
import { STYLE_LIBRARY_SCHEMA_VERSION, MODULE_ID, SETTINGS } from "../constants.mjs";
import { hasLegacyFaceKeys } from "../cards/elemental-suit-migration.mjs";

const clone = (value) => structuredClone(value);
function sources(raw = {}) { return Object.values(raw.styles ?? raw.looks ?? {}); }
function currentStyleId(styleId, normalized = {}) {
  const id = String(styleId ?? "");
  if (!id || id === WORLD_STYLE_ID) return STANDARD_STYLE_ID;
  return isBundledStyleId(id) || Object.hasOwn(normalized, id) ? id : STANDARD_STYLE_ID;
}

// alpha.110's singleton `world` / "Card Style" record is migration residue.
// Keep it recoverable through legacyStylesBackup, but never expose it as a Style.
export function normalizeStyleLibrary(raw = {}) {
  const normalized = {};
  for (const source of sources(raw)) {
    const style = normalizeStyleSource(source);
    if (style.builtin || style.styleId === "placeholder" || style.styleId === WORLD_STYLE_ID || isBundledStyleId(style.styleId)) continue;
    normalized[style.styleId] = style;
  }
  const activeStyleId = currentStyleId(raw.activeStyleId, normalized);
  return {
    schemaVersion: STYLE_LIBRARY_SCHEMA_VERSION,
    activeStyleId,
    // Explicit per-user preferences; missing entries inherit the active world preset.
    // Keep unknown user IDs so offline players retain their assignments.
    assignments: Object.fromEntries(Object.entries(raw.assignments ?? {}).map(([userId, id]) => [String(userId), currentStyleId(id, normalized)])),
    styles: normalized,
    ...(raw.legacyStylesBackup ? { legacyStylesBackup: clone(raw.legacyStylesBackup) } : {}),
  };
}

export class StyleSettingsStore {
  read() {
    const raw = game.settings?.get?.(MODULE_ID, SETTINGS.CUSTOM_STYLES) ?? {};
    return normalizeStyleLibrary(raw);
  }
  list() { return Object.values(this.read().styles).map(clone); }
  selectionFor(userId) {
    // Read a small setting snapshot, not a normalized 30-image library, on every
    // play-state request. This path must stay lightweight while the drawer is open.
    const raw = game.settings?.get?.(MODULE_ID, SETTINGS.CUSTOM_STYLES) ?? {};
    const styles = raw.styles ?? {};
    const assigned = String(raw.assignments?.[String(userId)] ?? "");
    if (assigned === WORLD_STYLE_ID) return STANDARD_STYLE_ID;
    if (isBundledStyleId(assigned) || (assigned && assigned !== WORLD_STYLE_ID && Object.hasOwn(styles, assigned))) return assigned;
    const fallback = String(raw.activeStyleId ?? STANDARD_STYLE_ID);
    if (fallback === WORLD_STYLE_ID) return STANDARD_STYLE_ID;
    return isBundledStyleId(fallback) || (fallback && Object.hasOwn(styles, fallback)) ? fallback : STANDARD_STYLE_ID;
  }
  async assign(userId, styleId) {
    const next = this.read();
    if (!isBundledStyleId(styleId) && !Object.hasOwn(next.styles, styleId)) throw new Error("Unknown Ace card Style.");
    next.assignments[String(userId)] = styleId;
    await this.#write(next);
    return { userId: String(userId), styleId };
  }
  async #write(next) {
    if (!game.users.activeGM?.isSelf) throw new Error("Only the active GM may write the Ace Style library.");
    await game.settings.set(MODULE_ID, SETTINGS.CUSTOM_STYLES, next);
    replaceHydratedStyles(Object.values(next.styles), next.activeStyleId);
    return clone(next);
  }
  async create(source) {
    const next = this.read();
    const style = normalizeStyleSource(source);
    if (style.builtin || style.styleId === "placeholder" || style.styleId === WORLD_STYLE_ID || isBundledStyleId(style.styleId) || Object.hasOwn(next.styles, style.styleId)) throw new Error("This card Style ID is reserved or already exists.");
    next.styles[style.styleId] = style;
    await this.#write(next);
    return clone(style);
  }
  async update(source) {
    const next = this.read();
    const style = normalizeStyleSource(source);
    if (style.builtin || !Object.hasOwn(next.styles, style.styleId)) throw new Error("Only existing custom Styles can be updated.");
    next.styles[style.styleId] = style;
    await this.#write(next);
    return clone(style);
  }
  async activate(styleId) {
    const next = this.read();
    if (!isBundledStyleId(styleId) && !Object.hasOwn(next.styles, styleId)) throw new Error("Unknown Ace card Style.");
    next.activeStyleId = styleId;
    await this.#write(next);
    return styleId;
  }
  async remove(styleId) {
    const next = this.read();
    if (isBundledStyleId(styleId) || !Object.hasOwn(next.styles, styleId)) throw new Error("Included card Styles cannot be deleted; a custom Style must exist.");
    delete next.styles[styleId];
    if (next.activeStyleId === styleId) next.activeStyleId = STANDARD_STYLE_ID;
    for (const [userId, selection] of Object.entries(next.assignments)) {
      if (selection === styleId) next.assignments[userId] = STANDARD_STYLE_ID;
    }
    await this.#write(next);
    return { styleId, activeStyleId: next.activeStyleId };
  }
  // Called at startup by the active GM. Schema 5 retires alpha.110's visible
  // `world`/"Card Style" pseudo-preset and remaps its references to Flair.
  async migrateLibrary() {
    if (!game.users.activeGM?.isSelf) return { migrated: 0 };
    const raw = game.settings?.get?.(MODULE_ID, SETTINGS.CUSTOM_STYLES) ?? {};
    if (raw.schemaVersion === STYLE_LIBRARY_SCHEMA_VERSION && raw.activeStyleId && raw.styles && raw.assignments && !raw.styles?.[WORLD_STYLE_ID]) return { migrated: 0 };
    const next = normalizeStyleLibrary(raw);
    const hadLegacyWorld = Boolean(raw.styles?.[WORLD_STYLE_ID] || raw.looks?.[WORLD_STYLE_ID] || raw.activeStyleId === WORLD_STYLE_ID
      || Object.values(raw.assignments ?? {}).some((id) => id === WORLD_STYLE_ID));
    // Preserve old raw state before stripping migration-only records.
    if ((raw.schemaVersion || hadLegacyWorld) && !next.legacyStylesBackup) next.legacyStylesBackup = clone(raw);
    await this.#write(next);
    return { migrated: hadLegacyWorld ? 1 : Object.keys(next.styles).length };
  }
  async migrateLegacyLooks() {
    if (!game.users.activeGM?.isSelf) return { migrated: 0 };
    const raw = game.settings?.get?.(MODULE_ID, SETTINGS.LEGACY_CUSTOM_LOOKS) ?? {};
    const current = this.read();
    if (Object.keys(current.styles).length || !sources(raw).length) return { migrated: 0 };
    const legacy = sources(raw).map(normalizeStyleSource).filter((style) => !style.builtin);
    if (!legacy.length) return { migrated: 0 };
    const chosen = legacy.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    let styleId = String(chosen.styleId ?? "").trim();
    if (!styleId || styleId === "placeholder" || styleId === WORLD_STYLE_ID || isBundledStyleId(styleId)) styleId = "legacy-style";
    const base = styleId;
    let suffix = 2;
    while (Object.hasOwn(current.styles, styleId)) styleId = `${base}-${suffix++}`;
    const migrated = normalizeStyleSource({ ...chosen, styleId, name: String(chosen.name ?? "").trim() || "Legacy Style", builtin: false });
    current.styles[styleId] = migrated;
    current.activeStyleId = styleId;
    current.legacyStylesBackup ??= clone(raw);
    await this.#write(current);
    await game.settings.set(MODULE_ID, SETTINGS.LEGACY_CUSTOM_LOOKS, { schemaVersion: 1, looks: {} });
    return { migrated: legacy.length };
  }
  async migrateElementalSuits() {
    if (!game.users.activeGM?.isSelf) return { migrated: 0 };
    const raw = game.settings?.get?.(MODULE_ID, SETTINGS.CUSTOM_STYLES) ?? {};
    const migrating = sources(raw).filter((source) => Number(source?.schemaVersion ?? 0) < 2 || hasLegacyFaceKeys(source?.faces)).length;
    if (migrating) await this.#write(this.read());
    return { migrated: migrating };
  }
  async migrateCardBacks() {
    if (!game.users.activeGM?.isSelf) return { migrated: 0 };
    const raw = game.settings?.get?.(MODULE_ID, SETTINGS.CUSTOM_STYLES) ?? {};
    const migrating = sources(raw).filter((source) => Number(source?.schemaVersion ?? 0) < 3 || !String(source?.cardBack ?? "").trim()).length;
    if (migrating) await this.#write(this.read());
    return { migrated: migrating };
  }
  hydrate() { const value = this.read(); return replaceHydratedStyles(Object.values(value.styles), value.activeStyleId); }
}
export const styleSettingsStore = new StyleSettingsStore();
