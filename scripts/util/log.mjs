import { MODULE_ID, SETTINGS } from "../constants.mjs";

function debugEnabled() {
  try {
    return Boolean(game.settings?.get(MODULE_ID, SETTINGS.DEBUG));
  } catch (_error) {
    return false;
  }
}

export const Log = Object.freeze({
  info: (...args) => console.info(`${MODULE_ID} |`, ...args),
  warn: (...args) => console.warn(`${MODULE_ID} |`, ...args),
  error: (...args) => console.error(`${MODULE_ID} |`, ...args),
  debug: (...args) => {
    if (debugEnabled()) console.debug(`${MODULE_ID} |`, ...args);
  },
});
