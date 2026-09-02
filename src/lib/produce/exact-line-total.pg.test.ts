/**
 * PostgreSQL NUMERIC parity for Produce line totals.
 *
 * Runs the SAME inputs through the database's own expression from
 * 0033_produce_basis_pricing.sql and through the TypeScript implementation, and
 * requires exact equality IN SATANG — not formatted strings, which would hide a
 * disagreement in the last place.
 *
 *   basis row:  ROUND(quantity * basis_price / basis_quantity, 2)
 *   unit row:   quantity * price_per_unit          -- NOT rounded
 *
 * Operand types are the real column types: quantity numeric(10,3), both prices
 * numeric(10,2).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  exactLineTotalScaled,
  scaledToSatang,
  sumExactLineTotalsScaled,
  type ExactLineTotalInput,
} from "./exact-line-total";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `mig_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^mig_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error("exact-line-total.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1");
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
      PGHOST, PGUSER, PGPASSWORD, PGPORT,
      PGDATABASE: database,
      PGCLIENTENCODING: "UTF8",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function psql(args: string[], database = DATABASE, stdin?: string): Promise<PsqlResult> {
  const proc = spawnPsql(args, database, stdin);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function rows(sql: string): Promise<string[]> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], DATABASE, sql);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
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

/** The database's own CASE, verbatim, over the real column types. */
const DB_TOTAL_EXPR = `
  CASE
    WHEN basis_quantity IS NOT NULL AND basis_price IS NOT NULL
         AND basis_quantity <> 0 AND quantity IS NOT NULL
    THEN ROUND(quantity * basis_price / basis_quantity, 2)
    WHEN quantity IS NOT NULL AND price_per_unit IS NOT NULL
    THEN quantity * price_per_unit
    ELSE NULL
  END`;

interface Case {
  label: string;
  quantity: string | null;
  pricePerUnit: string | null;
  basisQuantity: string | null;
  basisPrice: string | null;
}

const unit = (label: string, quantity: string, pricePerUnit: string): Case =>
  ({ label, quantity, pricePerUnit, basisQuantity: null, basisPrice: null });
const basis = (label: string, quantity: string, basisPrice: string, basisQuantity: string): Case =>
  ({ label, quantity, pricePerUnit: null, basisQuantity, basisPrice });

const CASES: Case[] = [
  unit("0.1", "1", "0.1"),
  unit("0.2", "1", "0.2"),
  unit("0.3", "1", "0.3"),
  unit("1.10", "1", "1.10"),
  unit("2.01", "3", "2.01"),
  unit("10.05", "1", "10.05"),
  unit("8.29 × 7", "7", "8.29"),
  unit("1.15 × 3", "3", "1.15"),
  unit("sub-satang", "0.001", "0.01"),
  unit("fractional qty", "1.234", "5.67"),
  unit("large", "9999999.999", "9999999.99"),
  unit("zero price", "5", "0"),
  basis("documented 32/20/3", "32", "20", "3"),
  basis("half-satang up", "1", "0.05", "2"),
  basis("half-satang up 0.075", "1", "0.15", "2"),
  basis("just below boundary", "0.999", "0.05", "2"),
  basis("just above boundary", "1.001", "0.05", "2"),
  basis("repeating third", "1", "10", "3"),
  basis("repeating sixth", "1", "10", "6"),
  basis("large basis", "9999.999", "9999.99", "7"),
];

function toInput(c: Case): ExactLineTotalInput {
  return {
    quantity: c.quantity,
    pricePerUnit: c.pricePerUnit,
    basisQuantity: c.basisQuantity,
    basisPrice: c.basisPrice,
  };
}

function lit(value: string | null, type: string): string {
  return value === null ? `NULL::${type}` : `${value}::${type}`;
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_MONEY_PARITY_POSTGRES === "1") {
  throw new Error("REQUIRE_MONEY_PARITY_POSTGRES=1 but the PostgreSQL 17 harness is unavailable");
}

