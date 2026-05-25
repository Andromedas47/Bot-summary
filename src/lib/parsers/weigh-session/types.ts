export type ProduceUnit = "โล" | "ลูก" | "กล่อง";

export interface WeighSessionItem {
  item_number:    number;
  product_name:   string;
  price_per_unit: number;
  quantity:       number | null;
  unit:           ProduceUnit | null;
  section:        string;
}

export interface WeighSession {
  /** ISO 8601 date converted from Thai Buddhist year, e.g. "2026-05-25" */
  date:          string | null;
  staff_name:    string;
  session_title: string | null;
  items:         WeighSessionItem[];
  /** Lines that could not be parsed (for diagnostics) */
  parse_errors:  string[];
}
