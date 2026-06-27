import type { ProduceRoundEvent } from "./types";

export interface ProjectedLine {
  event:        ProduceRoundEvent;
  isAfterClose: boolean;
}

export interface ProjectionResult {
  orderedLines:      ProjectedLine[];
  /** Index into orderedLines of the accepted close_marker event, or null. */
  closeBoundaryIdx:  number | null;
  /** Events that arrived after the accepted close marker. */
  lateEvents:        ProduceRoundEvent[];
  /** needs_review events with no work_round_id when the message has attached events. */
  orphanedEvents:    ProduceRoundEvent[];
  /** normalizedLine values joined up to and including the close marker. */
  reconstructedText: string;
}

function sortDeterministic(events: ProduceRoundEvent[]): ProduceRoundEvent[] {
  return [...events].sort((a, b) => {
    if (a.lineTimestampMs !== b.lineTimestampMs) return a.lineTimestampMs - b.lineTimestampMs;
    if (a.seqInMessage    !== b.seqInMessage)    return a.seqInMessage    - b.seqInMessage;
    return a.lineEventId < b.lineEventId ? -1 : a.lineEventId > b.lineEventId ? 1 : 0;
  });
}

/**
 * Projects produce-round events into an ordered narrative.
 * Sort order: line_timestamp_ms → seq_in_message → line_event_id (never created_at).
 *
 * @param acceptedCloseMarker - normalizedLine of the valid close event for this session kind.
 *   e.g. "จบรายการเบิก" or "จบรายการเบิกเพิ่ม". Omit if close boundary is unknown.
 */
export function projectEvents(
  events: ProduceRoundEvent[],
  acceptedCloseMarker?: string,
): ProjectionResult {
  const sorted = sortDeterministic(events);

  let closeIdx: number | null = null;
  if (acceptedCloseMarker != null) {
    for (let i = 0; i < sorted.length; i++) {
      if (
        sorted[i].eventKind    === 'close_marker' &&
        sorted[i].normalizedLine === acceptedCloseMarker
      ) {
        closeIdx = i;
        break;
      }
    }
  }

  const orderedLines: ProjectedLine[] = sorted.map((e, i) => ({
    event:        e,
    isAfterClose: closeIdx !== null && i > closeIdx,
  }));

  const lateEvents = orderedLines.filter((l) => l.isAfterClose).map((l) => l.event);

  const hasAttachedEvent = sorted.some((e) => e.workRoundId != null);
  const orphanedEvents   = hasAttachedEvent
    ? sorted.filter((e) => e.workRoundId == null && e.eventStatus === 'needs_review')
    : [];

  const reconstructedText = orderedLines
    .filter((l) => !l.isAfterClose)
    .map((l) => l.event.normalizedLine)
    .join("\n");

  return { orderedLines, closeBoundaryIdx: closeIdx, lateEvents, orphanedEvents, reconstructedText };
}
