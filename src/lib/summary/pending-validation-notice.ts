/**
 * P4A — the 08:00 report's "some produce never landed" notice.
 *
 * The 08:10 sales summary already demotes its totals when a produce session is
 * unresolved (see countUnresolvedPendingSessions). The 08:00 stock report reads
 * only finalized rows, so a session the entry gate is holding is invisible
 * there: the day simply looks quieter than it was. This notice makes the
 * absence explicit without touching a single number in the report.
 */

/** Null when there is nothing to report — the ordinary morning stays unchanged. */
export function buildPendingValidationNotice(unresolvedSessionCount: number): string | null {
  if (unresolvedSessionCount <= 0) return null;
  return [
    `⚠️ มีรายการเบิก/ชั่งคืนที่ยังไม่ได้บันทึก ${unresolvedSessionCount} รายการ`,
    "ยอดด้านบนจึงยังไม่รวมรายการเหล่านี้",
    "กรุณาให้ผู้บันทึกตรวจและส่งรายการใหม่",
  ].join("\n");
}
