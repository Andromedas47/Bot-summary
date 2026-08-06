import { afterEach, describe, expect, it } from "bun:test";
import {
  LinePushError,
} from "./reply";
import {
  notificationRetryDelayMs,
  processDueProduceNotifications,
  resendProduceNotification,
  type ProduceNotificationRecord,
} from "./produce-notification-delivery";

const originalVercelEnv = process.env.VERCEL_ENV;
afterEach(() => {
  if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
});

const NOW = new Date("2026-07-03T00:00:00.000Z");

function notification(
  overrides: Partial<ProduceNotificationRecord> = {},
): ProduceNotificationRecord {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    produce_session_id: "20000000-0000-4000-8000-000000000002",
    session_key: "group:g-1:user:u-1",
    session_generation: "30000000-0000-4000-8000-000000000003",
    source_id: "g-1",
    correlation_id: "group:g-1:user:u-1:gen-1",
    notification_status: "sending",
    notification_attempt_count: 1,
    notification_cycle_attempt_count: 1,
    notification_retryable: true,
    last_notification_error: null,
    last_notification_attempt_at: NOW.toISOString(),
    notification_sent_at: null,
    notification_payload: "stored deterministic summary",
    line_retry_key: "40000000-0000-4000-8000-000000000004",
    next_notification_attempt_at: null,
    sending_started_at: NOW.toISOString(),
    resend_count: 0,
    last_resend_requested_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

function makeDueClient(claims: ProduceNotificationRecord[][]) {
  const calls: RpcCall[] = [];
  return {
    calls,
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "claim_due_produce_notifications") {
        return { data: claims.shift() ?? [], error: null };
      }
      if (name === "complete_produce_notification_attempt") {
        return { data: true, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
}

describe("produce notification delivery", () => {
  it("finalization success + push success becomes sent", async () => {
    const row = notification();
    const client = makeDueClient([[row]]);
    const pushes: Array<[string, string, string]> = [];

    const result = await processDueProduceNotifications(
      client as never,
      async (to, text, retryKey) => {
        pushes.push([to, text, retryKey]);
      },
      25,
      NOW,
    );

    expect(result).toMatchObject({ claimed: 1, sent: 1, errors: 0 });
    expect(pushes).toEqual([[
      row.source_id,
      row.notification_payload,
      row.line_retry_key,
    ]]);
    expect(client.calls.at(-1)).toMatchObject({
      name: "complete_produce_notification_attempt",
      args: { p_status: "sent", p_retryable: false },
    });
  });

  it("first push 429 + retry success is sent once with one stable retry key", async () => {
    const first = notification();
    const second = notification({
      notification_attempt_count: 2,
      notification_cycle_attempt_count: 2,
    });
    const client = makeDueClient([[first], [second]]);
    const retryKeys: string[] = [];
    let acceptedDeliveries = 0;
    let pushAttempts = 0;
    const push = async (_to: string, _text: string, retryKey: string) => {
      pushAttempts += 1;
      retryKeys.push(retryKey);
      if (pushAttempts === 1) {
        throw new LinePushError("LINE push HTTP 429", 429, true, 12_000);
      }
      acceptedDeliveries += 1;
    };

    const firstRun = await processDueProduceNotifications(
      client as never,
      push,
      25,
      NOW,
    );
    const secondRun = await processDueProduceNotifications(
      client as never,
      push,
      25,
      new Date(NOW.getTime() + 12_000),
    );

    expect(firstRun.retryScheduled).toBe(1);
    expect(secondRun.sent).toBe(1);
    expect(acceptedDeliveries).toBe(1);
    expect(retryKeys).toEqual([first.line_retry_key, first.line_retry_key]);
    const completions = client.calls.filter(
      (call) => call.name === "complete_produce_notification_attempt",
    );
    expect(completions[0].args).toMatchObject({
      p_status: "failed",
      p_retryable: true,
      p_retry_after_ms: 12_000,
      p_next_attempt_at: "2026-07-03T00:00:12.000Z",
    });
    expect(completions[1].args).toMatchObject({ p_status: "sent" });
  });

  it("5xx uses bounded exponential retry", async () => {
    const row = notification({
      notification_attempt_count: 3,
      notification_cycle_attempt_count: 3,
    });
    const client = makeDueClient([[row]]);

    const result = await processDueProduceNotifications(
      client as never,
      async () => {
        throw new LinePushError("LINE push HTTP 503", 503, true);
      },
      25,
      NOW,
    );

    expect(result.retryScheduled).toBe(1);
    expect(client.calls.at(-1)?.args).toMatchObject({
      p_status: "failed",
      p_retryable: true,
      p_http_status: 503,
      p_next_attempt_at: "2026-07-03T00:00:20.000Z",
    });
    expect(notificationRetryDelayMs(3, null)).toBe(20_000);
  });

  it("stops retrying a 5xx after the fifth cycle attempt", async () => {
    const row = notification({
      notification_attempt_count: 5,
      notification_cycle_attempt_count: 5,
    });
    const client = makeDueClient([[row]]);

    const result = await processDueProduceNotifications(
      client as never,
      async () => {
        throw new LinePushError("LINE push HTTP 500", 500, true);
      },
      25,
      NOW,
    );

    expect(result.failed).toBe(1);
    expect(client.calls.at(-1)?.args).toMatchObject({
      p_status: "failed",
      p_retryable: false,
      p_next_attempt_at: null,
    });
  });

  it("permanent 4xx becomes failed without touching accounting", async () => {
    const row = notification();
    const client = makeDueClient([[row]]);

    const result = await processDueProduceNotifications(
      client as never,
      async () => {
        throw new LinePushError(
          "LINE push HTTP 400: invalid destination",
          400,
          false,
        );
      },
      25,
      NOW,
    );

    expect(result.failed).toBe(1);
    expect(client.calls.map((call) => call.name)).toEqual([
      "claim_due_produce_notifications",
      "complete_produce_notification_attempt",
    ]);
    expect(client.calls.at(-1)?.args).toMatchObject({
      p_status: "failed",
      p_retryable: false,
      p_error: "LINE push HTTP 400: invalid destination",
    });
  });

  it("two overlapping workers claim and push the notification only once", async () => {
    const row = notification();
    const claims = [[row], []] as ProduceNotificationRecord[][];
    const client = makeDueClient(claims);
    let pushCount = 0;
    const push = async () => {
      pushCount += 1;
    };

    const [first, second] = await Promise.all([
      processDueProduceNotifications(client as never, push, 25, NOW),
      processDueProduceNotifications(client as never, push, 25, NOW),
    ]);

    expect(first.claimed + second.claimed).toBe(1);
    expect(first.sent + second.sent).toBe(1);
    expect(pushCount).toBe(1);
  });

  it("an accepted push with a completion-write failure stays recoverable", async () => {
    const row = notification();
    const client = {
      rpc: async (name: string) => {
        if (name === "claim_due_produce_notifications") {
          return { data: [row], error: null };
        }
        return { data: null, error: { message: "database unavailable" } };
      },
    };
    let pushCount = 0;

    const result = await processDueProduceNotifications(
      client as never,
      async () => {
        pushCount += 1;
      },
      25,
      NOW,
    );

    expect(pushCount).toBe(1);
    expect(result).toMatchObject({ claimed: 1, errors: 1, failed: 0 });
  });
});

describe("operator resend", () => {
  it("sends only the stored summary and invokes no accounting operation", async () => {
    const claimed = notification({
      line_retry_key: "50000000-0000-4000-8000-000000000005",
      notification_attempt_count: 6,
      notification_cycle_attempt_count: 1,
      resend_count: 1,
    });
    const calls: RpcCall[] = [];
    const client = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "requeue_produce_notification") {
          return { data: [claimed], error: null };
        }
        if (name === "complete_produce_notification_attempt") {
          return { data: true, error: null };
        }
        throw new Error(`unexpected RPC ${name}`);
      },
    };
    const pushes: Array<[string, string, string]> = [];

    const result = await resendProduceNotification(
      client as never,
      claimed.produce_session_id,
      async (to, text, retryKey) => {
        pushes.push([to, text, retryKey]);
      },
      NOW,
    );

    expect(result).toBe("sent");
    expect(pushes).toEqual([[
      claimed.source_id,
      "stored deterministic summary",
      claimed.line_retry_key,
    ]]);
    expect(calls.map((call) => call.name)).toEqual([
      "requeue_produce_notification",
      "complete_produce_notification_attempt",
    ]);
  });
});

