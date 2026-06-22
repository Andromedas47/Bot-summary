export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { createServiceClient } from "@/lib/supabase/server";
import { bangkokBusinessDateNow } from "@/lib/business-date";
import { fetchReconciliationReport } from "@/lib/reconciliation-report-service";
import {
  STATUS_FILTER_OPTIONS,
  STATUS_LABEL_TH,
  rowNeedsReview,
  type ReconciliationReportRow,
  type ReconciliationStatusFilter,
} from "@/lib/reconciliation-report";

const MONEY_FMT = "#,##0.00";
const VALID_STATUSES = new Set(STATUS_FILTER_OPTIONS.map((o) => o.value));

function parseStatus(value: string | null): ReconciliationStatusFilter | undefined {
  return value && VALID_STATUSES.has(value as ReconciliationStatusFilter)
    ? (value as ReconciliationStatusFilter)
    : undefined;
}

function detailRow(r: ReconciliationReportRow) {
  return {
    business_date: r.business_date,
    market:        r.market,
    submitted:     r.submitted_transfer_total,
    ai:            r.ai_verified_total,
    manual:        r.manual_slip_total,
    checked:       r.checked_slip_total,
    difference:    r.difference,
    status:        STATUS_LABEL_TH[r.status],
  };
}

const DETAIL_COLUMNS = [
  { header: "วันที่ธุรกิจ",       key: "business_date", width: 14 },
  { header: "ตลาด (ข้อมูลประกอบ)", key: "market",       width: 26 },
  { header: "ยอดโอนที่ส่ง",      key: "submitted",     width: 16, money: true },
  { header: "AI ตรวจสลิป",       key: "ai",            width: 16, money: true },
  { header: "สลิปมือ",            key: "manual",        width: 16, money: true },
  { header: "รวมสลิปที่ตรวจ",     key: "checked",       width: 16, money: true },
  { header: "ส่วนต่าง",           key: "difference",    width: 14, money: true },
  { header: "สถานะ",             key: "status",        width: 14 },
] as const;

function addDetailSheet(
  wb: ExcelJS.Workbook,
  name: string,
  rows: ReconciliationReportRow[],
) {
  const sheet = wb.addWorksheet(name);
  sheet.columns = DETAIL_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  sheet.getRow(1).font = { bold: true };

  for (const r of rows) {
    const added = sheet.addRow(detailRow(r));
    for (const c of DETAIL_COLUMNS) {
      if ("money" in c && c.money) added.getCell(c.key).numFmt = MONEY_FMT;
    }
    // Highlight exception rows in amber for auditability.
    if (rowNeedsReview(r.status)) {
      added.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3CD" } };
      });
    }
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  return sheet;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const today    = bangkokBusinessDateNow();
  const fromDate = searchParams.get("from") || today;
  const toDate   = searchParams.get("to")   || today;
  const market   = searchParams.get("market") || undefined;
  const status   = parseStatus(searchParams.get("status"));

  const supabase = await createServiceClient();

  let report;
  try {
    report = await fetchReconciliationReport(supabase, { fromDate, toDate, market, status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "export failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const { rows, summary } = report;
  const exceptions = rows.filter((r) => rowNeedsReview(r.status));

  const wb = new ExcelJS.Workbook();
  wb.creator  = "Bot-summary Backoffice";
  wb.created  = new Date();

  // ── Sheet 1: Summary ──────────────────────────────────────────────────────
  const summarySheet = wb.addWorksheet("สรุป");
  summarySheet.columns = [
    { header: "รายการ", key: "label", width: 30 },
    { header: "ค่า",     key: "value", width: 22 },
  ];
  summarySheet.getRow(1).font = { bold: true };

  const summaryRows: { label: string; value: string | number; money?: boolean }[] = [
    { label: "รายงาน",                value: "กระทบยอดรายกลุ่ม LINE + วันที่ธุรกิจ" },
    { label: "หมายเหตุ",              value: "คอลัมน์ตลาดเป็นข้อมูลประกอบ อาจแทนหลายตลาดในกลุ่มเดียวกัน ไม่ใช่ยอดแยกรายตลาด" },
    { label: "ช่วงวันที่ธุรกิจ",        value: `${fromDate} ถึง ${toDate}` },
    { label: "ตลาด (ตัวกรอง)",         value: market ?? "ทั้งหมด" },
    { label: "ตัวกรองสถานะ",          value: status ?? "ทั้งหมด" },
    { label: "ยอดโอนที่ส่งรวม",        value: summary.submitted_transfer_total, money: true },
    { label: "ยอดสลิปที่ตรวจรวม",      value: summary.checked_slip_total, money: true },
    { label: "ส่วนต่างรวม",            value: summary.difference_total, money: true },
    { label: "จำนวนรายการทั้งหมด",     value: summary.total_count },
    { label: "รายการที่ต้องตรวจสอบ",   value: summary.needs_review_count },
  ];
  for (const sr of summaryRows) {
    const added = summarySheet.addRow({ label: sr.label, value: sr.value });
    if (sr.money) added.getCell("value").numFmt = MONEY_FMT;
  }

  // ── Sheet 2: Reconciliation detail ────────────────────────────────────────
  addDetailSheet(wb, "รายละเอียดกระทบยอด", rows);

  // ── Sheet 3: Exceptions ───────────────────────────────────────────────────
  addDetailSheet(wb, "รายการที่ต้องตรวจสอบ", exceptions);

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `reconciliation_${fromDate}_${toDate}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
