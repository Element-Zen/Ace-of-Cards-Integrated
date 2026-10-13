export const DRAWER_DEFAULT_HEIGHT = 315;
export const DRAWER_MIN_HEIGHT = 220;
export const DRAWER_TOP_GAP = 72;
export const DRAWER_CHROME_ALLOWANCE = 150;
export const DRAWER_DIRECTIONS = Object.freeze(["bottom", "top"]);

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeDrawerDirection(value) {
  return DRAWER_DIRECTIONS.includes(String(value ?? "")) ? String(value) : "bottom";
}

export function oppositeDrawerDirection(value) {
  return normalizeDrawerDirection(value) === "top" ? "bottom" : "top";
}

export function minimumDrawerHeightForCardScale({
  baseCardHeight = 160,
  scale = 1,
  chromeAllowance = DRAWER_CHROME_ALLOWANCE,
  minimum = DRAWER_MIN_HEIGHT,
} = {}) {
  const scaledCardHeight = Math.max(0, finiteNumber(baseCardHeight, 160) * Math.max(0, finiteNumber(scale, 1)));
  return Math.max(finiteNumber(minimum, DRAWER_MIN_HEIGHT), Math.ceil(scaledCardHeight + finiteNumber(chromeAllowance, DRAWER_CHROME_ALLOWANCE)));
}

export function minimumDrawerHeightForContent({
  baseCardHeight = 160,
  scale = 1,
  chromeAllowance = DRAWER_CHROME_ALLOWANCE,
  abilityStackHeight = 0,
  contentGap = 12,
  minimum = DRAWER_MIN_HEIGHT,
} = {}) {
  const cardMinimum = minimumDrawerHeightForCardScale({
    baseCardHeight,
    scale,
    chromeAllowance,
    minimum,
  });
  const contentMinimum = Math.ceil(Math.max(0, finiteNumber(abilityStackHeight)) + Math.max(0, finiteNumber(contentGap)));
  return Math.max(cardMinimum, contentMinimum);
}

export function maximumDrawerHeight({ viewportHeight = 0, topGap = DRAWER_TOP_GAP } = {}) {
  return Math.max(120, Math.floor(finiteNumber(viewportHeight) - finiteNumber(topGap, DRAWER_TOP_GAP)));
}

export function clampDrawerHeight(height, {
  viewportHeight = 0,
  topGap = DRAWER_TOP_GAP,
  minimum = DRAWER_MIN_HEIGHT,
} = {}) {
  const requestedMinimum = finiteNumber(minimum, DRAWER_MIN_HEIGHT);
  const max = maximumDrawerHeight({ viewportHeight, topGap });
  const min = Math.min(requestedMinimum, max);
  const requested = finiteNumber(height, DRAWER_DEFAULT_HEIGHT);
  return Math.min(max, Math.max(min, Math.round(requested)));
}

export function calculateSidebarInset({ viewportWidth = 0, sidebarRect = null, visible = true } = {}) {
  const width = finiteNumber(viewportWidth);
  if (!visible || !sidebarRect || width <= 0) return 0;

  const left = finiteNumber(sidebarRect.left, width);
  const right = finiteNumber(sidebarRect.right, 0);
  const rectWidth = finiteNumber(sidebarRect.width, Math.max(0, right - left));
  if (rectWidth <= 0 || left < 0 || left >= width) return 0;
  if (right < width - 4 || left < width / 2) return 0;
  return Math.max(0, Math.ceil(width - left));
}
