import React from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { STATUS_LABEL_TH, type ReconciliationReportRow, type ReconciliationSummary } from "@/lib/reconciliation-report";

const S = StyleSheet.create({
  page: { fontFamily: "SarabunPDF", fontSize: 8, paddingTop: 70, paddingBottom: 36, paddingHorizontal: 28, color: "#1e293b" },
  header: { position: "absolute", top: 24, left: 28, right: 28, borderBottomWidth: 1, borderBottomColor: "#cbd5e1", paddingBottom: 7 }, title: { fontSize: 14, fontWeight: "bold" }, meta: { marginTop: 2, color: "#64748b" },
  summary: { flexDirection: "row", gap: 6, marginBottom: 10 }, metric: { flex: 1, backgroundColor: "#f1f5f9", padding: 6 }, label: { fontSize: 6.5, color: "#64748b" }, value: { fontSize: 9, fontWeight: "bold", marginTop: 2 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#e2e8f0" }, head: { flexDirection: "row", backgroundColor: "#1e293b" }, cell: { flex: 1, padding: 4, textAlign: "right" }, left: { flex: 1.2, textAlign: "left" }, market: { flex: 1.5, textAlign: "left" }, th: { color: "white", fontWeight: "bold" },
  footer: { position: "absolute", bottom: 15, left: 28, right: 28, flexDirection: "row", justifyContent: "space-between", fontSize: 7, color: "#94a3b8" },
});
function money(value: number | null): string { return value == null ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export function ReconciliationDoc({ rows, summary, fromDate, toDate, market, status }: { rows: ReconciliationReportRow[]; summary: ReconciliationSummary; fromDate: string; toDate: string; market?: string; status?: string }) {
  return <Document title={`รายงานกระทบยอด ${fromDate} ถึง ${toDate}`}><Page size="A4" orientation="landscape" style={S.page} wrap>
    <View style={S.header} fixed><Text style={S.title}>รายงานกระทบยอดรายกลุ่มและวันธุรกิจ</Text><Text style={S.meta}>ช่วง {fromDate} ถึง {toDate} · ตลาด {market ?? 'ทั้งหมด'} · สถานะ {status ?? 'ทั้งหมด'}</Text></View>
    <View style={S.summary} wrap={false}>{[["ยอดโอนที่ส่งรวม", money(summary.submitted_transfer_total)], ["ยอดสลิปที่ตรวจรวม", money(summary.checked_slip_total)], ["ส่วนต่างรวม", money(summary.difference_total)], ["ต้องตรวจสอบ", `${summary.needs_review_count}/${summary.total_count}`]].map(([label, value]) => <View key={label} style={S.metric}><Text style={S.label}>{label}</Text><Text style={S.value}>{value}</Text></View>)}</View>
    <View style={S.head} fixed>{['วันที่ธุรกิจ', 'ตลาด', 'ยอดโอนที่ส่ง', 'AI ตรวจสลิป', 'สลิปมือ', 'รวมสลิป', 'ส่วนต่าง', 'สถานะ'].map((label, index) => <Text key={label} style={[S.cell, S.th, index === 0 ? S.left : {}, index === 1 ? S.market : {}]}>{label}</Text>)}</View>
    {rows.map((row) => <View key={`${row.source_id}-${row.business_date}`} style={S.row} wrap={false}><Text style={[S.cell, S.left]}>{row.business_date}</Text><Text style={[S.cell, S.market]}>{row.market}</Text><Text style={S.cell}>{money(row.submitted_transfer_total)}</Text><Text style={S.cell}>{money(row.ai_verified_total)}</Text><Text style={S.cell}>{money(row.manual_slip_total)}</Text><Text style={S.cell}>{money(row.checked_slip_total)}</Text><Text style={S.cell}>{money(row.difference)}</Text><Text style={S.cell}>{STATUS_LABEL_TH[row.status]}</Text></View>)}
    <View style={S.footer} fixed><Text>สูตรเดียวกับหน้าและ Excel: อ่านค่าจาก transfer_reconciliations</Text><Text render={({ pageNumber, totalPages }) => `หน้า ${pageNumber}/${totalPages}`} /></View>
  </Page></Document>;
}
