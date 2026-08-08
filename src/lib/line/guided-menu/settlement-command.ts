/**
 * Slice 3D.1 — guided settlement submission ("ส่งยอด").
 *
 * This is the last step that used to require the Dashboard. It is a THIN LINE
 * adapter: it parses one guided template and calls the existing authoritative
 * boundary, submitSettlementEntryForSource — the same reconcile → upsert →
 * tryFinalizeSettlement contract POST /api/settlement uses. No settlement
 * accounting, no reconciliation formula and no second write path lives here.
 *
 * Money strings and the Buddhist date are parsed by the SAME helpers the White
 * Sheet closing command uses, so "1,250.50" and "29/07/2569" mean exactly what
 * they already mean elsewhere.
 *
 * The template is generated next to the parser on purpose: a change to one that
 * breaks the other fails the round-trip test in slice3d1-settlement.test.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseBusinessDate,
  parseCloseMoneyAmount,
  stripExportPrefix,
} from "@/lib/line/white-sheet-close-command";
import {
  submitSettlementEntryForSource,
  type SubmitSettlementEntryResult,
} from "@/lib/settlement/submit-entry";
import { thaiDateFromIso, type GuidedJourneyContext } from "./journey";
import type { GuidedJourneyService } from "./journey";
import { resolveGuidedOwnership } from "./ownership-guard";
import { withGuidedMarker } from "./provenance";
import type { GuidedRoundService } from "./round-close";
import { GUIDED_ROUND_BLOCKER_LABEL, summarizeSlipStatuses } from "./round-close";
import { buildRoundStatusMessage, buildSettlementSavedMessage } from "./messages";
import { GUIDED_MENU_COPY } from "./ux-types";
import type { GuidedMenuIdentity } from "./ux-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any>;

const HEADER_RE = /^(.+?)\s+ส่งยอด\s+(\d{1,2}\/\d{1,2}\/(?:25)?\d{2})\s*$/;
const CLOSE_LINE = "จบส่งยอด";

/**
 * The four operator-facing amounts, mapped onto the settlement_entries columns
 * the Dashboard form already writes. No field is invented and none is optional:
 * a settlement submitted from LINE must be as complete as one typed on the web.
 */
const FIELDS = {
  ยอดโอน: "moneyTransfer",
  เงินสด: "moneyCash",
  ค่าใช้จ่าย: "expenses",
  ค่าแรง: "labor",
} as const;

type FieldKey = (typeof FIELDS)[keyof typeof FIELDS];

const FIELD_LINE_RE = /^(ยอดโอน|เงินสด|ค่าใช้จ่าย|ค่าแรง)\s+(.+?)\s*$/;

export type GuidedSettlementCommand = {
  /** Raw "<seller> <market>" prefix — validated against the round, never split. */
  subject: string;
  businessDate: string;
  moneyTransfer: number;
  moneyCash: number;
  expenses: number;
  labor: number;
};

export type GuidedSettlementParseResult =
  | { kind: "not_command" }
  | { kind: "invalid"; message: string }
  | { kind: "ok"; command: GuidedSettlementCommand };

