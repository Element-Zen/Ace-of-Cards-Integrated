export function escapeSelectorValue(value) {
  if (globalThis.CSS?.escape) return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}

export function findProjectFUItemRow(root, itemId) {
  if (!root?.querySelector || !itemId) return null;
  const escaped = escapeSelectorValue(itemId);
  const attributes = ["data-item-id", "data-document-id", "data-entry-id"];

  for (const attribute of attributes) {
    const selector = `.fu-table__row-container[${attribute}="${escaped}"]`;
    const row = root.matches?.(selector) ? root : root.querySelector(selector);
    if (row) return row;
  }

  for (const attribute of attributes) {
    const nested = root.querySelector(`[${attribute}="${escaped}"]`);
    const row = nested?.closest?.(".fu-table__row-container");
    if (row) return row;
  }

  return null;
}

export function findProjectFUNameTarget(row) {
  if (!row?.querySelector) return null;
  const main = row.querySelector(".fu-table__row .cell-item-name__main")
    ?? row.querySelector(".cell-item-name__main");
  if (!main) return null;

  return Array.from(main.children ?? [])
    .find((child) => child?.classList?.contains?.("cell-item-name__name"))
    ?? null;
}
