export const CARD_WINDOW_DEFAULTS = Object.freeze({
  cardGap: 8,
  stripPadding: 12,
  zoneChrome: 29,
});

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function whole(value, fallback = 0) {
  return Math.max(0, Math.trunc(finite(value, fallback)));
}

export function calculateWholeCardCapacity({
  viewportWidth = 0,
  cardWidth = 0,
  totalCards = 0,
  zoneCount = 0,
  cardGap = CARD_WINDOW_DEFAULTS.cardGap,
  stripPadding = CARD_WINDOW_DEFAULTS.stripPadding,
  zoneChrome = CARD_WINDOW_DEFAULTS.zoneChrome,
  reservedWidth = 0,
} = {}) {
  const total = whole(totalCards);
  const width = Math.max(0, finite(cardWidth));
  if (!total || !width) return 0;

  const zones = Math.max(1, whole(zoneCount, 1));
  const reserved = Math.max(0, finite(stripPadding))
    + zones * Math.max(0, finite(zoneChrome))
    + Math.max(0, finite(reservedWidth));
  const usable = Math.max(0, finite(viewportWidth) - reserved);
  const gap = Math.max(0, finite(cardGap));
  if (usable < width) return 0;
  return Math.min(total, Math.max(1, Math.floor((usable + gap) / (width + gap))));
}

export function clampCardWindowStart({ requestedStart = 0, totalCards = 0, capacity = 0 } = {}) {
  const total = whole(totalCards);
  const visible = Math.min(total, whole(capacity));
  if (!total || !visible) return 0;
  return Math.min(Math.max(0, whole(requestedStart)), Math.max(0, total - visible));
}

export function cardWindowRange({ requestedStart = 0, totalCards = 0, capacity = 0 } = {}) {
  const total = whole(totalCards);
  const visible = Math.min(total, whole(capacity));
  const start = clampCardWindowStart({ requestedStart, totalCards: total, capacity: visible });
  return { start, end: Math.min(total, start + visible), capacity: visible, total };
}

export function shiftCardWindow({ start = 0, direction = 0, totalCards = 0, capacity = 0 } = {}) {
  const step = Math.sign(finite(direction));
  return clampCardWindowStart({
    requestedStart: whole(start) + step,
    totalCards,
    capacity,
  });
}

export function shiftCardWindowWithinGroup({
  start = 0,
  direction = 0,
  totalCards = 0,
  capacity = 0,
  groupIndexes = [],
} = {}) {
  const current = clampCardWindowStart({ requestedStart: start, totalCards, capacity });
  const visible = Math.min(whole(totalCards), whole(capacity));
  const indexes = [...new Set((Array.isArray(groupIndexes) ? groupIndexes : [])
    .map((value) => Math.trunc(finite(value, -1)))
    .filter((value) => value >= 0 && value < whole(totalCards)))]
    .sort((left, right) => left - right);
  const step = Math.sign(finite(direction));
  if (!visible || !indexes.length || !step) return current;
  const groupCardIsHidden = step < 0
    ? indexes.some((index) => index < current)
    : indexes.some((index) => index >= current + visible);
  return groupCardIsHidden
    ? shiftCardWindow({ start: current, direction: step, totalCards, capacity: visible })
    : current;
}

export function cardWindowStartForSelection({
  selectedIndexes = [],
  currentStart = 0,
  totalCards = 0,
  capacity = 0,
} = {}) {
  const total = whole(totalCards);
  const visible = Math.min(total, whole(capacity));
  if (!total || !visible) return 0;

  const indexes = [...new Set((Array.isArray(selectedIndexes) ? selectedIndexes : [])
    .map((value) => Math.trunc(finite(value, -1)))
    .filter((value) => value >= 0 && value < total))]
    .sort((left, right) => left - right);
  if (!indexes.length) return clampCardWindowStart({ requestedStart: currentStart, totalCards: total, capacity: visible });

  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  const span = last - first + 1;
  const requestedStart = span <= visible
    ? Math.floor((first + last + 1 - visible) / 2)
    : first;
  return clampCardWindowStart({ requestedStart, totalCards: total, capacity: visible });
}
