import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import {
  loadDigitalWhiteSheetSummary,
  type DigitalWhiteSheetCashInput,
  type DigitalWhiteSheetScope,
} from "./load";
import type { DigitalWhiteSheetSummary } from "./types";

/**
 * Existing server/report code can call this boundary without exposing a mock
 * fixture or creating a new Production-facing route.
 */
export async function loadServerDigitalWhiteSheetSummary(
  scope: DigitalWhiteSheetScope,
  cashInput: DigitalWhiteSheetCashInput,
): Promise<DigitalWhiteSheetSummary> {
  return loadDigitalWhiteSheetSummary(createServiceClient(), scope, cashInput);
}
