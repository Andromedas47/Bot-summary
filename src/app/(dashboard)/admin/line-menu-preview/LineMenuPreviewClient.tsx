"use client";

import { useMemo, useState } from "react";
import {
  applyCustomDateInPreview,
  buildAllPreviewStates,
  emptySelection,
  initialGuidedMenuFlow,
  PREVIEW_STAFF_LABEL,
  reduceGuidedMenuPostback,
  TX_CODE_TO_LABEL,
  type GuidedMenuActiveSession,
  type GuidedMenuFlowResult,
  type GuidedMenuSelection,
  type LinePreviewMessage,
} from "@/lib/line/guided-menu";

function extractPostbackTargets(message: LinePreviewMessage): { label: string; data: string }[] {
  const targets: { label: string; data: string }[] = [];

  if (message.type === "flex") {
    const footer = message.contents.footer as
      | { contents?: Array<{ type?: string; action?: { type?: string; label?: string; data?: string } }> }
      | undefined;
    for (const item of footer?.contents ?? []) {
      if (item.type === "button" && item.action?.type === "postback" && item.action.data && item.action.label) {
        targets.push({ label: item.action.label, data: item.action.data });
      }
    }
  }

  for (const item of message.quickReply?.items ?? []) {
    if (item.action.type === "postback") {
      targets.push({ label: item.action.label, data: item.action.data });
    }
  }

  return targets;
}

function PhoneFrame({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <div className="mx-auto w-full max-w-[390px]">
      <div className="rounded-[1.75rem] border border-slate-300 bg-slate-900 shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 bg-slate-950">
          <span className="text-[0.6875rem] font-medium text-slate-400">LINE Preview</span>
          <span className="rounded bg-amber-400/20 px-2 py-0.5 text-[0.625rem] font-bold tracking-wide text-amber-300">
            PREVIEW ONLY
          </span>
        </div>
        <div className="bg-[#747F8D] px-3 py-2 text-center text-[0.75rem] font-medium text-white">
          {title}
        </div>
        <div className="min-h-[520px] bg-[#8CABD8] p-3 space-y-3">{children}</div>
      </div>
    </div>
  );
}

function FlexBubbleView({ message }: { message: Extract<LinePreviewMessage, { type: "flex" }> }) {
  const header = message.contents.header as
    | { contents?: Array<{ text?: string; color?: string; size?: string; weight?: string }> }
    | undefined;
  const body = message.contents.body as
    | { contents?: Array<Record<string, unknown>> }
    | undefined;
  const footer = message.contents.footer as
    | { contents?: Array<{ type?: string; style?: string; action?: { label?: string } }> }
    | undefined;

  return (
    <div className="rounded-2xl bg-white shadow-md overflow-hidden">
      <div className="bg-slate-900 px-4 py-3 space-y-1">
        {(header?.contents ?? []).map((c, i) => (
          <p
            key={i}
            className={
              c.size === "xs"
                ? "text-[0.6875rem] font-bold text-amber-300"
                : "text-base font-bold text-white"
            }
          >
            {c.text}
          </p>
        ))}
      </div>
      <div className="px-4 py-3 space-y-2">
        {(body?.contents ?? []).map((block, i) => {
          if (block.type === "text") {
            return (
              <p
                key={i}
                className={`text-sm wrap-break-word ${
                  block.weight === "bold" ? "font-semibold text-slate-900" : "text-slate-600"
                }`}
              >
                {String(block.text ?? "")}
              </p>
            );
          }
          if (block.type === "box" && Array.isArray(block.contents)) {
            const kids = block.contents as Array<{ text?: string; weight?: string; color?: string; size?: string }>;
            return (
              <div key={i} className="flex gap-2 text-sm">
                {kids.map((k, j) => (
                  <span
                    key={j}
                    className={
                      k.weight === "bold"
                        ? "font-semibold text-slate-900 flex-3"
                        : "text-slate-500 flex-2"
                    }
                  >
                    {k.text}
                  </span>
                ))}
              </div>
            );
          }
          return null;
        })}
      </div>
      <div className="border-t border-slate-100 p-3 space-y-2">
        {(footer?.contents ?? []).map((btn, i) => (
          <div
            key={i}
            className={`rounded-xl px-3 py-3 text-center text-sm font-semibold ${
              btn.style === "secondary"
                ? "bg-slate-100 text-slate-700"
                : "bg-[#06C755] text-white"
            }`}
          >
            {btn.action?.label}
          </div>
        ))}
      </div>
    </div>
  );
}

