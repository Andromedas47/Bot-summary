export const runtime = "nodejs";

import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { NextRequest, NextResponse } from "next/server";
import { bangkokBusinessDateNow } from "@/lib/business-date";
import { ReconciliationDoc } from "@/lib/pdf/ReconciliationDoc";
import { registerFonts } from "@/lib/pdf/fonts";
import { fetchReconciliationReport } from "@/lib/reconciliation-report-service";
import { STATUS_FILTER_OPTIONS, type ReconciliationStatusFilter } from "@/lib/reconciliation-report";
import { createServiceClient } from "@/lib/supabase/server";

const valid = new Set(STATUS_FILTER_OPTIONS.map((option) => option.value));
export async function GET(request: NextRequest) {
  const today = bangkokBusinessDateNow();
async function createReconciliationPdf(
  report: Awaited<ReturnType<typeof fetchReconciliationReport>>,
  fromDate: string,
  toDate: string,
  market?: string,
  status?: ReconciliationStatusFilter,
) {
  return renderToBuffer(
    <ReconciliationDoc rows={report.rows} summary={report.summary} fromDate={fromDate} toDate={toDate} market={market} status={status} />,
  );
}

  const fromDate = request.nextUrl.searchParams.get("from") || today;
  const toDate = request.nextUrl.searchParams.get("to") || today;
  const market = request.nextUrl.searchParams.get("market") || undefined;
  const rawStatus = request.nextUrl.searchParams.get("status");
  const status = rawStatus && valid.has(rawStatus as ReconciliationStatusFilter) ? rawStatus as ReconciliationStatusFilter : undefined;
  try {
    const report = await fetchReconciliationReport(createServiceClient(), { fromDate, toDate, market, status });
    registerFonts();
    const buffer = await createReconciliationPdf(report, fromDate, toDate, market, status);
    return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="reconciliation-${fromDate}-${toDate}.pdf"`, "Cache-Control": "no-store" } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "cannot create PDF" }, { status: 500 }); }
}
