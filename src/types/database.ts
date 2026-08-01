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
export type ManualWhiteSheetNoteSessionStatus = "open" | "closed" | "cancelled";
export type SettlementFinalizationStatus = "pending" | "sending" | "sent" | "failed" | "ambiguous";
export type ProduceNotificationStatus = "pending" | "sending" | "sent" | "failed";

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
          id:                      string;
          raw_message_id:          string;
          line_user_id:            string | null;
          staff_name:              string;
          sender_name:             string | null;
          transaction_time:        string | null;
          session_date:            string | null;
          session_title:           string | null;
          total_items:             number;
          parser_errors:           Json | null;
          created_at:              string;
          finalization_started_at: string | null;
          finalized_at:            string | null;
          session_kind:            string;
          declared_transaction_type: string | null;
          ingest_idempotency_key:  string | null;
          ingest_source:           string | null;
          voided_at:               string | null;
          voided_by:               string | null;
          void_reason:             string | null;
          replacement_session_id:  string | null;
        };
        Insert: {
          id?:                      string;
          raw_message_id:           string;
          line_user_id?:            string | null;
          staff_name:               string;
          sender_name?:             string | null;
          transaction_time?:        string | null;
          session_date?:            string | null;
          session_title?:           string | null;
          total_items?:             number;
          parser_errors?:           Json | null;
          created_at?:              string;
          finalization_started_at?: string | null;
          finalized_at?:            string | null;
          session_kind?:            string;
          declared_transaction_type?: string | null;
          ingest_idempotency_key?:  string | null;
          ingest_source?:           string | null;
          voided_at?:               string | null;
          voided_by?:               string | null;
          void_reason?:             string | null;
          replacement_session_id?:  string | null;
        };
        Update: {
          id?:                      string;
          raw_message_id?:          string;
          line_user_id?:            string | null;
          staff_name?:              string;
          sender_name?:             string | null;
          transaction_time?:        string | null;
          session_date?:            string | null;
          session_title?:           string | null;
          total_items?:             number;
          parser_errors?:           Json | null;
          created_at?:              string;
          finalization_started_at?: string | null;
          finalized_at?:            string | null;
          session_kind?:            string;
          declared_transaction_type?: string | null;
          ingest_idempotency_key?:  string | null;
          ingest_source?:           string | null;
          voided_at?:               string | null;
          voided_by?:               string | null;
          void_reason?:             string | null;
          replacement_session_id?:  string | null;
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
          basis_quantity:   number | null;
          basis_unit:       string | null;
          basis_price:      number | null;
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
          basis_quantity?:   number | null;
          basis_unit?:       string | null;
          basis_price?:      number | null;
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
          basis_quantity?:   number | null;
          basis_unit?:       string | null;
          basis_price?:      number | null;
        };
        Relationships: [];
      };

      produce_session_notifications: {
        Row: {
          id:                                string;
          produce_session_id:                string;
          session_key:                       string;
          session_generation:                string;
          source_id:                         string;
          correlation_id:                    string;
          notification_status:               ProduceNotificationStatus;
          notification_attempt_count:        number;
          notification_cycle_attempt_count:  number;
          notification_retryable:            boolean;
          last_notification_error:           string | null;
          last_notification_attempt_at:      string | null;
          notification_sent_at:              string | null;
          notification_payload:              string;
          line_retry_key:                    string;
          next_notification_attempt_at:      string | null;
          sending_started_at:                string | null;
          resend_count:                      number;
          last_resend_requested_at:          string | null;
          created_at:                        string;
          updated_at:                        string;
        };
        Insert: {
          id?:                                string;
          produce_session_id:                 string;
          session_key:                        string;
          session_generation:                 string;
          source_id:                          string;
          correlation_id:                     string;
          notification_status?:               ProduceNotificationStatus;
          notification_attempt_count?:        number;
          notification_cycle_attempt_count?:  number;
          notification_retryable?:            boolean;
          last_notification_error?:           string | null;
          last_notification_attempt_at?:      string | null;
          notification_sent_at?:              string | null;
          notification_payload:               string;
          line_retry_key?:                    string;
          next_notification_attempt_at?:      string | null;
          sending_started_at?:                string | null;
          resend_count?:                      number;
          last_resend_requested_at?:          string | null;
          created_at?:                        string;
          updated_at?:                        string;
        };
        Update: {
          id?:                                string;
          produce_session_id?:                string;
          session_key?:                       string;
          session_generation?:                string;
          source_id?:                         string;
          correlation_id?:                    string;
          notification_status?:               ProduceNotificationStatus;
          notification_attempt_count?:        number;
          notification_cycle_attempt_count?:  number;
          notification_retryable?:            boolean;
          last_notification_error?:           string | null;
          last_notification_attempt_at?:      string | null;
          notification_sent_at?:              string | null;
          notification_payload?:              string;
          line_retry_key?:                    string;
          next_notification_attempt_at?:      string | null;
          sending_started_at?:                string | null;
          resend_count?:                      number;
          last_resend_requested_at?:          string | null;
          created_at?:                        string;
          updated_at?:                        string;
        };
        Relationships: [];
      };

      produce_notification_attempts: {
        Row: {
          id:                    string;
          notification_id:       string;
          attempt_number:        number;
          cycle_attempt_number:  number;
          correlation_id:        string;
          transition_from:       string;
          transition_to:         string;
          attempted_at:          string;
          completed_at:          string | null;
          http_status:           number | null;
          retry_after_ms:        number | null;
          error:                 string | null;
        };
        Insert: {
          id?:                    string;
          notification_id:        string;
          attempt_number:         number;
          cycle_attempt_number:   number;
          correlation_id:         string;
          transition_from:        string;
          transition_to?:         string;
          attempted_at?:          string;
          completed_at?:          string | null;
          http_status?:           number | null;
          retry_after_ms?:        number | null;
          error?:                 string | null;
        };
        Update: {
          id?:                    string;
          notification_id?:       string;
          attempt_number?:        number;
          cycle_attempt_number?:  number;
          correlation_id?:        string;
          transition_from?:       string;
          transition_to?:         string;
          attempted_at?:          string;
          completed_at?:          string | null;
          http_status?:           number | null;
          retry_after_ms?:        number | null;
          error?:                 string | null;
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
        };
        Relationships: [];
      };

      manual_white_sheet_note_sessions: {
        Row: {
          id:                       string;
          source_id:                string;
          market_label:             string;
          market_label_normalized:  string;
          business_date:            string;
          status:                   ManualWhiteSheetNoteSessionStatus;
          labor:                    number | null;
          location_fee:             number | null;
          bag:                      number | null;
          snack:                    number | null;
          other_amount:             number | null;
          other_note:               string | null;
          actual_cash:              number | null;
          opened_by_line_user_id:   string | null;
          opened_line_event_id:     string;
          closed_by_line_user_id:   string | null;
          closed_line_event_id:     string | null;
          created_at:               string;
          updated_at:               string;
          closed_at:                string | null;
        };
        Insert: {
          id?:                      string;
          source_id:                string;
          market_label:             string;
          market_label_normalized:  string;
          business_date:            string;
          status?:                  ManualWhiteSheetNoteSessionStatus;
          labor?:                   number | null;
          location_fee?:            number | null;
          bag?:                     number | null;
          snack?:                   number | null;
          other_amount?:            number | null;
          other_note?:              string | null;
          actual_cash?:             number | null;
          opened_by_line_user_id?:  string | null;
          opened_line_event_id:     string;
          closed_by_line_user_id?:  string | null;
          closed_line_event_id?:    string | null;
          created_at?:              string;
          updated_at?:              string;
          closed_at?:               string | null;
        };
        Update: {
          id?:                      string;
          source_id?:               string;
          market_label?:            string;
          market_label_normalized?: string;
          business_date?:           string;
          status?:                  ManualWhiteSheetNoteSessionStatus;
          labor?:                   number | null;
          location_fee?:            number | null;
          bag?:                     number | null;
          snack?:                   number | null;
          other_amount?:            number | null;
          other_note?:              string | null;
          actual_cash?:             number | null;
          opened_by_line_user_id?:  string | null;
          opened_line_event_id?:    string;
          closed_by_line_user_id?:  string | null;
          closed_line_event_id?:    string | null;
          created_at?:              string;
          updated_at?:              string;
          closed_at?:               string | null;
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
        };
        Relationships: [];
      };

      digital_white_sheet_cash_entries: {
        Row: {
          id:                      string;
          source_id:               string;
          market_label_normalized: string;
          business_date:           string;
          labor:                   number;
          location_fee:            number;
          bag:                     number;
          snack:                   number;
          other:                   number;
          other_note:              string | null;
          actual_cash_submitted:   number;
          created_at:              string;
          updated_at:              string;
          finalized_at:            string | null;
          finalized_by:            string | null;
        };
        Insert: {
          id?:                      string;
          source_id:                string;
          market_label_normalized:  string;
          business_date:            string;
          labor?:                   number;
          location_fee?:            number;
          bag?:                     number;
          snack?:                   number;
          other?:                   number;
          other_note?:              string | null;
          actual_cash_submitted?:   number;
          created_at?:              string;
          updated_at?:              string;
          finalized_at?:            string | null;
          finalized_by?:            string | null;
        };
        Update: {
          id?:                      string;
          source_id?:               string;
          market_label_normalized?: string;
          business_date?:           string;
          labor?:                   number;
          location_fee?:            number;
          bag?:                     number;
          snack?:                   number;
          other?:                   number;
          other_note?:              string | null;
          actual_cash_submitted?:   number;
          created_at?:              string;
          updated_at?:              string;
          finalized_at?:            string | null;
          finalized_by?:            string | null;
        };
        Relationships: [];
      };

      white_sheet_lifecycle_events: {
        Row: {
          id:                      string;
          source_id:               string;
          market_label_normalized: string;
          business_date:           string;
          event:                   "finalized" | "reopened";
          actor:                   string;
          reason:                  string | null;
          created_at:              string;
        };
        Insert: {
          id?:                      string;
          source_id:                string;
          market_label_normalized:  string;
          business_date:            string;
          event:                    "finalized" | "reopened";
          actor:                    string;
          reason?:                  string | null;
          created_at?:              string;
        };
        Update: {
          id?:                      string;
          source_id?:               string;
          market_label_normalized?: string;
          business_date?:           string;
          event?:                   "finalized" | "reopened";
          actor?:                   string;
          reason?:                  string | null;
          created_at?:              string;
        };
        Relationships: [];
      };

      central_selling_prices: {
        Row: {
          id:            string;
          product_key:   string;
          unit_key:      string;
          business_date: string;
          price_satang:  number;
          set_by:        string;
          set_reason:    string | null;
          created_at:    string;
          updated_at:    string;
        };
        Insert: {
          id?:            string;
          product_key:    string;
          unit_key:       string;
          business_date:  string;
          price_satang:   number;
          set_by:         string;
          set_reason?:    string | null;
          created_at?:    string;
          updated_at?:    string;
        };
        Update: {
          id?:            string;
          product_key?:   string;
          unit_key?:      string;
          business_date?: string;
          price_satang?:  number;
          set_by?:        string;
          set_reason?:    string | null;
          created_at?:    string;
          updated_at?:    string;
        };
        Relationships: [];
      };

      central_selling_price_corrections: {
        Row: {
          id:                    string;
          price_id:              string;
          product_key:           string;
          unit_key:              string;
          business_date:         string;
          previous_price_satang: number | null;
          new_price_satang:      number;
          actor:                 string;
          reason:                string | null;
          created_at:            string;
        };
        Insert: {
          id?:                    string;
          price_id:               string;
          product_key:            string;
          unit_key:               string;
          business_date:          string;
          previous_price_satang?: number | null;
          new_price_satang:       number;
          actor:                  string;
          reason?:                string | null;
          created_at?:            string;
        };
        Update: {
          id?:                    string;
          price_id?:              string;
          product_key?:           string;
          unit_key?:              string;
          business_date?:         string;
          previous_price_satang?: number | null;
          new_price_satang?:      number;
          actor?:                 string;
          reason?:                string | null;
          created_at?:            string;
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
          market_label:            string | null;
          market_label_normalized: string | null;
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
          market_label?:            string | null;
          market_label_normalized?: string | null;
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
          market_label?:            string | null;
          market_label_normalized?: string | null;
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

      slip_check_reference_resolutions: {
        Row: {
          id:           string;
          check_id:     string;
          reference_id: string;
          actor:        string;
          created_at:   string;
        };
        Insert: {
          id?:           string;
          check_id:      string;
          reference_id:  string;
          actor:         string;
          created_at?:   string;
        };
        Update: {
          id?:           string;
          check_id?:     string;
          reference_id?: string;
          actor?:        string;
          created_at?:   string;
        };
        Relationships: [];
      };

      physical_inventory_sessions: {
        Row: {
          id:                    string;
          source_type:           "user" | "group" | "room";
          source_id:             string;
          sender_line_user_id:   string;
          opened_line_event_id:  string;
          session_generation:    string;
          business_date:         string | null;
          warehouse_code:        string;
          status:                "open" | "closing" | "finalized" | "failed_closed" | "voided";
          parser_version:        string | null;
          opened_at:             string;
          close_requested_at:    string | null;
          close_event_timestamp_ms: number | null;
          close_quiet_until:     string | null;
          close_deadline_at:     string | null;
          closed_at:             string | null;
          failed_closed_at:      string | null;
          fail_reason:           string | null;
          ingest_revision:       number;
          snapshot_id:           string | null;
          header_raw_message_id: string | null;
          close_raw_message_id:  string | null;
          close_line_event_id:   string | null;
          warnings:              Json;
          created_at:            string;
          updated_at:            string;
        };
        Insert: {
          id?:                    string;
          source_type:            "user" | "group" | "room";
          source_id:              string;
          sender_line_user_id:    string;
          opened_line_event_id:   string;
          session_generation?:    string;
          business_date?:         string | null;
          warehouse_code?:        string;
          status?:                "open" | "closing" | "finalized" | "failed_closed" | "voided";
          parser_version?:        string | null;
          opened_at?:             string;
          close_requested_at?:    string | null;
          close_event_timestamp_ms?: number | null;
          close_quiet_until?:     string | null;
          close_deadline_at?:     string | null;
          closed_at?:             string | null;
          failed_closed_at?:      string | null;
          fail_reason?:           string | null;
          ingest_revision?:       number;
          snapshot_id?:           string | null;
          header_raw_message_id?: string | null;
          close_raw_message_id?:  string | null;
          close_line_event_id?:   string | null;
          warnings?:              Json;
          created_at?:            string;
          updated_at?:            string;
        };
        Update: {
          id?:                    string;
          source_type?:           "user" | "group" | "room";
          source_id?:             string;
          sender_line_user_id?:   string;
          opened_line_event_id?:  string;
          session_generation?:    string;
          business_date?:         string | null;
          warehouse_code?:        string;
          status?:                "open" | "closing" | "finalized" | "failed_closed" | "voided";
          parser_version?:        string | null;
          opened_at?:             string;
          close_requested_at?:    string | null;
          close_event_timestamp_ms?: number | null;
          close_quiet_until?:     string | null;
          close_deadline_at?:     string | null;
          closed_at?:             string | null;
          failed_closed_at?:      string | null;
          fail_reason?:           string | null;
          ingest_revision?:       number;
          snapshot_id?:           string | null;
          header_raw_message_id?: string | null;
          close_raw_message_id?:  string | null;
          close_line_event_id?:   string | null;
          warnings?:              Json;
          created_at?:            string;
          updated_at?:            string;
        };
        Relationships: [];
      };

      physical_inventory_session_ingests: {
        Row: {
          id:              string;
          session_id:      string;
          line_event_id:   string;
          line_message_id: string | null;
          line_timestamp_ms: number;
          raw_message_id:  string | null;
          kind:            "header" | "item" | "close" | "other";
          raw_text:        string;
          ingest_revision: number;
          created_at:      string;
        };
        Insert: {
          id?:              string;
          session_id:       string;
          line_event_id:    string;
          line_message_id?: string | null;
          line_timestamp_ms: number;
          raw_message_id?:  string | null;
          kind:             "header" | "item" | "close" | "other";
          raw_text:         string;
          ingest_revision:  number;
          created_at?:      string;
        };
        Update: {
          id?:              string;
          session_id?:      string;
          line_event_id?:   string;
          line_message_id?: string | null;
          line_timestamp_ms?: number;
          raw_message_id?:  string | null;
          kind?:            "header" | "item" | "close" | "other";
          raw_text?:        string;
          ingest_revision?: number;
          created_at?:      string;
        };
        Relationships: [];
      };

      physical_inventory_snapshots: {
        Row: {
          id:                        string;
          session_id:                string;
          warehouse_code:            string;
          source_type:               string;
          source_id:                 string;
          sender_line_user_id:       string;
          business_date:             string;
          counted_at:                string;
          parser_version:            string;
          accepted_normalized_count: number;
          accepted_raw_count:        number;
          rejected_count:            number;
          item_count:                number;
          warnings:                  Json;
          status:                    "finalized" | "voided" | "superseded";
          ingest_idempotency_key:    string;
          finalized_ingest_revision: number;
          finalized_ingest_hash:     string;
          finalized_at:              string;
          voided_at:                 string | null;
          voided_by:                 string | null;
          void_reason:               string | null;
          replacement_snapshot_id:   string | null;
          created_at:                string;
        };
        Insert: {
          id?:                        string;
          session_id:                 string;
          warehouse_code?:            string;
          source_type:                string;
          source_id:                  string;
          sender_line_user_id:        string;
          business_date:              string;
          counted_at?:                string;
          parser_version:             string;
          accepted_normalized_count?: number;
          accepted_raw_count?:        number;
          rejected_count?:            number;
          item_count?:                number;
          warnings?:                  Json;
          status?:                    "finalized" | "voided" | "superseded";
          ingest_idempotency_key:     string;
          finalized_ingest_revision:  number;
          finalized_ingest_hash:      string;
          finalized_at?:              string;
          voided_at?:                 string | null;
          voided_by?:                 string | null;
          void_reason?:               string | null;
          replacement_snapshot_id?:   string | null;
          created_at?:                string;
        };
        Update: {
          id?:                        string;
          session_id?:                string;
          warehouse_code?:            string;
          source_type?:               string;
          source_id?:                 string;
          sender_line_user_id?:       string;
          business_date?:             string;
          counted_at?:                string;
          parser_version?:            string;
          accepted_normalized_count?: number;
          accepted_raw_count?:        number;
          rejected_count?:            number;
          item_count?:                number;
          warnings?:                  Json;
          status?:                    "finalized" | "voided" | "superseded";
          ingest_idempotency_key?:    string;
          finalized_ingest_revision?: number;
          finalized_ingest_hash?:     string;
          finalized_at?:              string;
          voided_at?:                 string | null;
          voided_by?:                 string | null;
          void_reason?:               string | null;
          replacement_snapshot_id?:   string | null;
          created_at?:                string;
        };
        Relationships: [];
      };

      physical_inventory_items: {
        Row: {
          id:                      string;
          snapshot_id:             string;
          item_ordinal:            number;
          staff_sequence:          number | null;
          raw_text:                string;
          raw_product_description: string | null;
          normalized_product:      string | null;
          quantity:                number | null;
          raw_unit:                string | null;
          normalized_unit:         string | null;
          resolution_status:       "ACCEPTED_NORMALIZED" | "ACCEPTED_RAW" | "REJECTED";
          reason:                  string | null;
          created_at:              string;
        };
        Insert: {
          id?:                      string;
          snapshot_id:              string;
          item_ordinal:             number;
          staff_sequence?:          number | null;
          raw_text:                 string;
          raw_product_description?: string | null;
          normalized_product?:      string | null;
          quantity?:                number | null;
          raw_unit?:                string | null;
          normalized_unit?:         string | null;
          resolution_status:        "ACCEPTED_NORMALIZED" | "ACCEPTED_RAW" | "REJECTED";
          reason?:                  string | null;
          created_at?:              string;
        };
        Update: {
          id?:                      string;
          snapshot_id?:             string;
          item_ordinal?:            number;
          staff_sequence?:          number | null;
          raw_text?:                string;
          raw_product_description?: string | null;
          normalized_product?:      string | null;
          quantity?:                number | null;
          raw_unit?:                string | null;
          normalized_unit?:         string | null;
          resolution_status?:       "ACCEPTED_NORMALIZED" | "ACCEPTED_RAW" | "REJECTED";
          reason?:                  string | null;
          created_at?:              string;
        };
        Relationships: [];
      };

      physical_inventory_lifecycle_events: {
        Row: {
          id:          string;
          session_id:  string;
          snapshot_id: string | null;
          event:       "finalized" | "failed_closed" | "voided" | "superseded";
          actor:       string | null;
          detail:      Json;
          created_at:  string;
        };
        Insert: {
          id?:          string;
          session_id:   string;
          snapshot_id?: string | null;
          event:        "finalized" | "failed_closed" | "voided" | "superseded";
          actor?:       string | null;
          detail?:      Json;
          created_at?:  string;
        };
        Update: {
          id?:          string;
          session_id?:  string;
          snapshot_id?: string | null;
          event?:       "finalized" | "failed_closed" | "voided" | "superseded";
          actor?:       string | null;
          detail?:      Json;
          created_at?:  string;
        };
        Relationships: [];
      };
      purchase_receipts: {
        Row: {
          id:                     string;
          // Document identity. NOT a delivery event id.
          document_namespace:     string;
          document_key:           string;
          status:                 "draft" | "confirmed" | "void";
          contract_version:       string;
          business_date:          string;
          purchase_time:          string | null;
          supplier_key:           string | null;
          supplier_raw:           string | null;
          supplier_ref:           string | null;
          reference_text:         string | null;
          intended_warehouse_code: "MAIN";
          // bigint: carried as lossless strings, never JS numbers.
          freight_satang:         string;
          handling_satang:        string;
          discount_satang:        string;
          vat_kind:               "NONE" | "AMOUNT";
          vat_satang:             string | null;
          vat_included_in_item_prices: boolean | null;
          vat_recoverable:        boolean | null;
          item_count:             number;
          source_type:            LineSourceType | null;
          source_id:              string | null;
          sender_line_user_id:    string | null;
          source_line_event_id:   string | null;
          source_raw_message_id:  string | null;
          source_evidence:        Json;
          review_flags:           Json;
          draft_revision:         string;
          confirmation_key:       string | null;
          confirmation_payload:   Json | null;
          confirmation_contract_version: string | null;
          confirmation_canonical_form:   string | null;
          confirmation_hash_algorithm:   string | null;
          confirmation_hash:      string | null;
          confirmed_at:           string | null;
          confirmed_by:           string | null;
          supersedes_receipt_id:    string | null;
          superseded_by_receipt_id: string | null;
          posting_locked_at:      string | null;
          posting_locked_by:      string | null;
          voided_at:              string | null;
          voided_by:              string | null;
          void_reason:            string | null;
          created_at:             string;
          updated_at:             string;
        };
        // Mutation is RPC-only: service_role holds SELECT and nothing else.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      purchase_receipt_items: {
        Row: {
          id:                 string;
          receipt_id:         string;
          item_ordinal:       number;
          // bigint, unbounded in the source document: lossless string.
          item_number:        string | null;
          product_key:        string;
          raw_product_text:   string;
          product_identity_status: "RESOLVED" | "UNRESOLVED";
          // numeric(18,6) / numeric(18,4) arrive as strings: never a JS number.
          quantity:           string;
          unit_key:           string;
          raw_unit:           string;
          unit_identity_status: "RESOLVED" | "UNRESOLVED";
          unit_cost:          string | null;
          price_unit_text:    string | null;
          price_unit_status:  "NOT_APPLICABLE" | "RESOLVED" | "UNRESOLVED";
          // Exact numeric (the Slice A envelope exceeds bigint): lossless string.
          line_amount_satang: string | null;
          source_evidence:    Json;
          created_at:         string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      purchase_receipt_lifecycle_events: {
        Row: {
          // bigint identity: lossless string.
          id:         string;
          receipt_id: string;
          event:      "drafted" | "confirmed" | "voided" | "superseded" | "posting_locked";
          actor:      string | null;
          detail:     Json;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      purchase_receipt_document_namespaces: {
        Row: {
          namespace:   string;
          description: string;
          created_at:  string;
        };
        Insert: never;
        Update: never;
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
          basis_quantity:     number | null;
          basis_unit:         string | null;
          basis_price:        number | null;
          pricing_mode:       string;
          base_transaction_type: string;
          session_kind:       string;
          declared_transaction_type: string | null;
          voided_at:          string | null;
          voided_by:          string | null;
          void_reason:        string | null;
          replacement_session_id: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      produce_transactions_all: {
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
          basis_quantity:     number | null;
          basis_unit:         string | null;
          basis_price:        number | null;
          pricing_mode:       string;
          base_transaction_type: string;
          session_kind:       string;
          declared_transaction_type: string | null;
          voided_at:          string | null;
          voided_by:          string | null;
          void_reason:        string | null;
          replacement_session_id: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Functions: {
      close_manual_white_sheet_note_session: {
        Args: {
          p_session_id:             string;
          p_source_id:              string;
          p_closed_by_line_user_id: string | null;
          p_closed_line_event_id:   string;
        };
        Returns: {
          outcome:    "closed" | "already_closed" | "already_cancelled" | "empty" | "finalized" | "not_found";
          session:    Database["public"]["Tables"]["manual_white_sheet_note_sessions"]["Row"] | null;
          cash_entry: Database["public"]["Tables"]["digital_white_sheet_cash_entries"]["Row"] | null;
        };
      };
      submit_manual_white_sheet_note_all_in_one: {
        Args: {
          p_source_id:               string;
          p_market_label:            string;
          p_market_label_normalized: string;
          p_business_date:           string;
          p_labor:                   number | null;
          p_location_fee:            number | null;
          p_bag:                     number | null;
          p_snack:                   number | null;
          p_other_amount:            number | null;
          p_other_note:              string | null;
          p_actual_cash:             number | null;
          p_opened_by_line_user_id:  string | null;
          p_opened_line_event_id:    string;
          p_closed_by_line_user_id:  string | null;
          p_closed_line_event_id:    string;
        };
        Returns: {
          outcome:    "closed" | "already_closed" | "open_conflict" | "empty" | "finalized";
          session:    Database["public"]["Tables"]["manual_white_sheet_note_sessions"]["Row"] | null;
          cash_entry: Database["public"]["Tables"]["digital_white_sheet_cash_entries"]["Row"] | null;
        };
      };
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
      set_central_selling_price: {
        Args: {
          p_product_key:    string;
          p_unit_key:       string;
          p_business_date:  string;
          p_price_satang:   number;
          p_actor:          string;
          p_reason:         string | null;
        };
        Returns: {
          id:            string;
          product_key:   string;
          unit_key:      string;
          business_date: string;
          price_satang:  number;
          set_by:        string;
          set_reason:    string | null;
          created_at:    string;
          updated_at:    string;
        };
      };
      seed_central_selling_price: {
        Args: {
          p_product_key:    string;
          p_unit_key:       string;
          p_business_date:  string;
          p_price_satang:   number;
          p_actor:          string;
          p_reason:         string | null;
        };
        Returns: {
          id:            string;
          product_key:   string;
          unit_key:      string;
          business_date: string;
          price_satang:  number;
          set_by:        string;
          set_reason:    string | null;
          created_at:    string;
          updated_at:    string;
        };
      };
      finalize_white_sheet_cash_entry: {
        Args: {
          p_source_id:               string;
          p_market_label_normalized: string;
          p_business_date:           string;
          p_actor:                   string;
        };
        Returns: {
          id:                      string;
          source_id:               string;
          market_label_normalized: string;
          business_date:           string;
          labor:                   number;
          location_fee:            number;
          bag:                     number;
          snack:                   number;
          other:                   number;
          other_note:              string | null;
          actual_cash_submitted:   number;
          created_at:              string;
          updated_at:              string;
          finalized_at:            string | null;
          finalized_by:            string | null;
        };
      };
      reopen_white_sheet_cash_entry: {
        Args: {
          p_source_id:               string;
          p_market_label_normalized: string;
          p_business_date:           string;
          p_actor:                   string;
          p_reason:                  string;
        };
        Returns: {
          id:                      string;
          source_id:               string;
          market_label_normalized: string;
          business_date:           string;
          labor:                   number;
          location_fee:            number;
          bag:                     number;
          snack:                   number;
          other:                   number;
          other_note:              string | null;
          actual_cash_submitted:   number;
          created_at:              string;
          updated_at:              string;
          finalized_at:            string | null;
          finalized_by:            string | null;
        };
      };
      open_physical_inventory_session: {
        Args: {
          p_source_type:          string;
          p_source_id:            string;
          p_sender_line_user_id:  string;
          p_opened_line_event_id: string;
          p_line_timestamp_ms:    number;
          p_raw_text:             string;
          p_line_message_id?:     string | null;
          p_raw_message_id?:      string | null;
          p_business_date?:       string | null;
          p_parser_version?:      string | null;
        };
        Returns: Json;
      };
      admit_physical_inventory_event: {
        Args: {
          p_session_id:          string;
          p_expected_generation: string;
          p_line_event_id:       string;
          p_line_timestamp_ms:   number;
          p_kind:                string;
          p_raw_text:            string;
          p_line_message_id?:    string | null;
          p_raw_message_id?:     string | null;
        };
        Returns: Json;
      };
      get_physical_inventory_finalize_candidate: {
        Args: {
          p_session_id:          string;
          p_expected_generation: string;
        };
        Returns: Json;
      };
      finalize_physical_inventory_session: {
        Args: {
          p_session_id:               string;
          p_expected_generation:      string;
          p_expected_ingest_revision: number;
          p_expected_ingest_hash:     string;
          p_business_date:            string | null;
          p_parser_version:           string;
          p_warnings:                 Json;
          p_items:                    Json;
          p_fail_closed:              boolean;
          p_fail_reason?:             string | null;
        };
        Returns: Json;
      };
      physical_inventory_compute_ingest_set_hash: {
        Args: { p_session_id: string };
        Returns: string;
      };
      upsert_purchase_receipt_draft: {
        Args: {
          p_document_namespace:   string;
          p_document_key:         string;
          p_contract_version:     string;
          p_business_date:        string;
          p_items:                Json;
          p_purchase_time?:       string | null;
          p_supplier_key?:        string | null;
          p_supplier_raw?:        string | null;
          p_supplier_ref?:        string | null;
          p_reference_text?:      string | null;
          // bigint arguments are sent as lossless strings.
          p_freight_satang?:      string;
          p_handling_satang?:     string;
          p_discount_satang?:     string;
          p_vat_kind?:            "NONE" | "AMOUNT";
          p_vat_satang?:          string | null;
          p_vat_included_in_item_prices?: boolean | null;
          p_vat_recoverable?:     boolean | null;
          p_source_type?:         LineSourceType | null;
          p_source_id?:           string | null;
          p_sender_line_user_id?: string | null;
          p_source_line_event_id?: string | null;
          p_source_raw_message_id?: string | null;
          p_source_evidence?:     Json;
          p_review_flags?:        Json;
          p_supersedes_receipt_id?: string | null;
          p_actor?:               string | null;
        };
        Returns: Json;
      };
      confirm_purchase_receipt: {
        Args: {
          p_receipt_id:              string;
          p_confirmation_key:        string;
          p_expected_draft_revision?: string | null;
          p_actor?:                  string | null;
        };
        Returns: Json;
      };
      void_purchase_receipt: {
        Args: {
          p_receipt_id: string;
          p_reason:     string;
          p_actor?:     string | null;
        };
        Returns: Json;
      };
      lock_purchase_receipt_for_posting: {
        Args: { p_receipt_id: string; p_locked_by: string };
        Returns: Json;
      };
      get_purchase_receipt_confirmation: {
        Args: { p_receipt_id: string };
        Returns: Json;
      };
      purchase_receipt_build_confirmation_payload: {
        Args: { p_receipt_id: string };
        Returns: Json;
      };
      // ─── P2C inventory movement ledger (migration 0053) ───────────────
      post_purchase_receipt_inventory_movement: {
        Args: { p_receipt_id: string; p_actor?: string | null };
        Returns: Json;
      };
      reverse_inventory_movement: {
        Args: {
          p_movement_id:  string;
          p_reversal_key: string;
          p_reason:       string;
          p_actor?:       string | null;
        };
        Returns: Json;
      };
      get_inventory_balances: {
        Args: {
          p_location_code?: string | null;
          p_product_key?:   string | null;
          p_unit_key?:      string | null;
          p_include_zero?:  boolean;
        };
        Returns: Json;
      };
      purchase_receipt_canonical_json: {
        Args: { p_value: Json };
        Returns: string;
      };
      purchase_receipt_normalize_document_key: {
        Args: { p_key: string };
        Returns: string;
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
export type ManualWhiteSheetNoteSessionRow = Database["public"]["Tables"]["manual_white_sheet_note_sessions"]["Row"];
export type ManualSlipEntryRow           = Database["public"]["Tables"]["manual_slip_entries"]["Row"];
export type TransferReconciliationRow      = Database["public"]["Tables"]["transfer_reconciliations"]["Row"];
export type SettlementFinalizationRow      = Database["public"]["Tables"]["settlement_finalizations"]["Row"];
export type DigitalWhiteSheetCashEntryRow  = Database["public"]["Tables"]["digital_white_sheet_cash_entries"]["Row"];
export type PhysicalInventorySessionRow    = Database["public"]["Tables"]["physical_inventory_sessions"]["Row"];
export type PhysicalInventorySnapshotRow   = Database["public"]["Tables"]["physical_inventory_snapshots"]["Row"];
export type PhysicalInventoryItemRow       = Database["public"]["Tables"]["physical_inventory_items"]["Row"];
export type PurchaseReceiptRow             = Database["public"]["Tables"]["purchase_receipts"]["Row"];
export type PurchaseReceiptItemRow         = Database["public"]["Tables"]["purchase_receipt_items"]["Row"];
export type PurchaseReceiptLifecycleEventRow = Database["public"]["Tables"]["purchase_receipt_lifecycle_events"]["Row"];
export type PurchaseReceiptDocumentNamespaceRow = Database["public"]["Tables"]["purchase_receipt_document_namespaces"]["Row"];
