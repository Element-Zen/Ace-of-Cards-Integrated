import { PROJECTFU_HOOKS } from "../constants.mjs";
import { openDeckManager } from "../apps/deck-manager-app.mjs";

export function registerProjectFUSidebarTool() {
  Hooks.on(PROJECTFU_HOOKS.GET_SIDEBAR_TOOLS, (groups) => {
    const utilities = groups.find((group) => group.id === "utilities");
    if (!utilities) return;
    utilities.tools ??= {};
    utilities.tools.aceOfCardsEditor = {
      icon: "fa-solid fa-cards",
      label: "ACEOC.Deck.PlayerStyleLabel",
      tooltip: "ACEOC.Deck.PlayerStyleHint",
      click: () => openDeckManager(),
      condition: () => Boolean(game.user && !game.user.isGM),
    };
  });
}
