function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export const DRAG_EDGE_NAVIGATION = Object.freeze({
  dwellMs: 300,
  repeatMs: 180,
});

function sameMembers(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return rightSet.size === right.length && left.every((value) => rightSet.has(value));
}

export function reorderCardAtGap(cardIds, draggedCardId, beforeCardId = "") {
  const order = cardIds.map(String).filter(Boolean);
  const dragged = String(draggedCardId ?? "");
  const before = String(beforeCardId ?? "");
  if (!dragged || !order.includes(dragged) || order.length !== new Set(order).size) return [...order];

  const remaining = order.filter((cardId) => cardId !== dragged);
  const insertionIndex = before ? remaining.indexOf(before) : remaining.length;
  if (insertionIndex < 0) return [...order];
  remaining.splice(insertionIndex, 0, dragged);
  return remaining;
}

export function nextCardIdAfterVisibleGroup({
  groupOrder = [],
  draggedCardId = "",
  visibleCardIds = [],
} = {}) {
  const dragged = String(draggedCardId ?? "");
  const order = (Array.isArray(groupOrder) ? groupOrder : [])
    .map(String)
    .filter((cardId) => cardId && cardId !== dragged);
  const visible = new Set((Array.isArray(visibleCardIds) ? visibleCardIds : []).map(String).filter(Boolean));
  const lastVisibleIndex = order.reduce(
    (last, cardId, index) => visible.has(cardId) ? index : last,
    -1,
  );
  if (lastVisibleIndex < 0) return "";
  return order.slice(lastVisibleIndex + 1).find((cardId) => !visible.has(cardId)) ?? "";
}

export function mergeGroupOrder(handOrder, originalGroupOrder, reorderedGroupOrder) {
  const hand = handOrder.map(String).filter(Boolean);
  const original = originalGroupOrder.map(String).filter(Boolean);
  const reordered = reorderedGroupOrder.map(String).filter(Boolean);
  if (!sameMembers(original, reordered)) return [...hand];

  const groupSet = new Set(original);
  let groupIndex = 0;
  return hand.map((cardId) => groupSet.has(cardId) ? reordered[groupIndex++] : cardId);
}

export function reflowTranslations(beforeRects = [], afterRects = []) {
  const beforeById = new Map((Array.isArray(beforeRects) ? beforeRects : [])
    .map(({ cardId, rect }) => [
      String(cardId ?? ""),
      {
        left: finite(rect?.left),
        top: finite(rect?.top),
      },
    ])
    .filter(([cardId]) => cardId));

  return (Array.isArray(afterRects) ? afterRects : [])
    .map(({ cardId, rect }) => {
      const id = String(cardId ?? "");
      const before = beforeById.get(id);
      if (!id || !before) return null;
      const translateX = before.left - finite(rect?.left);
      const translateY = before.top - finite(rect?.top);
      if (Math.abs(translateX) < 0.5 && Math.abs(translateY) < 0.5) return null;
      return { cardId: id, translateX, translateY };
    })
    .filter(Boolean);
}

export function terminalInsertionSlotDirection({
  pointerInsideSlot = false,
  slotIndex = -1,
  visibleIndexes = [],
} = {}) {
  if (!pointerInsideSlot || !Number.isInteger(slotIndex) || slotIndex < 0) return 0;
  const indexes = (Array.isArray(visibleIndexes) ? visibleIndexes : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0)
    .sort((left, right) => left - right);
  if (!indexes.length) return 0;
  if (slotIndex < indexes[0]) return -1;
  if (slotIndex > indexes.at(-1)) return 1;
  return 0;
}

export function insertionGapForPointer({
  clientX,
  clientY,
  groupRect,
  cardRects = [],
}) {
  if (!groupRect) return null;
  const x = finite(clientX, Number.NaN);
  const y = finite(clientY, Number.NaN);
  const groupLeft = finite(groupRect.left);
  const groupRight = finite(groupRect.right, groupLeft + finite(groupRect.width));
  const groupTop = finite(groupRect.top);
  const groupBottom = finite(groupRect.bottom, groupTop + finite(groupRect.height));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < groupLeft || x > groupRight || y < groupTop || y > groupBottom) return null;

  const cards = cardRects
    .map(({ cardId, rect }) => ({
      cardId: String(cardId ?? ""),
      left: finite(rect?.left),
      right: finite(rect?.right, finite(rect?.left) + finite(rect?.width)),
    }))
    .filter(({ cardId, left, right }) => cardId && right > left)
    .sort((left, right) => left.left - right.left);
  if (!cards.length) return null;

  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const center = card.left + (card.right - card.left) / 2;
    if (x >= center) continue;
    const previous = cards[index - 1] ?? null;
    return {
      beforeCardId: card.cardId,
      clientX: previous ? (previous.right + card.left) / 2 : card.left,
    };
  }

  return {
    beforeCardId: "",
    clientX: cards.at(-1).right,
  };
}
