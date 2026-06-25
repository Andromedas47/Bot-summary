export type ProduceUnit     = "โล" | "ลูก" | "กล่อง" | "แพค" | "กำ" | "มัด" | "ถุง" | "หัว" | "หวี" | "เครือ" | "เข่ง" | "พวง" | "ลัง";
export type TransactionType = "เบิก" | "เบิกเพิ่ม" | "คืน" | "คืนเสีย" | "ชั่งคืนเพิ่ม";

export interface WeighSessionItem {
  item_number:      number;
  product_name:     string;
  price_per_unit:   number;
  quantity:         number | null;
  unit:             ProduceUnit | null;
  section:          string;
  transaction_type: TransactionType;
}

export interface WeighSessionReviewIssue {
  item_number: number | null;
  line:          string;
  reason:        "unparsed" | "ambiguous_price" | "missing_quantity" | "index_gap";
}

export interface WeighSession {
  /** ISO 8601 date converted from Thai Buddhist year, e.g. "2026-05-25" */
  date:             string | null;
  /** คนขาย — from "พี่ดำ-วิหาร เบิก" header, or falls back to sender_name */
  staff_name:       string;
  /** ผู้ส่ง LINE — from TIME_PREFIX sender field */
  sender_name:      string | null;
  /** "HH:MM" from first TIME_PREFIX in the message */
  transaction_time: string | null;
  session_title:    string | null;
  items:            WeighSessionItem[];
  parse_errors:     string[];
  review_issues:    WeighSessionReviewIssue[];
}
