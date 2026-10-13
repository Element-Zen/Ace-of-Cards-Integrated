import { STYLES_CHANGED_HOOK } from "../constants.mjs";
import { styleSettingsStore } from "../services/style-settings-store.mjs";
import { Log } from "../util/log.mjs";

let queued = false;
function queueHydration() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    try { styleSettingsStore.hydrate(); }
    catch (error) { Log.error("Unable to refresh the Ace card Style registry.", error); }
  });
}
export function registerStyleRegistryHooks() {
  Hooks.on(STYLES_CHANGED_HOOK, queueHydration);
}
