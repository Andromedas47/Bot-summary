"use client";

import { useActionState, useMemo, useState } from "react";
import { createCorrectionAction } from "@/app/(dashboard)/corrections/actions";
import type { CorrectionSnapshot } from "@/lib/corrections/types";

function money(value: number): string {
  return value.toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const inputClass =
  "mt-1 block h-11 w-full rounded-lg border border-slate-300 px-3 text-base outline-none transition-colors focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:bg-slate-100 sm:text-sm";

export function CorrectionForm({
  transactionId,
  snapshot,
}: {
  transactionId: string;
  snapshot: CorrectionSnapshot;
}) {
  const [productName, setProductName] = useState(snapshot.productName);
  const [quantity, setQuantity] = useState(String(snapshot.quantity));
  const [unit, setUnit] = useState(snapshot.unit);
  const [priceAmount, setPriceAmount] = useState(String(snapshot.priceAmount));
  const [priceQuantity, setPriceQuantity] = useState(
    String(snapshot.priceQuantity),
  );
  const [duplicate, setDuplicate] = useState(false);
  const [reasonType, setReasonType] = useState("");
  const requestKey = useMemo(() => crypto.randomUUID(), []);
  const [state, formAction, pending] = useActionState(
    createCorrectionAction,
    { error: null },
  );

  const parsedQuantity = Number(quantity);
  const parsedPriceAmount = Number(priceAmount);
  const parsedPriceQuantity = Number(priceQuantity);
  const nextTotal = duplicate
    ? 0
    : roundMoney(
        (Number.isFinite(parsedQuantity) ? parsedQuantity : 0)
        * (Number.isFinite(parsedPriceAmount) ? parsedPriceAmount : 0)
        / (
          Number.isFinite(parsedPriceQuantity) && parsedPriceQuantity > 0
            ? parsedPriceQuantity
            : 1
        ),
      );

  const changed = {
    productName: productName.trim() !== snapshot.productName,
    quantity:
      Number.isFinite(parsedQuantity) && parsedQuantity !== snapshot.quantity,
    unit: unit.trim() !== snapshot.unit,
    priceAmount:
      Number.isFinite(parsedPriceAmount)
      && parsedPriceAmount !== snapshot.priceAmount,
    priceQuantity:
      Number.isFinite(parsedPriceQuantity)
      && parsedPriceQuantity !== snapshot.priceQuantity,
  };

  function toggleDuplicate(next: boolean): void {
    setDuplicate(next);
    if (next) setReasonType("duplicate");
  }

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="transactionId" value={transactionId} />
      <input type="hidden" name="requestKey" value={requestKey} />

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-slate-700">
          ชื่อสินค้า
          <input
            name={!duplicate && changed.productName ? "productName" : undefined}
            value={productName}
            onChange={(event) => setProductName(event.target.value)}
            disabled={duplicate}
            required
            maxLength={200}
            className={inputClass}
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          จำนวน
          <input
            name={!duplicate && changed.quantity ? "quantity" : undefined}
            type="number"
            min="0.001"
            max="1000000"
            step="0.001"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            disabled={duplicate}
            required
            className={inputClass}
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          หน่วย
          <input
            name={!duplicate && changed.unit ? "unit" : undefined}
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            disabled={duplicate}
            required
            maxLength={50}
            className={inputClass}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm font-medium text-slate-700">
            ราคา
            <input
              name={
                !duplicate && changed.priceAmount ? "priceAmount" : undefined
              }
              type="number"
              min="0"
              max="1000000"
              step="0.01"
              value={priceAmount}
              onChange={(event) => setPriceAmount(event.target.value)}
              disabled={duplicate}
              required
              className={inputClass}
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            ต่อจำนวน
            <input
              name={
                !duplicate && changed.priceQuantity
                  ? "priceQuantity"
                  : undefined
              }
              type="number"
              min="0.001"
              max="1000000"
              step="0.001"
              value={priceQuantity}
              onChange={(event) => setPriceQuantity(event.target.value)}
              disabled={duplicate}
              required
              className={inputClass}
            />
          </label>
        </div>
      </div>

      <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-800">
        <input
          name="duplicate"
          type="checkbox"
          checked={duplicate}
          onChange={(event) => toggleDuplicate(event.target.checked)}
          className="size-4 accent-red-600"
        />
        ยกเลิกรายการนี้เพราะเป็นรายการซ้ำ
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-slate-700">
          ประเภทเหตุผล
          <select
            name="reasonType"
            required
            value={reasonType}
            onChange={(event) => setReasonType(event.target.value)}
            className={inputClass + " bg-white"}
          >
            <option value="">เลือกเหตุผล</option>
            <option value="wrong_price">ราคาผิด</option>
            <option value="wrong_quantity">จำนวนผิด</option>
            <option value="wrong_unit">หน่วยผิด</option>
            <option value="wrong_product">ชื่อสินค้าผิด</option>
            <option value="duplicate">รายการซ้ำ</option>
            <option value="other">อื่น ๆ</option>
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          หลักฐาน (URL)
          <input
            name="evidenceUrl"
            type="url"
            maxLength={2048}
            className={inputClass}
          />
        </label>
      </div>

      <label className="block text-sm font-medium text-slate-700">
        รายละเอียดเหตุผล
        <textarea
          name="reasonDetail"
          minLength={3}
          maxLength={1000}
          required
          rows={3}
          className="mt-1 block w-full rounded-lg border border-slate-300 p-3 text-base outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 sm:text-sm"
        />
      </label>

      <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <h2 className="font-semibold text-amber-950">
          ตัวอย่างผลลัพธ์ก่อนส่ง
        </h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-amber-700">รูปแบบราคา</dt>
            <dd className="mt-1 font-medium text-amber-950">
              {money(snapshot.priceAmount)} บาท / {snapshot.priceQuantity}{" "}
              {snapshot.unit}
              <br />
              →{" "}
              {duplicate
                ? "ยกเลิกรายการ"
                : money(parsedPriceAmount || 0)
                  + " บาท / "
                  + (parsedPriceQuantity || 0)
                  + " "
                  + unit}
            </dd>
          </div>
          <div>
            <dt className="text-amber-700">ยอด</dt>
            <dd className="mt-1 font-medium text-amber-950">
              {money(snapshot.totalAmount)} → {money(nextTotal)} บาท
            </dd>
          </div>
          <div>
            <dt className="text-amber-700">ผลกระทบ</dt>
            <dd className="mt-1 font-semibold text-amber-950">
              {money(nextTotal - snapshot.totalAmount)} บาท
            </dd>
          </div>
        </dl>
      </section>

      <p className="text-xs leading-5 text-slate-600">
        วันที่ ตลาด/พนักงาน และประเภทรายการแก้ตรงนี้ไม่ได้
        ระบบฐานข้อมูลจะโหลดรายการต้นฉบับและคำนวณยอดใหม่อีกครั้งก่อนบันทึกคำขอ
      </p>

      {state.error && (
        <p
          role="alert"
          aria-live="polite"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {state.error}
        </p>
      )}

      <button
        disabled={pending}
        className="h-11 cursor-pointer rounded-lg bg-[#06C755] px-6 text-sm font-semibold text-white transition-colors hover:bg-[#05b34d] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "กำลังส่งคำขอ…" : "ส่งคำขอแก้ไข"}
      </button>
    </form>
  );
}
