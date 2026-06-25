export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ─── Enum mirrors (keep in sync with migration enums) ─────────────────
export type LineSourceType   = "user" | "group" | "room";
export type LineEventType    =
  | "message" | "follow" | "unfollow" | "join" | "leave"
  | "memberJoined" | "memberLeft" | "postback" | "beacon"
  | "accountLink" | "unsend" | "videoPlayComplete";
export type LineMessageType  =
  | "text" | "image" | "video" | "audio" | "file"
  | "location" | "sticker" | "imagemap" | "template" | "flex";
export type ParseErrorType   =
  | "format_error" | "validation_error" | "unknown_format"
  | "parser_crash" | "timeout" | "unsupported_type";
export type SlipEvidenceStatus =
  | "RECEIVED" | "DOWNLOAD_FAILED" | "STORAGE_FAILED";
export type SlipCheckStatus =
  | "PROCESSING" | "EXTRACTED" | "PARTIAL_EXTRACTED"
  | "NEED_REVIEW" | "FAILED";
export type SlipType =
  | "BANK_SLIP_QR" | "BANK_SLIP_NO_QR" | "THAI_HELP_THAI"
  | "GWALLET" | "NUMBERS_ONLY" | "WHITE_PAPER" | "UNKNOWN";
export type SlipBatchStatus =
  | "collecting" | "closing" | "processing" | "completed" | "review_needed" | "failed";
export type ManualSlipSessionStatus      = "open" | "closed";
export type SettlementFinalizationStatus = "pending" | "sending" | "sent" | "failed" | "ambiguous";
export type WorkRoundStatus =
  | "open" | "produce_complete" | "awaiting_settlement" | "awaiting_slips"
  | "variance_found" | "ready_for_review" | "approved" | "needs_correction";
export type SettlementDraftStatus =
  | "pending" | "declared" | "submitted" | "variance_found"
  | "ready_for_review" | "approved" | "needs_correction";
export type WorkRoundSelectionIntent =
  | "settlement"
  | "produce_attach"
  | "slip"
  | "manual_slip"
  | "close_round"
  | "close_round_confirm";
export type WorkRoundSelectionStatus  = "pending" | "resolved" | "expired";

