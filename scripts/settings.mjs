import { STYLE_LIBRARY_SCHEMA_VERSION, MODULE_ID, PLAY_CARD_SCALE_CHANGED_HOOK, SETTINGS } from "./constants.mjs";
import { replaceHydratedStyles } from "./cards/style-registry.mjs";
import { DEFAULT_CARD_SCALE, localizedCardScaleChoices, normalizeCardScale } from "./apps/card-scale.mjs";
import { normalizeDrawerDirection } from "./apps/drawer-layout.mjs";
import { projectFUAdapter } from "./integrations/projectfu-adapter.mjs";
import { handleCrossEncounterWorldSettingChange, registerCrossEncounterWorldHooks } from "./services/cross-encounter-world-service.mjs";


function localize(key, fallback = key) {
  const value = globalThis.game?.i18n?.localize?.(key);
  return value && value !== key ? value : fallback;
}

export function encounterAutoOpenActorChoices() {
  const actors = Array.from(globalThis.game?.actors ?? [])
    .filter((actor) => actor?.type === "character" || actor?.isCharacterType)
    .filter((actor) => projectFUAdapter.hasMagicCards(actor))
    .sort((left, right) => String(left?.name ?? "").localeCompare(String(right?.name ?? "")));
  return Object.fromEntries([
    ["", localize("ACEOC.Settings.EncounterAutoOpenNone", "None")],
    ...actors.map((actor) => [String(actor.uuid ?? actor.id ?? ""), String(actor.name ?? "Unnamed Actor")]),
  ]);
}