describe("notification claim — runtime environment ownership", () => {
  // Regression: Preview successfully finalizing a session creates a
  // produce_session_notifications row. Production's globally scoped claim
  // RPC could dequeue it and push using Production's LINE credentials before
  // this fix — the write would succeed while the originating (Preview/Test
  // OA) channel never receives the summary. The actual claim-time isolation
  // is enforced inside claim_due_produce_notifications (SQL, see
  // 0061_pending_session_runtime_environment.sql) — this only verifies the
  // TypeScript caller always tells the RPC which environment it is.

  it("passes p_environment='production' when running as Production", async () => {
    process.env.VERCEL_ENV = "production";
    const client = makeDueClient([[]]);

    await processDueProduceNotifications(client as never);

    const call = client.calls.find((c) => c.name === "claim_due_produce_notifications");
    expect(call?.args).toMatchObject({ p_environment: "production" });
  });

  it("passes p_environment='preview' when running as Preview", async () => {
    process.env.VERCEL_ENV = "preview";
    const client = makeDueClient([[]]);

    await processDueProduceNotifications(client as never);

    const call = client.calls.find((c) => c.name === "claim_due_produce_notifications");
    expect(call?.args).toMatchObject({ p_environment: "preview" });
  });

  it("fails safe to p_environment='development' when VERCEL_ENV is unset", async () => {
    delete process.env.VERCEL_ENV;
    const client = makeDueClient([[]]);

    await processDueProduceNotifications(client as never);

    const call = client.calls.find((c) => c.name === "claim_due_produce_notifications");
    expect(call?.args).toMatchObject({ p_environment: "development" });
  });
});