// ─── Database schema ──────────────────────────────────────────────────
export interface Database {
  public: {
    Tables: {
      raw_messages: {
        Row: {
          id:             string;
          line_event_id:  string;
          destination:    string;
          event_type:     LineEventType;
          source_type:    LineSourceType;
          source_id:      string;
          user_id:        string | null;
          message_id:     string | null;
          message_type:   LineMessageType | null;
          raw_text:       string | null;
          payload:        Json;
          is_processed:   boolean;
          processed_at:   string | null;
          created_at:     string;
        };
        Insert: {
          id?:            string;
          line_event_id:  string;
          destination:    string;
          event_type:     LineEventType;
          source_type:    LineSourceType;
          source_id:      string;
          user_id?:       string | null;
          message_id?:    string | null;
          message_type?:  LineMessageType | null;
          raw_text?:      string | null;
          payload:        Json;
          is_processed?:  boolean;
          processed_at?:  string | null;
          created_at?:    string;
        };
        Update: {
          id?:            string;
          line_event_id?: string;
          destination?:   string;
          event_type?:    LineEventType;
          source_type?:   LineSourceType;
          source_id?:     string;
          user_id?:       string | null;
          message_id?:    string | null;
          message_type?:  LineMessageType | null;
          raw_text?:      string | null;
          payload?:       Json;
          is_processed?:  boolean;
          processed_at?:  string | null;
          created_at?:    string;
        };
        Relationships: [];
      };

      parse_errors: {
        Row: {
          id:               string;
          raw_message_id:   string;
          parser_name:      string;
          parser_version:   string;
          error_type:       ParseErrorType;
          error_message:    string;
          error_detail:     Json | null;
          created_at:       string;
        };
        Insert: {
          id?:              string;
          raw_message_id:   string;
          parser_name:      string;
          parser_version?:  string;
          error_type:       ParseErrorType;
          error_message:    string;
          error_detail?:    Json | null;
          created_at?:      string;
        };
        Update: {
          id?:              string;
          raw_message_id?:  string;
          parser_name?:     string;
          parser_version?:  string;
          error_type?:      ParseErrorType;
          error_message?:   string;
          error_detail?:    Json | null;
          created_at?:      string;
        };
        Relationships: [];
      };

      produce_sessions: {
        Row: {
          id:                string;
          raw_message_id:    string;
          line_user_id:      string | null;
          staff_name:        string;
          sender_name:       string | null;
          transaction_time:  string | null;
          session_date:      string | null;
          session_title:     string | null;
          total_items:       number;
          parser_errors:     Json | null;
          work_round_id:     string | null;
          is_append_session: boolean;
          created_at:        string;
        };
        Insert: {
          id?:                string;
          raw_message_id:     string;
          line_user_id?:      string | null;
          staff_name:         string;
          sender_name?:       string | null;
          transaction_time?:  string | null;
          session_date?:      string | null;
          session_title?:     string | null;
          total_items?:       number;
          parser_errors?:     Json | null;
          work_round_id?:     string | null;
          is_append_session?: boolean;
          created_at?:        string;
        };
        Update: {
          id?:                string;
          raw_message_id?:    string;
          line_user_id?:      string | null;
          staff_name?:        string;
          sender_name?:       string | null;
          transaction_time?:  string | null;
          session_date?:      string | null;
          session_title?:     string | null;
          total_items?:       number;
          parser_errors?:     Json | null;
          work_round_id?:     string | null;
          is_append_session?: boolean;
          created_at?:        string;
        };
        Relationships: [];
      };

      produce_items: {
        Row: {
          id:               string;
          session_id:       string;
          item_number:      number | null;
          product_name:     string;
          price_per_unit:   number | null;
          quantity:         number | null;
          unit:             string | null;
          section:          string;
          transaction_type: string;
          item_hash:        string | null;
          created_at:       string;
        };
        Insert: {
          id?:               string;
          session_id:        string;
          item_number?:      number | null;
          product_name:      string;
          price_per_unit?:   number | null;
          quantity?:         number | null;
          unit?:             string | null;
          section?:          string;
          transaction_type?: string;
          item_hash?:        string | null;
          created_at?:       string;
        };
        Update: {
          id?:               string;
          session_id?:       string;
          item_number?:      number | null;
          product_name?:     string;
          price_per_unit?:   number | null;
          quantity?:         number | null;
          unit?:             string | null;
          section?:          string;
          transaction_type?: string;
          item_hash?:        string | null;
          created_at?:       string;
        };
        Relationships: [];
      };
      imported_sessions: {
        Row: {
          id:               string;
          session_hash:     string;
          transaction_date: string | null;
          staff_name:       string;
          market_name:      string;
          transaction_type: string;
          raw_text:         string | null;
          created_at:       string;
        };
        Insert: {
          id?:               string;
          session_hash:      string;
          transaction_date?: string | null;
          staff_name?:       string;
          market_name?:      string;
          transaction_type?: string;
          raw_text?:         string | null;
          created_at?:       string;
        };
        Update: never;
        Relationships: [];
      };

      daily_summaries: {
        Row: {
          id:                 string;
          summary_date:       string;
          staff_name:         string;
          market_name:        string;
          borrow_total:       number;
          return_total:       number;
          bad_return_total:   number;
          net_sales:          number;
          transaction_count:  number;
          created_at:         string;
          updated_at:         string;
        };
        Insert: {
          id?:                string;
          summary_date:       string;
          staff_name?:        string;
          market_name?:       string;
          borrow_total?:      number;
          return_total?:      number;
          bad_return_total?:  number;
          net_sales?:         number;
          transaction_count?: number;
          created_at?:        string;
          updated_at?:        string;
        };
        Update: {
          id?:                string;
          summary_date?:      string;
          staff_name?:        string;
          market_name?:       string;
          borrow_total?:      number;
          return_total?:      number;
          bad_return_total?:  number;
          net_sales?:         number;
          transaction_count?: number;
          created_at?:        string;
          updated_at?:        string;
        };
        Relationships: [];
      };

      settlement_entries: {
        Row: {
          id:              string;
          settlement_date: string;
          settlement_time: string;
          staff_name:      string;
          market_name:     string;
          money_transfer:  number;
          money_cash:      number;
          expenses:        number;
          labor:           number;
          notes:           string;
          source_id:       string | null;
          created_at:      string;
          updated_at:      string;
        };
        Insert: {
          id?:              string;
          settlement_date:  string;
          settlement_time?: string;
          staff_name?:      string;
          market_name?:     string;
          money_transfer?:  number;
          money_cash?:      number;
          expenses?:        number;
          labor?:           number;
          notes?:           string;
          source_id?:       string | null;
          created_at?:      string;
          updated_at?:      string;
        };
        Update: {
          id?:              string;
          settlement_date?: string;
          settlement_time?: string;
          staff_name?:      string;
          market_name?:     string;
          money_transfer?:  number;
          money_cash?:      number;
          expenses?:        number;
          labor?:           number;
          notes?:           string;
          source_id?:       string | null;
          created_at?:      string;
          updated_at?:      string;
        };
        Relationships: [];
      };

      manual_slip_sessions: {
        Row: {
          id:                      string;
          source_id:               string;
          business_date:           string;
          market_label:            string | null;
          market_key:              string;
          status:                  ManualSlipSessionStatus;
          opened_at:               string;
          closed_at:               string | null;
          opened_by_line_user_id:  string | null;
          closed_by_line_user_id:  string | null;
          opened_line_message_id:  string | null;
          closed_line_message_id:  string | null;
          work_round_id:           string | null;
        };
        Insert: {
          id?:                      string;
          source_id:                string;
          business_date:            string;
          market_label?:            string | null;
          market_key?:              string;
          status?:                  ManualSlipSessionStatus;
          opened_at?:               string;
          closed_at?:               string | null;
          opened_by_line_user_id?:  string | null;
          closed_by_line_user_id?:  string | null;
          opened_line_message_id?:  string | null;
          closed_line_message_id?:  string | null;
          work_round_id?:           string | null;
        };
        Update: {
          id?:                      string;
          source_id?:               string;
          business_date?:           string;
          market_label?:            string | null;
          market_key?:              string;
          status?:                  ManualSlipSessionStatus;
          opened_at?:               string;
          closed_at?:               string | null;
          opened_by_line_user_id?:  string | null;
          closed_by_line_user_id?:  string | null;
          opened_line_message_id?:  string | null;
          closed_line_message_id?:  string | null;
          work_round_id?:           string | null;
        };
        Relationships: [];
      };

      manual_slip_entries: {
        Row: {
          id:              string;
          session_id:      string;
          sequence_no:     number;
          raw_line:        string;
          amount:          number;
          line_message_id: string;
          line_user_id:    string | null;
          created_at:      string;
        };
        Insert: {
          id?:              string;
          session_id:       string;
          sequence_no:      number;
          raw_line:         string;
          amount:           number;
          line_message_id:  string;
          line_user_id?:    string | null;
          created_at?:      string;
        };
        Update: {
          id?:              string;
          session_id?:      string;
          sequence_no?:     number;
          raw_line?:        string;
          amount?:          number;
          line_message_id?: string;
          line_user_id?:    string | null;
          created_at?:      string;
        };
        Relationships: [];
      };

      transfer_reconciliations: {
        Row: {
          id:                        string;
          source_id:                 string;
          business_date:             string;
          ai_verified_total:         number;
          manual_slip_total:         number;
          checked_slip_total:        number;
          submitted_transfer_total:  number;
          difference:                number;
          matched:                   boolean;
          created_at:                string;
          updated_at:                string;
          work_round_id:             string | null;
        };
        Insert: {
          id?:                        string;
          source_id:                  string;
          business_date:              string;
          ai_verified_total?:         number;
          manual_slip_total?:         number;
          checked_slip_total?:        number;
          submitted_transfer_total?:  number;
          difference?:                number;
          matched?:                   boolean;
          created_at?:                string;
          updated_at?:                string;
          work_round_id?:             string | null;
        };
        Update: {
          id?:                        string;
          source_id?:                 string;
          business_date?:             string;
          ai_verified_total?:         number;
          manual_slip_total?:         number;
          checked_slip_total?:        number;
          submitted_transfer_total?:  number;
          difference?:                number;
          matched?:                   boolean;
          created_at?:                string;
          updated_at?:                string;
          work_round_id?:             string | null;
        };
        Relationships: [];
      };

      slip_batches: {
        Row: {
          id:              string;
          source_id:       string;
          source_type:     string | null;
          sender_id:       string | null;
          status:          SlipBatchStatus;
          first_image_at:  string;
          last_image_at:   string;
          image_count:     number;
          success_count:   number;
          failed_count:    number;
          summary_sent_at: string | null;
          created_at:      string;
          updated_at:      string;
          header_text:     string | null;
          seller_name:     string | null;
          market_name:     string | null;
          slip_date:       string | null;
          batch_type:      string;
          finalized_at:    string | null;
          closing_at:      string | null;
          work_round_id:   string | null;
        };
        Insert: {
          id?:              string;
          source_id:        string;
          source_type?:     string | null;
          sender_id?:       string | null;
          status?:          SlipBatchStatus;
          first_image_at?:  string;
          last_image_at?:   string;
          image_count?:     number;
          success_count?:   number;
          failed_count?:    number;
          summary_sent_at?: string | null;
          created_at?:      string;
          updated_at?:      string;
          header_text?:     string | null;
          seller_name?:     string | null;
          market_name?:     string | null;
          slip_date?:       string | null;
          batch_type?:      string;
          finalized_at?:    string | null;
          closing_at?:      string | null;
          work_round_id?:   string | null;
        };
        Update: {
          id?:              string;
          source_id?:       string;
          source_type?:     string | null;
          sender_id?:       string | null;
          status?:          SlipBatchStatus;
          first_image_at?:  string;
          last_image_at?:   string;
          image_count?:     number;
          success_count?:   number;
          failed_count?:    number;
          summary_sent_at?: string | null;
          created_at?:      string;
          updated_at?:      string;
          header_text?:     string | null;
          seller_name?:     string | null;
          market_name?:     string | null;
          slip_date?:       string | null;
          batch_type?:      string;
          finalized_at?:    string | null;
          closing_at?:      string | null;
          work_round_id?:   string | null;
        };
        Relationships: [];
      };

      slip_evidences: {
        Row: {
          id:              string;
          raw_message_id:  string;
          line_message_id: string;
          source_id:       string;
          source_type:     string;
          line_user_id:    string | null;
          storage_bucket:  string;
          storage_path:    string;
          mime_type:       string | null;
          byte_size:       number | null;
          sha256:          string;
          status:          SlipEvidenceStatus;
          received_at:     string;
          created_at:      string;
          updated_at:      string;
          batch_id:        string | null;
          batch_index:     number | null;
          work_round_id:   string | null;
        };
        Insert: {
          id?:              string;
          raw_message_id:   string;
          line_message_id:  string;
          source_id:        string;
          source_type:      string;
          line_user_id?:    string | null;
          storage_bucket?:  string;
          storage_path:     string;
          mime_type?:       string | null;
          byte_size?:       number | null;
          sha256:           string;
          status?:          SlipEvidenceStatus;
          received_at?:     string;
          created_at?:      string;
          updated_at?:      string;
          batch_id?:        string | null;
          batch_index?:     number | null;
          work_round_id?:   string | null;
        };
        Update: {
          id?:              string;
          raw_message_id?:  string;
          line_message_id?: string;
          source_id?:       string;
          source_type?:     string;
          line_user_id?:    string | null;
          storage_bucket?:  string;
          storage_path?:    string;
          mime_type?:       string | null;
          byte_size?:       number | null;
          sha256?:          string;
          status?:          SlipEvidenceStatus;
          received_at?:     string;
          created_at?:      string;
          updated_at?:      string;
          batch_id?:        string | null;
          batch_index?:     number | null;
          work_round_id?:   string | null;
        };
        Relationships: [];
      };

      settlement_finalizations: {
        Row: {
          id:              string;
          source_id:       string;
          business_date:   string;
          status:          SettlementFinalizationStatus;
          line_retry_key:  string;
          finalized_at:    string;
          claimed_at:      string | null;
          message_sent_at: string | null;
          last_error:      string | null;
          updated_at:      string;
          work_round_id:   string | null;
        };
        Insert: {
          id?:              string;
          source_id:        string;
          business_date:    string;
          status?:          SettlementFinalizationStatus;
          line_retry_key?:  string;
          finalized_at?:    string;
          claimed_at?:      string | null;
          message_sent_at?: string | null;
          last_error?:      string | null;
          updated_at?:      string;
          work_round_id?:   string | null;
        };
        Update: {
          id?:              string;
          source_id?:       string;
          business_date?:   string;
          status?:          SettlementFinalizationStatus;
          line_retry_key?:  string;
          finalized_at?:    string;
          claimed_at?:      string | null;
          message_sent_at?: string | null;
          last_error?:      string | null;
          updated_at?:      string;
          work_round_id?:   string | null;
        };
        Relationships: [];
      };

      slip_checks: {
        Row: {
          id:                    string;
          evidence_id:           string;
          status:                SlipCheckStatus;
          slip_type:             SlipType;
          gross_amount:          number | null;
          discount_amount:       number | null;
          paid_amount:           number | null;
          transfer_amount:       number | null;
          reference_id:          string | null;
          transaction_time:      string | null;
          sender_name:           string | null;
          receiver_name:         string | null;
          receiver_account_tail: string | null;
          confidence:            number | null;
          extracted_json:        Json | null;
          failure_reason:        string | null;
          created_at:            string;
          updated_at:            string;
        };
        Insert: {
          id?:                    string;
          evidence_id:            string;
          status:                 SlipCheckStatus;
          slip_type?:             SlipType;
          gross_amount?:          number | null;
          discount_amount?:       number | null;
          paid_amount?:           number | null;
          transfer_amount?:       number | null;
          reference_id?:          string | null;
          transaction_time?:      string | null;
          sender_name?:           string | null;
          receiver_name?:         string | null;
          receiver_account_tail?: string | null;
          confidence?:            number | null;
          extracted_json?:        Json | null;
          failure_reason?:        string | null;
          created_at?:            string;
          updated_at?:            string;
        };
        Update: {
          id?:                    string;
          evidence_id?:           string;
          status?:                 SlipCheckStatus;
          slip_type?:              SlipType;
          gross_amount?:           number | null;
          discount_amount?:        number | null;
          paid_amount?:            number | null;
          transfer_amount?:        number | null;
          reference_id?:           string | null;
          transaction_time?:       string | null;
          sender_name?:            string | null;
          receiver_name?:          string | null;
          receiver_account_tail?:  string | null;
          confidence?:             number | null;
          extracted_json?:         Json | null;
          failure_reason?:         string | null;
          created_at?:             string;
          updated_at?:             string;
        };
        Relationships: [];
      };
      // ── V2 tables ────────────────────────────────────────────────────────

      line_groups: {
        Row: {
          id:           string;
          source_id:    string;
          display_name: string | null;
          active:       boolean;
          created_at:   string;
          updated_at:   string;
        };
        Insert: {
          id?:           string;
          source_id:     string;
          display_name?: string | null;
          active?:       boolean;
          created_at?:   string;
          updated_at?:   string;
        };
        Update: {
          id?:           string;
          source_id?:    string;
          display_name?: string | null;
          active?:       boolean;
          created_at?:   string;
          updated_at?:   string;
        };
        Relationships: [];
      };

      work_rounds: {
        Row: {
          id:            string;
          source_id:     string;
          business_date: string;
          seller_name:   string;
          market_name:   string;
          round_seq:     number;
          status:        WorkRoundStatus;
          source_meta:   Json | null;
          created_at:    string;
          updated_at:    string;
        };
        Insert: {
          id?:            string;
          source_id:      string;
          business_date:  string;
          seller_name:    string;
          market_name:    string;
          round_seq?:     number;
          status?:        WorkRoundStatus;
          source_meta?:   Json | null;
          created_at?:    string;
          updated_at?:    string;
        };
        Update: {
          id?:            string;
          source_id?:     string;
          business_date?: string;
          seller_name?:   string;
          market_name?:   string;
          round_seq?:     number;
          status?:        WorkRoundStatus;
          source_meta?:   Json | null;
          created_at?:    string;
          updated_at?:    string;
        };
        Relationships: [];
      };

      settlement_drafts: {
        Row: {
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
        };
        Insert: {
          id?:                       string;
          work_round_id:             string;
          declared_transfer?:        number | null;
          declared_cash?:            number | null;
          declared_expenses?:        number | null;
          declared_labor?:           number | null;
          notes?:                    string | null;
          status?:                   SettlementDraftStatus;
          declared_by_line_user_id?: string | null;
          declared_via?:             "line" | "website";
          white_bill_ref?:           string | null;
          approved_by?:              string | null;
          approved_at?:              string | null;
          version?:                  number;
          created_at?:               string;
          updated_at?:               string;
        };
        Update: {
          id?:                       string;
          work_round_id?:            string;
          declared_transfer?:        number | null;
          declared_cash?:            number | null;
          declared_expenses?:        number | null;
          declared_labor?:           number | null;
          notes?:                    string | null;
          status?:                   SettlementDraftStatus;
          declared_by_line_user_id?: string | null;
          declared_via?:             "line" | "website";
          white_bill_ref?:           string | null;
          approved_by?:              string | null;
          approved_at?:              string | null;
          version?:                  number;
          created_at?:               string;
          updated_at?:               string;
        };
        Relationships: [];
      };

      settlement_draft_history: {
        Row: {
          id:            string;
          draft_id:      string;
          changed_by:    string | null;
          change_type:   string;
          previous_data: Json | null;
          new_data:      Json | null;
          changed_at:    string;
        };
        Insert: {
          id?:            string;
          draft_id:       string;
          changed_by?:    string | null;
          change_type:    string;
          previous_data?: Json | null;
          new_data?:      Json | null;
          changed_at?:    string;
        };
        Update: never;
        Relationships: [];
      };

      work_round_selections: {
        Row: {
          id:                     string;
          source_id:              string;
          line_user_id:           string | null;
          business_date:          string;
          intent:                 WorkRoundSelectionIntent;
          candidates:             Json;
          payload:                Json | null;
          status:                 WorkRoundSelectionStatus;
          resolved_work_round_id: string | null;
          created_at:             string;
          expires_at:             string;
          resolved_at:            string | null;
        };
        Insert: {
          id?:                     string;
          source_id:               string;
          line_user_id?:           string | null;
          business_date:           string;
          intent:                  WorkRoundSelectionIntent;
          candidates:              Json;
          payload?:                Json | null;
          status?:                 WorkRoundSelectionStatus;
          resolved_work_round_id?: string | null;
          created_at?:             string;
          expires_at:              string;
          resolved_at?:            string | null;
        };
        Update: {
          id?:                     string;
          source_id?:              string;
          line_user_id?:           string | null;
          business_date?:          string;
          intent?:                 WorkRoundSelectionIntent;
          candidates?:             Json;
          payload?:                Json | null;
          status?:                 WorkRoundSelectionStatus;
          resolved_work_round_id?: string | null;
          created_at?:             string;
          expires_at?:             string;
          resolved_at?:            string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      produce_transactions: {
        Row: {
          id:                 string;
          item_number:        number | null;
          product_name:       string;
          price_per_unit:     number | null;
          quantity:           number | null;
          total_amount:       number | null;
          unit:               string | null;
          section:            string;
          transaction_type:   string;
          item_hash:          string | null;
          item_created_at:    string;
          session_id:         string;
          transaction_date:   string | null;
          transaction_time:   string | null;
          market_name:        string | null;
          staff_name:         string;
          sender_name:        string | null;
          session_created_at: string;
          raw_message_id:     string;
          source_message:     string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Functions: {
      attach_evidence_to_slip_batch: {
        Args: { p_batch_id: string; p_evidence_id: string };
        Returns: number;
      };
      claim_closing_slip_batch: {
        Args: {
          p_batch_id:      string;
          p_quiet_seconds: number;
          p_max_seconds:   number;
        };
        Returns: Array<{
          claimed_id:        string;
          claimed_source_id: string;
          was_timeout:       boolean;
        }>;
      };
      get_or_create_slip_batch: {
        Args: {
          p_source_id:     string;
          p_source_type:   string;
          p_sender_id:     string | null;
          p_quiet_seconds?: number;
        };
        Returns: Array<{ batch_id: string; is_new_batch: boolean }>;
      };
      claim_work_round_selection: {
        Args: {
          p_selection_id: string;
          p_source_id: string;
          p_line_user_id: string;
          p_choice: number;
          p_allowed_statuses: string[];
        };
        Returns: Array<{
          id: string;
          source_id: string;
          line_user_id: string;
          business_date: string;
          intent: WorkRoundSelectionIntent;
          candidates: Json;
          payload: Json | null;
          resolved_work_round_id: string;
        }>;
      };
    };
    CompositeTypes: { [_ in never]: never };
    Enums: {
      line_source_type:   LineSourceType;
      line_event_type:    LineEventType;
      line_message_type:  LineMessageType;
      parse_error_type:   ParseErrorType;
    };
  };
}

// ─── Convenience row aliases ──────────────────────────────────────────
export type RawMessageRow      = Database["public"]["Tables"]["raw_messages"]["Row"];
export type ParseErrorRow      = Database["public"]["Tables"]["parse_errors"]["Row"];
export type ProduceSessionRow  = Database["public"]["Tables"]["produce_sessions"]["Row"];
export type ProduceItemRow     = Database["public"]["Tables"]["produce_items"]["Row"];
export type DailySummaryRow      = Database["public"]["Tables"]["daily_summaries"]["Row"];
export type ImportedSessionRow   = Database["public"]["Tables"]["imported_sessions"]["Row"];
export type SlipEvidenceRow              = Database["public"]["Tables"]["slip_evidences"]["Row"];
export type SlipCheckRow                 = Database["public"]["Tables"]["slip_checks"]["Row"];
export type SlipBatchRow                 = Database["public"]["Tables"]["slip_batches"]["Row"];
export type ManualSlipSessionRow         = Database["public"]["Tables"]["manual_slip_sessions"]["Row"];
export type ManualSlipEntryRow           = Database["public"]["Tables"]["manual_slip_entries"]["Row"];
export type TransferReconciliationRow      = Database["public"]["Tables"]["transfer_reconciliations"]["Row"];
export type SettlementFinalizationRow      = Database["public"]["Tables"]["settlement_finalizations"]["Row"];
export type LineGroupRow                   = Database["public"]["Tables"]["line_groups"]["Row"];
export type WorkRoundRow                   = Database["public"]["Tables"]["work_rounds"]["Row"];
export type SettlementDraftRow             = Database["public"]["Tables"]["settlement_drafts"]["Row"];
export type SettlementDraftHistoryRow      = Database["public"]["Tables"]["settlement_draft_history"]["Row"];
export type WorkRoundSelectionRow          = Database["public"]["Tables"]["work_round_selections"]["Row"];
