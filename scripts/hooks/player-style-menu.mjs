import { MODULE_ID } from "../constants.mjs";
import { AceDeckManagerApplication, openDeckManager } from "../apps/deck-manager-app.mjs";
import { AcePlayerStyleAssignmentsApplication } from "../apps/player-style-assignments-app.mjs";

const MENU_ACTIONS = Object.freeze([
  {
    id: "cardStyleEditor",
    label: "Edit Deck Styles",
    hint: "Create, edit, and delete saved card artwork Styles and set the default Style.",
    icon: "fa-solid fa-palette",
    type: AceDeckManagerApplication,
    open: () => openDeckManager(),
  },
  {
    id: "playerDeckStyles",
    label: "Manage Player Deck Styles",
    hint: "Assign saved card Styles to individual players. Players may change their assignment.",
    icon: "fa-solid fa-users",
    type: AcePlayerStyleAssignmentsApplication,
    open: () => new AcePlayerStyleAssignmentsApplication().render({ force: true }),
  },
]);

// Only augment Ace's settings category when Foundry omits registered submenu buttons.
// Do not replace or restructure the core SettingsConfig application.
export function ensureDeckStyleConfigButtons(element) {
  if (!globalThis.game?.user?.isGM) return 0;
  const root = element?.querySelector ? element : element?.[0];
  if (!root?.querySelector) return 0;

  const category = root.querySelector(
    `[data-category-id="${MODULE_ID}"], [data-category="${MODULE_ID}"], [data-package-id="${MODULE_ID}"]`,
  );
  const settingInput = root.querySelector(
    `input[name^="${MODULE_ID}."], select[name^="${MODULE_ID}."], [name^="${MODULE_ID}."]`,
  );
  // A category with the same data attribute can also be a *navigation* entry.
  // Anchor to a real Ace setting first, never the category-list sidebar.
  const area = settingInput?.closest?.(`[data-category-id="${MODULE_ID}"], [data-category="${MODULE_ID}"], [data-package-id="${MODULE_ID}"]`)
    ?? settingInput?.closest?.(".settings-category, .tab, section")
    ?? settingInput?.closest?.(".form-group")?.parentElement
    ?? (category?.querySelector?.(`[name^="${MODULE_ID}."]`) ? category : null);
  if (!area) return 0;

  // Registered native buttons take precedence. Fallback controls are idempotent.
  const buttons = Array.from(area.querySelectorAll("button"));
  const missing = MENU_ACTIONS.filter((action) => !buttons.some((button) =>
    button.dataset.aceStyleConfig === action.id || button.textContent.trim() === action.label
  ));
  if (!missing.length) return 0;

  const doc = area.ownerDocument ?? globalThis.document;
  const group = area.querySelector("[data-ace-style-config-fallback]") ?? doc.createElement("div");
  if (!group.hasAttribute("data-ace-style-config-fallback")) {
    group.dataset.aceStyleConfigFallback = "";
    group.className = "form-group ace-style-config-actions";
    area.prepend(group);
  }
  for (const action of missing) {
    if (group.querySelector(`[data-ace-style-config="${action.id}"]`)) continue;
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "ace-style-config-action";
    button.dataset.aceStyleConfig = action.id;
    button.title = action.hint;
    const icon = doc.createElement("i");
    icon.className = action.icon;
    icon.setAttribute("aria-hidden", "true");
    button.append(icon, doc.createTextNode(` ${action.label}`));
    button.addEventListener("click", () => { if (game.user?.isGM) void action.open(); });
    group.append(button);
  }
  return missing.length;
}

export function registerStyleConfigurationMenus() {
  for (const action of MENU_ACTIONS) {
    game.settings.registerMenu(MODULE_ID, action.id, {
      name: action.label,
      label: action.label,
      hint: action.hint,
      icon: action.icon,
      type: action.type,
      restricted: true,
    });
  }
  Hooks.on("renderSettingsConfig", (_app, element) => ensureDeckStyleConfigButtons(element));
}
