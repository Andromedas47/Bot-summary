/**
 * Exact Production UAT field payload from raw_messages
 * id = 5b869e9b-60fc-43de-97de-a6c67d48712e
 * (2026-08-01 14:12:55Z, event 01KYYTQDQ4X6FVPSMH8ZHP3MM4).
 *
 * Proven code points:
 * - line endings: U+000A (LF) only
 * - separators: U+0020 (SPACE) only
 * - Thai labels match FIELD_LABELS byte-for-byte (no NBSP / ZWSP / CR)
 */
export const PRODUCTION_UAT_FIELD_PAYLOAD_HEX =
  "e0b884e0b988e0b8b2e0b981e0b8a3e0b887203530300a" +
  "e0b884e0b988e0b8b2e0b897e0b8b5e0b988203230300a" +
  "e0b884e0b988e0b8b2e0b896e0b8b8e0b887203130300a" +
  "e0b884e0b988e0b8b2e0b882e0b899e0b8a12035300a" +
  "e0b884e0b988e0b8b2e0b8ade0b8b7e0b988e0b89920333020e0b884e0b988e0b8b2e0b899e0b989e0b8b30a" +
  "e0b980e0b887e0b8b4e0b899e0b8aae0b8942034383530";

export const PRODUCTION_UAT_FIELD_PAYLOAD = Buffer
  .from(PRODUCTION_UAT_FIELD_PAYLOAD_HEX, "hex")
  .toString("utf8");