describe("notification migration contract", () => {
  const migrationPath = new URL(
    "../../../supabase/migrations/0034_produce_notification_delivery.sql",
    import.meta.url,
  );
  const retryScheduleFixPath = new URL(
    "../../../supabase/migrations/0035_fix_notification_retry_schedule.sql",
    import.meta.url,
  );

  it("creates accounting and one pending outbox row in the same finalization RPC", async () => {
    const sql = await Bun.file(migrationPath).text();
    const finalizer = sql.slice(sql.indexOf(
      "CREATE OR REPLACE FUNCTION public.try_finalize_pending_generation",
    ));

    expect(finalizer).toContain("FOR UPDATE");
    expect(finalizer).toContain("INSERT INTO public.produce_sessions");
    expect(finalizer).toContain("INSERT INTO public.produce_items");
    expect(finalizer).toContain("INSERT INTO public.produce_session_notifications");
    expect(finalizer).toContain("finalization_status = 'finalized'");
    expect(sql).toContain("produce_session_id                uuid NOT NULL UNIQUE");
  });

  it("serializes worker overlap and keeps resend isolated from accounting", async () => {
    const sql = await Bun.file(migrationPath).text();
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("notification_status = 'sending'");
    expect(sql).toContain("notification_attempt_count = n.notification_attempt_count + 1");

    const resendSql = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.requeue_produce_notification"),
      sql.indexOf("-- Latest finalization authority"),
    );
    expect(resendSql).not.toContain("notification_payload =");
    expect(resendSql).not.toContain("INSERT INTO public.produce_sessions");
    expect(resendSql).not.toContain("INSERT INTO public.produce_items");
  });

  it("allows a due notification claim to clear its retry schedule without recreating accounting", async () => {
    const sql = await Bun.file(migrationPath).text();
    const fixSql = await Bun.file(retryScheduleFixPath).text();
    const claimSql = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.claim_due_produce_notifications"),
      sql.indexOf("-- Claim exactly one already-queued notification"),
    );

    expect(fixSql).toContain(
      "ALTER COLUMN next_notification_attempt_at DROP NOT NULL",
    );
    expect(claimSql).toContain("n.next_notification_attempt_at <= now()");
    expect(claimSql).toContain("next_notification_attempt_at = NULL");
    expect(claimSql).toContain(
      "notification_attempt_count = n.notification_attempt_count + 1",
    );
    expect(claimSql).not.toContain("INSERT INTO public.produce_sessions");
    expect(claimSql).not.toContain("INSERT INTO public.produce_items");
  });

  it("does not add a cron or alter Release B quiet-window admission", async () => {
    const sql = await Bun.file(migrationPath).text();
    expect(sql).not.toContain("cron.schedule");
    expect(sql).not.toContain("append_pending_session");
    expect(sql).not.toContain("interval '8 seconds'");
  });
});

