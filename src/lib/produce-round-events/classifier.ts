import { RE, isReservedFinancialLine } from "@/lib/parsers/weigh-session/regex";
import { classifyHeader } from "@/lib/parsers/work-round-header";
import type { ProduceRoundEventDraft, EventKind } from "./types";

export interface ClassifyInput {
  rawMessageId:    string;
  lineEventId:     string;
  lineTimestampMs: number;
  rawText:         string;
}

// Strips LINE export "HH:MM sender " prefix from a single line.
function normalizeOneLine(line: string): string {
  return line.replace(/^\d{1,2}[:.]\d{2}\s+\S+\s+/, "");
}

type ClassifyResult = {
  kind:         EventKind;
  category:     string | null;
  parsedPayload: Record<string, unknown>;
};

function classifyOneLine(normalized: string): ClassifyResult {
  if (RE.SESSION_END.test(normalized)) {
    return { kind: 'close_marker', category: null, parsedPayload: {} };
  }

  const header = classifyHeader(normalized);
  if (header) {
    const parsedPayload: Record<string, unknown> = {
      headerType: header.type,
      txIntent:   header.txIntent,
    };
    if (header.type === 'explicit') {
      parsedPayload.sellerName = header.sellerName;
      parsedPayload.marketName = header.marketName;
    } else if (header.type === 'seller_only') {
      parsedPayload.sellerName = header.sellerName;
    }
    return { kind: 'header', category: header.txIntent, parsedPayload };
  }

  if (RE.DATE_ONLY.test(normalized)) {
    return { kind: 'date', category: null, parsedPayload: {} };
  }

  if (RE.ITEM.test(normalized) || RE.ITEM_NO_INDEX.test(normalized)) {
    return { kind: 'item', category: null, parsedPayload: {} };
  }

  if (RE.QUANTITY.test(normalized)) {
    return { kind: 'quantity', category: null, parsedPayload: {} };
  }

  return { kind: 'unparsed', category: null, parsedPayload: {} };
}

export function classifyMessage(input: ClassifyInput): ProduceRoundEventDraft[] {
  const physicalLines = input.rawText.split("\n");
  const drafts: Array<ProduceRoundEventDraft & { _unparsed: boolean }> = [];
  let hasProduceContext = false;

  for (let seq = 0; seq < physicalLines.length; seq++) {
    const rawLine   = physicalLines[seq];
    const normalized = normalizeOneLine(rawLine.trim());
    if (!normalized || isReservedFinancialLine(normalized)) continue;

    const { kind, category, parsedPayload } = classifyOneLine(normalized);

    if (kind === 'header' || kind === 'item' || kind === 'quantity' || kind === 'close_marker') {
      hasProduceContext = true;
    }

    drafts.push({
      rawMessageId:    input.rawMessageId,
      lineEventId:     input.lineEventId,
      seqInMessage:    seq,
      lineTimestampMs: input.lineTimestampMs,
      eventKind:       kind,
      eventStatus:     'parsed',
      rawLine:         rawLine.trim(),
      normalizedLine:  normalized,
      category,
      parsedPayload,
      workRoundId:     null,
      _unparsed:       kind === 'unparsed',
    });
  }

  if (!hasProduceContext) return [];

  // Pass 2: flag unparsed lines needs_review when the message has produce context.
  for (const d of drafts) {
    if (d._unparsed) d.eventStatus = 'needs_review';
  }

  return drafts.map(({ _unparsed: _u, ...d }) => d);
}
