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
          id:               string;
          raw_message_id:   string;
          line_user_id:     string | null;
          staff_name:       string;
          sender_name:      string | null;
          transaction_time: string | null;
          session_date:     string | null;
          session_title:    string | null;
          total_items:      number;
          parser_errors:    Json | null;
          created_at:       string;
        };
        Insert: {
          id?:               string;
          raw_message_id:    string;
          line_user_id?:     string | null;
          staff_name:        string;
          sender_name?:      string | null;
          transaction_time?: string | null;
          session_date?:     string | null;
          session_title?:    string | null;
          total_items?:      number;
          parser_errors?:    Json | null;
          created_at?:       string;
        };
        Update: {
          id?:               string;
          raw_message_id?:   string;
          line_user_id?:     string | null;
          staff_name?:       string;
          sender_name?:      string | null;
          transaction_time?: string | null;
          session_date?:     string | null;
          session_title?:    string | null;
          total_items?:      number;
          parser_errors?:    Json | null;
          created_at?:       string;
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
          created_at?:      string;
          updated_at?:      string;
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
    Functions:      { [_ in never]: never };
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
export type SlipEvidenceRow       = Database["public"]["Tables"]["slip_evidences"]["Row"];
export type SlipCheckRow          = Database["public"]["Tables"]["slip_checks"]["Row"];
