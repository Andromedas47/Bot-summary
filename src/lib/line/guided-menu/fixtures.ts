/**
 * Local preview fixtures — deterministic produce-style examples.
 * Do not use LLM/fuzzy interpretation. Preview-only; not Production parser output.
 */

import type {
  GuidedMenuActiveSession,
  GuidedMenuBaseTransactionType,
  GuidedMenuSelection,
  PreviewBlockingIssue,
  PreviewParsedItem,
  PreviewReceivedMessage,
  PreviewScenarioId,
} from "./types";
import { PREVIEW_STAFF_LABEL } from "./config";

const FORWARDED_EVENTS: PreviewReceivedMessage[] = [
  {
    eventId: "evt-fwd-1",
    kind: "forwarded",
    rawText: "1แตงโม40บาท\n4ลูก",
  },
  {
    eventId: "evt-fwd-2",
    kind: "forwarded",
    rawText: "2มะละกอ17บาท\n30ลูก",
  },
  {
    eventId: "evt-fwd-3",
    kind: "forwarded",
    rawText: "3แก้วแดง50บาท\n7.6โล",
  },
];

const PASTED_BLOCK: PreviewReceivedMessage = {
  eventId: "evt-paste-1",
  kind: "pasted_block",
  rawText: "4มหาชนก40บาท\n21.7โล",
};

const VALID_ITEMS: PreviewParsedItem[] = [
  {
    itemNumber: 1,
    productName: "แตงโม",
    pricePerUnit: 40,
    quantity: 4,
    unit: "ลูก",
    transactionType: "เบิก",
    rawPreview: "1แตงโม40บาท / 4ลูก",
  },
  {
    itemNumber: 2,
    productName: "มะละกอ",
    pricePerUnit: 17,
    quantity: 30,
    unit: "ลูก",
    transactionType: "เบิก",
    rawPreview: "2มะละกอ17บาท / 30ลูก",
  },
  {
    itemNumber: 3,
    productName: "แก้วแดง",
    pricePerUnit: 50,
    quantity: 7.6,
    unit: "โล",
    transactionType: "เบิก",
    rawPreview: "3แก้วแดง50บาท / 7.6โล",
  },
  {
    itemNumber: 4,
    productName: "มหาชนก",
    pricePerUnit: 40,
    quantity: 21.7,
    unit: "โล",
    transactionType: "เบิก",
    rawPreview: "4มหาชนก40บาท / 21.7โล",
  },
];

const MALFORMED_RAW = "8มหาชนก40บาท\n(ไม่มีจำนวน)";

const BLOCKING_ISSUE: PreviewBlockingIssue = {
  itemNumber: 8,
  rawText: MALFORMED_RAW,
  message: "ไม่พบจำนวนและหน่วย",
};

const PARTIAL_ITEMS: PreviewParsedItem[] = VALID_ITEMS.slice(0, 3);

function withTxType(
  items: PreviewParsedItem[],
  tx: GuidedMenuBaseTransactionType,
): PreviewParsedItem[] {
  return items.map((item) => ({ ...item, transactionType: tx }));
}

export interface PreviewScenarioFixture {
  id: PreviewScenarioId;
  label: string;
  description: string;
  receivedMessages: PreviewReceivedMessage[];
  items: PreviewParsedItem[];
  issues: PreviewBlockingIssue[];
}

export const PREVIEW_SCENARIOS: Record<PreviewScenarioId, PreviewScenarioFixture> = {
  valid: {
    id: "valid",
    label: "ครบถ้วน (valid)",
    description: "Forwarded events + pasted block — all items parse cleanly",
    receivedMessages: [...FORWARDED_EVENTS, PASTED_BLOCK],
    items: VALID_ITEMS,
    issues: [],
  },
  partial_error: {
    id: "partial_error",
    label: "มีจุดต้องตรวจ (blocking)",
    description: "3 valid items + 1 malformed raw block",
    receivedMessages: [
      ...FORWARDED_EVENTS,
      {
        eventId: "evt-bad-1",
        kind: "forwarded",
        rawText: MALFORMED_RAW,
      },
    ],
    items: PARTIAL_ITEMS,
    issues: [BLOCKING_ISSUE],
  },
};

