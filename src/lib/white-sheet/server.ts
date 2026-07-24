import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import {
  loadDigitalWhiteSheetSummary,
  type DigitalWhiteSheetCashInput,
  type DigitalWhiteSheetScope,
} from "./load";
import {
  loadWhiteSheetCashEntry,
  saveWhiteSheetCashEntry,
  type WhiteSheetCashEntryIdentity,
  type WhiteSheetCashEntryInput,
  type WhiteSheetCashEntryState,
} from "./persist";
import {
  loadDigitalWhiteSheetPageModel,
  type DigitalWhiteSheetPageModel,
} from "./compose";
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

export async function loadServerWhiteSheetCashEntry(
  identity: WhiteSheetCashEntryIdentity,
): Promise<WhiteSheetCashEntryState> {
  return loadWhiteSheetCashEntry(createServiceClient(), identity);
}

export async function saveServerWhiteSheetCashEntry(
  input: WhiteSheetCashEntryInput,
): Promise<WhiteSheetCashEntryState> {
  return saveWhiteSheetCashEntry(createServiceClient(), input);
}

export async function loadServerDigitalWhiteSheetPageModel(
  scope: DigitalWhiteSheetScope,
): Promise<DigitalWhiteSheetPageModel> {
  return loadDigitalWhiteSheetPageModel(createServiceClient(), scope);
}
