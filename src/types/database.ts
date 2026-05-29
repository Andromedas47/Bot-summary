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
          created_at?:       string;
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
          notes?:           string;
          created_at?:      string;
          updated_at?:      string;
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
