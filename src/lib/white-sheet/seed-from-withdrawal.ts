import type { SupabaseClient } from "@supabase/supabase-js";
import { baseTransactionType } from "@/lib/summary/transactions";
import type { Database } from "@/types/database";
import { resolveWithdrawalUnitPriceBaht } from "./calculate";
import { seedCentralPriceFromWithdrawal } from "./pricing";

type Supabase = SupabaseClient<Database>;

/**
 * One persisted produce item as seen after a successful withdrawal write.
 * Only base-type withdrawals (เบิก / เบิกเพิ่ม) seed; returns never do.
 */
export interface PersistedWithdrawalSeedItem {
  product_name: string;
  unit: string | null;
  price_per_unit: number;
  transaction_type: string;
  basis_quantity: number | null;
  basis_price: number | null;
}

/**
 * BR-01 write-path seed: after a valid withdrawal session has been persisted,
 * seed-or-read the central daily price for each withdrawal item. Seeding is
 * idempotent (seed_central_selling_price never overwrites). Returns and
 * damaged returns are skipped. Must not be called from White Sheet reads.
 */
export async function seedCentralPricesFromPersistedWithdrawals(
  supabase: Supabase,
  input: {
    businessDate: string;
    items: readonly PersistedWithdrawalSeedItem[];
  },
): Promise<void> {
  const businessDate = input.businessDate.normalize("NFC").trim();
  if (!businessDate) return;

  for (const item of input.items) {
    if (baseTransactionType(item.transaction_type) !== "เบิก") continue;

    const productName = item.product_name?.normalize("NFC").trim();
    const unit = item.unit?.normalize("NFC").trim();
    if (!productName || !unit) continue;
    if (!Number.isFinite(item.price_per_unit)) continue;

    const priceBaht = resolveWithdrawalUnitPriceBaht({
      unit,
      unitPrice: item.price_per_unit,
      basisQuantity: item.basis_quantity,
    });
    const priceSatang = Math.round(priceBaht * 100);

    await seedCentralPriceFromWithdrawal(supabase, {
      identity: { productName, unit, businessDate },
      priceSatang,
    });
  }
}