/** Collapse runs of whitespace so a copied template survives LINE reflowing. */
function collapse(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

export function isGuidedSettlementCommandText(text: string): boolean {
  return parseGuidedSettlementCommand(text).kind !== "not_command";
}

export function parseGuidedSettlementCommand(
  text: string,
): GuidedSettlementParseResult {
  const lines = text
    .split("\n")
    .map(stripExportPrefix)
    .filter((line) => line.length > 0);

  const looksLikeCommand = lines.some(
    (line) => HEADER_RE.test(line) || line === CLOSE_LINE,
  );
  if (!looksLikeCommand) return { kind: "not_command" };

  let subject: string | null = null;
  let businessDate: string | null = null;
  let headerSeen = false;
  let closeCount = 0;
  const values = new Map<FieldKey, number[]>();

  for (const line of lines) {
    const header = HEADER_RE.exec(line);
    if (header) {
      if (headerSeen) {
        return {
          kind: "invalid",
          message: "พบหัวข้อส่งยอดซ้ำในข้อความเดียวกัน กรุณาส่งทีละรอบ",
        };
      }
      headerSeen = true;
      subject = collapse(header[1]);
      businessDate = parseBusinessDate(header[2]);
      if (!businessDate) {
        return {
          kind: "invalid",
          message: `วันที่ไม่ถูกต้อง: ${header[2]}\nกรุณาใช้รูปแบบ วว/ดด/พ.ศ. เช่น 29/07/2569`,
        };
      }
      continue;
    }

    if (line === CLOSE_LINE) {
      closeCount += 1;
      continue;
    }

    const field = FIELD_LINE_RE.exec(line);
    if (!field) {
      return {
        kind: "invalid",
        message: `ไม่รู้จักบรรทัดนี้ในคำสั่งส่งยอด:\n${line}`,
      };
    }
    const amount = parseCloseMoneyAmount(field[2]);
    if (amount === null) {
      return {
        kind: "invalid",
        message: `จำนวนเงินไม่ถูกต้องที่บรรทัด:\n${line}`,
      };
    }
    const key = FIELDS[field[1] as keyof typeof FIELDS];
    values.set(key, [...(values.get(key) ?? []), amount]);
  }

  if (!headerSeen || !subject || !businessDate) {
    return {
      kind: "invalid",
      message: [
        "รูปแบบหัวข้อส่งยอดไม่ถูกต้อง",
        "ตัวอย่าง:",
        "กี้ วัดทุ่งลานนา ส่งยอด 29/07/2569",
      ].join("\n"),
    };
  }
  if (closeCount === 0) {
    return { kind: "invalid", message: `ต้องมีบรรทัด "${CLOSE_LINE}" ท้ายข้อความ` };
  }
  if (closeCount > 1) {
    return {
      kind: "invalid",
      message: `พบ "${CLOSE_LINE}" ซ้ำ กรุณาส่งคำสั่งส่งยอดเพียงชุดเดียว`,
    };
  }

  for (const [label, key] of Object.entries(FIELDS) as Array<
    [string, FieldKey]
  >) {
    const seen = values.get(key) ?? [];
    if (seen.length === 0) {
      return {
        kind: "invalid",
        message: `ต้องระบุ${label} เช่น\n${label} 0`,
      };
    }
    if (seen.length > 1) {
      return {
        kind: "invalid",
        message: `พบ${label}ซ้ำในข้อความ กรุณาระบุเพียงบรรทัดเดียว`,
      };
    }
  }

  return {
    kind: "ok",
    command: {
      subject,
      businessDate,
      moneyTransfer: values.get("moneyTransfer")![0]!,
      moneyCash: values.get("moneyCash")![0]!,
      expenses: values.get("expenses")![0]!,
      labor: values.get("labor")![0]!,
    },
  };
}

/**
 * The prefilled template, in the EXACT syntax parseGuidedSettlementCommand
 * accepts. The operator edits only the numbers.
 *
 * Every amount starts at 0: settlement_entries and the White Sheet record
 * different money (see docs/guided-operations-end-to-end.md §2.7), and no
 * value is carried across without an existing rule saying it may be.
 */
export function buildSettlementTemplate(
  context: {
    sellerLabel: string;
    marketLabel: string;
    businessDate: string;
  } & Partial<GuidedJourneyContext>,
): string | null {
  const thaiDate = thaiDateFromIso(context.businessDate);
  if (!thaiDate) return null;
  const template = [
    `${context.sellerLabel} ${context.marketLabel} ส่งยอด ${thaiDate}`,
    "ยอดโอน 0",
    "เงินสด 0",
    "ค่าใช้จ่าย 0",
    "ค่าแรง 0",
    CLOSE_LINE,
  ].join("\n");
  // Signed provenance, appended only when the full round context is available;
  // stripped before the parser above ever sees it.
  if (
    !context.sourceId ||
    !context.lineUserId ||
    !context.marketLabelNormalized ||
    !context.sessionGeneration
  ) {
    return template;
  }
  return withGuidedMarker(template, {
    purpose: "settlement",
    sourceId: context.sourceId,
    lineUserId: context.lineUserId,
    marketLabelNormalized: context.marketLabelNormalized,
    businessDate: context.businessDate,
    sessionGeneration: context.sessionGeneration,
  });
}

/** The identity the LINE submission writes, mirroring the Dashboard form. */
export const GUIDED_SETTLEMENT_TIME = "";

export type GuidedSettlementReply = {
  messages: string[];
  saved: boolean;
};

type SubmitFn = typeof submitSettlementEntryForSource;

/**
 * Handle one "ส่งยอด" message end to end.
 *
 * Everything that could bind the money to the wrong round is checked BEFORE the
 * authoritative call, and every refusal writes nothing.
 */
export async function processGuidedSettlementSubmission(input: {
  supabase: AnyClient;
  journey: GuidedJourneyService;
  rounds: GuidedRoundService;
  identity: GuidedMenuIdentity;
  text: string;
  /** Signed provenance marker the message carried, if any. */
  marker?: string | null;
  submit?: SubmitFn;
}): Promise<GuidedSettlementReply> {
  const parsed = parseGuidedSettlementCommand(input.text);
  if (parsed.kind === "not_command") {
    return { messages: [], saved: false };
  }
  if (parsed.kind === "invalid") {
    return { messages: [refusal(parsed.message)], saved: false };
  }
  const command = parsed.command;

  const state = await input.journey.resolve(input.identity);
  if (state.stage === "idle") {
    return { messages: [refusal(GUIDED_MENU_COPY.settlementNoJourney)], saved: false };
  }
  if (state.stage === "capture" || state.stage === "awaiting_confirm") {
    return {
      messages: [refusal(GUIDED_MENU_COPY.settlementProduceUnfinished)],
      saved: false,
    };
  }
  // Produce rows are not proven to exist yet, or provably do not.
  if (state.stage === "finalizing") {
    return { messages: [refusal(GUIDED_MENU_COPY.produceFinalizing)], saved: false };
  }
  if (state.stage === "finalize_failed") {
    return {
      messages: [refusal(GUIDED_MENU_COPY.produceFinalizeFailedShort)],
      saved: false,
    };
  }
  if (state.whiteSheet.status === "not_submitted") {
    return {
      messages: [refusal(GUIDED_MENU_COPY.settlementWhiteSheetMissing)],
      saved: false,
    };
  }

  const context = state.context;
  const expectedSubject = collapse(
    `${context.sellerLabel} ${context.marketLabel}`,
  );
  if (command.subject !== expectedSubject) {
    return { messages: [mismatchMessage(context)], saved: false };
  }
  if (command.businessDate !== context.businessDate) {
    return { messages: [mismatchMessage(context)], saved: false };
  }

  // The same gate the White Sheet and slip open use: source-wide ownership of
  // this market/date, plus the signed marker when the message carries one. A
  // template copied by another member, or edited off this round, stops here.
  const ownership = await resolveGuidedOwnership({
    journey: input.journey,
    identity: input.identity,
    target: {
      marketLabelNormalized: context.marketLabelNormalized,
      businessDate: context.businessDate,
    },
    purpose: "settlement",
    marker: input.marker,
  });
  if (ownership.verdict === "refused") {
    return { messages: [ownership.message], saved: false };
  }
  if (ownership.verdict !== "allowed") {
    // The caller's own journey resolved to this round but the source-wide query
    // cannot confirm it. Never write money into that gap.
    return { messages: [refusal(GUIDED_MENU_COPY.ownershipUnknown)], saved: false };
  }

  // A round whose settlement message already went out is never rewritten from
  // LINE — the same rule the finalizer applies to itself (`already_done`).
  let finalizationQuery = input.supabase
    .from("settlement_finalizations")
    .select("status, message_sent_at")
    .eq("source_id", context.sourceId)
    .eq("business_date", context.businessDate);
  if (context.accountabilityRoundId) finalizationQuery = finalizationQuery.eq("accountability_round_id", context.accountabilityRoundId);
  const { data: finalization } = await finalizationQuery.maybeSingle();
  if (finalization?.status === "sent" || finalization?.message_sent_at) {
    return {
      messages: [refusal(GUIDED_MENU_COPY.settlementAlreadyClosed)],
      saved: false,
    };
  }

  // Writing a second settlement row for the round would make the finalizer
  // ambiguous forever, so a row under a different key is refused, not upserted
  // beside. A row under OUR key is an update — the API's own upsert rule.
  let existingQuery = input.supabase
    .from("settlement_entries")
    .select("settlement_time, staff_name, market_name")
    .eq("source_id", context.sourceId)
    .eq("settlement_date", context.businessDate);
  if (context.accountabilityRoundId) existingQuery = existingQuery.eq("accountability_round_id", context.accountabilityRoundId);
  const { data: existing, error: existingError } = await existingQuery;
  if (existingError) {
    throw new Error(`settlement entry lookup failed: ${existingError.message}`);
  }
  const foreign = (existing ?? []).filter(
    (row: Record<string, unknown>) =>
      (row.settlement_time ?? "") !== GUIDED_SETTLEMENT_TIME ||
      (row.staff_name ?? "") !== context.sellerLabel ||
      (row.market_name ?? "") !== context.marketLabel,
  );
  if (foreign.length > 0) {
    return {
      messages: [refusal(GUIDED_MENU_COPY.settlementAmbiguous)],
      saved: false,
    };
  }

  const submit = input.submit ?? submitSettlementEntryForSource;
  // finalize:false — closing the round stays with "ปิดรอบ", which applies the
  // guided blockers (a non-zero difference among them) before calling the same
  // finalizer. Finalizing here would close the round past those checks.
  const result: SubmitSettlementEntryResult = await submit(
    input.supabase,
    context.sourceId,
    {
      settlement_date: context.businessDate,
      settlement_time: GUIDED_SETTLEMENT_TIME,
      staff_name: context.sellerLabel,
      market_name: context.marketLabel,
      money_transfer: command.moneyTransfer,
      money_cash: command.moneyCash,
      expenses: command.expenses,
      labor: command.labor,
      notes: "",
    },
    { finalize: false, accountabilityRoundId: context.accountabilityRoundId ?? null },
  );

  if (result.status === "blocked") {
    return { messages: [refusal(result.reason)], saved: false };
  }
  if (result.status === "failed") {
    return {
      messages: [refusal(GUIDED_MENU_COPY.settlementWriteFailed)],
      saved: false,
    };
  }

  const receipt = buildSettlementSavedMessage({
    moneyTransfer: command.moneyTransfer,
    moneyCash: command.moneyCash,
    expenses: command.expenses,
    labor: command.labor,
  });

  // "ตรวจยอด" without a button: the reconciliation the operator is told to do
  // next is rendered right here, from the same read-only 3D report. The round is
  // never reported as closed by this step — only "ปิดรอบ" closes it.
  const report = await input.rounds.report(context, true);
  const status = buildRoundStatusMessage({
    sellerLabel: context.sellerLabel,
    marketLabel: context.marketLabel,
    dateThaiShort:
      thaiDateFromIso(context.businessDate) ?? context.businessDate,
    totals: report.totals,
    slipCounts: summarizeSlipStatuses(report.slips),
    blockerLines: [
      ...report.blockers.map((b) => GUIDED_ROUND_BLOCKER_LABEL[b]),
      report.blockers.length === 0
        ? `พิมพ์ "${GUIDED_MENU_COPY.roundCloseCommand}" เพื่อปิดรอบ`
        : `แก้ไขแล้วพิมพ์ "${GUIDED_MENU_COPY.roundCloseCommand}" อีกครั้ง`,
    ],
    closed: false,
  });

  return { messages: [receipt.text, status.text], saved: true };
}

/** Every refusal says plainly that nothing was recorded. */
function refusal(reason: string): string {
  return [reason, "", GUIDED_MENU_COPY.settlementNotRecorded].join("\n");
}

function mismatchMessage(context: GuidedJourneyContext): string {
  const date = thaiDateFromIso(context.businessDate) ?? context.businessDate;
  return [
    "ยอดส่งนี้ไม่ตรงกับรอบที่เปิดอยู่",
    `รอบที่เปิดอยู่: ${context.sellerLabel} — ${context.marketLabel} — ${date}`,
    "กรุณาใช้แบบฟอร์มที่ระบบส่งให้ และแก้เฉพาะตัวเลข",
    "",
    GUIDED_MENU_COPY.settlementNotRecorded,
  ].join("\n");
}
