/**
 * P2B/P2C purchase-capture feature flags.
 *
 * Fail-closed by design: every flag here defaults to disabled unless the
 * environment variable is present and exactly "true".
 */

/**
 * Fail-closed cron gate. Absent or anything but "true" => disabled.
 */
export function isPurchaseCaptureCronEnabled(
  value = process.env.PURCHASE_CAPTURE_CRON_ENABLED,
): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

/** Fail-closed webhook routing gate. Absent or anything but "true" => disabled. */
export function isPurchaseCaptureWebhookEnabled(
  value = process.env.PURCHASE_CAPTURE_WEBHOOK_ENABLED,
): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

/**
 * LINE source allowlist for purchase capture.
 *
 * Deliberately stricter than PHYSICAL_INVENTORY_LINE_GROUP_IDS, which ships a
 * baked-in default group: purchase capture writes stock into the MAIN
 * warehouse, so the set of LINE sources permitted to do that has to be an
 * explicit Production decision, never a repository default. Absent or empty
 * therefore means "no source is allowed" rather than "all sources".
 *
 * PURCHASE_CAPTURE_WEBHOOK_ENABLED alone is not sufficient to route anything.
 * Both gates must pass, so flipping the flag on cannot accidentally expose the
 * feature to every live market group at once.
 */
export function purchaseCaptureLineSourceIds(
  value = process.env.PURCHASE_CAPTURE_LINE_GROUP_IDS,
): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function isPurchaseCaptureLineSourceAllowed(
  sourceId: string,
  value = process.env.PURCHASE_CAPTURE_LINE_GROUP_IDS,
): boolean {
  return purchaseCaptureLineSourceIds(value).has(sourceId);
}

/**
 * The single authoritative answer to "may this LINE source use purchase
 * capture right now?". Both the feature flag and the source allowlist must
 * agree, and either one being absent means no.
 */
export function isPurchaseCaptureRoutingAllowed(sourceId: string): boolean {
  return isPurchaseCaptureWebhookEnabled() && isPurchaseCaptureLineSourceAllowed(sourceId);
}
