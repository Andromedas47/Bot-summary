export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      line_raw_events: {
        Row: {
          id: string;
          event_id: string;
          destination: string;
          event_type: string;
          message_type: string | null;
          source_type: string;
          source_id: string;
          user_id: string | null;
          payload: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          event_id: string;
          destination: string;
          event_type: string;
          message_type?: string | null;
          source_type: string;
          source_id: string;
          user_id?: string | null;
          payload: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          event_id?: string;
          destination?: string;
          event_type?: string;
          message_type?: string | null;
          source_type?: string;
          source_id?: string;
          user_id?: string | null;
          payload?: Json;
          created_at?: string;
        };
      };
      parsed_messages: {
        Row: {
          id: string;
          raw_event_id: string;
          parser_name: string;
          parser_version: string;
          parsed_data: Json;
          status: string;
          error_message: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          raw_event_id: string;
          parser_name: string;
          parser_version: string;
          parsed_data: Json;
          status?: string;
          error_message?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          raw_event_id?: string;
          parser_name?: string;
          parser_version?: string;
          parsed_data?: Json;
          status?: string;
          error_message?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
  };
}