describe("notification environment ownership migration contract (0061)", () => {
  const envMigrationPath = new URL(
    "../../../supabase/migrations/0061_pending_session_runtime_environment.sql",
    import.meta.url,
  );

  it("stamps notification ownership from the locked pending_sessions row, not re-derived independently", async () => {
    const sql = await Bun.file(envMigrationPath).text();
    const finalizer = sql.slice(sql.indexOf(
      "CREATE OR REPLACE FUNCTION public.try_finalize_pending_generation",
    ));

    expect(finalizer).toContain("SELECT * INTO v_row");
    expect(finalizer).toContain("FOR UPDATE");
    const insert = finalizer.slice(
      finalizer.indexOf("INSERT INTO public.produce_session_notifications"),
      finalizer.indexOf("RETURNING id INTO v_notification_id"),
    );
    expect(insert).toContain("runtime_environment");
    expect(insert).toContain("v_row.runtime_environment");
  });

  it("claim RPC requires an explicit environment and never trusts a caller-supplied default of production", async () => {
    const sql = await Bun.file(envMigrationPath).text();
    const claim = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.claim_due_produce_notifications"),
    );

    expect(claim).toContain("RAISE EXCEPTION");
    expect(claim).toContain("p_environment IS NULL OR p_environment NOT IN");
    expect(claim).toContain("n.runtime_environment = 'production' OR n.runtime_environment IS NULL");
    expect(claim).toContain("n.runtime_environment = p_environment");
    expect(claim).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("keeps the legacy 1-arg claim RPC for rollout safety, hardcoded to production only", async () => {
    const sql = await Bun.file(envMigrationPath).text();

    // Never dropped mid-rollout — Production's currently running cron still
    // calls the 1-arg signature until it is itself redeployed onto the new
    // code that calls the 2-arg RPC.
    expect(sql).not.toContain("DROP FUNCTION IF EXISTS public.claim_due_produce_notifications(integer)");

    const wrapper = sql.slice(
      sql.lastIndexOf("CREATE OR REPLACE FUNCTION public.claim_due_produce_notifications(\n  p_limit integer DEFAULT 25\n)"),
    );
    expect(wrapper).toContain(
      "SELECT * FROM public.claim_due_produce_notifications(p_limit, 'production');",
    );
    // Fixed to 'production', not parameterized — this wrapper can never be
    // made to claim a 'preview' or 'development' row regardless of caller.
    expect(wrapper).not.toContain("p_environment text");
  });

  it("grants both the legacy 1-arg and new 2-arg signatures to service_role only", async () => {
    const sql = await Bun.file(envMigrationPath).text();
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.claim_due_produce_notifications(integer, text) TO service_role;");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.claim_due_produce_notifications(integer) TO service_role;");
  });
});
