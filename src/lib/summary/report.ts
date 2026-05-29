import {
  calculateSettlementTotals,
  calculateYodSong,
  transactionBucket,
} from "@/lib/summary/transactions";
import { displayMarketName } from "@/lib/market";

export interface ReportRow {
  transaction_date: string | null;
  market_name: string | null;
  staff_name: string;
  product_name: string;
  quantity: number | null;
  unit: string | null;
  price_per_unit: number | null;
  total_amount: number | null;
  transaction_type: string;
  item_number: number | null;
}

export type SettlementMap = Record<string, { ยอดโอน: number; ยอดขาย: number }>;

export interface ReportGroup {
  date: string;
  market: string;
  seller: string;
  เบิก: ReportRow[];
  คืน: ReportRow[];
  คืนเสีย: ReportRow[];
  ยอดเบิก: number;
  ยอดคืน: number;
  ยอดคืนเสีย: number;
  ยอดส่ง: number;
  ยอดโอน: number;
  ยอดขาย: number;
  เงินสดต้องส่งเจ๊: number;
  ขาดเกิน: number;
}

export function buildReportGroups(rows: ReportRow[], settlements: SettlementMap): ReportGroup[] {
  const map = new Map<string, ReportGroup>();

  for (const r of rows) {
    const bucket = transactionBucket(r.transaction_type);
    if (!bucket) continue;

    const date = r.transaction_date ?? "ไม่ระบุวันที่";
    const market = displayMarketName(r.market_name, "ไม่ระบุตลาด");
    const seller = r.staff_name || "ไม่ระบุ";
    const key = `${date}||${market}||${seller}`;

    if (!map.has(key)) {
      map.set(key, {
        date,
        market,
        seller,
        เบิก: [],
        คืน: [],
        คืนเสีย: [],
        ยอดเบิก: 0,
        ยอดคืน: 0,
        ยอดคืนเสีย: 0,
        ยอดส่ง: 0,
        ยอดโอน: 0,
        ยอดขาย: 0,
        เงินสดต้องส่งเจ๊: 0,
        ขาดเกิน: 0,
      });
    }

    const g = map.get(key)!;
    const amt = r.total_amount ?? 0;

    if (bucket === "เบิก") {
      g.เบิก.push(r);
      g.ยอดเบิก += amt;
    } else if (bucket === "คืน") {
      g.คืน.push(r);
      g.ยอดคืน += amt;
    } else {
      g.คืนเสีย.push(r);
      g.ยอดคืนเสีย += amt;
    }
  }

  return Array.from(map.values())
    .map((g) => {
      const key = `${g.date}||${g.market}||${g.seller}`;
      const s = settlements[key] ?? { ยอดโอน: 0, ยอดขาย: 0 };
      const ยอดส่ง = calculateYodSong({
        เบิก: g.ยอดเบิก,
        คืน: g.ยอดคืน,
        คืนเสีย: g.ยอดคืนเสีย,
      });
      const moneyCash = s.ยอดขาย - s.ยอดโอน;
      const settlement = calculateSettlementTotals({
        ยอดส่ง,
        money_transfer: s.ยอดโอน,
        money_cash: moneyCash,
      });

      return {
        ...g,
        ยอดส่ง,
        ยอดโอน: settlement.ยอดโอน,
        ยอดขาย: settlement.ยอดขาย,
        เงินสดต้องส่งเจ๊: settlement.เงินสดต้องส่งเจ๊,
        ขาดเกิน: settlement.ขาดเกิน,
      };
    })
    .sort((a, b) =>
      a.date.localeCompare(b.date) ||
      a.market.localeCompare(b.market) ||
      a.seller.localeCompare(b.seller),
    );
}
