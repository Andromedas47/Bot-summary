import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { DailyRow } from "@/components/daily-table/DailyTable";

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n == null) return "-";
  return n.toLocaleString("th-TH", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "-";
  return new Intl.DateTimeFormat("th-TH", {
    day:   "numeric",
    month: "short",
    year:  "2-digit",
  }).format(new Date(d + "T00:00:00"));
}

function fmtTime(d: string | null | undefined): string {
  if (!d) return "-";
  if (/^\d{1,2}[:.]\d{2}$/.test(d)) return d.replace(".", ":");
  return new Intl.DateTimeFormat("th-TH", {
    hour:     "2-digit",
    minute:   "2-digit",
    timeZone: "Asia/Bangkok",
  }).format(new Date(d));
}

const S = StyleSheet.create({
  page: {
    fontFamily: "SarabunPDF",
    fontSize: 7,
    paddingTop: 24,
    paddingBottom: 32,
    paddingHorizontal: 20,
    color: "#1E293B",
  },
  header: {
    marginBottom: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    borderBottomWidth: 1.2,
    borderBottomColor: "#0F172A",
    paddingBottom: 6,
  },
  title: {
    fontSize: 13,
    fontWeight: "bold",
  },
  subtitle: {
    fontSize: 7,
    color: "#64748B",
  },
  table: {
    flexDirection: "column",
  },
  thead: {
    flexDirection: "row",
    backgroundColor: "#0F172A",
  },
  th: {
    paddingVertical: 3,
    paddingHorizontal: 2.5,
    fontSize: 6,
    fontWeight: "bold",
    color: "#FFFFFF",
    textAlign: "right",
  },
  thLeft: {
    textAlign: "left",
  },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#E2E8F0",
  },
  trAlt: {
    backgroundColor: "#F8FAFC",
  },
  td: {
    paddingVertical: 2.5,
    paddingHorizontal: 2.5,
    fontSize: 6.5,
    textAlign: "right",
  },
  tdLeft: {
    textAlign: "left",
  },
  footer: {
    position: "absolute",
    bottom: 14,
    right: 20,
    fontSize: 7,
    color: "#94A3B8",
  },
});

const COLS = [
  { label: "วันที่", flex: 7, left: true },
  { label: "เวลา", flex: 5, left: false },
  { label: "ผู้ส่ง LINE", flex: 8, left: true },
  { label: "คนขาย", flex: 8, left: true },
  { label: "ตลาด", flex: 10, left: true },
  { label: "ประเภท", flex: 7, left: true },
  { label: "ลำดับ", flex: 4, left: false },
  { label: "สินค้า", flex: 13, left: true },
  { label: "จำนวน", flex: 6, left: false },
  { label: "หน่วย", flex: 5, left: true },
  { label: "ราคา", flex: 6, left: false },
  { label: "รวม", flex: 7, left: false },
] as const;

export function DailyTableDoc({ rows, filterLabel }: { rows: DailyRow[]; filterLabel: string }) {
  const today = new Date().toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" });

  return (
    <Document title={`ตารางรายการสินค้า-${filterLabel}`} author="bot-summary">
      <Page size="A4" orientation="landscape" style={S.page} wrap>
        <View style={S.header} fixed>
          <View>
            <Text style={S.title}>ตารางรายการสินค้า</Text>
            <Text style={S.subtitle}>{rows.length.toLocaleString("th-TH")} รายการ</Text>
          </View>
          <Text style={S.subtitle}>พิมพ์วันที่ {today}</Text>
        </View>

        <View style={S.table}>
          <View style={S.thead} fixed>
            {COLS.map((c) => (
              <Text key={c.label} style={[S.th, c.left ? S.thLeft : {}, { flex: c.flex }]}>
                {c.label}
              </Text>
            ))}
          </View>

          {rows.map((r, i) => {
            const vals = [
              fmtDate(r.transaction_date),
              fmtTime(r.transaction_time ?? r.session_created_at),
              r.sender_name ?? r.staff_name,
              r.staff_name,
              r.market_name ?? "-",
              r.transaction_type,
              String(r.item_number ?? ""),
              r.product_name,
              fmt(r.quantity, 3),
              r.unit ?? "-",
              fmt(r.price_per_unit, 2),
              fmt(r.total_amount, 2),
            ];

            return (
              <View key={r.id} style={[S.tr, i % 2 === 1 ? S.trAlt : {}]} wrap={false}>
                {COLS.map((c, ci) => (
                  <Text key={c.label} style={[S.td, c.left ? S.tdLeft : {}, { flex: c.flex }]}>
                    {vals[ci]}
                  </Text>
                ))}
              </View>
            );
          })}
        </View>

        <Text
          style={S.footer}
          render={({ pageNumber, totalPages }) => `หน้า ${pageNumber} / ${totalPages}`}
          fixed
        />
      </Page>
    </Document>
  );
}
