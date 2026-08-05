/**
 * P2B purchase capture parser adapter (plan §9).
 *
 * Imports src/lib/purchases/* and src/lib/purchase-receipts/* only — neither
 * imports this module back.
 */

import {
  assemblePurchaseEvidence,
  createPurchaseTextChunk,
  extractPurchaseCommandsFromTextChunks,
  PURCHASE_CONTRACT_VERSION,
  PURCHASE_INTENDED_WAREHOUSE_MAIN,
  type PurchaseAssemblyResult,
  type PurchaseTextChunk,
  type PurchaseTextChunkInput,
  type LineTextEvidenceMetadata,
} from "@/lib/purchases";
import type { PurchaseReceiptDraftInput, PurchaseReceiptItemInput } from "@/lib/purchase-receipts/types";
import type { PurchaseCaptureFinalizeCandidate } from "./session-service";
import {
  itemHasBlockingIdentity,
  loadIntakeRegistries,
  resolvePriceUnitIdentity,
  resolveProductIdentity,
  resolveQuantityUnitIdentity,
  type IntakeProductRegistryRow,
  type IntakeUnitAliasRegistryRow,
} from "./identity";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;

export type PurchaseCaptureIngestRow = PurchaseCaptureFinalizeCandidate["ingests"][number];

export type PurchaseCaptureParseContext = {
  sourceType: "user" | "group" | "room";
  sourceId: string;
  senderLineUserId: string;
  openedLineEventId: string;
};

export type PurchaseCaptureParsedDocument = {
  assembly: PurchaseAssemblyResult;
  draft: PurchaseReceiptDraftInput | null;
  blockingItemCount: number;
};

export function sortPurchaseCaptureIngests<T extends {
  line_timestamp_ms: number;
  line_event_id: string;
}>(ingests: readonly T[]): T[] {
  return [...ingests].sort((left, right) => {
    if (left.line_timestamp_ms !== right.line_timestamp_ms) {
      return left.line_timestamp_ms - right.line_timestamp_ms;
    }
    return left.line_event_id.localeCompare(right.line_event_id);
  });
}

function ingestEvidence(
  ingest: PurchaseCaptureIngestRow,
  context: PurchaseCaptureParseContext,
): LineTextEvidenceMetadata {
  return {
    source: "LINE_TEXT",
    lineEventId: ingest.line_event_id,
    lineMessageId: ingest.line_message_id ?? null,
    eventTimestampMs: BigInt(ingest.line_timestamp_ms),
    sourceType: context.sourceType,
    sourceId: context.sourceId,
    senderLineUserId: context.senderLineUserId,
  };
}

export function buildPurchaseTextChunks(
  ingests: readonly PurchaseCaptureIngestRow[],
  context: PurchaseCaptureParseContext,
): PurchaseTextChunk[] {
  const sorted = sortPurchaseCaptureIngests(ingests);
  return sorted.map((ingest, index) => {
    const input: PurchaseTextChunkInput = {
      chunkId: ingest.line_event_id,
      chunkOrdinal: index + 1,
      rawText: ingest.raw_text,
      evidence: ingestEvidence(ingest, context),
    };
    return createPurchaseTextChunk(input);
  });
}

export function parsePurchaseCaptureAssembly(
  ingests: readonly PurchaseCaptureIngestRow[],
  context: PurchaseCaptureParseContext,
): PurchaseAssemblyResult {
  const chunks = buildPurchaseTextChunks(ingests, context);
  const commandEnvelopes = extractPurchaseCommandsFromTextChunks(chunks);
  return assemblePurchaseEvidence({
    chunks,
    postbackEvidence: [],
    commandEnvelopes,
  });
}

function mapVat(costs: NonNullable<PurchaseAssemblyResult["evidence"]["costs"]>) {
  if (costs.vat.kind === "NONE") return { kind: "NONE" as const };
  return {
    kind: "AMOUNT" as const,
    satang: costs.vat.amount.satang.toString(),
    includedInItemPrices: costs.vat.includedInItemPrices,
    recoverable: costs.vat.recoverable,
  };
}

