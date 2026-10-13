function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, minimum, maximum) {
  if (minimum > maximum) return (minimum + maximum) / 2;
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedRect(rect) {
  if (!rect || typeof rect !== "object") return null;
  const left = finite(rect.left);
  const top = finite(rect.top);
  const width = Math.max(0, finite(rect.width, finite(rect.right) - left));
  const height = Math.max(0, finite(rect.height, finite(rect.bottom) - top));
  const right = Number.isFinite(Number(rect.right)) ? Number(rect.right) : left + width;
  const bottom = Number.isFinite(Number(rect.bottom)) ? Number(rect.bottom) : top + height;
  return { left, top, width, height, right, bottom };
}

export function calculateResultRailLayout({
  layoutRect,
  stripRect,
  selectedRects,
  messageWidth,
  messageHeight,
  direction = "bottom",
  margin = 8,
  cardClearance = 9,
  lowerCardClearance = 10,
  messageGap = 9,
  minimumLineWidth = 24,
} = {}) {
  const layout = normalizedRect(layoutRect);
  const strip = normalizedRect(stripRect);
  const cards = (Array.isArray(selectedRects) ? selectedRects : [])
    .map(normalizedRect)
    .filter(Boolean)
    .sort((left, right) => left.left - right.left);
  if (!layout || !strip || !cards.length || !layout.width || !layout.height || !strip.width) return null;

  const visible = cards.some((card) => card.right > strip.left && card.left < strip.right);
  if (!visible) return null;

  const first = cards[0];
  const last = cards[cards.length - 1];
  const rawStart = cards.length === 1 ? first.left + first.width * 0.2 : first.left + first.width / 2;
  const rawEnd = cards.length === 1 ? first.right - first.width * 0.2 : last.left + last.width / 2;
  const stripLeft = Math.max(margin, strip.left - layout.left + margin);
  const stripRight = Math.min(layout.width - margin, strip.right - layout.left - margin);
  if (stripRight <= stripLeft) return null;

  let lineLeft = clamp(Math.min(rawStart, rawEnd) - layout.left, stripLeft, stripRight);
  let lineRight = clamp(Math.max(rawStart, rawEnd) - layout.left, stripLeft, stripRight);
  if (lineRight - lineLeft < minimumLineWidth) {
    const midpoint = clamp((lineLeft + lineRight) / 2, stripLeft, stripRight);
    const half = minimumLineWidth / 2;
    lineLeft = Math.max(stripLeft, midpoint - half);
    lineRight = Math.min(stripRight, midpoint + half);
    if (lineRight - lineLeft < minimumLineWidth) {
      if (lineLeft === stripLeft) lineRight = Math.min(stripRight, stripLeft + minimumLineWidth);
      else lineLeft = Math.max(stripLeft, stripRight - minimumLineWidth);
    }
  }

  const boxWidth = Math.max(0, finite(messageWidth));
  const boxHeight = Math.max(0, finite(messageHeight));
  const desiredCenter = ((rawStart + rawEnd) / 2) - layout.left;
  const minimumCenter = stripLeft + boxWidth / 2;
  const maximumCenter = stripRight - boxWidth / 2;
  const messageCenter = minimumCenter <= maximumCenter
    ? clamp(desiredCenter, minimumCenter, maximumCenter)
    : (stripLeft + stripRight) / 2;

  const cardTop = Math.min(...cards.map((card) => card.top - layout.top));
  const cardBottom = Math.max(...cards.map((card) => card.bottom - layout.top));
  const preferredUpperLineTop = cardTop - cardClearance;
  const preferredLowerLineTop = cardBottom + lowerCardClearance;
  let upperLineTop = clamp(preferredUpperLineTop, margin, layout.height - margin);
  let lowerLineTop = clamp(preferredLowerLineTop, margin, layout.height - margin);
  let messageTop;
  let placement;

  if (String(direction) === "top") {
    const canSitBelow = preferredLowerLineTop + messageGap + boxHeight <= layout.height - margin;
    if (canSitBelow) {
      lowerLineTop = preferredLowerLineTop;
      messageTop = lowerLineTop + messageGap;
      placement = "below";
    } else {
      lowerLineTop = Math.max(margin, layout.height - margin - boxHeight - messageGap);
      messageTop = Math.min(layout.height - margin - boxHeight, lowerLineTop + messageGap);
      placement = "overlay";
    }
  } else {
    const canSitAbove = preferredUpperLineTop - messageGap - boxHeight >= margin;
    if (canSitAbove) {
      upperLineTop = preferredUpperLineTop;
      messageTop = upperLineTop - messageGap - boxHeight;
      placement = "above";
    } else {
      upperLineTop = Math.max(margin, Math.min(layout.height - margin, margin + boxHeight + messageGap));
      messageTop = Math.max(margin, upperLineTop - messageGap - boxHeight);
      placement = "overlay";
    }
  }

  const markerCenters = cards.map((card) => clamp(card.left + card.width / 2 - layout.left, stripLeft, stripRight));
  return {
    lineLeft,
    lineWidth: Math.max(0, lineRight - lineLeft),
    upperLineTop,
    lowerLineTop,
    markerCenters,
    messageCenter,
    messageTop,
    messageWidth: boxWidth,
    messageHeight: boxHeight,
    placement,
  };
}