export function emptySessionIntake(): Pick<
  GuidedMenuActiveSession,
  | "receivedMessageCount"
  | "parsedItemCount"
  | "blockingIssueCount"
  | "observedItemCount"
  | "admittedEventCount"
  | "ingestedEventCount"
  | "closeBarrierStatus"
  | "reviewStatus"
  | "receivedMessages"
  | "items"
  | "issues"
  | "persistedSimulated"
> {
  return {
    receivedMessageCount: 0,
    parsedItemCount: 0,
    blockingIssueCount: 0,
    observedItemCount: 0,
    admittedEventCount: 0,
    ingestedEventCount: 0,
    closeBarrierStatus: "idle",
    reviewStatus: "none",
    receivedMessages: [],
    items: [],
    issues: [],
    persistedSimulated: false,
  };
}

export function applyScenarioToSession(
  session: GuidedMenuActiveSession,
  scenarioId: PreviewScenarioId,
): GuidedMenuActiveSession {
  const fixture = PREVIEW_SCENARIOS[scenarioId];
  const items = withTxType(fixture.items, session.baseTransactionType);
  const received = fixture.receivedMessages;
  return {
    ...session,
    receivedMessages: received,
    items,
    issues: fixture.issues,
    receivedMessageCount: received.length,
    parsedItemCount: items.length,
    blockingIssueCount: fixture.issues.length,
    observedItemCount: items.length,
    admittedEventCount: received.length,
    ingestedEventCount: received.length,
    closeBarrierStatus: "idle",
    reviewStatus: fixture.issues.length > 0 ? "blocking" : "valid",
    persistedSimulated: false,
  };
}

/** Close-barrier waiting: admitted ahead of ingested (in-flight forwards). */
export function applyCloseBarrierWaiting(
  session: GuidedMenuActiveSession,
): GuidedMenuActiveSession {
  const admitted = Math.max(session.admittedEventCount, session.receivedMessageCount);
  return {
    ...session,
    closeBarrierStatus: "waiting",
    reviewStatus: "none",
    admittedEventCount: admitted,
    // One in-flight event not yet ingested
    ingestedEventCount: Math.max(0, admitted - 1),
    persistedSimulated: false,
  };
}

/** Barrier matched — ready for review (still not persisted). */
export function applyCloseBarrierMatched(
  session: GuidedMenuActiveSession,
): GuidedMenuActiveSession {
  const admitted = Math.max(session.admittedEventCount, session.receivedMessageCount);
  return {
    ...session,
    closeBarrierStatus: "matched",
    admittedEventCount: admitted,
    ingestedEventCount: admitted,
    reviewStatus: session.blockingIssueCount > 0 ? "blocking" : "valid",
    persistedSimulated: false,
  };
}

export function countsByTransactionType(
  items: PreviewParsedItem[],
): Partial<Record<GuidedMenuBaseTransactionType, number>> {
  const counts: Partial<Record<GuidedMenuBaseTransactionType, number>> = {};
  for (const item of items) {
    counts[item.transactionType] = (counts[item.transactionType] ?? 0) + 1;
  }
  return counts;
}

export function sampleSelection(): GuidedMenuSelection {
  return {
    txCode: "k",
    marketId: "mkt_seven_front",
    dateMode: "today",
    customIsoDate: null,
  };
}

export function sampleActiveSessionBase(
  overrides: Partial<GuidedMenuActiveSession> = {},
): GuidedMenuActiveSession {
  const selection = overrides.selection ?? sampleSelection();
  return {
    selection,
    marketLabel: "หน้าเซเวน",
    businessDateIso: "2026-07-28",
    businessDateThai: "28 กรกฎาคม 2569",
    transactionLabel: "ชั่งคืน",
    baseTransactionType: "คืน",
    staffLabel: PREVIEW_STAFF_LABEL,
    openedAtMs: Date.parse("2026-07-28T08:30:00.000Z"),
    ...emptySessionIntake(),
    ...overrides,
  };
}
