export type {
  LineSourceType,
  LineEventType,
  LineMessageType,
  ParseErrorType,
  RawMessageRow,
  WeighEntryRow,
  ParseErrorRow,
} from "./database";

// ─── Domain models (richer than raw DB rows) ─────────────────────────

export interface RawMessage {
  id:            string;
  line_event_id: string;
  destination:   string;
  event_type:    import("./database").LineEventType;
  source_type:   import("./database").LineSourceType;
  source_id:     string;
  user_id:       string | null;
  message_id:    string | null;
  message_type:  import("./database").LineMessageType | null;
  raw_text:      string | null;
  payload:       Record<string, unknown>;
  is_processed:  boolean;
  processed_at:  string | null;
  created_at:    string;
}

export interface WeighEntry {
  id:             string;
  raw_message_id: string;
  line_user_id:   string;
  weight_kg:      number;
  body_fat_pct:   number | null;
  muscle_mass_kg: number | null;
  bmi:            number | null;
  note:           string | null;
  recorded_at:    string;
  created_at:     string;
  /** Joined from raw_messages when requested */
  raw_message?:   RawMessage;
}

export interface ParseError {
  id:             string;
  raw_message_id: string;
  parser_name:    string;
  parser_version: string;
  error_type:     import("./database").ParseErrorType;
  error_message:  string;
  error_detail:   Record<string, unknown> | null;
  created_at:     string;
  /** Joined from raw_messages when requested */
  raw_message?:   RawMessage;
}

// ─── Dashboard aggregates ─────────────────────────────────────────────

export interface DashboardStats {
  total_messages:    number;
  processed_count:   number;
  unprocessed_count: number;
  weigh_entries:     number;
  parse_errors:      number;
  messages_today:    number;
}

export interface UserWeightSummary {
  line_user_id:   string;
  entry_count:    number;
  latest_weight:  number;
  lowest_weight:  number;
  highest_weight: number;
  latest_at:      string;
}

// ─── Utility ─────────────────────────────────────────────────────────

export interface PaginatedResult<T> {
  data:        T[];
  count:       number;
  page:        number;
  pageSize:    number;
  totalPages:  number;
}
