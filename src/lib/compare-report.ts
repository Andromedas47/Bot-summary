import { calculateSettlementTotals, calculateYodSong, transactionBucket } from "@/lib/summary/transactions";

export const PRODUCT_ALIASES: Readonly<Record<string, string>> = {
  "เพิ่มถั่วพู": "ถั่วพู",
  "ถั่วพํ": "ถั่วพู",
  "เพิ่มกะหล่ำปี": "กะหล่ำปี",
  "กวางตุ้งดอกเหลือง": "กวางตุ้งดอก",
  "เครืองต้มยำ": "เครื่องต้มยำ",
  "ดอกกะกล่ำ": "ดอกกะหล่ำ",
  "ใบมังลีก": "ใบมังลัก",
  "ใบตั่งโอ้": "ใบตั้งโอ้",
  "พริดป่น": "พริกป่น",
  "เหดออริจิ": "เห็ดออริจิ",
  "เหดออริจี": "เห็ดออริจิ",
  "สลัดคอต": "ผักสลัดคอต",
};

export interface CompareSourceRow {
  id: string;
  product_name: string;
  quantity: number | null;
  unit: string | null;
  price_per_unit: number | null;
  total_amount: number | null;
  transaction_type: string;
  base_transaction_type?: string | null;
  is_corrected?: boolean | null;
  correction_id?: string | null;
  correction_reason_detail?: string | null;
  original_product_name?: string | null;
  original_quantity?: number | null;
  original_price_amount?: number | null;
  original_price_quantity?: number | null;
  original_total_amount?: number | null;
}

export interface QuantityAmount {
  quantities: Record<string, number>;
  amount: number;
}

export interface CompareAuditItem {
  transactionId: string;
  correctionId: string;
  productName: string;
  transactionType: string;
  originalQuantity: number | null;
  quantity: number | null;
  unit: string;
  originalPriceAmount: number | null;
  originalPriceQuantity: number | null;
  pricePerUnit: number | null;
  originalAmount: number | null;
  amount: number;
  reason: string;
}

export interface CompareProductRow {
  canonicalName: string;
  sourceNames: string[];
  prices: number[];
  issued: QuantityAmount;
  returned: QuantityAmount;
  damaged: QuantityAmount;
  remaining: QuantityAmount;
  transactions: CompareSourceRow[];
}

export interface CompareSettlementInput {
  money_transfer: number;
  money_cash: number;
  expenses: number;
  labor: number;
}

export interface CompareSummary {
  issuedAmount: number;
  returnedAmount: number;
  damagedAmount: number;
  expectedAmount: number;
  settlementAmount: number | null;
  difference: number | null;
  settlementStatus: "recorded" | "pending";
}

