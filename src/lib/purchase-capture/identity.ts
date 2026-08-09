/**
 * P2B purchase intake identity resolution (plan §10.3).
 *
 * Exact registry lookup only — NFC/whitespace normalization never implies RESOLVED.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type {
  PurchaseIdentityStatus,
  PurchasePriceUnitStatus,
} from "@/lib/purchase-receipts/types";

type Supabase = SupabaseClient<Database>;

export type IntakeProductRegistryRow = {
  raw_product_text: string;
  product_key: string;
  active: boolean;
};

export type IntakeUnitAliasRegistryRow = {
  raw_unit_text: string;
  unit_key: string;
  active: boolean;
};

export type ResolvedProductIdentity = {
  productKey: string;
  productIdentityStatus: PurchaseIdentityStatus;
};

export type ResolvedUnitIdentity = {
  unitKey: string;
  unitIdentityStatus: PurchaseIdentityStatus;
};

export type ResolvedPriceUnitIdentity = {
  priceUnitStatus: PurchasePriceUnitStatus;
};

export function normalizeRegistryText(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Deterministic placeholder when registry lookup fails (§10.3). */
export function unresolvedPlaceholderKey(kind: "product" | "unit", normalizedText: string): string {
  const token = normalizedText.trim();
  if (!token) return `unresolved:${kind}:empty`;
  return `unresolved:${kind}:${token}`;
}

/**
 * Supplier identity for a document whose supplier is raw staff text.
 *
 * No supplier master exists (0052: "Supplier identity text. No supplier master
 * exists at 0052."), so there is nothing to resolve against and no
 * supplier_identity_status column to report a fallback through. supplier_key is
 * therefore the CANONICAL TEXT FORM of supplier_raw — the same NFC + collapsed
 * whitespace + trim normalization the DB already applies to document_key
 * (purchase_receipt_normalize_document_key) and this module applies to registry
 * lookups. Deterministic and idempotent, so a redelivered or rechecked document
 * derives the identical key. Textual variants of one supplier are MEANT to
 * canonicalize onto the same key; what never collides is two distinct canonical
 * supplier identities.
 *
 * The pair is returned together because purchase_receipts_supplier_pairing
 * requires `(supplier_key IS NULL) = (supplier_raw IS NULL)`: a raw text that
 * normalizes to nothing (e.g. only non-ASCII whitespace, which the parser's
 * ASCII-only trim admits but btrim does not) yields NO supplier at all rather
 * than a half pair the constraint would reject.
 */
export function resolveSupplierIdentity(rawSupplierText: string | null | undefined): {
  supplierKey: string | null;
  supplierRaw: string | null;
} {
  const supplierKey = normalizeRegistryText(rawSupplierText ?? "");
  if (!supplierKey) return { supplierKey: null, supplierRaw: null };
  return { supplierKey, supplierRaw: rawSupplierText ?? null };
}

export async function loadIntakeRegistries(
  supabase: Supabase,
): Promise<{
  products: Map<string, IntakeProductRegistryRow>;
  units: Map<string, IntakeUnitAliasRegistryRow>;
}> {
  const [productResult, unitResult] = await Promise.all([
    supabase.from("purchase_intake_product_registry").select("raw_product_text, product_key, active"),
    supabase.from("purchase_intake_unit_alias_registry").select("raw_unit_text, unit_key, active"),
  ]);
  if (productResult.error) {
    throw new Error(`product registry load failed: ${productResult.error.message}`);
  }
  if (unitResult.error) {
    throw new Error(`unit registry load failed: ${unitResult.error.message}`);
  }

  const products = new Map<string, IntakeProductRegistryRow>();
  for (const row of productResult.data ?? []) {
    products.set(row.raw_product_text, row);
  }

  const units = new Map<string, IntakeUnitAliasRegistryRow>();
  for (const row of unitResult.data ?? []) {
    units.set(row.raw_unit_text, row);
  }

  return { products, units };
}

export function resolveProductIdentity(
  rawProductText: string,
  products: Map<string, IntakeProductRegistryRow>,
): ResolvedProductIdentity {
  const normalized = normalizeRegistryText(rawProductText);
  const row = products.get(normalized);
  if (row?.active) {
    return { productKey: row.product_key, productIdentityStatus: "RESOLVED" };
  }
  return {
    productKey: unresolvedPlaceholderKey("product", normalized),
    productIdentityStatus: "UNRESOLVED",
  };
}

export function resolveQuantityUnitIdentity(
  rawUnit: string,
  units: Map<string, IntakeUnitAliasRegistryRow>,
): ResolvedUnitIdentity {
  const normalized = normalizeRegistryText(rawUnit);
  const row = units.get(normalized);
  if (row?.active) {
    return { unitKey: row.unit_key, unitIdentityStatus: "RESOLVED" };
  }
  return {
    unitKey: unresolvedPlaceholderKey("unit", normalized),
    unitIdentityStatus: "UNRESOLVED",
  };
}

export function resolvePriceUnitIdentity(params: {
  priceUnitText: string | null;
  quantityUnit: ResolvedUnitIdentity;
  units: Map<string, IntakeUnitAliasRegistryRow>;
}): ResolvedPriceUnitIdentity {
  if (params.priceUnitText == null) {
    return { priceUnitStatus: "NOT_APPLICABLE" };
  }

  const normalized = normalizeRegistryText(params.priceUnitText);
  const row = params.units.get(normalized);
  if (!row?.active) {
    return { priceUnitStatus: "UNRESOLVED" };
  }

  if (
    params.quantityUnit.unitIdentityStatus === "RESOLVED"
    && row.unit_key !== params.quantityUnit.unitKey
  ) {
    return { priceUnitStatus: "UNRESOLVED" };
  }

  return { priceUnitStatus: "RESOLVED" };
}

export function itemHasBlockingIdentity(params: {
  productIdentityStatus: PurchaseIdentityStatus;
  unitIdentityStatus: PurchaseIdentityStatus;
  priceUnitStatus: PurchasePriceUnitStatus;
}): boolean {
  if (params.productIdentityStatus !== "RESOLVED") return true;
  if (params.unitIdentityStatus !== "RESOLVED") return true;
  if (params.priceUnitStatus === "NOT_APPLICABLE" || params.priceUnitStatus === "RESOLVED") {
    return false;
  }
  return true;
}