describe.skipIf(!pgAvailable)("Produce line total — PostgreSQL NUMERIC parity", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
  }, 120_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("every case agrees with PostgreSQL to the exact satang", async () => {
    // One query, one row per case: the DB total scaled to satang as an integer.
    const selects = CASES.map((c, i) => `
      SELECT ${i} AS idx, (
        SELECT CASE WHEN t IS NULL THEN NULL ELSE ROUND(t * 100, 0)::text END
        FROM (
          SELECT (${DB_TOTAL_EXPR}) AS t
          FROM (SELECT
            ${lit(c.quantity, "numeric(10,3)")}      AS quantity,
            ${lit(c.pricePerUnit, "numeric(10,2)")}  AS price_per_unit,
            ${lit(c.basisQuantity, "numeric(10,3)")} AS basis_quantity,
            ${lit(c.basisPrice, "numeric(10,2)")}    AS basis_price
          ) operands
        ) computed
      ) AS satang`).join("\nUNION ALL\n");

    const output = await rows(`${selects}\nORDER BY idx;`);
    expect(output).toHaveLength(CASES.length);

    for (const line of output) {
      const [idxText, satangText] = line.split("|");
      const c = CASES[Number(idxText)];
      const scaled = exactLineTotalScaled(toInput(c));

      if (satangText === "" || satangText === undefined) {
        expect(scaled, `${c.label}: database returned NULL`).toBeNull();
        continue;
      }
      // Exact integer comparison in satang — never a formatted string.
      expect(scaledToSatang(scaled!).toString(), `${c.label}`).toBe(satangText);
    }
  }, 60_000);

  test("aggregate parity — the database sums unrounded unit rows, and so do we", async () => {
    // Ten rows whose per-row value is half a satang. Rounding each row first
    // would give 0.10; PostgreSQL's SUM of the unrounded values is 0.05.
    const rowCount = 10;
    const values = Array.from({ length: rowCount },
      () => `(0.5::numeric(10,3), 0.01::numeric(10,2))`).join(", ");

    const [dbSatang] = await rows(`
      SELECT ROUND(SUM(quantity * price_per_unit) * 100, 0)::text
      FROM (VALUES ${values}) AS v(quantity, price_per_unit);`);

    const ours = sumExactLineTotalsScaled(
      Array.from({ length: rowCount }, () => ({
        quantity: "0.5", pricePerUnit: "0.01", basisQuantity: null, basisPrice: null,
      })),
    );
    expect(scaledToSatang(ours).toString()).toBe(dbSatang);
    expect(dbSatang).toBe("5");
  }, 60_000);

  test("mixed basis and unit rows aggregate identically", async () => {
    const [dbSatang] = await rows(`
      SELECT ROUND(SUM(
        CASE
          WHEN basis_quantity IS NOT NULL AND basis_price IS NOT NULL
               AND basis_quantity <> 0 AND quantity IS NOT NULL
          THEN ROUND(quantity * basis_price / basis_quantity, 2)
          ELSE quantity * price_per_unit
        END
      ) * 100, 0)::text
      FROM (VALUES
        (32::numeric(10,3), NULL::numeric(10,2), 3::numeric(10,3), 20::numeric(10,2)),
        (3::numeric(10,3), 2.01::numeric(10,2), NULL::numeric(10,3), NULL::numeric(10,2)),
        (0.001::numeric(10,3), 0.01::numeric(10,2), NULL::numeric(10,3), NULL::numeric(10,2))
      ) AS v(quantity, price_per_unit, basis_quantity, basis_price);`);

    const ours = sumExactLineTotalsScaled([
      { quantity: "32", pricePerUnit: null, basisQuantity: "3", basisPrice: "20" },
      { quantity: "3", pricePerUnit: "2.01", basisQuantity: null, basisPrice: null },
      { quantity: "0.001", pricePerUnit: "0.01", basisQuantity: null, basisPrice: null },
    ]);
    expect(scaledToSatang(ours).toString()).toBe(dbSatang);
  }, 60_000);
});
