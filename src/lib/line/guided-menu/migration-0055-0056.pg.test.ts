/**
 * Real PostgreSQL 17 harness for Guided Menu catalog rollout migrations.
 * Creates only disposable local databases and skips explicitly if PG is absent.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const BOOTSTRAP = join(
  ROOT,
  "supabase",
  "tests",
  "guided_menu_0051_bootstrap.sql",
);
const MIGRATION_0051 = join(
  ROOT,
  "supabase",
  "migrations",
  "20260729074617_guided_menu_identity_and_state.sql",
);
const MIGRATION_0055 = join(
  ROOT,
  "supabase",
  "migrations",
  "20260730090006_guided_menu_seller_market_catalog.sql",
);
const MIGRATION_0056 = join(
  ROOT,
  "supabase",
  "migrations",
  "20260730090937_guided_menu_seller_catalog_strict_cleanup.sql",
);

type PsqlResult = { code: number; stdout: string; stderr: string };

async function psql(
  database: string,
  args: string[],
): Promise<PsqlResult> {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      PGHOST,
      PGUSER,
      PGPASSWORD,
      PGPORT,
      PGDATABASE: database,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function scalar(database: string, sql: string): Promise<string> {
  const result = await psql(database, [
    "-v",
    "ON_ERROR_STOP=1",
    "-tAc",
    sql,
  ]);
  if (result.code !== 0) {
    throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  }
  return result.stdout.trim();
}

async function apply(database: string, file: string): Promise<PsqlResult> {
  return psql(database, ["-v", "ON_ERROR_STOP=1", "-f", file]);
}

async function probe(): Promise<boolean> {
  try {
    const result = await psql("postgres", ["-tAc", "SHOW server_version_num"]);
    return result.code === 0 && Number(result.stdout.trim()) >= 170000;
  } catch {
    return false;
  }
}

const pgAvailable = await probe();
const tag = randomBytes(4).toString("hex");
const mainDb = `gm_0055_${tag}`;
const databases = new Set<string>();
const temp = mkdtempSync(join(tmpdir(), "gm-0055-"));
const seedReplay = join(temp, "0055-seeds.sql");

const migration0055Sql = readFileSync(MIGRATION_0055, "utf8");
const seedStart = migration0055Sql.indexOf(
  "-- BEGIN REVIEWED CATALOG SEEDS",
);
const seedEndMarker = "-- END REVIEWED CATALOG SEEDS";
const seedEnd = migration0055Sql.indexOf(seedEndMarker);
if (seedStart < 0 || seedEnd < 0) {
  throw new Error("0055 reviewed seed markers are missing");
}
writeFileSync(
  seedReplay,
  `BEGIN;\n${migration0055Sql.slice(
    seedStart,
    seedEnd + seedEndMarker.length,
  )}\nCOMMIT;\n`,
);

async function createDatabase(name: string): Promise<void> {
  if (!/^gm_0055_[a-z0-9_]+$/.test(name)) {
    throw new Error(`unsafe disposable database name: ${name}`);
  }
  const result = await psql("postgres", ["-c", `CREATE DATABASE ${name}`]);
  expect(result.code, result.stderr).toBe(0);
  databases.add(name);
}

async function createAdditiveDatabase(name: string): Promise<void> {
  await createDatabase(name);
  for (const file of [BOOTSTRAP, MIGRATION_0051, MIGRATION_0055]) {
    const result = await apply(name, file);
    expect(result.code, `${file}\n${result.stderr}\n${result.stdout}`).toBe(0);
  }
}

function token(char: string): string {
  return char.repeat(64);
}

function createStateSql(
  hash: string,
  action: string,
  payload: Record<string, string>,
): string {
  const json = JSON.stringify(payload).replaceAll("'", "''");
  return `SELECT public.create_line_menu_state(
    '${hash}', '${action}', 'U-pg', 'group', 'G-pg', 'group:G-pg:user:U-pg',
    '${json}'::jsonb
  )::text`;
}

function consumeSql(hash: string, event: string): string {
  return `SELECT public.consume_line_menu_state(
    '${hash}', '${event}', 'U-pg', 'group', 'G-pg',
    'group:G-pg:user:U-pg'
  )::text`;
}

describe.skipIf(!pgAvailable)(
  "Guided Menu 0055/0056 real PostgreSQL 17 rollout",
  () => {
    test(
      "applies 0051 then additive 0055 with exact private catalog security",
      async () => {
        await createAdditiveDatabase(mainDb);
        expect(
          await scalar(
            mainDb,
            `SELECT (
              (SELECT count(*) FROM public.line_guided_menu_sellers) = 16
              AND (SELECT count(*) FROM public.line_guided_menu_seller_aliases) = 3
              AND (SELECT count(*) FROM public.line_guided_menu_market_aliases) = 21
              AND (SELECT count(*) FROM public.line_guided_menu_seller_markets) = 35
              AND EXISTS (
                SELECT 1 FROM public.line_guided_menu_markets
                WHERE market_code = 'kee' AND active
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.line_guided_menu_seller_aliases
                WHERE alias_label = 'ป้าลีนาง'
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.line_guided_menu_market_aliases
                WHERE alias_label IN ('พาสิโอ้', 'ผัก', 'ผลไม้', 'ทุเรียน')
              )
            )::text`,
          ),
        ).toBe("true");

        expect(
          await scalar(
            mainDb,
            `SELECT (
              SELECT bool_and(
                c.relrowsecurity
                AND has_table_privilege('service_role', c.oid, 'SELECT')
                AND has_table_privilege('service_role', c.oid, 'INSERT')
                AND has_table_privilege('service_role', c.oid, 'UPDATE')
                AND NOT has_table_privilege('service_role', c.oid, 'DELETE')
                AND NOT has_table_privilege('service_role', c.oid, 'TRUNCATE')
                AND NOT has_table_privilege('service_role', c.oid, 'REFERENCES')
                AND NOT has_table_privilege('service_role', c.oid, 'TRIGGER')
                AND NOT has_table_privilege('anon', c.oid, 'SELECT')
                AND NOT has_table_privilege('authenticated', c.oid, 'SELECT')
              )
              FROM pg_class c
              WHERE c.oid IN (
                'public.line_guided_menu_sellers'::regclass,
                'public.line_guided_menu_seller_aliases'::regclass,
                'public.line_guided_menu_market_aliases'::regclass,
                'public.line_guided_menu_seller_markets'::regclass
              )
            )::text`,
          ),
        ).toBe("true");

        expect(
          await scalar(
            mainDb,
            `SELECT (
              has_function_privilege(
                'service_role',
                'public.consume_line_menu_state(text,text,text,text,text,text)',
                'EXECUTE'
              )
              AND NOT has_function_privilege(
                'anon',
                'public.consume_line_menu_state(text,text,text,text,text,text)',
                'EXECUTE'
              )
              AND NOT has_function_privilege(
                'authenticated',
                'public.guided_menu_payload_valid(text,jsonb)',
                'EXECUTE'
              )
            )::text`,
          ),
        ).toBe("true");
      },
      { timeout: 60_000 },
    );

    test("old code and new code both work on additive 0055", async () => {
      const legacyHash = token("a");
      expect(
        JSON.parse(
          await scalar(
            mainDb,
            createStateSql(legacyHash, "choose_market", {
              transaction_type: "withdraw",
              market_code: "wat_thung_lanna",
            }),
          ),
        ).status,
      ).toBe("created");
      expect(
        JSON.parse(
          await scalar(mainDb, consumeSql(legacyHash, "evt-legacy")),
        ).status,
      ).toBe("consumed");
      expect(
        await scalar(
          mainDb,
          `SELECT (
            public.guided_menu_payload_valid(
              'choose_date',
              '{"transaction_type":"withdraw","market_code":"wat_thung_lanna","date_mode":"today"}'
            )
            AND public.guided_menu_payload_valid(
              'confirm_open',
              '{"transaction_type":"withdraw","market_code":"wat_thung_lanna","date_mode":"today"}'
            )
            AND public.guided_menu_payload_valid(
              'choose_market',
              '{"transaction_type":"withdraw","seller_code":"ki","market_code":"wat_thung_lanna"}'
            )
          )::text`,
        ),
      ).toBe("true");
    });

    test(
      "consume and same-event replay revalidate current catalog without throwing",
      async () => {
        const cases = [
          {
            char: "b",
            before:
              "UPDATE public.line_guided_menu_sellers SET active = false WHERE seller_code = 'ki'",
            after:
              "UPDATE public.line_guided_menu_sellers SET active = true WHERE seller_code = 'ki'",
          },
          {
            char: "c",
            before:
              "UPDATE public.line_guided_menu_markets SET active = false WHERE market_code = 'wat_thung_lanna'",
            after:
              "UPDATE public.line_guided_menu_markets SET active = true WHERE market_code = 'wat_thung_lanna'",
          },
          {
            char: "d",
            before:
              "UPDATE public.line_guided_menu_seller_markets SET active = false WHERE seller_code = 'ki' AND market_code = 'wat_thung_lanna'",
            after:
              "UPDATE public.line_guided_menu_seller_markets SET active = true WHERE seller_code = 'ki' AND market_code = 'wat_thung_lanna'",
          },
          {
            char: "e",
            before:
              "DELETE FROM public.line_guided_menu_seller_markets WHERE seller_code = 'ki' AND market_code = 'wat_thung_lanna'",
            after:
              "INSERT INTO public.line_guided_menu_seller_markets (seller_code, market_code, active, sort_order) VALUES ('ki', 'wat_thung_lanna', true, 10)",
          },
        ];
        for (const item of cases) {
          const hash = token(item.char);
          await scalar(
            mainDb,
            createStateSql(hash, "choose_market", {
              transaction_type: "withdraw",
              seller_code: "ki",
              market_code: "wat_thung_lanna",
            }),
          );
          await scalar(mainDb, item.before);
          const consumed = JSON.parse(
            await scalar(mainDb, consumeSql(hash, `evt-${item.char}`)),
          );
          expect(consumed.status).toBe("invalid_or_expired");
          expect(
            await scalar(
              mainDb,
              `SELECT (consumed_at IS NULL)::text
               FROM public.line_menu_states WHERE token_hash = '${hash}'`,
            ),
          ).toBe("true");
          await scalar(mainDb, item.after);
        }

        const replayHash = token("f");
        await scalar(
          mainDb,
          createStateSql(replayHash, "choose_seller", {
            transaction_type: "withdraw",
            seller_code: "ki",
          }),
        );
        expect(
          JSON.parse(
            await scalar(mainDb, consumeSql(replayHash, "evt-replay")),
          ).status,
        ).toBe("consumed");
        await scalar(
          mainDb,
          "UPDATE public.line_guided_menu_sellers SET active = false WHERE seller_code = 'ki'",
        );
        expect(
          JSON.parse(
            await scalar(mainDb, consumeSql(replayHash, "evt-replay")),
          ).status,
        ).toBe("invalid_or_expired");
        await scalar(
          mainDb,
          "UPDATE public.line_guided_menu_sellers SET active = true WHERE seller_code = 'ki'",
        );

        const missingHash = token("9");
        await scalar(
          mainDb,
          createStateSql(missingHash, "choose_seller", {
            transaction_type: "withdraw",
            seller_code: "nang",
          }),
        );
        await scalar(
          mainDb,
          "DELETE FROM public.line_guided_menu_sellers WHERE seller_code = 'nang'",
        );
        expect(
          JSON.parse(
            await scalar(mainDb, consumeSql(missingHash, "evt-missing")),
          ).status,
        ).toBe("invalid_or_expired");
        await scalar(
          mainDb,
          "INSERT INTO public.line_guided_menu_sellers (seller_code, label, active, sort_order) VALUES ('nang', 'นาง', true, 160)",
        );
      },
    );

    test(
      "matching seed replay is a no-op and seller/market/alias/assignment drift aborts",
      async () => {
        const replayDb = `gm_0055_replay_${tag}`;
        await createAdditiveDatabase(replayDb);
        await scalar(
          replayDb,
          "UPDATE public.line_guided_menu_sellers SET updated_at = '2020-01-01T00:00:00Z' WHERE seller_code = 'ki'",
        );
        const matching = await apply(replayDb, seedReplay);
        expect(matching.code, matching.stderr).toBe(0);
        expect(
          await scalar(
            replayDb,
            "SELECT updated_at::text FROM public.line_guided_menu_sellers WHERE seller_code = 'ki'",
          ),
        ).toContain("2020-01-01");

        const drifts = [
          [
            "seller",
            "UPDATE public.line_guided_menu_sellers SET active = false WHERE seller_code = 'ki'",
            "reviewed seller baseline drift",
          ],
          [
            "market",
            "UPDATE public.line_guided_menu_markets SET label = 'drift' WHERE market_code = 'wat_taklam'",
            "reviewed market baseline drift",
          ],
          [
            "alias",
            "UPDATE public.line_guided_menu_seller_aliases SET active = false",
            "reviewed seller alias baseline drift",
          ],
          [
            "assignment",
            "UPDATE public.line_guided_menu_seller_markets SET active = false WHERE seller_code = 'ki' AND market_code = 'wat_thung_lanna'",
            "reviewed seller-market baseline drift",
          ],
        ] as const;
        for (const [name, mutation, expected] of drifts) {
          const db = `gm_0055_${name}_${tag}`;
          await createAdditiveDatabase(db);
          await scalar(db, mutation);
          const result = await apply(db, seedReplay);
          expect(result.code, `${name}: ${result.stderr}`).not.toBe(0);
          expect(result.stderr + result.stdout).toContain(expected);
        }
      },
      { timeout: 120_000 },
    );

    test(
      "strict cleanup blocks legacy states, then removes compatibility and kee",
      async () => {
        const blocked = await apply(mainDb, MIGRATION_0056);
        expect(blocked.code).not.toBe(0);
        expect(blocked.stderr + blocked.stdout).toContain(
          "unexpired legacy seller-less Guided Menu states remain",
        );

        await scalar(
          mainDb,
          `DELETE FROM public.line_menu_states
           WHERE action_type IN ('choose_market', 'choose_date', 'confirm_open')
             AND NOT (payload ? 'seller_code')`,
        );
        const strict = await apply(mainDb, MIGRATION_0056);
        expect(strict.code, strict.stderr + strict.stdout).toBe(0);
        expect(
          await scalar(
            mainDb,
            `SELECT (
              NOT public.guided_menu_payload_valid(
                'choose_market',
                '{"transaction_type":"withdraw","market_code":"wat_thung_lanna"}'
              )
              AND public.guided_menu_payload_valid(
                'choose_market',
                '{"transaction_type":"withdraw","seller_code":"ki","market_code":"wat_thung_lanna"}'
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.line_guided_menu_markets
                WHERE market_code = 'kee' OR label = 'ตลาดกี้'
              )
            )::text`,
          ),
        ).toBe("true");
      },
    );

    test("strict cleanup aborts on unexpected kee drift", async () => {
      const db = `gm_0055_kee_${tag}`;
      await createAdditiveDatabase(db);
      await scalar(
        db,
        "UPDATE public.line_guided_menu_markets SET label = 'drift' WHERE market_code = 'kee'",
      );
      const strict = await apply(db, MIGRATION_0056);
      expect(strict.code).not.toBe(0);
      expect(strict.stderr + strict.stdout).toContain(
        "differs from the original 0051 baseline",
      );
    });
  },
);

afterAll(
  async () => {
    for (const database of databases) {
      if (!/^gm_0055_[a-z0-9_]+$/.test(database)) continue;
      await psql("postgres", [
        "-c",
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = '${database}' AND pid <> pg_backend_pid()`,
      ]);
      await psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${database}`]);
    }
    rmSync(temp, { recursive: true, force: true });
  },
  60_000,
);

if (!pgAvailable) {
  describe("Guided Menu PostgreSQL 17 unavailable", () => {
    test.skip("requires local PostgreSQL 17", () => {});
  });
}
