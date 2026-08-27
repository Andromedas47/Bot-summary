import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { LineSource } from "@/lib/line/types";
import { getPendingSessionKey } from "@/lib/line/verify";
import {
  PendingSessionService,
  type PendingSession,
} from "@/lib/line/pending-session-service";
import {
  ManualSlipSessionService,
  type ManualSlipSessionRow,
} from "@/lib/line/manual-slip-session-service";
import {
  PhysicalInventorySessionService,
  type PhysicalInventorySessionRow,
} from "@/lib/physical-inventory/session-service";

type Supabase = SupabaseClient<Database>;

export type LegacyDataEntrySessionKind = "produce" | "manual_slip";

export interface DataEntrySessionOwnership {
  physicalInventorySession: PhysicalInventorySessionRow | null;
  legacyProduceSession: PendingSession | null;
  legacyManualSlipSession: ManualSlipSessionRow | null;
  legacyKinds: LegacyDataEntrySessionKind[];
  hasLegacySession: boolean;
  hasOverlap: boolean;
}

export interface DataEntrySessionOwnershipResolver {
  resolve(params: {
    source: LineSource;
    sourceId: string;
    senderLineUserId: string;
  }): Promise<DataEntrySessionOwnership>;
}

type PhysicalInventorySessionFinder = Pick<
  PhysicalInventorySessionService,
  "findOpenSession"
>;

/**
 * Resolves interactive data-entry ownership without changing any legacy
 * persistence behavior. Produce ownership follows its source+sender session
 * key. Manual-slip ownership remains source-scoped because that established
 * router accepts amounts from the single open session for the whole source.
 */
export class DefaultDataEntrySessionOwnershipResolver
implements DataEntrySessionOwnershipResolver {
  private readonly pendingSessions: PendingSessionService;
  private readonly manualSlipSessions: ManualSlipSessionService;
  private readonly physicalInventorySessions: PhysicalInventorySessionFinder;

  constructor(
    supabase: Supabase,
    physicalInventorySessions: PhysicalInventorySessionFinder =
      new PhysicalInventorySessionService(supabase),
  ) {
    this.pendingSessions = new PendingSessionService(supabase);
    this.manualSlipSessions = new ManualSlipSessionService(supabase);
    this.physicalInventorySessions = physicalInventorySessions;
  }

  async resolve(params: {
    source: LineSource;
    sourceId: string;
    senderLineUserId: string;
  }): Promise<DataEntrySessionOwnership> {
    const pendingSessionKey = getPendingSessionKey(params.source);
    const [physicalInventorySession, pendingLookup, manualSlipSession] =
      await Promise.all([
        this.physicalInventorySessions.findOpenSession(
          params.sourceId,
          params.senderLineUserId,
        ),
        pendingSessionKey
          ? this.pendingSessions.lookupActive(pendingSessionKey)
          : Promise.resolve({ session: null, reason: "no_row" } as const),
        this.manualSlipSessions.findOpenSession(params.sourceId),
      ]);

    if (pendingLookup.reason === "db_error") {
      throw new Error(
        `legacy Produce ownership lookup failed: ${pendingLookup.error ?? "unknown error"}`,
      );
    }

    const legacyProduceSession = pendingLookup.session;
    const legacyKinds: LegacyDataEntrySessionKind[] = [];
    if (legacyProduceSession) legacyKinds.push("produce");
    if (manualSlipSession) legacyKinds.push("manual_slip");

    return {
      physicalInventorySession,
      legacyProduceSession,
      legacyManualSlipSession: manualSlipSession,
      legacyKinds,
      hasLegacySession: legacyKinds.length > 0,
      hasOverlap: Boolean(physicalInventorySession) && legacyKinds.length > 0,
    };
  }
}
