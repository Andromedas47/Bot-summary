/**
 * PostgreSQL 17 proof for migration 20260820090000
 * (produce_notification_boundary_lockdown) — the P0 security lockdown of
 * produce_session_notifications / produce_notification_attempts.
 *
 * What has to be true, and is proven here against a real database (not just
 * catalog lookups):
 *
 *   * RLS is enabled AND forced on both tables;
 *   * anon and authenticated cannot SELECT, INSERT, UPDATE, DELETE, or
 *     TRUNCATE either table — attempted as those roles, not inferred;
 *   * anon and authenticated specifically cannot alter source_id,
 *     notification_payload, status, or next_notification_attempt_at;
 *   * anon and authenticated cannot EXECUTE requeue_produce_notification or
 *     complete_produce_notification_attempt;
 *   * service_role can still do everything the worker needs: create a
 *     notification row the way try_finalize_pending_generation does, claim
 *     it, complete the attempt, and requeue a legitimate notification;
 *   * the migration is idempotent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `notif_lockdown_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^notif_lockdown_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const MIGRATION = join(
  ROOT, "supabase", "migrations",
  "20260820090000_produce_notification_boundary_lockdown.sql",
);
const DEPENDENCY_MIGRATIONS = [
  "0034_produce_notification_delivery.sql",
  // Drops the NOT NULL on next_notification_attempt_at — claim_due sets it
  // to NULL when it moves a row to 'sending', which fails without this.
  "0035_fix_notification_retry_schedule.sql",
].map((name) => join(ROOT, "supabase", "migrations", name));
const BOOTSTRAP = join(
  ROOT, "supabase", "tests", "produce_notification_boundary_bootstrap.sql",
);

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-produce-notification-boundary-lockdown.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
    );
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };

function spawnPsql(args: string[], database = DATABASE, stdin?: string) {
  return Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    env: {
      ...process.env,
      PGHOST,
      PGUSER,
      PGPASSWORD,
      PGPORT,
      PGDATABASE: database,
      PGCLIENTENCODING: "UTF8",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function collect(proc: ReturnType<typeof spawnPsql>): Promise<PsqlResult> {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function psql(args: string[], database = DATABASE, stdin?: string): Promise<PsqlResult> {
  return collect(spawnPsql(args, database, stdin));
}

/**
 * Runs as the connecting superuser (PGUSER), ON_ERROR_STOP. `-q` suppresses
 * command tags ("SET", "INSERT 0 1", ...) so stdout carries only real query
 * output — required once a script mixes `SET ROLE` with data-returning
 * statements.
 */
function run(sql: string): Promise<PsqlResult> {
  return psql(["-v", "ON_ERROR_STOP=1", "-q", "-tA", "-f", "-"], DATABASE, sql);
}

/**
 * Runs SQL after `SET ROLE <role>` in the same session/connection, so the
 * grant/RLS boundary is exercised as that role would actually experience it
 * — not inferred from catalog privilege lookups. ON_ERROR_STOP=1 is required
 * here: without it, psql silently swallows a mid-script permission-denied
 * error and still exits 0.
 */
function runAs(role: string, sql: string): Promise<PsqlResult> {
  return psql(
    ["-v", "ON_ERROR_STOP=1", "-q", "-tA", "-f", "-"],
    DATABASE,
    `SET ROLE ${role};\n${sql}`,
  );
}

async function scalar(sql: string): Promise<string> {
  const result = await run(sql);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

async function apply(file: string): Promise<void> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", file]);
  expect(result.code, `${file}\n${result.stderr}\n${result.stdout}`).toBe(0);
}

async function probe(): Promise<boolean> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !ALLOWED_HOSTS.has(PGHOST)) {
    return false;
  }
  try {
    const result = await psql(["-tAc", "SHOW server_version_num"], "postgres");
    return result.code === 0 && Number(result.stdout.trim()) >= 170000;
  } catch {
    return false;
  }
}

