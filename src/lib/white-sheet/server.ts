import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import {
  loadDigitalWhiteSheetSummary,
  type DigitalWhiteSheetCashInput,
  type DigitalWhiteSheetScope,
} from "./load";
import {
  finalizeWhiteSheetCashEntry,
  loadWhiteSheetCashEntry,
  reopenWhiteSheetCashEntry,
  saveWhiteSheetCashEntry,
  type WhiteSheetCashEntryIdentity,
  type WhiteSheetCashEntryInput,
  type WhiteSheetCashEntryState,
} from "./persist";
import {
  loadDigitalWhiteSheetPageModel,
  type DigitalWhiteSheetPageModel,
} from "./compose";
import {
  getCentralPrice,
  getCentralPriceHistory,
  setCentralPrice,
  type CentralPriceCorrection,
  type CentralPriceIdentity,
  type CentralPriceRecord,
} from "./pricing";
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

/**
 * BR-06 admin-only lifecycle transitions. Callers (API routes) must call
 * requireAdminActor() against a request-scoped session client BEFORE calling
 * these — the actor id passed here is trusted as already-authorized.
 */
export async function finalizeServerWhiteSheetCashEntry(
  identity: WhiteSheetCashEntryIdentity,
  actorId: string,
): Promise<WhiteSheetCashEntryState> {
  return finalizeWhiteSheetCashEntry(createServiceClient(), identity, actorId);
}

export async function reopenServerWhiteSheetCashEntry(
  identity: WhiteSheetCashEntryIdentity,
  actorId: string,
  reason: string,
): Promise<WhiteSheetCashEntryState> {
  return reopenWhiteSheetCashEntry(createServiceClient(), identity, actorId, reason);
}

/** Central price reads are not privileged — any authenticated session may read. */
export async function getServerCentralPrice(
  identity: CentralPriceIdentity,
): Promise<CentralPriceRecord | null> {
  return getCentralPrice(createServiceClient(), identity);
}

export async function getServerCentralPriceHistory(
  identity: CentralPriceIdentity,
): Promise<CentralPriceCorrection[]> {
  return getCentralPriceHistory(createServiceClient(), identity);
}

/** BR-01/BR-04 admin-only. Caller must call requireAdminActor() first. */
export async function setServerCentralPrice(input: {
  identity: CentralPriceIdentity;
  priceBaht: number;
  actor: string;
  reason?: string | null;
}): Promise<CentralPriceRecord> {
  return setCentralPrice(createServiceClient(), input);
}
