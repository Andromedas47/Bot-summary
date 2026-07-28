const DEFAULT_PHYSICAL_INVENTORY_LINE_GROUP_IDS = [
  "C1d96954d298d99f65912a5f1e96edffc",
] as const;

function parseAllowlist(value: string | undefined): Set<string> {
  const configured = value === undefined
    ? DEFAULT_PHYSICAL_INVENTORY_LINE_GROUP_IDS
    : value.split(/[\s,]+/);

  return new Set(configured.map((id) => id.trim()).filter(Boolean));
}

/**
 * Physical Inventory routing is group-only and fail-closed outside this
 * explicit allowlist. Set an empty env value to disable routing.
 */
export function physicalInventoryLineGroupIds(
  value = process.env.PHYSICAL_INVENTORY_LINE_GROUP_IDS,
): ReadonlySet<string> {
  return parseAllowlist(value);
}

export function isPhysicalInventoryLineGroupAllowed(
  sourceId: string,
  value = process.env.PHYSICAL_INVENTORY_LINE_GROUP_IDS,
): boolean {
  return physicalInventoryLineGroupIds(value).has(sourceId);
}
