export type WorkRoundStatus =
  | "open"
  | "produce_complete"
  | "awaiting_settlement"
  | "awaiting_slips"
  | "variance_found"
  | "ready_for_review"
  | "approved"
  | "needs_correction";

export interface WorkRound {
  id:            string;
  source_id:     string;
  business_date: string; // ISO date "YYYY-MM-DD"
  seller_name:   string;
  market_name:   string;
  round_seq:     number;
  status:        WorkRoundStatus;
  source_meta:   Record<string, unknown> | null;
  created_at:    string;
  updated_at:    string;
}

export type SettlementDraftStatus =
  | "pending"
  | "declared"
  | "submitted"
  | "variance_found"
  | "ready_for_review"
  | "approved"
  | "needs_correction";

export type SelectionIntent =
  | "settlement"
  | "produce_attach"
  | "slip"
  | "manual_slip"
  | "close_round"
  | "close_round_confirm";

export interface SelectionCandidate {
  work_round_id: string;
  seller_name:   string;
  market_name:   string;
  round_seq:     number;
  expected_sales: number;
}

export interface WorkRoundSelection {
  id:                     string;
  source_id:              string;
  line_user_id:           string | null;
  business_date:          string;
  intent:                 SelectionIntent;
  candidates:             SelectionCandidate[];
  payload:                Record<string, unknown> | null;
  status:                 "pending" | "resolved" | "expired";
  resolved_work_round_id: string | null;
  created_at:             string;
  expires_at:             string;
  resolved_at:            string | null;
}

export interface SettlementDraft {
  id:                       string;
  work_round_id:            string;
  declared_transfer:        number | null;
  declared_cash:            number | null;
  declared_expenses:        number | null;
  declared_labor:           number | null;
  notes:                    string | null;
  status:                   SettlementDraftStatus;
  declared_by_line_user_id: string | null;
  declared_via:             "line" | "website";
  white_bill_ref:           string | null;
  approved_by:              string | null;
  approved_at:              string | null;
  version:                  number;
  created_at:               string;
  updated_at:               string;
}