function q(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

let sequence = 1;
function nextUuid(): string {
  return `00000000-0000-4000-9000-${String(sequence++).padStart(12, "0")}`;
}

/** Asserts a role's statement was refused with a permission-denied error and wrote nothing. */
function expectDenied(result: PsqlResult, context: string): void {
  expect(result.code, `${context} unexpectedly succeeded:\n${result.stdout}`).not.toBe(0);
  expect(
    /permission denied/i.test(result.stderr),
    `${context} failed for a reason OTHER than permission denied:\n${result.stderr}`,
  ).toBe(true);
}

async function seedProduceSession(): Promise<string> {
  const id = nextUuid();
  await scalar(`
    INSERT INTO public.produce_sessions (id, session_date, staff_name)
    VALUES (${q(id)}::uuid, DATE '2026-08-20', 'ทดสอบ')
    RETURNING 1`);
  return id;
}

const pgAvailable = await probe();
let databaseCreated = false;
// Captured in beforeAll, BEFORE the lockdown migration is applied. This is
// the load-bearing proof that the bootstrap reproduces the actual bug this
// migration fixes — not just the roles and tables, but the vulnerable
// starting privileges (production's project-level ALTER DEFAULT PRIVILEGES).
// If the bootstrap ever regresses to a "clean by accident" local database,
// `preLockdownState` flips to already-safe and the assertions on it below
// fail loudly, instead of the whole suite silently becoming a no-op check.
let preLockdownState: {
  anonSelect: string;
  anonInsert: string;
  anonExecuteRequeue: string;
  anonOrAuthenticatedExecuteClaimDue: string;
} | null = null;

describe.skipIf(!pgAvailable)(
  "produce notification boundary lockdown on PostgreSQL 17",
  () => {
    beforeAll(async () => {
      assertSafe();
      const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
      expect(created.code, created.stderr).toBe(0);
      databaseCreated = true;
      await apply(BOOTSTRAP);
      for (const migration of DEPENDENCY_MIGRATIONS) await apply(migration);

      preLockdownState = {
        anonSelect: await scalar(`
          SELECT has_table_privilege('anon', 'public.produce_session_notifications', 'SELECT')::text`),
        anonInsert: await scalar(`
          SELECT has_table_privilege('anon', 'public.produce_session_notifications', 'INSERT')::text`),
        anonExecuteRequeue: await scalar(`
          SELECT has_function_privilege('anon',
            (SELECT oid FROM pg_proc WHERE proname = 'requeue_produce_notification'),
            'EXECUTE')::text`),
        // claim_due_produce_notifications is only cleaned up by 0050/0061/
        // 0062, none of which this minimal harness applies (out of scope
        // dependency chain for an out-of-scope function). So in THIS
        // disposable database it is expected to still be default-ACL dirty
        // before AND after the lockdown migration — the migration must
        // leave it exactly as it found it, not clean it. See the matching
        // assertion below.
        anonOrAuthenticatedExecuteClaimDue: await scalar(`
          SELECT (has_function_privilege('anon', oid, 'EXECUTE')
            OR has_function_privilege('authenticated', oid, 'EXECUTE'))::text
          FROM pg_proc WHERE proname = 'claim_due_produce_notifications'
          LIMIT 1`),
      };

      await apply(MIGRATION);
    }, 120_000);

    afterAll(async () => {
      if (!databaseCreated) return;
      await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
    });

    test("the bootstrap actually reproduces the vulnerable pre-migration state", () => {
      // If this fails, every "anon cannot ..." test below is meaningless —
      // it would be proving anon was never able to do it in the first
      // place, not that the migration stopped it. This is the regression
      // guard for that exact failure mode.
      expect(preLockdownState).not.toBeNull();
      expect(preLockdownState!.anonSelect).toBe("true");
      expect(preLockdownState!.anonInsert).toBe("true");
      expect(preLockdownState!.anonExecuteRequeue).toBe("true");
    });

    test("the migration is idempotent", async () => {
      await apply(MIGRATION);
      expect(await scalar(`
        SELECT (relrowsecurity AND relforcerowsecurity)::text
        FROM pg_class WHERE oid = 'public.produce_session_notifications'::regclass`))
        .toBe("true");
      expect(await scalar(`
        SELECT (relrowsecurity AND relforcerowsecurity)::text
        FROM pg_class WHERE oid = 'public.produce_notification_attempts'::regclass`))
        .toBe("true");
    });

    // ── RLS enabled + forced ────────────────────────────────────────────────

    test("row level security is enabled and forced on both tables", async () => {
      for (const table of ["produce_session_notifications", "produce_notification_attempts"]) {
        expect(await scalar(`
          SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.${table}'::regclass`))
          .toBe("true");
        expect(await scalar(`
          SELECT relforcerowsecurity::text FROM pg_class WHERE oid = 'public.${table}'::regclass`))
          .toBe("true");
      }
    });

    // ── anon / authenticated: no table access at all ───────────────────────

    for (const role of ["anon", "authenticated"] as const) {
      test(`${role} cannot SELECT from either notification table`, async () => {
        expectDenied(
          await runAs(role, "SELECT * FROM public.produce_session_notifications;"),
          `${role} SELECT produce_session_notifications`,
        );
        expectDenied(
          await runAs(role, "SELECT * FROM public.produce_notification_attempts;"),
          `${role} SELECT produce_notification_attempts`,
        );
      });

      test(`${role} cannot INSERT into either notification table`, async () => {
        const sessionId = await seedProduceSession();
        expectDenied(
          await runAs(role, `
            INSERT INTO public.produce_session_notifications (
              produce_session_id, session_key, session_generation,
              source_id, correlation_id, notification_payload
            ) VALUES (
              ${q(sessionId)}::uuid, 'k', gen_random_uuid(), 's', 'c', 'payload'
            );`),
          `${role} INSERT produce_session_notifications`,
        );
        expect(await scalar(`
          SELECT count(*)::text FROM public.produce_session_notifications
          WHERE produce_session_id = ${q(sessionId)}::uuid`)).toBe("0");

        expectDenied(
          await runAs(role, `
            INSERT INTO public.produce_notification_attempts (
              notification_id, attempt_number, cycle_attempt_number,
              correlation_id, transition_from
            ) VALUES (gen_random_uuid(), 1, 1, 'c', 'pending');`),
          `${role} INSERT produce_notification_attempts`,
        );
      });

      test(`${role} cannot UPDATE, DELETE, or TRUNCATE either notification table`, async () => {
        const sessionId = await seedProduceSession();
        const notificationId = await scalar(`
          INSERT INTO public.produce_session_notifications (
            produce_session_id, session_key, session_generation,
            source_id, correlation_id, notification_payload
          ) VALUES (
            ${q(sessionId)}::uuid, 'k', gen_random_uuid(), 's', 'c', 'payload'
          ) RETURNING id::text`);

        expectDenied(
          await runAs(role, `
            UPDATE public.produce_session_notifications
            SET notification_status = 'sent' WHERE id = ${q(notificationId)}::uuid;`),
          `${role} UPDATE produce_session_notifications`,
        );
        expectDenied(
          await runAs(role, `
            DELETE FROM public.produce_session_notifications WHERE id = ${q(notificationId)}::uuid;`),
          `${role} DELETE produce_session_notifications`,
        );
        expectDenied(
          await runAs(role, "TRUNCATE public.produce_session_notifications;"),
          `${role} TRUNCATE produce_session_notifications`,
        );
        expectDenied(
          await runAs(role, "TRUNCATE public.produce_notification_attempts;"),
          `${role} TRUNCATE produce_notification_attempts`,
        );

        // Nothing above touched anything — the row is exactly as it was.
        expect(await scalar(`
          SELECT notification_status FROM public.produce_session_notifications
          WHERE id = ${q(notificationId)}::uuid`)).toBe("pending");
      });

      test(`${role} cannot alter source_id, notification_payload, status, or next_notification_attempt_at`, async () => {
        const sessionId = await seedProduceSession();
        const notificationId = await scalar(`
          INSERT INTO public.produce_session_notifications (
            produce_session_id, session_key, session_generation,
            source_id, correlation_id, notification_payload
          ) VALUES (
            ${q(sessionId)}::uuid, 'k', gen_random_uuid(), 'original-source', 'c', 'original-payload'
          ) RETURNING id::text`);

        const columnAttacks: Array<[string, string]> = [
          ["source_id", "'attacker-source'"],
          ["notification_payload", "'attacker payload'"],
          ["notification_status", "'sent'"],
          ["next_notification_attempt_at", "now()"],
        ];
        for (const [column, value] of columnAttacks) {
          expectDenied(
            await runAs(role, `
              UPDATE public.produce_session_notifications
              SET ${column} = ${value} WHERE id = ${q(notificationId)}::uuid;`),
            `${role} UPDATE ${column}`,
          );
        }

        expect(await scalar(`
          SELECT source_id FROM public.produce_session_notifications
          WHERE id = ${q(notificationId)}::uuid`)).toBe("original-source");
        expect(await scalar(`
          SELECT notification_payload FROM public.produce_session_notifications
          WHERE id = ${q(notificationId)}::uuid`)).toBe("original-payload");
        expect(await scalar(`
          SELECT notification_status FROM public.produce_session_notifications
          WHERE id = ${q(notificationId)}::uuid`)).toBe("pending");
      });

      test(`${role} cannot EXECUTE requeue_produce_notification`, async () => {
        expectDenied(
          await runAs(role, `SELECT public.requeue_produce_notification('${nextUuid()}'::uuid);`),
          `${role} EXECUTE requeue_produce_notification`,
        );
      });

      test(`${role} cannot EXECUTE complete_produce_notification_attempt`, async () => {
        expectDenied(
          await runAs(role, `
            SELECT public.complete_produce_notification_attempt(
              '${nextUuid()}'::uuid, 1, 'sent');`),
          `${role} EXECUTE complete_produce_notification_attempt`,
        );
      });
    }

    // ── service_role: the intended server flow still works end to end ──────

    test("service_role can create a notification row the way try_finalize_pending_generation does", async () => {
      const sessionId = await seedProduceSession();
      const generation = nextUuid();
      const inserted = await run(`
        SET ROLE service_role;
        INSERT INTO public.produce_session_notifications (
          produce_session_id, session_key, session_generation,
          source_id, correlation_id, notification_payload
        ) VALUES (
          '${sessionId}'::uuid, 'session-key-1', '${generation}'::uuid,
          'line-source', 'corr-1', 'hello from the finalizer'
        );`);
      expect(inserted.code, inserted.stderr).toBe(0);
      // Read back as the superuser (owner + BYPASSRLS): proves the row was
      // really written, independent of who is allowed to read it back.
      expect(await scalar(`
        SELECT notification_status FROM public.produce_session_notifications
        WHERE session_key = 'session-key-1'`)).toBe("pending");
    });

    test("service_role can claim, complete, and requeue a notification end to end", async () => {
      const sessionId = await seedProduceSession();
      const generation = nextUuid();

      const claimed = await run(`
        SET ROLE service_role;
        INSERT INTO public.produce_session_notifications (
          produce_session_id, session_key, session_generation,
          source_id, correlation_id, notification_payload
        ) VALUES (
          '${sessionId}'::uuid, 'session-key-2', '${generation}'::uuid,
          'line-source', 'corr-2', 'lifecycle payload'
        );

        -- claim_due_produce_notifications(p_limit) claims it.
        SELECT id, notification_attempt_count, notification_status
        FROM public.claim_due_produce_notifications(10)
        WHERE produce_session_id = '${sessionId}'::uuid;
      `);
      expect(claimed.code, claimed.stderr).toBe(0);
      const [notificationId, attemptCountStr, status] =
        claimed.stdout.split("\n").map((l) => l.trim()).find(Boolean)!.split("|");
      expect(status).toBe("sending");

      // complete_produce_notification_attempt(...) — sent.
      const completed = await scalar(`
        SET ROLE service_role;
        SELECT public.complete_produce_notification_attempt(
          '${notificationId}'::uuid, ${attemptCountStr}, 'sent'
        )::text;`);
      expect(completed).toBe("true");
      expect(await scalar(`
        SELECT notification_status FROM public.produce_session_notifications
        WHERE id = '${notificationId}'::uuid`)).toBe("sent");

      // requeue_produce_notification(...) — an operator-initiated resend.
      const requeueScript = `
        SET ROLE service_role;
        SELECT notification_status, resend_count
        FROM public.requeue_produce_notification('${sessionId}'::uuid);
      `;
      const requeued = await run(requeueScript);
      expect(requeued.code, requeued.stderr).toBe(0);
      const [requeuedStatus, resendCount] =
        requeued.stdout.split("\n").map((l) => l.trim()).find(Boolean)!.split("|");
      expect(requeuedStatus).toBe("sending");
      expect(resendCount).toBe("1");
    });

    // ── explicit privilege assertions (catalog-level, belt-and-suspenders) ──

    test("catalog privileges match the intended boundary exactly", async () => {
      // MAINTAIN is new in PG17 and is what production's relacl actually
      // shows (arwdDxtm has a trailing 'm'). This whole describe block is
      // gated on server_version_num >= 170000 by probe()/pgAvailable above,
      // so MAINTAIN is always a valid privilege name here — no separate
      // version guard is needed inside the test itself.
      //
      // Each table is checked with ONE psql spawn (a privilege x role
      // matrix in a single query) rather than one spawn per cell — this
      // used to be ~50 sequential psql spawns in this one test, which was
      // flaky under Windows process-spawn load. Batching removed the flake
      // and is simply better test hygiene regardless.
      const tablePrivs = [
        "SELECT", "INSERT", "UPDATE", "DELETE",
        "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN",
      ];
      for (const table of ["produce_session_notifications", "produce_notification_attempts"]) {
        const matrix = await run(`
          SELECT priv, role_name, has_table_privilege(role_name, 'public.${table}', priv)::text
          FROM unnest(ARRAY[${tablePrivs.map((p) => q(p)).join(",")}]) AS priv
          CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) AS role_name
          ORDER BY priv, role_name;`);
        expect(matrix.code, matrix.stderr).toBe(0);
        const rows = new Map<string, string>();
        for (const line of matrix.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
          const [priv, roleName, value] = line.split("|");
          rows.set(`${priv}:${roleName}`, value);
        }
        for (const priv of tablePrivs) {
          for (const role of ["anon", "authenticated"]) {
            expect(rows.get(`${priv}:${role}`), `${table} ${priv} for ${role}`).toBe("false");
          }
        }
        for (const priv of ["SELECT", "INSERT", "UPDATE"]) {
          expect(rows.get(`${priv}:service_role`), `${table} ${priv} for service_role`).toBe("true");
        }
        for (const priv of ["DELETE", "TRUNCATE", "MAINTAIN"]) {
          expect(rows.get(`${priv}:service_role`), `${table} ${priv} for service_role`).toBe("false");
        }
      }

      const fnMatrix = await run(`
        SELECT p.proname, role_name,
          bool_or(has_function_privilege(role_name, p.oid, 'EXECUTE'))::text AS any_overload,
          bool_and(has_function_privilege(role_name, p.oid, 'EXECUTE'))::text AS all_overloads
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) AS role_name
        WHERE n.nspname = 'public'
          AND p.proname IN ('complete_produce_notification_attempt', 'requeue_produce_notification')
        GROUP BY p.proname, role_name
        ORDER BY p.proname, role_name;`);
      expect(fnMatrix.code, fnMatrix.stderr).toBe(0);
      const fnRows = new Map<string, { any: string; all: string }>();
      for (const line of fnMatrix.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
        const [fn, roleName, anyOverload, allOverloads] = line.split("|");
        fnRows.set(`${fn}:${roleName}`, { any: anyOverload, all: allOverloads });
      }
      for (const fn of ["complete_produce_notification_attempt", "requeue_produce_notification"]) {
        for (const role of ["anon", "authenticated"]) {
          expect(fnRows.get(`${fn}:${role}`)?.any, `${fn} EXECUTE for ${role}`).toBe("false");
        }
        expect(fnRows.get(`${fn}:service_role`)?.all, `${fn} EXECUTE for service_role`).toBe("true");
      }

      // claim_due_produce_notifications is out of scope for this migration:
      // in production it's already clean via 0050/0061/0062, none of which
      // this minimal harness applies. The correct claim here is therefore
      // NOT "it's clean" (it isn't, in this disposable DB) but "this
      // migration didn't touch it either way" — compared against the value
      // captured before the lockdown migration ran.
      expect(preLockdownState).not.toBeNull();
      const claimDueAfter = await scalar(`
        SELECT (has_function_privilege('anon', oid, 'EXECUTE')
          OR has_function_privilege('authenticated', oid, 'EXECUTE'))::text
        FROM pg_proc WHERE proname = 'claim_due_produce_notifications'
        LIMIT 1`);
      expect(claimDueAfter).toBe(preLockdownState!.anonOrAuthenticatedExecuteClaimDue);
    });
  },
);
