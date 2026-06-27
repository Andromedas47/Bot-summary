import { RE } from "@/lib/parsers/weigh-session/regex";
import { projectEvents } from "./projector";
import type { ProduceRoundEvent } from "./types";

export type ProducePendingKind = "borrow" | "return" | "bad-return" | "append" | "unknown";

function hasExactLine(text: string, exact: string): boolean {
  return text.split("\n").some((l) => l.trim() === exact);
}

function hasBorrowCloseMarker(text: string): boolean {
  return hasExactLine(text, "จบรายการเบิก");
}

function hasGenericCloseMarker(text: string): boolean {
  return hasExactLine(text, "จบรายการ");
}

/** Close marker string accepted by legacy pending-session logic for this kind. */
export function resolveAcceptedCloseMarker(
  kind: ProducePendingKind,
  normalizedText: string,
): string | undefined {
  switch (kind) {
    case "borrow":
      return hasBorrowCloseMarker(normalizedText) ? "จบรายการเบิก" : undefined;
    case "return":
      if (hasExactLine(normalizedText, "จบรายการชั่งคืน")) return "จบรายการชั่งคืน";
      if (hasExactLine(normalizedText, "จบรายการคืน")) return "จบรายการคืน";
      if (hasGenericCloseMarker(normalizedText)) return "จบรายการ";
      return undefined;
    case "bad-return":
      if (hasExactLine(normalizedText, "จบรายการคืนเสีย")) return "จบรายการคืนเสีย";
      if (hasGenericCloseMarker(normalizedText)) return "จบรายการ";
      return undefined;
    case "append":
      return hasExactLine(normalizedText, "จบรายการเบิกเพิ่ม")
        ? "จบรายการเบิกเพิ่ม"
        : undefined;
    case "unknown":
      for (const line of normalizedText.split("\n")) {
        const t = line.trim();
        if (RE.SESSION_END.test(t)) return t;
      }
      return undefined;
  }
}

export interface ParityCheckResult {
  match:           boolean;
  lateEventCount:  number;
  legacyText:      string;
  projectedText:   string;
}

export function compareProduceRoundParity(
  events: ProduceRoundEvent[],
  normalizedLegacyText: string,
  pendingKind: ProducePendingKind,
): ParityCheckResult {
  const closeMarker = resolveAcceptedCloseMarker(pendingKind, normalizedLegacyText);
  const projection = projectEvents(events, closeMarker);
  return {
    match:          projection.reconstructedText === normalizedLegacyText,
    lateEventCount: projection.lateEvents.length,
    legacyText:     normalizedLegacyText,
    projectedText:  projection.reconstructedText,
  };
}
