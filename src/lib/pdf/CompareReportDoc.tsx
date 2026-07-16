import React from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { CompareReport } from "@/lib/compare-report";

const S = StyleSheet.create({
  page: { fontFamily: "SarabunPDF", fontSize: 8, paddingTop: 74, paddingBottom: 38, paddingHorizontal: 28, color: "#1e293b" },
  header: { position: "absolute", top: 24, left: 28, right: 28, borderBottomWidth: 1, borderBottomColor: "#cbd5e1", paddingBottom: 8 },
  title: { fontSize: 14, fontWeight: "bold" }, meta: { color: "#64748b", marginTop: 2 },
  tr: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#e2e8f0" },
  thRow: { flexDirection: "row", backgroundColor: "#1e293b" },
  th: { color: "white", fontWeight: "bold", padding: 5 }, td: { padding: 5 },
  product: { flex: 1.5 }, price: { flex: 1 }, bucket: { flex: 1.2 },
  sub: { color: "#64748b", fontSize: 6.5, marginTop: 2 },
  summary: { marginTop: 12, padding: 9, backgroundColor: "#f1f5f9" },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 3 },
  audit: { marginTop: 10, paddingTop: 7, borderTopWidth: 1, borderTopColor: "#cbd5e1" },
  footer: { position: "absolute", bottom: 16, left: 28, right: 28, flexDirection: "row", justifyContent: "space-between", color: "#94a3b8", fontSize: 7 },
});

function money(value: number): string { return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function qty(values: Record<string, number>): string {
  return Object.entries(values).filter(([, value]) => value !== 0).map(([unit, value]) => `${value.toLocaleString("en-US", { maximumFractionDigits: 3 })} ${unit}`).join(" / ") || "0";
}
function bucket(values: { quantities: Record<string, number>; amount: number }): string { return `${qty(values.quantities)}\n${money(values.amount)} บาท`; }

export function CompareReportDoc({ report, date, worker, market }: { report: CompareReport; date: string; worker: string; market?: string }) {
  const s = report.summary;
  return <Document title={`รายงานเปรียบเทียบ ${worker} ${date}`}>
    <Page size="A4" style={S.page} wrap>
      <View style={S.header} fixed><Text style={S.title}>รายงานเปรียบเทียบสินค้า</Text><Text style={S.meta}>วันที่ {date} · พนักงาน {worker}{market ? ` · ตลาด ${market}` : " · ทุกตลาด"}</Text></View>
      <View style={S.thRow} fixed>
        <Text style={[S.th, S.product]}>รายการ</Text><Text style={[S.th, S.price]}>ราคาต่อหน่วย</Text><Text style={[S.th, S.bucket]}>เบิก</Text><Text style={[S.th, S.bucket]}>ชั่งคืน</Text><Text style={[S.th, S.bucket]}>คืนเสีย</Text><Text style={[S.th, S.bucket]}>คงเหลือ</Text>
      </View>
      {report.rows.map((row) => <View key={row.canonicalName} style={S.tr} wrap={false}>
        <View style={[S.td, S.product]}><Text>{row.canonicalName}</Text>{row.sourceNames.some((name) => name !== row.canonicalName) && <Text style={S.sub}>ชื่อเดิม: {row.sourceNames.join(", ")}</Text>}{row.transactions.some((item) => item.is_corrected) && <Text style={S.sub}>แก้ไขแล้ว</Text>}</View>
        <Text style={[S.td, S.price]}>{row.prices.map(money).join(" / ") || "—"} บาท</Text>
        <Text style={[S.td, S.bucket]}>{bucket(row.issued)}</Text><Text style={[S.td, S.bucket]}>{bucket(row.returned)}</Text><Text style={[S.td, S.bucket]}>{bucket(row.damaged)}</Text><Text style={[S.td, S.bucket]}>{bucket(row.remaining)}</Text>
      </View>)}
      <View style={S.summary} wrap={false}>
        {[['ยอดเบิก', money(s.issuedAmount)], ['ยอดชั่งคืน', money(s.returnedAmount)], ['ยอดคืนเสีย', money(s.damagedAmount)], ['ยอดที่ควรรับ', money(s.expectedAmount)], ['ยอดตามรายการส่งเงิน', s.settlementAmount == null ? 'รอข้อมูล' : money(s.settlementAmount)], ['เงินขาด/เกิน', s.difference == null ? 'ยังไม่สามารถคำนวณได้' : money(s.difference)]].map(([label, value]) => <View key={label} style={S.summaryRow}><Text>{label}</Text><Text>{value}</Text></View>)}
        <Text>สถานะข้อมูลปิดยอด: {s.settlementStatus === "recorded" ? "บันทึกรายการส่งเงินแล้ว" : "ยังไม่ได้บันทึกรายการส่งเงิน/ใบขาว"}</Text>
      </View>
      {report.corrections.length > 0 && <View style={S.audit}><Text style={{ fontWeight: "bold" }}>รายการปรับแก้</Text>{report.corrections.map((item) => <View key={item.correctionId} wrap={false} style={{ marginTop: 4 }}><Text>{item.productName} — {item.transactionType} · {item.quantity?.toLocaleString("en-US", { maximumFractionDigits: 3 })} {item.unit}</Text><Text>{money(item.originalAmount ?? 0)} → {money(item.amount)} บาท (ผลต่าง {money(item.amount - (item.originalAmount ?? 0))} บาท) · {item.reason}</Text></View>)}</View>}
      <View style={S.footer} fixed><Text>สร้างจากข้อมูลรายการหลังอนุมัติ correction</Text><Text render={({ pageNumber, totalPages }) => `หน้า ${pageNumber}/${totalPages}`} /></View>
    </Page>
  </Document>;
}
