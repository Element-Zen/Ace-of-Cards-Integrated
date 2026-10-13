import { MODULE_ID } from "../constants.mjs";
import { socketService } from "../services/socket-service.mjs";
import { Log } from "../util/log.mjs";
import { buildDeckManagerView } from "./deck-manager-view.mjs";
import { createStyleDraft, styleDraftChanged, updateStyleDraftCardBack, updateStyleDraftFace } from "./style-editor-draft.mjs";
import { openImageFilePicker } from "./image-file-picker.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

export class AceDeckManagerApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "ace-of-cards-integrated-card-style-editor",
    classes: ["ace-of-cards-integrated", "ace-deck-manager"],
    position: { width: 920, height: 820 },
    window: { title: "ACEOC.Deck.CardStyleEditor", icon: "fa-solid fa-palette", resizable: true, minimizable: true },
    actions: {
      replaceStyleFace: AceDeckManagerApplication.replaceStyleFace,
      replaceStyleBack: AceDeckManagerApplication.replaceStyleBack,
      saveStyle: AceDeckManagerApplication.saveStyle,
      saveStyleAs: AceDeckManagerApplication.saveStyleAs,
      activateStyle: AceDeckManagerApplication.activateStyle,
      deleteStyle: AceDeckManagerApplication.deleteStyle,
    },
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/deck-manager.hbs` } };

  #styles = [];
  #activeStyleId = "standard";
  #myStyleId = "standard";
  #selectedId = null;
  #draft = null;
  #snapshot = null;
  #saving = false;
  #error = "";
  #scrollTop = 0;

  async #loadLibrary(preferId = null) {
    const data = await socketService.request("style.list");
    this.#styles = data.styles ?? [];
    this.#activeStyleId = data.activeStyleId ?? "standard";
    this.#myStyleId = data.myStyleId ?? this.#activeStyleId;
    const selectedId = preferId ?? this.#selectedId ?? this.#myStyleId;
    const style = this.#styles.find((item) => item.styleId === selectedId)
      ?? this.#styles.find((item) => item.styleId === this.#activeStyleId)
      ?? this.#styles[0];
    if (!style) throw new Error("No Ace card Styles are available.");
    this.#selectedId = style.styleId;
    this.#snapshot = createStyleDraft(style);
    this.#draft = createStyleDraft(style);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    if (!this.#draft) {
      try { await this.#loadLibrary(); }
      catch (error) { this.#error = error.message; Log.error("Unable to load the Card Style Editor.", error); }
    }
    return {
      ...context,
      ...buildDeckManagerView(this.#draft, {
        styles: this.#styles, activeStyleId: this.#activeStyleId, myStyleId: this.#myStyleId,
        isGM: game.user.isGM, saving: this.#saving,
        dirty: styleDraftChanged(this.#draft, this.#snapshot),
      }),
      error: this.#error,
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    const main = root?.querySelector(".ace-deck-manager__main");
    if (main) main.scrollTop = this.#scrollTop;
    root?.querySelector("[data-style-select]")?.addEventListener("change", (event) => this.#switchStyle(event));
    root?.querySelector("[data-style-name]")?.addEventListener("input", (event) => {
      if (!game.user.isGM || !this.#draft) return;
      this.#draft.name = event.currentTarget.value;
      // Do not rerender while typing or lose input focus.
    });
    main?.addEventListener("scroll", () => { this.#scrollTop = main.scrollTop; }, { passive: true });
  }

  async #confirmDiscard() {
    if (!styleDraftChanged(this.#draft, this.#snapshot)) return true;
    return DialogV2.confirm({
      window: { title: "Discard unsaved card images?" },
      content: "Switching Styles will discard unsaved image and name edits. Continue?",
      modal: true,
    });
  }

  async #switchStyle(event) {
    const control = event.currentTarget;
    const nextId = control.value;
    if (nextId === this.#selectedId) return;
    if (!game.user.isGM) {
      // For players, selecting a saved preset is the only edit action: apply it immediately.
      // The authoritative style.assign operation permits only their own user ID.
      control.disabled = true;
      const applied = await this.#request("style.assign", { styleId: nextId, userId: game.user.id }, nextId);
      if (!applied) control.value = this.#selectedId;
      return;
    }
    if (!(await this.#confirmDiscard())) { control.value = this.#selectedId; return; }
    const chosen = this.#styles.find((style) => style.styleId === nextId);
    if (!chosen) { control.value = this.#selectedId; return; }
    this.#selectedId = nextId;
    this.#snapshot = createStyleDraft(chosen);
    this.#draft = createStyleDraft(chosen);
    this.#error = "";
    await this.render({ force: true });
  }

  async #request(operation, payload, nextSelection = this.#selectedId) {
    if (this.#saving) return;
    this.#saving = true;
    this.#error = "";
    try {
      const result = await socketService.request(operation, payload);
      await this.#loadLibrary(typeof nextSelection === "function" ? nextSelection(result) : nextSelection);
      return result;
    } catch (error) {
      this.#error = error.message;
      Log.error(`Unable to complete ${operation}.`, error);
      ui.notifications.error(error.message);
      return null;
    } finally { this.#saving = false; await this.render({ force: true }); }
  }

  #setDraft(next) {
    if (!next || this.#saving) return;
    this.#draft = next;
    void this.render({ force: true });
  }

  static async replaceStyleBack() {
    if (!game.user.isGM || !this.#draft || this.#saving) return;
    return openImageFilePicker({
      current: this.#draft.cardBack ?? "",
      callback: (path) => this.#setDraft(updateStyleDraftCardBack(this.#draft, path)),
      position: { top: Number(this.position?.top ?? 0) + 40, left: Number(this.position?.left ?? 0) + 40 },
    });
  }
  static async replaceStyleFace(_event, target) {
    if (!game.user.isGM || !this.#draft || this.#saving) return;
    const cardId = String(target.dataset.cardId ?? "");
    return openImageFilePicker({
      current: this.#draft.faces?.[cardId] ?? "",
      callback: (path) => this.#setDraft(updateStyleDraftFace(this.#draft, cardId, path)),
      position: { top: Number(this.position?.top ?? 0) + 40, left: Number(this.position?.left ?? 0) + 40 },
    });
  }
  #canEditStyle() {
    return game.user.isGM && !this.#draft?.builtin;
  }
  static async saveStyle() {
    if (!this.#draft || !this.#canEditStyle()) return;
    await this.#request("style.update", { ...this.#draft, styleId: this.#selectedId });
  }
  static async saveStyleAs() {
    if (!game.user.isGM || !this.#draft) return;
    const enteredName = String(this.#draft.name ?? "").trim();
    const originalName = this.#snapshot?.name ?? "";
    // A copy may be made without editing the name field first.
    const name = enteredName === originalName ? `${enteredName} Copy` : enteredName;
    await this.#request("style.create", { ...this.#draft, name }, (style) => style.styleId);
  }
  static async activateStyle() {
    if (!game.user.isGM || !this.#draft || this.#selectedId === this.#activeStyleId) return;
    if (styleDraftChanged(this.#draft, this.#snapshot) && !(await this.#confirmDiscard())) return;
    await this.#request("style.activate", { styleId: this.#selectedId });
  }
  static async deleteStyle() {
    if (!game.user.isGM || !this.#draft || !this.#canEditStyle()) return;
    const confirmed = await DialogV2.confirm({
      window: { title: "Delete card Style?" },
      content: `Delete the custom Style “${this.#draft.name.replace(/[&<>"']/g, "")}”? ${this.#activeStyleId === this.#selectedId ? "The world-wide appearance will return to Flair by Zenfyre." : "This cannot be undone."}`,
      modal: true,
    });
    if (!confirmed) return;
    await this.#request("style.delete", { styleId: this.#selectedId }, "standard");
  }
  async close(options = {}) {
    if (!(await this.#confirmDiscard())) return;
    deckManagerApp = null;
    return super.close(options);
  }
}

let deckManagerApp;
export function openDeckManager() {
  deckManagerApp ??= new AceDeckManagerApplication({
    window: { title: game.user?.isGM ? "ACEOC.Deck.CardStyleEditor" : "My Deck Style" },
  });
  return deckManagerApp.render({ force: true });
}
