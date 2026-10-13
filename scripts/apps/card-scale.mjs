export const CARD_SCALE_PRESETS = Object.freeze([
  Object.freeze({
    id: "small", tick: 4, value: 1.25, labelKey: "ACEOC.Settings.CardScaleSmall",
    controls: Object.freeze({ abilityWidth: 152, rowHeight: 28, gutter: 22, fontSize: 12, jokerSize: 15, railWidth: 152 }),
  }),
  Object.freeze({
    id: "medium", tick: 5, value: 1.5, labelKey: "ACEOC.Settings.CardScaleMedium",
    controls: Object.freeze({ abilityWidth: 171, rowHeight: 32, gutter: 25, fontSize: 14, jokerSize: 17, railWidth: 171 }),
  }),
  Object.freeze({
    id: "large", tick: 6, value: 1.75, labelKey: "ACEOC.Settings.CardScaleLarge",
    controls: Object.freeze({ abilityWidth: 190, rowHeight: 35, gutter: 28, fontSize: 15, jokerSize: 19, railWidth: 190 }),
  }),
]);

export const CARD_SCALE_MIN = CARD_SCALE_PRESETS[0].value;
export const CARD_SCALE_MAX = CARD_SCALE_PRESETS.at(-1).value;
export const CARD_SCALE_STEP = 0.25;
export const DEFAULT_CARD_SCALE = CARD_SCALE_PRESETS[1].value;

export function cardScalePreset(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return CARD_SCALE_PRESETS[1];
  return CARD_SCALE_PRESETS.reduce((nearest, preset) => (
    Math.abs(preset.value - numeric) < Math.abs(nearest.value - numeric) ? preset : nearest
  ), CARD_SCALE_PRESETS[0]);
}

export function normalizeCardScale(value) {
  return cardScalePreset(value).value;
}

export function cardControlMetrics(value) {
  return cardScalePreset(value).controls;
}

export function localizedCardScaleChoices() {
  const localize = globalThis.game?.i18n?.localize?.bind(globalThis.game.i18n) ?? ((key) => key);
  return Object.fromEntries(CARD_SCALE_PRESETS.map(({ value, labelKey }) => [
    String(value),
    localize(labelKey),
  ]));
}
