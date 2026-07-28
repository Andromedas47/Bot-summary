"use client";

import { useMemo, useState } from "react";
import {
  applyCustomDateInPreview,
  applyScenarioInPreview,
  buildAllPreviewStates,
  emptySelection,
  initialGuidedMenuFlow,
  PREVIEW_SCENARIOS,
  PREVIEW_STAFF_LABEL,
  reduceGuidedMenuPostback,
  sampleActiveSessionBase,
  sampleSelection,
  TX_CODE_TO_LABEL,
  applyCloseBarrierWaiting,
  applyScenarioToSession,
  type GuidedMenuFlowResult,
  type LinePreviewMessage,
  type PreviewScenarioId,
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
      <div className="overflow-hidden rounded-[1.75rem] border border-slate-300 bg-slate-900 shadow-xl">
        <div className="flex items-center justify-between bg-slate-950 px-4 py-2.5">
          <span className="text-[0.6875rem] font-medium text-slate-400">LINE Preview</span>
          <span className="rounded bg-amber-400/20 px-2 py-0.5 text-[0.625rem] font-bold tracking-wide text-amber-300">
            PREVIEW ONLY
          </span>
        </div>
        <div className="bg-[#747F8D] px-3 py-2 text-center text-[0.75rem] font-medium text-white">
          {title}
        </div>
        <div className="min-h-[520px] space-y-3 bg-[#8CABD8] p-3">{children}</div>
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
    <div className="overflow-hidden rounded-2xl bg-white shadow-md">
      <div className="space-y-1 bg-slate-900 px-4 py-3">
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
      <div className="space-y-2 px-4 py-3">
        {(body?.contents ?? []).map((block, i) => {
          if (block.type === "separator") {
            return <hr key={i} className="border-slate-200" />;
          }
          if (block.type === "text") {
            return (
              <p
                key={i}
                className={`break-words text-sm ${
                  block.weight === "bold" ? "font-semibold text-slate-900" : "text-slate-600"
                }`}
              >
                {String(block.text ?? "")}
              </p>
            );
          }
          if (block.type === "box" && Array.isArray(block.contents)) {
            const kids = block.contents as Array<{ text?: string; weight?: string }>;
            return (
              <div key={i} className="flex gap-2 text-sm">
                {kids.map((k, j) => (
                  <span
                    key={j}
                    className={k.weight === "bold" ? "flex-[3] font-semibold text-slate-900" : "flex-[2] text-slate-500"}
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
      <div className="space-y-2 border-t border-slate-100 p-3">
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
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{message.text}</p>
    </div>
  );
}

function ActionPad({
  targets,
  onAction,
}: {
  targets: { label: string; data: string }[];
  onAction: (data: string, label: string) => void;
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
            onClick={() => onAction(t.data, t.label)}
            className="min-h-11 min-w-[7.5rem] flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-800 shadow-sm hover:border-[#06C755] hover:text-[#059B45]"
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function LineMenuPreviewClient() {
  const [nowMs] = useState(() => Date.now());
  const [flow, setFlow] = useState<GuidedMenuFlowResult>(() => initialGuidedMenuFlow());
  const [lastActionLabel, setLastActionLabel] = useState<string | null>(null);
  const [customIso, setCustomIso] = useState("2026-07-27");
  const [scenarioId, setScenarioId] = useState<PreviewScenarioId>("valid");
  const [galleryId, setGalleryId] = useState("start_menu");

  const gallery = useMemo(() => {
    const base = sampleActiveSessionBase({ openedAtMs: nowMs });
    const validSession = applyScenarioToSession(base, "valid");
    const blockingSession = applyScenarioToSession(base, "partial_error");
    const barrierSession = applyCloseBarrierWaiting(validSession);
    return buildAllPreviewStates({
      selection: sampleSelection(),
      session: base,
      validSession,
      blockingSession,
      barrierSession,
      transactionLabel: "ชั่งคืน",
      marketLabel: "หน้าเซเวน",
      businessDateThai: "28 กรกฎาคม 2569",
      businessDateIso: "2026-07-28",
      staffLabel: PREVIEW_STAFF_LABEL,
    });
  }, [nowMs]);

  const currentMessages = flow.messages;
  const targets = currentMessages.flatMap(extractPostbackTargets);
  const session = flow.activeSession;
  const typedCommand = flow.openCommand ?? flow.closeCommand;
  const txLabel = flow.selection.txCode ? TX_CODE_TO_LABEL[flow.selection.txCode] : null;
  const galleryMessage = gallery.find((g) => g.id === galleryId)?.message;

  function handlePostback(data: string, label: string) {
    setLastActionLabel(label);
    setFlow((prev) =>
      reduceGuidedMenuPostback({
        data,
        selection: prev.selection,
        activeSession: prev.activeSession,
        lineTimestampMs: nowMs,
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

  function loadScenario(id: PreviewScenarioId) {
    setScenarioId(id);
    setFlow((prev) => {
      if (!prev.activeSession) return prev;
      setLastActionLabel(`โหลดสถานการณ์: ${PREVIEW_SCENARIOS[id].label}`);
      return applyScenarioInPreview({
        activeSession: prev.activeSession,
        scenarioId: id,
      });
    });
  }

  function resetFlow() {
    setLastActionLabel(null);
    setScenarioId("valid");
    setFlow(initialGuidedMenuFlow());
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
        <p className="text-sm font-semibold text-amber-900">
          PREVIEW ONLY — ไม่ส่ง LINE / ไม่เขียนฐานข้อมูล / ไม่เรียก Production
        </p>
        <p className="mt-1 text-sm text-amber-800">
          V1 flow: เริ่มรายการ → ประเภท → ตลาด → วันที่ → เปิดรายการ → ส่งต่อข้อความ → ตรวจและจบ → ยืนยันบันทึก
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

          {session && (
            <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                โหลดสถานการณ์ข้อความ (พรีวิว)
              </p>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(PREVIEW_SCENARIOS) as PreviewScenarioId[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => loadScenario(id)}
                    className={`rounded-lg px-3 py-2 text-xs font-semibold ${
                      scenarioId === id
                        ? "bg-slate-900 text-white"
                        : "border border-slate-200 bg-white text-slate-700"
                    }`}
                  >
                    {PREVIEW_SCENARIOS[id].label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-500">{PREVIEW_SCENARIOS[scenarioId].description}</p>
            </div>
          )}

          <PhoneFrame title="รายการผลิต (พรีวิว)">
            {currentMessages.map((message, idx) =>
              message.type === "flex" ? (
                <FlexBubbleView key={idx} message={message} />
              ) : (
                <TextBubbleView key={idx} message={message} />
              ),
            )}
          </PhoneFrame>

          {flow.screen === "custom_date" && (
            <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-slate-900">เลือกวันที่ (พรีวิว)</p>
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
                className="min-h-11 w-full rounded-xl bg-[#06C755] text-sm font-semibold text-white"
              >
                ยืนยันวันที่นี้
              </button>
            </div>
          )}

          <ActionPad targets={targets} onAction={handlePostback} />
        </div>

        <div className="space-y-4">
          <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-900">คำสั่ง typed (0049 shape)</h2>
            {typedCommand ? (
              <pre className="overflow-x-auto rounded-lg bg-slate-950 p-3 text-[0.75rem] leading-relaxed text-emerald-300">
                {JSON.stringify(typedCommand, null, 2)}
              </pre>
            ) : (
              <p className="text-sm text-slate-500">ยังไม่มีคำสั่ง — เปิดรายการหรือยืนยันบันทึกก่อน</p>
            )}
            <p className="text-xs text-slate-500">ไม่สร้างหัวข้อไทยสังเคราะห์</p>
          </section>

          <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-900">สถานะเซสชัน / close barrier</h2>
            {session ? (
              <pre className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 text-[0.75rem] leading-relaxed text-amber-200">
                {JSON.stringify(
                  {
                    receivedMessageCount: session.receivedMessageCount,
                    parsedItemCount: session.parsedItemCount,
                    blockingIssueCount: session.blockingIssueCount,
                    admittedEventCount: session.admittedEventCount,
                    ingestedEventCount: session.ingestedEventCount,
                    closeBarrierStatus: session.closeBarrierStatus,
                    reviewStatus: session.reviewStatus,
                    persistedSimulated: session.persistedSimulated,
                    items: session.items.map((i) => i.rawPreview),
                    issues: session.issues,
                  },
                  null,
                  2,
                )}
              </pre>
            ) : (
              <p className="text-sm text-slate-500">ยังไม่มีเซสชันเปิด</p>
            )}
          </section>

          <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-900">LINE message JSON</h2>
            <pre className="max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 text-[0.75rem] leading-relaxed text-sky-200">
              {JSON.stringify(currentMessages, null, 2)}
            </pre>
          </section>

          <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
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

          <section className="space-y-1 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-xs text-slate-600">
            <p>selection: {JSON.stringify(flow.selection)}</p>
            <p>error: {flow.error ?? "—"}</p>
            <p>emptySelection: {JSON.stringify(emptySelection())}</p>
          </section>
        </div>
      </div>
    </div>
  );
}
