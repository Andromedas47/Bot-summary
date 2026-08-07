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
