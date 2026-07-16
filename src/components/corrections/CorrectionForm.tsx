"use client";

import { useMemo, useState } from "react";
import { createCorrectionAction } from "@/app/(dashboard)/corrections/actions";
import type { CorrectionSnapshot } from "@/lib/corrections/types";

function money(value: number): string { return value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

export function CorrectionForm({ transactionId, targetVersion, snapshot }: { transactionId: string; targetVersion: string; snapshot: CorrectionSnapshot }) {
  const [productName, setProductName] = useState(snapshot.productName);
  const [quantity, setQuantity] = useState(String(snapshot.quantity));
  const [unit, setUnit] = useState(snapshot.unit);
  const [priceAmount, setPriceAmount] = useState(String(snapshot.priceAmount));
  const [priceQuantity, setPriceQuantity] = useState(String(snapshot.priceQuantity));
  const [duplicate, setDuplicate] = useState(false);
  const requestKey = useMemo(() => crypto.randomUUID(), []);
  const nextTotal = duplicate ? 0 : (Number(quantity) || 0) * (Number(priceAmount) || 0) / (Number(priceQuantity) || 1);

  return <form action={createCorrectionAction} className="space-y-5">
    <input type="hidden" name="transactionId" value={transactionId} /><input type="hidden" name="targetVersion" value={targetVersion} /><input type="hidden" name="requestKey" value={requestKey} />
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm font-medium text-slate-700">ชื่อสินค้า<input name="productName" value={productName} onChange={(e) => setProductName(e.target.value)} disabled={duplicate} required className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-3 disabled:bg-slate-100" /></label>
      <label className="text-sm font-medium text-slate-700">จำนวน<input name="quantity" type="number" min="0" step="0.001" value={quantity} onChange={(e) => setQuantity(e.target.value)} disabled={duplicate} required className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-3 disabled:bg-slate-100" /></label>
      <label className="text-sm font-medium text-slate-700">หน่วย<input name="unit" value={unit} onChange={(e) => setUnit(e.target.value)} disabled={duplicate} required className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-3 disabled:bg-slate-100" /></label>
      <div className="grid grid-cols-2 gap-2"><label className="text-sm font-medium text-slate-700">ราคา<input name="priceAmount" type="number" min="0" step="0.01" value={priceAmount} onChange={(e) => setPriceAmount(e.target.value)} disabled={duplicate} required className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-3 disabled:bg-slate-100" /></label><label className="text-sm font-medium text-slate-700">ต่อจำนวน<input name="priceQuantity" type="number" min="0.001" step="0.001" value={priceQuantity} onChange={(e) => setPriceQuantity(e.target.value)} disabled={duplicate} required className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-3 disabled:bg-slate-100" /></label></div>
    </div>
    <label className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-800"><input name="duplicate" type="checkbox" checked={duplicate} onChange={(e) => setDuplicate(e.target.checked)} className="size-4" />ยกเลิกรายการนี้เพราะเป็นรายการซ้ำ</label>
    <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium text-slate-700">ประเภทเหตุผล<select name="reasonType" required className="mt-1 block h-10 w-full rounded-lg border border-slate-300 bg-white px-3"><option value="">เลือกเหตุผล</option><option value="wrong_price">ราคาผิด</option><option value="wrong_quantity">จำนวนผิด</option><option value="wrong_unit">หน่วยผิด</option><option value="wrong_product">ชื่อสินค้าผิด</option><option value="duplicate">รายการซ้ำ</option><option value="other">อื่น ๆ</option></select></label><label className="text-sm font-medium text-slate-700">หลักฐาน (URL)<input name="evidenceUrl" type="url" className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-3" /></label></div>
    <label className="block text-sm font-medium text-slate-700">รายละเอียดเหตุผล<textarea name="reasonDetail" minLength={3} required rows={3} className="mt-1 block w-full rounded-lg border border-slate-300 p-3" /></label>
    <section className="rounded-xl border border-amber-200 bg-amber-50 p-4"><h2 className="font-semibold text-amber-950">ตัวอย่างผลลัพธ์ก่อนส่ง</h2><dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3"><div><dt className="text-amber-700">ราคา</dt><dd>{money(snapshot.priceAmount)} → {duplicate ? 'ยกเลิก' : money(Number(priceAmount) || 0)} บาท/{unit}</dd></div><div><dt className="text-amber-700">ยอด</dt><dd>{money(snapshot.totalAmount)} → {money(nextTotal)} บาท</dd></div><div><dt className="text-amber-700">ผลกระทบ</dt><dd className="font-semibold">{money(nextTotal - snapshot.totalAmount)} บาท</dd></div></dl></section>
    <p className="text-xs text-slate-500">วันที่ ตลาด/พนักงาน และประเภทรายการแก้ตรงนี้ไม่ได้ หากต้องย้ายรายการให้ยกเลิกรายการเดิมและสร้างรายการทดแทนตามกระบวนการที่ได้รับอนุมัติ</p>
    <button className="h-11 rounded-lg bg-[#06C755] px-6 text-sm font-semibold text-white hover:bg-[#05b34d]">ส่งคำขอแก้ไข</button>
  </form>;
}
