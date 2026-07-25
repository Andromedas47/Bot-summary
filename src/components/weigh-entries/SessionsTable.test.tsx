import { describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProduceSession } from "@/types";
import { canVoidProduceSession, SessionsTable } from "./SessionsTable";

mock.module("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

function session(overrides: Partial<ProduceSession> = {}): ProduceSession {
  return {
    id: "sess-active-1",
    raw_message_id: "raw-1",
    line_user_id: null,
    staff_name: "กี้",
    sender_name: null,
    transaction_time: null,
    session_date: "2026-07-25",
    session_title: "ทดสอบเงินโอน เบิก",
    total_items: 3,
    parser_errors: null,
    created_at: "2026-07-25T01:00:00.000Z",
    declared_transaction_type: "เบิก",
    voided_at: null,
    voided_by: null,
    void_reason: null,
    ...overrides,
  };
}

describe("canVoidProduceSession", () => {
  it("allows Void only for active/non-voided sessions", () => {
    expect(canVoidProduceSession({ voided_at: null })).toBe(true);
    expect(canVoidProduceSession({ voided_at: undefined })).toBe(true);
    expect(canVoidProduceSession({ voided_at: "2026-07-25T10:00:00.000Z" })).toBe(false);
  });
});

describe("SessionsTable void UX", () => {
  it("shows Void action for an active session", () => {
    const html = renderToStaticMarkup(
      <SessionsTable sessions={[session({ id: "sess-active-1" })]} />,
    );
    expect(html).toContain('data-testid="void-button-sess-active-1"');
    expect(html).toContain("Void");
    expect(html).not.toContain("VOIDED");
  });

  it("does not allow another Void for an already voided session", () => {
    const html = renderToStaticMarkup(
      <SessionsTable
        sessions={[
          session({
            id: "sess-void-1",
            voided_at: "2026-07-25T10:00:00.000Z",
            voided_by: "admin-1",
            void_reason: "UAT",
          }),
        ]}
      />,
    );
    expect(html).toContain("VOIDED");
    expect(html).toContain('data-testid="voided-label-sess-void-1"');
    expect(html).not.toContain('data-testid="void-button-sess-void-1"');
  });
});
