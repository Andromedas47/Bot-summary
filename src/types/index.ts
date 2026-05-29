export type {
  LineSourceType,
  LineEventType,
  LineMessageType,
  ParseErrorType,
  RawMessageRow,
  ParseErrorRow,
  ProduceSessionRow,
  ProduceItemRow,
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

// ─── Produce weighing domain models ──────────────────────────────────

export interface ProduceSession {
  id:               string;
  raw_message_id:   string;
  line_user_id:     string | null;
  staff_name:       string;
  sender_name:      string | null;
  transaction_time: string | null;
  session_date:     string | null;
  session_title:    string | null;
  total_items:      number;
  parser_errors:    string[] | null;
  created_at:       string;
}

export interface ProduceItem {
  id:               string;
  session_id:       string;
  item_number:      number | null;
  product_name:     string;
  price_per_unit:   number | null;
  quantity:         number | null;
  unit:             string | null;
  section:          string;
  transaction_type: string;
  created_at:       string;
}

// ─── Utility ─────────────────────────────────────────────────────────

export interface PaginatedResult<T> {
  data:        T[];
  count:       number;
  page:        number;
  pageSize:    number;
  totalPages:  number;
}
