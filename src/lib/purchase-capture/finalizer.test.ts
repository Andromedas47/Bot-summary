import { describe, expect, test } from "bun:test";
import { listUndeliveredNotificationWork } from "./finalizer";

type NotificationRow = {
  session_id: string;
  notification_kind: string;
  notification_version: string;
  delivery_status: string;
  claim_expires_at: string | null;
};

function mockSupabase(
  notifications: NotificationRow[],
  sessionStatus: Record<string, { source_id: string; status: string }>,
) {
  return {
    from(table: string) {
      if (table === "purchase_capture_notifications") {
        const api: Record<string, unknown> = {};
        api.select = () => api;
        api.neq = () => api;
        api.order = () => api;
        api.limit = async () => ({ data: notifications, error: null });
        return api;
      }
      if (table === "purchase_capture_sessions") {
        // Mirrors the real (chainable-then-awaitable) PostgrestFilterBuilder:
        // .in("id", ...) narrows nothing in this fake (id filtering is a
        // no-op — every row not present in sessionStatus is simply absent),
        // .in("status", [...]) records the status allow-list, and the
        // object itself is thenable so `await` resolves after any filter.
        let statusFilter: string[] | null = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api: any = {
          select: () => api,
          in: (column: string, values: string[]) => {
            if (column === "status") statusFilter = values;
            return api;
          },
          then: (
            resolve: (value: { data: unknown[]; error: null }) => unknown,
            reject?: (reason: unknown) => unknown,
          ) => {
            const rows = Object.entries(sessionStatus)
              .filter(([, session]) => statusFilter == null || statusFilter.includes(session.status))
              .map(([id, session]) => ({ id, source_id: session.source_id, status: session.status }));
            return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
          },
        };
        return api;
      }
      throw new Error(`unexpected ${table}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("listUndeliveredNotificationWork", () => {
  test("discovers pending, failed, and expired sending without age cutoff", async () => {
    const now = new Date().toISOString();
    const notifications: NotificationRow[] = [
      {
        session_id: "s-old-pending",
        notification_kind: "preview_ready",
        notification_version: "1",
        delivery_status: "pending",
        claim_expires_at: null,
      },
      {
        session_id: "s-failed",
        notification_kind: "preview_ready",
        notification_version: "2",
        delivery_status: "failed",
        claim_expires_at: null,
      },
      {
        session_id: "s-expired",
        notification_kind: "preview_ready",
        notification_version: "3",
        delivery_status: "sending",
        claim_expires_at: "2020-01-01T00:00:00.000Z",
      },
      {
        session_id: "s-active-lease",
        notification_kind: "preview_ready",
        notification_version: "4",
        delivery_status: "sending",
        claim_expires_at: "2099-01-01T00:00:00.000Z",
      },
      {
        session_id: "s-delivered",
        notification_kind: "preview_ready",
        notification_version: "5",
        delivery_status: "delivered",
        claim_expires_at: null,
      },
    ];
    const sessions = {
      "s-old-pending": { source_id: "G-old", status: "awaiting_confirmation" },
      "s-failed": { source_id: "G-failed", status: "awaiting_confirmation" },
      "s-expired": { source_id: "G-expired", status: "awaiting_confirmation" },
      "s-active-lease": { source_id: "G-active", status: "awaiting_confirmation" },
      "s-delivered": { source_id: "G-delivered", status: "awaiting_confirmation" },
    };

    const work = await listUndeliveredNotificationWork(
      mockSupabase(notifications, sessions),
      10,
    );
    expect(work.map((item) => item.sessionId).sort()).toEqual([
      "s-expired",
      "s-failed",
      "s-old-pending",
    ]);
    expect(work.find((item) => item.sessionId === "s-active-lease")).toBeUndefined();
    expect(work.find((item) => item.sessionId === "s-delivered")).toBeUndefined();
    expect(now).toBeTruthy();
  });

  test("respects bounded sweep limit", async () => {
    const notifications: NotificationRow[] = Array.from({ length: 10 }, (_, index) => ({
      session_id: `s-${index}`,
      notification_kind: "preview_ready",
      notification_version: "1",
      delivery_status: "pending",
      claim_expires_at: null,
    }));
    const sessions = Object.fromEntries(
      notifications.map((row) => [
        row.session_id,
        { source_id: `G-${row.session_id}`, status: "awaiting_confirmation" },
      ]),
    );

    const work = await listUndeliveredNotificationWork(
      mockSupabase(notifications, sessions),
      3,
    );
    expect(work).toHaveLength(3);
  });
});
