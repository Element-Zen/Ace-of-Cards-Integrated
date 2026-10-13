import { CARD_IDS } from "../cards/card-catalog.mjs";

function titleCase(value) {
  const text = String(value ?? "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

export function createStyleDraft(style = {}) {
  return {
    styleId: String(style.styleId ?? ""),
    name: String(style.name ?? ""),
    builtin: Boolean(style.builtin),
    cardBack: String(style.cardBack ?? ""),
    faces: Object.fromEntries(CARD_IDS.map((cardId) => [cardId, String(style.faces?.[cardId] ?? "")])),
  };
}

export function updateStyleDraftCardBack(draft, path) {
  return { ...createStyleDraft(draft), cardBack: String(path ?? "").trim() };
}

export function updateStyleDraftFace(draft, cardId, path) {
  if (!CARD_IDS.includes(String(cardId))) throw new Error(`Unknown Ace card ${cardId}.`);
  return {
    ...createStyleDraft(draft),
    faces: { ...draft.faces, [cardId]: String(path ?? "").trim() },
  };
}

export function styleDraftChanged(draft, snapshot) {
  if (!draft || !snapshot) return false;
  return String(draft.name ?? "") !== String(snapshot.name ?? "")
    || String(draft.cardBack ?? "") !== String(snapshot.cardBack ?? "")
    || CARD_IDS.some((cardId) => String(draft.faces?.[cardId] ?? "") !== String(snapshot.faces?.[cardId] ?? ""));
}

export function cardEditorLabel(card) {
  if (card?.joker) return card.id === "joker-b" ? "Joker B" : "Joker A";
  const element = titleCase(card?.suit);
  const rank = Number(card?.value) === 1 ? "Ace" : String(card?.value ?? "");
  return `${element} ${rank}`.trim();
}
