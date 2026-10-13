import { MODULE_ID } from "../constants.mjs";
import { socketService } from "../services/socket-service.mjs";
import { Log } from "../util/log.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// Opened from Configure Settings > Module Settings; not exposed to players.
export class AcePlayerStyleAssignmentsApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "ace-player-deck-styles",
    classes: ["ace-of-cards-integrated", "ace-deck-manager"],
    position: { width: 540, height: 520 },
    window: { title: "Player Deck Styles", icon: "fa-solid fa-users", resizable: true },
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/player-style-assignments.hbs` } };

  #savingUser = "";
  #error = "";

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    if (!game.user.isGM) return { ...context, users: [], error: "GM access required." };
    try {
      const library = await socketService.request("style.list");
      const styles = library.styles ?? [];
      const assignments = library.assignments ?? {};
      return {
        ...context, error: this.#error,
        users: Array.from(game.users ?? []).map((user) => ({
          id: user.id, name: user.name, isSaving: this.#savingUser === user.id,
          choices: styles.map((style) => ({
            value: style.styleId,
            label: style.name,
            selected: style.styleId === (assignments[user.id] ?? library.activeStyleId),
          })),
        })),
      };
    } catch (error) {
      Log.error("Unable to open the player Style assignments.", error);
      return { ...context, users: [], error: error.message };
    }
  }

  _onRender(context, options) {
    super._onRender(context, options);
    for (const select of this.element?.querySelectorAll?.("[data-ace-player-style]") ?? []) {
      select.addEventListener("change", async (event) => {
        if (!game.user.isGM || this.#savingUser) return;
        const control = event.currentTarget;
        const userId = control.dataset.acePlayerStyle;
        this.#savingUser = userId;
        try {
          await socketService.request("style.assign", { userId, styleId: control.value });
          this.#error = "";
        } catch (error) {
          this.#error = error.message;
          ui.notifications.error(error.message);
        } finally {
          this.#savingUser = "";
          await this.render({ force: true });
        }
      });
    }
  }
}