export interface CompareReport {
  rows: CompareProductRow[];
  summary: CompareSummary;
  corrections: CompareAuditItem[];
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function canonicalProductName(name: string, datasetNames: ReadonlySet<string>): string {
  const cleaned = cleanName(name);
  const explicit = PRODUCT_ALIASES[cleaned];
  if (explicit) return explicit;

  if (cleaned.startsWith("เพิ่ม") && cleaned.length > 5) {
    const candidate = cleanName(cleaned.slice("เพิ่ม".length));
    const catalogued = Object.values(PRODUCT_ALIASES).includes(candidate);
    if (datasetNames.has(candidate) || catalogued) return candidate;
  }
  return cleaned;
}

function emptyBucket(): QuantityAmount {
  return { quantities: {}, amount: 0 };
}

function add(bucket: QuantityAmount, row: CompareSourceRow): void {
  const unit = row.unit?.trim() || "ไม่ระบุหน่วย";
  bucket.quantities[unit] = (bucket.quantities[unit] ?? 0) + (row.quantity ?? 0);
  bucket.amount += row.total_amount ?? 0;
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function buildCompareReport(
  sourceRows: readonly CompareSourceRow[],
  settlement: CompareSettlementInput | null,
): CompareReport {
  const datasetNames = new Set(sourceRows.map((row) => cleanName(row.product_name)));
  const products = new Map<string, CompareProductRow>();
  const corrections: CompareAuditItem[] = [];

  for (const source of sourceRows) {
    const row = { ...source };
    const bucketName = transactionBucket(row.base_transaction_type || row.transaction_type);
    if (!bucketName) continue;
    const canonicalName = canonicalProductName(row.product_name, datasetNames);
    let product = products.get(canonicalName);
    if (!product) {
      product = {
        canonicalName,
        sourceNames: [],
        prices: [],
        issued: emptyBucket(),
        returned: emptyBucket(),
        damaged: emptyBucket(),
        remaining: emptyBucket(),
        transactions: [],
      };
      products.set(canonicalName, product);
    }
    if (!product.sourceNames.includes(row.product_name)) product.sourceNames.push(row.product_name);
    if (row.price_per_unit != null && !product.prices.includes(row.price_per_unit)) product.prices.push(row.price_per_unit);
    product.transactions.push(row);
    if (bucketName === "เบิก") add(product.issued, row);
    if (bucketName === "คืน") add(product.returned, row);
    if (bucketName === "คืนเสีย") add(product.damaged, row);

    if (row.is_corrected && row.correction_id) {
      corrections.push({
        transactionId: row.id,
        correctionId: row.correction_id,
        productName: canonicalName,
        transactionType: bucketName,
        originalQuantity: row.original_quantity ?? null,
        quantity: row.quantity,
        unit: row.unit ?? "",
        originalPriceAmount: row.original_price_amount ?? null,
        originalPriceQuantity: row.original_price_quantity ?? null,
        pricePerUnit: row.price_per_unit,
        originalAmount: row.original_total_amount ?? null,
        amount: row.total_amount ?? 0,
        reason: row.correction_reason_detail ?? "",
      });
    }
  }

  for (const product of products.values()) {
    const units = new Set([
      ...Object.keys(product.issued.quantities),
      ...Object.keys(product.returned.quantities),
      ...Object.keys(product.damaged.quantities),
    ]);
    for (const unit of units) {
      product.remaining.quantities[unit] = rounded(
        (product.issued.quantities[unit] ?? 0)
        - (product.returned.quantities[unit] ?? 0)
        - (product.damaged.quantities[unit] ?? 0),
      );
    }
    product.remaining.amount = rounded(
      product.issued.amount - product.returned.amount - product.damaged.amount,
    );
    product.prices.sort((a, b) => a - b);
    product.sourceNames.sort((a, b) => a.localeCompare(b, "th"));
  }

  const rows = [...products.values()].sort((a, b) => a.canonicalName.localeCompare(b.canonicalName, "th"));
  const issuedAmount = rounded(rows.reduce((sum, row) => sum + row.issued.amount, 0));
  const returnedAmount = rounded(rows.reduce((sum, row) => sum + row.returned.amount, 0));
  const damagedAmount = rounded(rows.reduce((sum, row) => sum + row.damaged.amount, 0));
  const expectedAmount = rounded(calculateYodSong({ เบิก: issuedAmount, คืน: returnedAmount, คืนเสีย: damagedAmount }));

  if (!settlement) {
    return {
      rows,
      corrections,
      summary: {
        issuedAmount,
        returnedAmount,
        damagedAmount,
        expectedAmount,
        settlementAmount: null,
        difference: null,
        settlementStatus: "pending",
      },
    };
  }

  const totals = calculateSettlementTotals({ ยอดส่ง: expectedAmount, ...settlement });
  return {
    rows,
    corrections,
    summary: {
      issuedAmount,
      returnedAmount,
      damagedAmount,
      expectedAmount,
      settlementAmount: rounded(totals.ยอดขาย),
      difference: rounded(totals.ขาดเกิน),
      settlementStatus: "recorded",
    },
  };
}