function buildDraftItems(
  assembly: PurchaseAssemblyResult,
  products: Map<string, IntakeProductRegistryRow>,
  units: Map<string, IntakeUnitAliasRegistryRow>,
): { items: PurchaseReceiptItemInput[]; blockingItemCount: number } {
  const items: PurchaseReceiptItemInput[] = [];
  let blockingItemCount = 0;

  for (const item of assembly.evidence.items) {
    const product = resolveProductIdentity(item.productText.normalized, products);
    const quantityUnit = resolveQuantityUnitIdentity(item.unitText.normalized, units);
    const priceUnit = resolvePriceUnitIdentity({
      priceUnitText: item.priceUnitText?.normalized ?? null,
      quantityUnit,
      units,
    });

    if (
      itemHasBlockingIdentity({
        productIdentityStatus: product.productIdentityStatus,
        unitIdentityStatus: quantityUnit.unitIdentityStatus,
        priceUnitStatus: priceUnit.priceUnitStatus,
      })
    ) {
      blockingItemCount += 1;
    }

    items.push({
      productKey: product.productKey,
      rawProductText: item.productText.raw,
      productIdentityStatus: product.productIdentityStatus,
      quantity: item.quantity.canonical,
      unitKey: quantityUnit.unitKey,
      rawUnit: item.unitText.raw,
      unitIdentityStatus: quantityUnit.unitIdentityStatus,
      unitCost: item.unitRate?.canonical ?? null,
      priceUnitText: item.priceUnitText?.raw ?? null,
      priceUnitStatus: priceUnit.priceUnitStatus,
      itemNumber: item.itemNumber.toString(),
      sourceEvidence: {
        itemNumberText: item.itemNumberText.raw,
      },
    });
  }

  return { items, blockingItemCount };
}

export function buildPurchaseReceiptDraftInput(params: {
  assembly: PurchaseAssemblyResult;
  context: PurchaseCaptureParseContext;
  products: Map<string, IntakeProductRegistryRow>;
  units: Map<string, IntakeUnitAliasRegistryRow>;
  latestLineEventId?: string | null;
  latestRawMessageId?: string | null;
}): PurchaseReceiptDraftInput | null {
  if (params.assembly.status !== "COMPLETE") return null;

  const header = params.assembly.evidence.header;
  const costs = params.assembly.evidence.costs;
  if (!header || !costs) return null;

  const { items, blockingItemCount } = buildDraftItems(
    params.assembly,
    params.products,
    params.units,
  );

  return {
    documentNamespace: "line-text",
    documentKey: params.context.openedLineEventId,
    contractVersion: PURCHASE_CONTRACT_VERSION,
    businessDate: header.purchaseDate,
    purchaseTime: header.purchaseTime,
    supplierRaw: header.supplierText.raw,
    referenceText: header.referenceText?.raw ?? null,
    freightSatang: costs.freight.satang.toString(),
    handlingSatang: costs.handling.satang.toString(),
    discountSatang: costs.discount.satang.toString(),
    vat: mapVat(costs),
    items,
    sourceType: params.context.sourceType,
    sourceId: params.context.sourceId,
    senderLineUserId: params.context.senderLineUserId,
    sourceLineEventId: params.latestLineEventId ?? null,
    sourceRawMessageId: params.latestRawMessageId ?? null,
    sourceEvidence: {
      intendedWarehouseCode: PURCHASE_INTENDED_WAREHOUSE_MAIN,
      rawTextChunks: params.assembly.evidence.rawTextChunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        chunkOrdinal: chunk.chunkOrdinal,
        rawText: chunk.rawText,
        lineEventId: chunk.evidence.lineEventId,
        lineTimestampMs: chunk.evidence.eventTimestampMs.toString(),
      })),
      blockingItemCount,
    },
    reviewFlags: params.assembly.reviewFlags,
    actor: `line:${params.context.senderLineUserId}`,
  };
}

export async function parsePurchaseCaptureDocument(
  supabase: Supabase,
  ingests: readonly PurchaseCaptureIngestRow[],
  context: PurchaseCaptureParseContext,
): Promise<PurchaseCaptureParsedDocument> {
  const assembly = parsePurchaseCaptureAssembly(ingests, context);
  const registries = await loadIntakeRegistries(supabase);
  const sorted = sortPurchaseCaptureIngests(ingests);
  const latest = sorted[sorted.length - 1];

  const draft = buildPurchaseReceiptDraftInput({
    assembly,
    context,
    products: registries.products,
    units: registries.units,
    latestLineEventId: latest?.line_event_id ?? null,
    latestRawMessageId: latest?.raw_message_id ?? null,
  });

  const blockingItemCount = draft?.sourceEvidence && typeof draft.sourceEvidence === "object"
    && "blockingItemCount" in draft.sourceEvidence
    && typeof draft.sourceEvidence.blockingItemCount === "number"
    ? draft.sourceEvidence.blockingItemCount
    : 0;

  return { assembly, draft, blockingItemCount };
}

export function primaryAssemblyFailReason(assembly: PurchaseAssemblyResult): string {
  const primary = assembly.errors[0];
  if (!primary) return "assembly_incomplete";
  return primary.code;
}
