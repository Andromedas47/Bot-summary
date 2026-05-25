import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineMessageEvent } from "@/lib/line/types";
import type { Database } from "@/types/database";

export interface ParseResult {
  parserName:    string;
  parserVersion: string;
  data:          Record<string, unknown>;
  /** Writes the parsed data to the correct table */
  persist(
    supabase: SupabaseClient<Database>,
    rawMessageId: string
  ): Promise<void>;
}

export interface Parser {
  name:           string;
  version:        string;
  supportedTypes: string[];
  canHandle(event: LineMessageEvent): boolean;
  parse(event: LineMessageEvent): Promise<ParseResult>;
}

export abstract class BaseParser implements Parser {
  abstract name:           string;
  abstract version:        string;
  abstract supportedTypes: string[];

  canHandle(event: LineMessageEvent): boolean {
    return this.supportedTypes.includes(event.message.type);
  }

  abstract parse(event: LineMessageEvent): Promise<ParseResult>;
}
