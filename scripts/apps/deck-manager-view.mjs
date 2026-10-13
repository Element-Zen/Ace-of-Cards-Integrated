import { CARD_DEFINITIONS } from "../cards/card-catalog.mjs";
import { resolveCardBack, resolveCardFace } from "../cards/style-registry.mjs";
import { cardEditorLabel } from "./style-editor-draft.mjs";

export function buildDeckManagerView(style, { styles = [], activeStyleId = "standard", myStyleId = "standard", isGM = false, saving = false, dirty = false } = {}) {
  const selectedId = style?.styleId ?? "standard";
  const isStandard = selectedId === "standard";
  const isBuiltin = Boolean(style?.builtin);
  const canEdit = isGM;
  return {
    isGM, saving, dirty, isStandard, isBuiltin, canEdit,
    canSave: canEdit && !saving && !isBuiltin && dirty,
    canSaveAs: isGM && !saving,
    canDelete: canEdit && !saving && !isBuiltin,
    canActivate: isGM && !saving && selectedId !== activeStyleId,
    isMine: selectedId === myStyleId,
    selectedId, isActive: selectedId === activeStyleId,
    styleName: style?.name ?? "",
    choices: styles.map((candidate) => ({
      styleId: candidate.styleId,
      label: `${candidate.name}${candidate.styleId === activeStyleId ? " (Default)" : ""}`,
      selected: candidate.styleId === selectedId,
    })),
    cardBack: { face: style?.cardBack ?? resolveCardBack(), label: "Card Back" },
    cards: CARD_DEFINITIONS.map((card) => ({
      ...card, face: style?.faces?.[card.id] ?? resolveCardFace(card.id), label: cardEditorLabel(card),
    })),
  };
}
