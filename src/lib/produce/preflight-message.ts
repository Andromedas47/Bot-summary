/**
 * `ตรวจความพร้อม` — the Daily Close Preflight in the operator's words.
 *
 * Presentation only. Every fact comes from the DailyClosePreflightResult; this
 * file computes nothing and decides nothing. It also prints no UUIDs: the
 * operator's question is "which market do I have to chase", not "which row".
 * The ids stay in the structured result for the admin surfaces that need them.
 */

import { formatThaiDate } from "@/lib/date";
import { satangToBahtText } from "@/lib/sales/calculate";
import { chunkBlocks, LINE_MESSAGE_MAX_CODE_POINTS } from "@/lib/summary/line-chunking";
import type {
  DailyClosePreflightResult,
  PreflightIssue,
  PreflightRound,
} from "./daily-close-preflight";

export const PREFLIGHT_TITLE = "🔎 ตรวจความพร้อมก่อนปิดยอด";
export const PREFLIGHT_READY = "สถานะ: พร้อมปิดวันที่";
export const PREFLIGHT_READY_WITH_WARNINGS = "สถานะ: ปิดได้ แต่มีรายการที่ควรตรวจ";
export const PREFLIGHT_BLOCKED = "สถานะ: ยังไม่พร้อมปิดวันที่";
export const PREFLIGHT_NO_ROUNDS = "ยังไม่พบข้อมูลเบิก/คืนของวันที่นี้";

function statusLine(result: DailyClosePreflightResult): string {
  if (result.status === "blocked") return PREFLIGHT_BLOCKED;
  if (result.status === "ready_with_warnings") return PREFLIGHT_READY_WITH_WARNINGS;
  return PREFLIGHT_READY;
}

function roundTitle(round: PreflightRound): string {
  const market = round.marketName || "ไม่ระบุตลาด";
  return round.staffName ? `${market} — ${round.staffName}` : market;
}

/** One block per round that needs attention. Ready rounds are a count, not a list. */
function roundBlock(round: PreflightRound): string {
  const issues = [...round.blockers, ...round.warnings.filter((row) => row.code !== "unresolved_central_price")];
  return [roundTitle(round), ...issues.map((issue) => `• ${issue.message}`)].join("\n");
}

function pricingBlock(result: DailyClosePreflightResult): string[] {
  if (result.pricingConflicts.length === 0) return [];
  const lines = result.pricingConflicts.map((conflict) => {
    const prices = conflict.candidates
      .map((candidate) => satangToBahtText(candidate.priceSatang).replace(/\.00$/, ""))
      .join(" / ");
    return `• ${conflict.productDisplayName} (${conflict.unitKey}) — พบ ${prices} บาท`;
  });
  return [
    [`⚠️ ราคากลางต้องยืนยัน ${result.pricingConflicts.length} สินค้า`, ...lines].join("\n"),
  ];
}

function integrityBlock(issues: readonly PreflightIssue[]): string[] {
  const reportable = issues.filter((issue) => issue.code !== "unresolved_central_price");
  if (reportable.length === 0) return [];
  return [
    [
      "⚠️ ปัญหาความถูกต้องของข้อมูล",
      ...reportable.map((issue) => {
        const scope = issue.marketName ? `${issue.marketName} — ` : "";
        return `${issue.severity === "blocker" ? "⛔" : "•"} ${scope}${issue.message}`;
      }),
    ].join("\n"),
  ];
}

/**
 * Failures a later success replaced. Reported as a one-line count, never as a
 * list of problems: they are closed business, and the only reason to mention
 * them at all is so an operator who remembers sending a bad message can see
 * that the system noticed the correction.
 */
function supersededBlock(result: DailyClosePreflightResult): string[] {
  if (result.supersededFailures.length === 0) return [];
  return [
    `ℹ️ มีรายการเก่าที่แก้ไขและส่งใหม่สำเร็จแล้ว ${result.supersededFailures.length} ชุด (ไม่ต้องดำเนินการ)`,
  ];
}

export function buildPreflightBlocks(result: DailyClosePreflightResult): string[] {
  const header = [PREFLIGHT_TITLE, `ข้อมูลวันที่ ${formatThaiDate(result.businessDate)}`].join("\n");

  if (result.rounds.length === 0 && result.integrityIssues.length === 0) {
    return [`${header}\n\n${PREFLIGHT_NO_ROUNDS}\n\n${statusLine(result)}`];
  }

  const needsAttention = result.rounds.filter((round) => round.status !== "ready");
  const counts = [
    `✅ พร้อมปิด ${result.summary.readyRounds} ตลาด`,
    ...(result.summary.partialRounds > 0
      ? [`⚠️ ยืนยันยอดได้บางส่วน ${result.summary.partialRounds} ตลาด`]
      : []),
    ...(result.summary.blockedRounds > 0
      ? [`⛔ ต้องตรวจ ${result.summary.blockedRounds} ตลาด`]
      : []),
  ].join("\n");

  return [
    `${header}\n\n${counts}`,
    ...needsAttention.filter((round) => round.blockers.length > 0).map(roundBlock),
    ...pricingBlock(result),
    ...integrityBlock(result.integrityIssues),
    ...supersededBlock(result),
    statusLine(result),
  ];
}

export function buildPreflightMessages(
  result: DailyClosePreflightResult,
  options: { maxCodePoints?: number } = {},
): string[] {
  return chunkBlocks(
    buildPreflightBlocks(result),
    options.maxCodePoints ?? LINE_MESSAGE_MAX_CODE_POINTS,
  );
}
