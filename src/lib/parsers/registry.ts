import type { Parser } from "./base";
import type { LineMessageEvent } from "@/lib/line/types";

/**
 * Central registry for all message parsers.
 * Register parsers here; the webhook handler picks the first matching one.
 */
class ParserRegistry {
  private parsers: Parser[] = [];

  register(parser: Parser): void {
    this.parsers.push(parser);
  }

  findParser(event: LineMessageEvent): Parser | null {
    return this.parsers.find((p) => p.canHandle(event)) ?? null;
  }

  getAll(): Parser[] {
    return [...this.parsers];
  }
}

export const parserRegistry = new ParserRegistry();

import { WeighSessionParser } from "./weigh-session/parser";
parserRegistry.register(new WeighSessionParser());
