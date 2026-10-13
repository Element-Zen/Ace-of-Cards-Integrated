import { MODULE_ID } from "../constants.mjs";

export function isRunningOnForge(forgeVTT = globalThis.ForgeVTT) {
  return Boolean(forgeVTT?.usingTheForge);
}

export function configuredFilePickerClass({
  coreFilePicker = globalThis.foundry?.applications?.apps?.FilePicker,
  legacyFilePicker = globalThis.FilePicker,
} = {}) {
  return coreFilePicker?.implementation
    ?? legacyFilePicker?.implementation
    ?? coreFilePicker
    ?? legacyFilePicker
    ?? null;
}

function isBundledAssetPath(path) {
  const value = String(path ?? "").replace(/^\/+/, "");
  return value.startsWith(`modules/${MODULE_ID}/`)
    || value.startsWith("modules/")
    || value.startsWith("systems/")
    || value.startsWith("icons/")
    || value.startsWith("ui/");
}

function isForgeAssetUrl(path, forgeVTT) {
  const value = String(path ?? "");
  const prefix = String(forgeVTT?.ASSETS_LIBRARY_URL_PREFIX ?? "");
  if (prefix && value.startsWith(prefix)) return true;
  return /^https?:\/\/assets\.[^/]*forge-vtt\.com\//i.test(value);
}

export function filePickerCurrentPath(current, { forgeVTT = globalThis.ForgeVTT } = {}) {
  const value = String(current ?? "").trim();
  if (!isRunningOnForge(forgeVTT)) return value;
  if (!value || isBundledAssetPath(value)) return "";
  if (/^https?:\/\//i.test(value) && !isForgeAssetUrl(value, forgeVTT)) return "";
  return value;
}

export function imageFilePickerOptions({
  current = "",
  callback,
  position,
  forgeVTT = globalThis.ForgeVTT,
} = {}) {
  const forge = isRunningOnForge(forgeVTT);
  return {
    type: "image",
    current: filePickerCurrentPath(current, { forgeVTT }),
    callback,
    position,
    ...(forge ? { activeSource: "forgevtt" } : {}),
  };
}

export function openImageFilePicker({
  current = "",
  callback,
  position,
  forgeVTT = globalThis.ForgeVTT,
  coreFilePicker = globalThis.foundry?.applications?.apps?.FilePicker,
  legacyFilePicker = globalThis.FilePicker,
} = {}) {
  const FilePickerClass = configuredFilePickerClass({ coreFilePicker, legacyFilePicker });
  if (!FilePickerClass) throw new Error("Foundry File Picker is unavailable.");

  const picker = new FilePickerClass(imageFilePickerOptions({ current, callback, position, forgeVTT }));
  if (typeof picker.render === "function") return picker.render(true);
  if (typeof picker.browse === "function") return picker.browse();
  throw new Error("Configured Foundry File Picker cannot be opened.");
}
