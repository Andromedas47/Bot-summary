export type EventKind   = 'header' | 'date' | 'item' | 'quantity' | 'close_marker' | 'unparsed';
export type EventStatus = 'parsed' | 'needs_review';

export interface ProduceRoundEventDraft {
  rawMessageId:     string;
  lineEventId:      string;
  seqInMessage:     number;
  lineTimestampMs:  number;
  eventKind:        EventKind;
  eventStatus:      EventStatus;
  rawLine:          string;
  normalizedLine:   string;
  /** txIntent from classifyHeader for header events; null for all other kinds. */
  category:         string | null;
  parsedPayload:    Record<string, unknown>;
  workRoundId?:     string | null;
}

export interface ProduceRoundEvent {
  id:               string;
  rawMessageId:     string;
  lineEventId:      string;
  seqInMessage:     number;
  lineTimestampMs:  number;
  eventKind:        EventKind;
  eventStatus:      EventStatus;
  rawLine:          string;
  normalizedLine:   string;
  category:         string | null;
  parsedPayload:    Record<string, unknown>;
  workRoundId:      string | null;
  createdAt:        string;
}
