import type { DigitalWhiteSheetViewModel } from "./types";

export const matchedWhiteSheetFixture: DigitalWhiteSheetViewModel = {
  marketKey: "wat-thung-lan-na",
  marketLabel: "วัดทุ่งลานนา",
  businessDate: "2026-06-01",
  expectedSales: 12_500,
  verifiedTransfers: 8_200,
  expenses: {
    labor: 1_200,
    locationFee: 500,
    bag: 80,
    snack: 45,
    other: 0,
  },
  expenseTotal: 1_825,
  expectedCash: 2_475,
  actualCashSubmitted: 2_475,
  difference: 0,
  status: "matched",
  warnings: [],
};

export const shortageWhiteSheetFixture: DigitalWhiteSheetViewModel = {
  marketKey: "talad-kee",
  marketLabel: "ตลาดกี้",
  businessDate: "2026-06-15",
  expectedSales: 9_800,
  verifiedTransfers: 6_100,
  expenses: {
    labor: 900,
    locationFee: 400,
    bag: 60,
    snack: 30,
    other: 150,
    otherNote: "ค่าน้ำแข็ง",
  },
  expenseTotal: 1_540,
  expectedCash: 2_160,
  actualCashSubmitted: 1_850,
  difference: 310,
  status: "shortage",
  warnings: ["พบสลิปโอนซ้ำในช่วงเวลาเดียวกัน"],
};

export const overageWhiteSheetFixture: DigitalWhiteSheetViewModel = {
  marketKey: "bang-sue",
  marketLabel: "บางซื่อ",
  businessDate: "2026-07-01",
  expectedSales: 15_000,
  verifiedTransfers: 10_500,
  expenses: {
    labor: 1_500,
    locationFee: 600,
    bag: 100,
    snack: 50,
    other: 0,
  },
  expenseTotal: 2_250,
  expectedCash: 2_250,
  actualCashSubmitted: 2_400,
  difference: 150,
  status: "overage",
  warnings: [],
};

export const uncategorizedWarningFixture: DigitalWhiteSheetViewModel = {
  ...shortageWhiteSheetFixture,
  warnings: ["มีรายการที่ยังไม่ได้จัดหมวด"],
};
