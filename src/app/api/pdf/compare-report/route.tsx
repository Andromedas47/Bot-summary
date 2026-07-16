export const runtime = "nodejs";

import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { NextRequest, NextResponse } from "next/server";
import { fetchCompareReport } from "@/lib/compare-report-service";
import { CompareReportDoc } from "@/lib/pdf/CompareReportDoc";
import { registerFonts } from "@/lib/pdf/fonts";

export async function GET(request: NextRequest) {
async function createComparePdf(
  report: Awaited<ReturnType<typeof fetchCompareReport>>,
  date: string,
  worker: string,
  market?: string,
) {
  return renderToBuffer(<CompareReportDoc report={report} date={date} worker={worker} market={market} />);
}
  const date = request.nextUrl.searchParams.get("date")?.trim();
  const worker = request.nextUrl.searchParams.get("worker")?.trim();
  const market = request.nextUrl.searchParams.get("market")?.trim() || undefined;
  if (!date || !worker) return NextResponse.json({ error: "date and worker are required" }, { status: 400 });
  try {
    const report = await fetchCompareReport({ date, worker, market });
    registerFonts();
    const buffer = await createComparePdf(report, date, worker, market);
    const safeWorker = worker.replace(/[\\/:*?"<>|]/g, "-");
    return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="compare-${safeWorker}-${date}.pdf"`, "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "cannot create PDF" }, { status: 500 });
  }
}
