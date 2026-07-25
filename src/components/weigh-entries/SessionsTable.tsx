"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProduceSession } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cleanMarketName } from "@/lib/market";
import { postVoidProduceSession } from "./void-session-client";

export function canVoidProduceSession(session: Pick<ProduceSession, "voided_at">): boolean {
  return !session.voided_at;
}

type VoidOverlay = Pick<ProduceSession, "voided_at" | "voided_by" | "void_reason">;

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

const TH =
  "px-4 py-2.5 text-left text-[0.6875rem] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap";

const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 " +
  "placeholder:text-slate-400 focus:border-[#06C755] focus:outline-none focus:ring-2 focus:ring-[#06C755]/20";

function sessionMarketLabel(session: ProduceSession): string {
  return cleanMarketName(session.session_title) ?? session.session_title ?? "—";
}

function sessionTxnType(session: ProduceSession): string {
  return session.declared_transaction_type?.trim() || "—";
}

export function SessionsTable({ sessions }: { sessions: ProduceSession[] }) {
  const router = useRouter();
  const [voidOverlays, setVoidOverlays] = useState<Record<string, VoidOverlay>>({});
  const [voidTarget, setVoidTarget] = useState<ProduceSession | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  const rows = sessions.map((s) => {
    const overlay = voidOverlays[s.id];
    return overlay ? { ...s, ...overlay } : s;
  });

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-400">
        <p className="text-sm font-semibold text-slate-600">ยังไม่มีรายการชั่ง</p>
        <p className="text-xs mt-1 text-slate-400">รายการจะแสดงที่นี่เมื่อมีการชั่งผ่าน LINE</p>
      </div>
    );
  }

  async function confirmVoid() {
    if (!voidTarget || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError("");
    setSuccess("");
    try {
      const result = await postVoidProduceSession({
        sessionId: voidTarget.id,
        reason,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setVoidOverlays((prev) => ({
        ...prev,
        [result.sessionId]: {
          voided_at: result.voidedAt,
          voided_by: result.voidedBy,
          void_reason: result.voidReason,
        },
      }));
      setSuccess(`ยกเลิกเซสชันแล้ว (${result.sessionId.slice(0, 8)}…)`);
      setVoidTarget(null);
      setReason("");
      router.refresh();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      {success && (
        <p className="text-sm font-medium text-emerald-700" role="status" data-testid="void-success">
          {success}
        </p>
      )}
      {error && !voidTarget && (
        <p className="text-sm font-medium text-red-600" role="alert" data-testid="void-error">
          {error}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-y border-slate-200">
              <th className={`${TH} hidden sm:table-cell`}>วันที่</th>
              <th className={TH}>เจ้าหน้าที่</th>
              <th className={`${TH} hidden md:table-cell`}>รอบชั่ง</th>
              <th className={`${TH} text-right`}>รายการ</th>
              <th className={TH}>สถานะ</th>
              <th className={`${TH} hidden lg:table-cell`}>บันทึกเมื่อ</th>
              <th className={TH}>จัดการ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((s) => {
              const errorCount = Array.isArray(s.parser_errors) ? s.parser_errors.length : 0;
              const isVoided = !canVoidProduceSession(s);
              return (
                <tr
                  key={s.id}
                  className={
                    isVoided
                      ? "bg-slate-50 text-slate-500"
                      : "hover:bg-[#06C755]/5 transition-colors"
                  }
                  data-testid={`session-row-${s.id}`}
                  data-voided={isVoided ? "true" : "false"}
                >
                  <td className="px-4 py-3 hidden sm:table-cell whitespace-nowrap text-sm">
                    {s.session_date ?? <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-3 font-medium text-sm">{s.staff_name}</td>
                  <td className="px-4 py-3 hidden md:table-cell text-sm">
                    <span className="truncate max-w-48 block">
                      {s.session_title ?? <span className="text-slate-300 italic">—</span>}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-sm">
                    {s.total_items}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {isVoided ? (
                      <Badge variant="warning" dot>VOIDED</Badge>
                    ) : errorCount > 0 ? (
                      <Badge variant="warning" dot>มีปัญหา {errorCount}</Badge>
                    ) : (
                      <Badge variant="success" dot>ปกติ</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell whitespace-nowrap text-sm">
                    {formatDate(s.created_at)}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {isVoided ? (
                      <span className="text-xs text-slate-400" data-testid={`voided-label-${s.id}`}>
                        ยกเลิกแล้ว
                      </span>
                    ) : (
                      <Button
                        type="button"
                        variant="secondary"
                        className="!h-8 !px-2.5 !text-xs"
                        onClick={() => {
                          setVoidTarget(s);
                          setReason("");
                          setError("");
                          setSuccess("");
                        }}
                        data-testid={`void-button-${s.id}`}
                      >
                        Void
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {voidTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="void-session-title"
          data-testid="void-session-modal"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-lg space-y-3">
            <h3 id="void-session-title" className="text-sm font-semibold text-slate-900">
              ยืนยันยกเลิกเซสชันชั่ง
            </h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm text-slate-700">
              <dt className="text-slate-500">วันที่</dt>
              <dd>{voidTarget.session_date ?? "—"}</dd>
              <dt className="text-slate-500">เจ้าหน้าที่</dt>
              <dd>{voidTarget.staff_name}</dd>
              <dt className="text-slate-500">ตลาด</dt>
              <dd>{sessionMarketLabel(voidTarget)}</dd>
              <dt className="text-slate-500">ประเภท</dt>
              <dd>{sessionTxnType(voidTarget)}</dd>
              <dt className="text-slate-500">รายการ</dt>
              <dd>{voidTarget.total_items}</dd>
            </dl>
            <div className="space-y-1.5">
              <label
                htmlFor="void-reason"
                className="block text-xs font-medium text-slate-500 uppercase tracking-wide"
              >
                เหตุผล (จำเป็น)
              </label>
              <textarea
                id="void-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                className={INPUT_CLS}
                data-testid="void-reason-input"
                disabled={pending}
              />
            </div>
            {error && (
              <p className="text-sm font-medium text-red-600" role="alert" data-testid="void-modal-error">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  if (pendingRef.current) return;
                  setVoidTarget(null);
                  setReason("");
                  setError("");
                }}
              >
                ยกเลิก
              </Button>
              <Button
                type="button"
                isLoading={pending}
                disabled={pending}
                onClick={() => void confirmVoid()}
                data-testid="void-confirm-button"
              >
                ยืนยัน Void
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