export function refreshEncounterAutoOpenChoices(root = null) {
  const key = `${MODULE_ID}.${SETTINGS.ENCOUNTER_AUTO_OPEN_ACTOR}`;
  const choices = encounterAutoOpenActorChoices();
  const config = globalThis.game?.settings?.settings?.get?.(key);
  if (config) config.choices = choices;

  const HTMLElementClass = globalThis.HTMLElement;
  const element = HTMLElementClass && root instanceof HTMLElementClass ? root : root?.[0] ?? null;
  const select = element?.querySelector?.(`select[name="${key}"]`);
  if (!select) return choices;
  const current = String(globalThis.game?.settings?.get?.(MODULE_ID, SETTINGS.ENCOUNTER_AUTO_OPEN_ACTOR) ?? "");
  select.replaceChildren(...Object.entries(choices).map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
  select.value = Object.hasOwn(choices, current) ? current : "";
  return choices;
}

function registerEncounterAutoOpenChoiceHooks() {
  Hooks.once("ready", () => refreshEncounterAutoOpenChoices());
  Hooks.on("createActor", () => refreshEncounterAutoOpenChoices());
  Hooks.on("updateActor", () => refreshEncounterAutoOpenChoices());
  Hooks.on("deleteActor", () => refreshEncounterAutoOpenChoices());
}

export function registerSettings() {



  game.settings.register(MODULE_ID, SETTINGS.CUSTOM_STYLES, {
    scope: "world",
    config: false,
    type: Object,
    default: { schemaVersion: STYLE_LIBRARY_SCHEMA_VERSION, activeStyleId: "standard", assignments: {}, styles: {} },
    onChange: (value) => replaceHydratedStyles(Object.values(value?.styles ?? {}), value?.activeStyleId),
  });

  game.settings.register(MODULE_ID, SETTINGS.LEGACY_CUSTOM_LOOKS, {
    scope: "world",
    config: false,
    type: Object,
    default: { schemaVersion: 1, looks: {} },
  });

  game.settings.register(MODULE_ID, SETTINGS.DEBUG, {
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, SETTINGS.AUTHORITY_TIMEOUT, {
    name: "ACEOC.Settings.AuthorityTimeoutName",
    hint: "ACEOC.Settings.AuthorityTimeoutHint",
    scope: "world",
    config: false,
    type: Number,
    default: 20000,
  });

  game.settings.register(MODULE_ID, SETTINGS.PLAY_CARD_SCALE, {
    name: "ACEOC.Settings.CardScaleName",
    hint: "ACEOC.Settings.CardScaleHint",
    scope: "client",
    config: true,
    type: Number,
    choices: localizedCardScaleChoices(),
    default: DEFAULT_CARD_SCALE,
    onChange: (value) => Hooks.callAll(PLAY_CARD_SCALE_CHANGED_HOOK, { value: normalizeCardScale(value) }),
  });

  game.settings.register(MODULE_ID, SETTINGS.CARD_SCALE_MIGRATED, {
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, SETTINGS.GM_CARD_SCALE, {
    name: "ACEOC.Settings.GmCardScaleName",
    hint: "ACEOC.Settings.GmCardScaleHint",
    scope: "world",
    config: false,
    type: Number,
    choices: localizedCardScaleChoices(),
    default: DEFAULT_CARD_SCALE,
  });

  game.settings.register(MODULE_ID, SETTINGS.PLAYER_CARD_SCALE, {
    name: "ACEOC.Settings.PlayerCardScaleName",
    hint: "ACEOC.Settings.PlayerCardScaleHint",
    scope: "world",
    config: false,
    type: Number,
    choices: localizedCardScaleChoices(),
    default: DEFAULT_CARD_SCALE,
  });

  game.settings.register(MODULE_ID, SETTINGS.CROSS_ENCOUNTER_DECK, {
    name: "ACEOC.Settings.CrossEncounterDeckName",
    hint: "ACEOC.Settings.CrossEncounterDeckHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: handleCrossEncounterWorldSettingChange,
  });

  game.settings.register(MODULE_ID, SETTINGS.ENCOUNTER_AUTO_OPEN_ACTOR, {
    name: "ACEOC.Settings.EncounterAutoOpenName",
    hint: "ACEOC.Settings.EncounterAutoOpenHint",
    scope: "world",
    config: true,
    type: String,
    choices: encounterAutoOpenActorChoices(),
    default: "",
  });

  game.settings.register(MODULE_ID, SETTINGS.PLAY_DRAWER_DIRECTION, {
    scope: "client",
    config: false,
    type: String,
    choices: { bottom: "Bottom", top: "Top" },
    default: "bottom",
  });

  game.settings.register(MODULE_ID, SETTINGS.PLAY_EXTRAS_WINDOW_RECT, {
    scope: "client",
    config: false,
    type: Object,
    default: {},
  });

  registerEncounterAutoOpenChoiceHooks();
  registerCrossEncounterWorldHooks();
}

export async function normalizeClientSettings() {
  const migrated = game.settings.get(MODULE_ID, SETTINGS.CARD_SCALE_MIGRATED) === true;
  if (!migrated) {
    const legacyKey = game.user?.isGM ? SETTINGS.GM_CARD_SCALE : SETTINGS.PLAYER_CARD_SCALE;
    const legacyScale = normalizeCardScale(game.settings.get(MODULE_ID, legacyKey));
    await game.settings.set(MODULE_ID, SETTINGS.PLAY_CARD_SCALE, legacyScale);
    await game.settings.set(MODULE_ID, SETTINGS.CARD_SCALE_MIGRATED, true);
  }
  const current = game.settings.get(MODULE_ID, SETTINGS.PLAY_CARD_SCALE);
  const normalized = normalizeCardScale(current);
  if (Number(current) !== normalized) {
    await game.settings.set(MODULE_ID, SETTINGS.PLAY_CARD_SCALE, normalized);
  }
  const currentDirection = game.settings.get(MODULE_ID, SETTINGS.PLAY_DRAWER_DIRECTION);
  const normalizedDirection = normalizeDrawerDirection(currentDirection);
  if (String(currentDirection ?? "") !== normalizedDirection) {
    await game.settings.set(MODULE_ID, SETTINGS.PLAY_DRAWER_DIRECTION, normalizedDirection);
  }
  return normalized;
}
