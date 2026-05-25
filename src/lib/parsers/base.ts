import type { LineMessageEvent } from "@/lib/line/types";

export interface ParseResult {
  parserName: string;
  parserVersion: string;
  data: Record<string, unknown>;
}

export interface Parser {
  name: string;
  version: string;
  /** Message types this parser handles, e.g. ['text'] */
  supportedTypes: string[];
  /** Returns true if this parser can handle the given event */
  canHandle(event: LineMessageEvent): boolean;
  /** Parses the event and returns structured data */
  parse(event: LineMessageEvent): Promise<ParseResult>;
}

export abstract class BaseParser implements Parser {
  abstract name: string;
  abstract version: string;
  abstract supportedTypes: string[];

  canHandle(event: LineMessageEvent): boolean {
    return this.supportedTypes.includes(event.message.type);
  }

  abstract parse(event: LineMessageEvent): Promise<ParseResult>;

  protected result(data: Record<string, unknown>): ParseResult {
    return { parserName: this.name, parserVersion: this.version, data };
  }
}
