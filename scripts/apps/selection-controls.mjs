export function updateClearSetControl(root, { canManage = false, selectedIds = new Set() } = {}) {
  const button = root?.querySelector?.('[data-action="clearSet"]');
  if (!button) return false;
  const count = Number(selectedIds?.size ?? 0);
  const available = Boolean(canManage && count > 0);
  button.disabled = !available;
  button.hidden = false;
  button.setAttribute?.("aria-disabled", available ? "false" : "true");
  return available;
}