function TextBubbleView({ message }: { message: Extract<LinePreviewMessage, { type: "text" }> }) {
  return (
    <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 shadow-sm">
      <p className="whitespace-pre-wrap text-sm text-slate-800 leading-relaxed">{message.text}</p>
    </div>
  );
}

function ActionPad({
  targets,
  onAction,
  disabled,
}: {
  targets: { label: string; data: string }[];
  onAction: (data: string, label: string) => void;
  disabled?: boolean;
}) {
  if (targets.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-500">
        แตะเพื่อไปต่อ (พรีวิว)
      </p>
      <div className="flex flex-wrap gap-2">
        {targets.map((t) => (
          <button
            key={`${t.label}:${t.data}`}
            type="button"
            disabled={disabled}
            onClick={() => onAction(t.data, t.label)}
            className="min-h-11 min-w-[7.5rem] flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-800 shadow-sm hover:border-[#06C755] hover:text-[#059B45] disabled:opacity-50"
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const SAMPLE_SELECTION: GuidedMenuSelection = {
  txCode: "b",
  marketId: "mkt_khlong_toei",
  dateMode: "today",
  customIsoDate: null,
};

function sampleSession(nowMs: number): GuidedMenuActiveSession {
  return {
    selection: SAMPLE_SELECTION,
    marketLabel: "คลองเตย",
    businessDateIso: "2026-07-28",
    businessDateThai: "28 กรกฎาคม 2569",
    transactionLabel: "เบิก",
    baseTransactionType: "เบิก",
    staffLabel: PREVIEW_STAFF_LABEL,
    observedItemCount: 3,
    openedAtMs: nowMs,
  };
}

export function LineMenuPreviewClient() {
  const [nowMs] = useState(() => Date.now());
  const [flow, setFlow] = useState<GuidedMenuFlowResult>(() => initialGuidedMenuFlow());
  const [lastActionLabel, setLastActionLabel] = useState<string | null>(null);
  const [customIso, setCustomIso] = useState("2026-07-27");
  const [observedCount, setObservedCount] = useState(0);
  const [galleryId, setGalleryId] = useState("main_menu");

  const gallery = useMemo(
    () =>
      buildAllPreviewStates({
        selection: SAMPLE_SELECTION,
        session: sampleSession(nowMs),
        transactionLabel: "เบิก",
        marketLabel: "คลองเตย",
        businessDateThai: "28 กรกฎาคม 2569",
        businessDateIso: "2026-07-28",
        staffLabel: PREVIEW_STAFF_LABEL,
      }),
    [nowMs],
  );

  const currentMessages = flow.messages;
  const targets = currentMessages.flatMap(extractPostbackTargets);

  function handlePostback(data: string, label: string) {
    setLastActionLabel(label);
    setFlow((prev) =>
      reduceGuidedMenuPostback({
        data,
        selection: prev.selection,
        activeSession: prev.activeSession,
        lineTimestampMs: nowMs,
        observedItemCount: prev.activeSession?.observedItemCount ?? observedCount,
      }),
    );
  }

  function handleCustomDateConfirm() {
    setLastActionLabel("ยืนยันวันที่กำหนดเอง");
    setFlow(
      applyCustomDateInPreview({
        selection: flow.selection,
        iso: customIso,
        lineTimestampMs: nowMs,
      }),
    );
  }

  function resetFlow() {
    setLastActionLabel(null);
    setObservedCount(0);
    setFlow(initialGuidedMenuFlow());
  }

  function bumpItems() {
    setObservedCount((n) => n + 1);
    setFlow((prev) => {
      if (!prev.activeSession) return prev;
      const activeSession = {
        ...prev.activeSession,
        observedItemCount: prev.activeSession.observedItemCount + 1,
      };
      return {
        ...prev,
        activeSession,
        messages: prev.messages,
      };
    });
  }

  const galleryMessage = gallery.find((g) => g.id === galleryId)?.message;
  const typedCommand = flow.openCommand ?? flow.closeCommand;
  const txLabel = flow.selection.txCode ? TX_CODE_TO_LABEL[flow.selection.txCode] : null;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
        <p className="text-sm font-semibold text-amber-900">PREVIEW ONLY — ไม่ส่ง LINE / ไม่เขียนฐานข้อมูล / ไม่เรียก Production</p>
        <p className="mt-1 text-sm text-amber-800">
          จำลองเมนู Guided Produce สำหรับ เบิก / ชั่งคืน / คืนเสีย — สัญญาโพสต์แบ็ก + คำสั่ง typed ตามแนว 0049
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={resetFlow}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
            >
              รีเซ็ตโฟลว์
            </button>
            {flow.screen === "active_session" && (
              <button
                type="button"
                onClick={bumpItems}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700"
              >
                +1 รายการ (จำลอง)
              </button>
            )}
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
              หน้าจอ: {flow.screen}
            </span>
            {txLabel && (
              <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                ประเภท: {txLabel}
              </span>
            )}
            {lastActionLabel && (
              <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-medium text-sky-700">
                ล่าสุด: {lastActionLabel}
              </span>
            )}
          </div>

          <PhoneFrame title="รายการผลิต (พรีวิว)">
            {currentMessages.map((message, idx) =>
              message.type === "flex" ? (
                <FlexBubbleView key={idx} message={message} />
              ) : (
                <TextBubbleView key={idx} message={message} />
              ),
            )}
            {flow.screen === "active_session" && flow.activeSession && (
              <div className="rounded-xl bg-white/80 px-3 py-2 text-xs text-slate-700">
                observed items: {flow.activeSession.observedItemCount}
              </div>
            )}
          </PhoneFrame>

          {flow.screen === "custom_date" && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
              <p className="text-sm font-semibold text-slate-900">ระบุวันที่ (พรีวิว)</p>
              <p className="text-xs text-slate-500">แสดงผลเป็น พ.ศ. ในสรุป — ค่าคำสั่งเป็น ISO</p>
              <input
                type="date"
                value={customIso}
                onChange={(e) => setCustomIso(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"
              />
              <button
                type="button"
                onClick={handleCustomDateConfirm}
                className="w-full min-h-11 rounded-xl bg-[#06C755] text-sm font-semibold text-white"
              >
                ยืนยันวันที่นี้
              </button>
            </div>
          )}

          <ActionPad targets={targets} onAction={handlePostback} />
        </div>

        <div className="space-y-4">
          <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
            <h2 className="text-sm font-semibold text-slate-900">คำสั่ง typed ที่จะถูกส่ง (0049 shape)</h2>
            {typedCommand ? (
              <pre className="overflow-x-auto rounded-lg bg-slate-950 p-3 text-[0.75rem] leading-relaxed text-emerald-300">
                {JSON.stringify(typedCommand, null, 2)}
              </pre>
            ) : (
              <p className="text-sm text-slate-500">
                ยังไม่มีคำสั่ง — ยืนยันและกด «เริ่มเซสชัน» หรือยืนยันจบรายการก่อน
              </p>
            )}
            <p className="text-xs text-slate-500">
              ไม่มีการสร้างหัวข้อไทยสังเคราะห์ (เช่น «ชื่อ-ตลาด เบิก …»)
            </p>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
            <h2 className="text-sm font-semibold text-slate-900">LINE message JSON</h2>
            <pre className="max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 text-[0.75rem] leading-relaxed text-sky-200">
              {JSON.stringify(currentMessages, null, 2)}
            </pre>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
            <h2 className="text-sm font-semibold text-slate-900">แกลเลอรีทุกสถานะ</h2>
            <div className="flex flex-wrap gap-2">
              {gallery.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setGalleryId(g.id)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                    galleryId === g.id
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>
            {galleryMessage && (
              <pre className="max-h-64 overflow-auto rounded-lg bg-slate-50 p-3 text-[0.6875rem] text-slate-700">
                {JSON.stringify(galleryMessage, null, 2)}
              </pre>
            )}
          </section>

          <section className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-xs text-slate-600 space-y-1">
            <p>selection: {JSON.stringify(flow.selection)}</p>
            <p>activeSession: {flow.activeSession ? "yes" : "no"}</p>
            <p>error: {flow.error ?? "—"}</p>
            <p>emptySelection helper: {JSON.stringify(emptySelection())}</p>
          </section>
        </div>
      </div>
    </div>
  );
}
