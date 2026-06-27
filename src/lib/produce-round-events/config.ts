/** Shadow dual-write for produce_round_events. Default off unless explicitly enabled. */
export function isProduceRoundEventsDualWriteEnabled(
  override?: boolean,
): boolean {
  if (override !== undefined) return override;
  const v = process.env.PRODUCE_ROUND_EVENTS_DUAL_WRITE_ENABLED;
  return v === "1" || v === "true" || v === "TRUE";
}
