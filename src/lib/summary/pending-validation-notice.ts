/**
 * P4A — the 08:00 report's "some produce never landed" notice.
 *
 * The 08:10 sales summary already demotes its totals when a produce session is
 * unresolved (see countUnresolvedPendingSessions). The 08:00 stock report reads
 * only finalized rows, so a session the entry gate is holding is invisible
 * there: the day simply looks quieter than it was. This notice makes the
 * absence explicit without touching a single number in the report.
 */

import { isQaMarketLabel } from "@/lib/sales/qa-scopes";
import { LINE_MESSAGE_MAX_CODE_POINTS, countCodePoints } from "@/lib/summary/line-chunking";
import type { RoundReturnStatus } from "@/lib/produce/round-return-status";

/** Null when there is nothing to report — the ordinary morning stays unchanged. */
export function buildPendingValidationNotice(unresolvedSessionCount: number): string | null {
  if (unresolvedSessionCount <= 0) return null;
  return [
    `⚠️ มีรายการเบิก/ชั่งคืนที่ยังไม่ได้บันทึก ${unresolvedSessionCount} รายการ`,
    "ยอดด้านบนจึงยังไม่รวมรายการเหล่านี้",
    "กรุณาให้ผู้บันทึกตรวจและส่งรายการใหม่",
  ].join("\n");
}

export const MISSING_RETURN_HEADING =
  "⚠️ ตลาดที่มีเบิกแต่ยังไม่มีรายการคืนที่บันทึกสำเร็จ";

/**
 * Readability target, well under LINE's 4,000 code-point hard limit — the same
 * reasoning as the good-return report's own cap: the LINE client collapses a
 * long message behind "See more" long before the limit is reached, and this
 * section exists to be read at a glance before the markets run.
 */
const MISSING_RETURN_READABLE_MAX_CODE_POINTS = 900;

/**
 * The three not-yet-recorded states, in the operator's words.
 *
 * `none` is deliberately NOT called sold out here: the 08:00 report values what
 * was weighed back, and the sold-out inference lives in the 08:10 Sales report.
 * Naming the withdrawal size is what lets a human decide whether "no return" is
 * plausible for that market.
 */
function statusLine(row: RoundReturnStatus): string | null {
  if (row.state === "blocked") return "พบการส่งชั่งคืน แต่ยังบันทึกไม่สำเร็จ เนื่องจากรายการต้องแก้ไข";
  if (row.state === "pending") return "มีรายการชั่งคืนที่ยังปิดไม่สำเร็จ";
  if (row.state === "none") {
    return `เบิก ${row.withdrawalItemCount} รายการ แต่ยังไม่พบรายการชั่งคืนที่บันทึกสำเร็จ`;
  }
  return null;
}

/**
 * Per-round detail for markets whose ชั่งคืน has not landed.
 *
 * Round-keyed, so a market whose return was filed under an alias label is NOT
 * listed here — its return did land, in the round that holds the withdrawal.
 * Split across messages by real code-point length, never truncated silently.
 */
export function buildMissingReturnNotices(
  statuses: readonly RoundReturnStatus[],
): string[] {
  const blocks = statuses
    .filter((row) => row.state !== "persisted")
    .filter((row) => !isQaMarketLabel(row.marketLabel))
    .sort(
      (a, b) =>
        a.marketLabel.localeCompare(b.marketLabel, "th")
        || a.sellerLabel.localeCompare(b.sellerLabel, "th"),
    )
    .map((row) => {
      const title = row.sellerLabel
        ? `${row.marketLabel || "ไม่ระบุตลาด"} — ${row.sellerLabel}`
        : row.marketLabel || "ไม่ระบุตลาด";
      return [title, statusLine(row)].filter(Boolean).join("\n");
    });
  if (blocks.length === 0) return [];

  const messages: string[] = [];
  let current = MISSING_RETURN_HEADING;
  for (const block of blocks) {
    const candidate = `${current}\n\n${block}`;
    // A single entry is never split: it is two short lines by construction, so
    // a part holding only one entry can never reach the hard limit.
    if (
      current !== MISSING_RETURN_HEADING
      && countCodePoints(candidate) > MISSING_RETURN_READABLE_MAX_CODE_POINTS
    ) {
      messages.push(current);
      current = `${MISSING_RETURN_HEADING} (ต่อ)\n\n${block}`;
      continue;
    }
    current = candidate;
  }
  messages.push(current);
  if (messages.some((message) => countCodePoints(message) > LINE_MESSAGE_MAX_CODE_POINTS)) {
    throw new Error("missing-return notice exceeds LINE limit");
  }
  return messages;
}
