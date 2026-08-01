/**
 * Exact Production Second-UAT field payload from raw_messages
 * id = a0d07d14-5d04-4164-98af-259832555d2b
 * (2026-08-01 15:03:50Z, event 01KYYXMN4D376W0AGK1PN3TG2V).
 *
 * Proven code points:
 * - line endings: U+000A (LF) only
 * - separators: U+0020 (SPACE) only
 * - Thai labels are byte-normal UTF-8 (no NBSP / ZWSP / CR)
 */
export const PRODUCTION_SECOND_UAT_FIELD_PAYLOAD_HEX =
  "e0b884e0b988e0b8b2e0b981e0b8a3e0b887203632300a" +
  "e0b884e0b988e0b8b2e0b897e0b8b5e0b988203138300a" +
  "e0b884e0b988e0b8b2e0b896e0b8b8e0b8872039300a" +
  "e0b884e0b988e0b8b2e0b882e0b899e0b8a12034300a" +
  "e0b884e0b988e0b8b2e0b8ade0b8b7e0b988e0b89920323520e0b884e0b988e0b8b2e0b899e0b989e0b8b3e0b981e0b882e0b987e0b8870a" +
  "e0b980e0b887e0b8b4e0b899e0b8aae0b8942035333630";

export const PRODUCTION_SECOND_UAT_FIELD_PAYLOAD = Buffer
  .from(PRODUCTION_SECOND_UAT_FIELD_PAYLOAD_HEX, "hex")
  .toString("utf8");
