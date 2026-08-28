# P3 Profitability — Production Release Runbook

Migration: `supabase/migrations/20260809075951_p3_profitability_snapshots.sql`
Release branch: `codex/p3-release`

Every query in this document is **READ-ONLY** unless a section is explicitly
headed *APPLY*. No secret, connection string, key or token appears anywhere in
this file, and none may be added to it.

---

## 0. Release gate — do not start without this

P3 reads P2E's accountability round identity and P2D's actual cost. It cannot be
released before both are in Production.

| Dependency | PR | Production merge | Required state |
|---|---|---|---|
| P2E accountability round identity | [#38](https://github.com/Andromedas47/Bot-summary/pull/38) | `8cfd20a57c34af8c02df1e137ac6f6a10294f2de` | Production Active: EXPAND `20260809045345`, CONTRACT `20260809045849` |
| P2D actual cost | [#36](https://github.com/Andromedas47/Bot-summary/pull/36) | `c3c2fbb36713939539d1314f8df382ddd910c1bf` | Production Active: `20260809063116_inventory_cost_valuation` |

P2C Production UAT and both dependency cutovers passed on 2026-08-09. Recheck
their migration history and schema in preflight; do not infer them from this file.

**Prohibited throughout:** merging #36 or #38 to unblock P3, deploying either
dependency early, mutating Production data, sending LINE messages, changing cron,
weakening a test, or fabricating Production financial history to make a smoke
test pass.

---

## 1. Rollout order verdict

**Verdict: additive schema-first is SAFE and is the recommended order.**

Apply the P3 migration first, deploy the P3 application afterwards.

This is not an assumption. It was verified on a disposable PostgreSQL 17
database (§8, rehearsal C): the P3 migration creates three new tables, two
functions, two trigger functions and four triggers, and does **nothing else**.
It issues no `ALTER TABLE` against any pre-existing table, no `DROP`, and no
`INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` of any kind. A catalog-and-data
fingerprint covering every non-P3 relation, column, constraint, index, trigger,
function body, ACL and RLS flag — plus every legacy round-unbound row — was
**byte-identical before and after** the migration.

### Mixed-version matrix

| Case | Situation | Verdict | Why |
|---|---|---|---|
| **A** | old app + P2E/P2D schema | Out of P3 scope — governed by #36/#38 | P3 contributes no schema and no code in this state. |
| **B** | current app (no P3 code) + P2E/P2D schema | Safe | Identical to today's Production. P3 is absent. |
| **C** | current app + **P3 schema**, before the P3 app deploy | **Safe — this is the recommended window** | P3 is purely additive and invisible: no existing object changes, and nothing in the deployed app references `profitability_*` or the two RPCs. Verified by fingerprint equality. |
| **D** | P3 app + P3 schema | Safe — the certified path | Covered by the full test suite (§8). |
| **E** | app rolled back after the P3 schema exists | **Safe** | Rollback returns to case C, which is proven safe. The schema stays; see §7. |

### Actual dependency order

Production received P2E EXPAND, the compatible application, P2E CONTRACT, then
P2D. P3 was rehearsed in that exact schema order. Apply P3 as one exact reviewed
artifact; do not replay dependency migrations or use a bulk history push.

---

## 2. Preflight — READ-ONLY, run before applying P3

Run every query. Do not proceed on an unexpected result.

### 2.1 Both dependencies present, P3 absent

```sql
-- Expect: p2d_present = t, p2e_expand_present = t,
--         p2e_contract_present = t, p3_present = f
SELECT
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
           WHERE version = '20260809063116'
              OR name = 'inventory_cost_valuation')          AS p2d_present,
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
           WHERE version = '20260809045345'
              OR name = 'p2e_accountability_round_identity_expand') AS p2e_expand_present,
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
           WHERE version = '20260809045849'
              OR name = 'p2e_accountability_round_identity_contract') AS p2e_contract_present,
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations
           WHERE version LIKE '20260808130000%'
              OR name LIKE '%p3_profitability_snapshots%')   AS p3_present;
```

```sql
-- The applied history around the release point, for the record.
SELECT version, name FROM supabase_migrations.schema_migrations
 ORDER BY version DESC LIMIT 15;
```

### 2.2 Every object P3 depends on exists, at the right shape

```sql
-- Expect all 12 rows present = t. A single f is a STOP.
SELECT r.relation,
       to_regclass('public.' || r.relation) IS NOT NULL AS present
  FROM (VALUES
    ('accountability_rounds'),          -- P2E
    ('inventory_movements'),            -- 0053
    ('inventory_movement_lines'),       -- 0053
    ('inventory_cost_movements'),       -- P2D 0054
    ('inventory_cost_movement_lines'),  -- P2D 0054
    ('produce_transactions'),           -- 0037 view
    ('produce_sessions'),
    ('pending_sessions'),
    ('central_selling_prices'),
    ('digital_white_sheet_cash_entries'),
    ('settlement_entries'),
    ('purchase_receipts')
  ) AS r(relation)
 ORDER BY r.relation;
```

```sql
-- Expect all 4 rows present = t.
SELECT f.signature, to_regprocedure(f.signature) IS NOT NULL AS present
  FROM (VALUES
    ('public.value_inventory_consumption_movement(uuid,text)'),
    ('public.value_good_return_movement(uuid,uuid[],text)'),
    ('public.get_inventory_cost_balances(text,text,text,boolean)'),
    ('public.close_accountability_round(uuid,text,text,text,text)')
  ) AS f(signature)
 ORDER BY f.signature;
```

```sql
-- P2E's round status vocabulary. P3 certifies ONLY 'closed', names 'open' and
-- 'cancelled' as reasons, and RAISES on anything else. If this constraint has
-- gained a fourth value, P3 will refuse those rounds by design — expected, but
-- know it before release.
SELECT pg_get_constraintdef(oid) AS round_status_check
  FROM pg_constraint
 WHERE conrelid = 'public.accountability_rounds'::regclass
   AND conname LIKE '%status%';
```

### 2.3 No P3 object already exists, and no name collides

```sql
-- Expect 0 rows. Any row means P3 was partially applied — STOP.
SELECT c.relname, c.relkind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname LIKE 'profitability%'
UNION ALL
SELECT p.proname, 'f'
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname LIKE '%profitability%';
```

```sql
-- Expect 0 rows. P3's trigger names must not already be taken.
SELECT tgname FROM pg_trigger
 WHERE NOT tgisinternal
   AND tgname IN ('profitability_snapshots_guard_update',
                  'profitability_snapshots_forbid_delete',
                  'profitability_snapshot_lines_forbid_mutation',
                  'profitability_snapshot_sources_forbid_mutation');
```

### 2.4 Current accountability round population

```sql
-- Informational. Note the numbers; §5 compares against them.
SELECT status, count(*) AS rounds,
       min(business_date) AS earliest, max(business_date) AS latest
  FROM public.accountability_rounds GROUP BY status ORDER BY status;
```

```sql
-- Rounds that could be smoke-tested: closed, and holding a valued ISSUE.
SELECT r.id, r.business_date, r.market_label_normalized, r.seller_label,
       count(DISTINCT m.id)                                   AS round_movements,
       count(DISTINCT cml.id)                                 AS cost_lines,
       EXISTS (SELECT 1 FROM public.digital_white_sheet_cash_entries w
                WHERE w.accountability_round_id = r.id)       AS has_own_white_sheet
  FROM public.accountability_rounds r
  LEFT JOIN public.inventory_movements m
         ON m.accountability_round_id = r.id AND m.movement_type = 'ISSUE'
  LEFT JOIN public.inventory_movement_lines ml ON ml.movement_id = m.id
  LEFT JOIN public.inventory_cost_movement_lines cml ON cml.movement_line_id = ml.id
 WHERE r.status = 'closed'
 GROUP BY r.id, r.business_date, r.market_label_normalized, r.seller_label
 ORDER BY r.business_date DESC LIMIT 20;
```

### 2.5 Legacy / round-unbound population

P3 fails closed on unbound data: it never guesses a round binding. These counts
are the size of the "P3 can say nothing about this" population. They must be
**unchanged** by the migration (§5.7).

```sql
SELECT 'produce_sessions' AS relation,
       count(*) FILTER (WHERE accountability_round_id IS NULL) AS unbound,
       count(*) AS total FROM public.produce_sessions
UNION ALL SELECT 'pending_sessions',
       count(*) FILTER (WHERE accountability_round_id IS NULL), count(*) FROM public.pending_sessions
UNION ALL SELECT 'inventory_movements',
       count(*) FILTER (WHERE accountability_round_id IS NULL), count(*) FROM public.inventory_movements
UNION ALL SELECT 'digital_white_sheet_cash_entries',
       count(*) FILTER (WHERE accountability_round_id IS NULL), count(*) FROM public.digital_white_sheet_cash_entries
UNION ALL SELECT 'settlement_entries',
       count(*) FILTER (WHERE accountability_round_id IS NULL), count(*) FROM public.settlement_entries
UNION ALL SELECT 'settlement_finalizations',
       count(*) FILTER (WHERE accountability_round_id IS NULL), count(*) FROM public.settlement_finalizations
UNION ALL SELECT 'transfer_reconciliations',
       count(*) FILTER (WHERE accountability_round_id IS NULL), count(*) FROM public.transfer_reconciliations
UNION ALL SELECT 'slip_batches',
       count(*) FILTER (WHERE accountability_round_id IS NULL), count(*) FROM public.slip_batches
 ORDER BY relation;
```

### 2.6 Ledger / cost readiness

```sql
-- Round-bound ISSUE movements and how many are already valued by P2D. An ISSUE
-- with no cost line yields issue_cost_unvalued and a NULL COGS — never a 0.
SELECT m.movement_type,
       count(*)                                                        AS movements,
       count(*) FILTER (WHERE cm.id IS NOT NULL)                       AS valued,
       count(*) FILTER (WHERE m.reversed_by_movement_id IS NOT NULL)    AS reversed
  FROM public.inventory_movements m
  LEFT JOIN public.inventory_cost_movements cm ON cm.movement_id = m.id
 WHERE m.accountability_round_id IS NOT NULL
 GROUP BY m.movement_type ORDER BY m.movement_type;
```

```sql
-- Movement classes P3 refuses to certify around (anything but ISSUE,
-- GOOD_RETURN, REVERSAL). Expect 0 for a clean release; a non-zero count is not
-- a blocker, it just means those rounds report unsupported_round_movement.
SELECT movement_type, count(*)
  FROM public.inventory_movements
 WHERE accountability_round_id IS NOT NULL
   AND movement_type NOT IN ('ISSUE', 'GOOD_RETURN', 'REVERSAL')
   AND reversed_by_movement_id IS NULL
 GROUP BY movement_type;
```

### 2.7 Uniqueness invariants P3 relies on

```sql
-- Expect all 3 = t. P3 reads at most one white sheet and one settlement entry
-- per round; these partial unique indexes are what make that single-valued.
SELECT
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
           AND indexname='digital_white_sheet_cash_entries_accountability_round_uidx') AS one_sheet_per_round,
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
           AND indexname='settlement_entries_accountability_round_uidx')               AS one_settlement_per_round,
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
           AND indexname='transfer_reconciliations_accountability_round_uidx')          AS one_reconciliation_per_round;
```

---

## 3. APPLY

Apply only the exact reviewed contents of
`supabase/migrations/20260809075951_p3_profitability_snapshots.sql` through the
controlled Production migration runner. Record the resulting Production
migration version and file SHA-256 before continuing. Do not use `supabase db
push`: repository filenames do not match the already-recorded Production
versions for P2E/P2D, so a bulk push could attempt unrelated history.

The migration is a single additive unit; it creates objects and grants and
touches no existing row.

Do **not** hand-edit an applied migration, and do not fabricate a
`supabase_migrations.schema_migrations` row.

---

## 4. Post-migration verification — READ-ONLY

Expected results are stated per query. They are the results observed in the
disposable PostgreSQL 17 rehearsal (§8).

### 4.1 Migration history

```sql
-- Expect one row for P3.
SELECT version, name FROM supabase_migrations.schema_migrations
 WHERE version LIKE '20260808130000%' OR name LIKE '%p3_profitability_snapshots%';
```

### 4.2 Tables and RLS

```sql
-- Expect exactly 3 rows; relrowsecurity = t, relforcerowsecurity = f,
-- policies = 0 on all three. Zero policies with RLS enabled is deliberate:
-- deny by default. Reads reach the tables only through service_role, which
-- carries BYPASSRLS in Supabase.
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname LIKE 'profitability%' AND c.relkind = 'r'
 ORDER BY c.relname;
```

Expected:

| relname | relrowsecurity | relforcerowsecurity | policies |
|---|---|---|---|
| `profitability_snapshot_lines` | t | f | 0 |
| `profitability_snapshot_sources` | t | f | 0 |
| `profitability_snapshots` | t | f | 0 |

### 4.3 Table grants — no privilege widening

```sql
-- Expect service_role = SELECT on each of the three tables, plus the table
-- owner. NO row for anon, authenticated or PUBLIC. Any INSERT/UPDATE/DELETE
-- grant to service_role is a STOP: all writes go through the SECURITY DEFINER
-- RPC, so the tables are read-only even to the service role.
SELECT table_name, grantee,
       string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND table_name LIKE 'profitability%'
 GROUP BY table_name, grantee ORDER BY table_name, grantee;
```

### 4.4 RPC signatures, security and search_path

```sql
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS identity_args,
       pg_get_function_result(p.oid)             AS returns,
       p.prosecdef                               AS security_definer,
       p.provolatile                             AS volatility,
       array_to_string(p.proconfig, ' ')         AS config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('record_profitability_snapshot', 'get_profitability_snapshot',
                     'profitability_forbid_mutation', 'profitability_snapshots_guard_update')
 ORDER BY p.proname;
```

Expected — exactly four rows, one overload each:

| proname | identity_args | returns | security_definer | volatility | config |
|---|---|---|---|---|---|
| `get_profitability_snapshot` | `p_accountability_round_id uuid, p_revision integer` | `jsonb` | **f** | `s` (stable) | `search_path=public, pg_temp` |
| `profitability_forbid_mutation` | *(none)* | `trigger` | f | `v` | `search_path=public, pg_temp` |
| `profitability_snapshots_guard_update` | *(none)* | `trigger` | f | `v` | `search_path=public, pg_temp` |
| `record_profitability_snapshot` | `p_accountability_round_id uuid, p_quantity_attributions jsonb, p_verified_transfers_satang numeric, p_verified_transfer_source_ids uuid[], p_purchasing_expenses_satang numeric, p_purchasing_expense_receipt_ids uuid[], p_calculation_version text, p_actor text` | `jsonb` | **t** | `v` | `search_path=public, extensions, pg_temp` |

`get_profitability_snapshot` is SECURITY **INVOKER** on purpose: it needs no
elevation, so a leaked EXECUTE grant cannot become a data leak. Only
`record_profitability_snapshot` is DEFINER. Every function pins `search_path`.

### 4.5 Function EXECUTE grants

```sql
-- Expect service_role EXECUTE on the two RPCs ONLY. The two trigger functions
-- must have no grantee besides the owner, and anon/authenticated must appear
-- nowhere.
SELECT p.proname, a.grantee, a.privilege_type
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN information_schema.role_routine_grants a
         ON a.specific_name = p.proname || '_' || p.oid::text
 WHERE n.nspname = 'public' AND p.proname LIKE '%profitability%'
 ORDER BY p.proname, a.grantee;
```

### 4.6 Anon / authenticated denial

```sql
-- Expect f in EVERY column for anon and authenticated.
-- Expect service_role: sel_snap = t, ins_snap = f, exec_record = t, exec_get = t.
SELECT r.rolname,
       has_table_privilege(r.rolname, 'public.profitability_snapshots', 'SELECT') AS sel_snap,
       has_table_privilege(r.rolname, 'public.profitability_snapshots', 'INSERT') AS ins_snap,
       has_function_privilege(r.rolname,
         'public.record_profitability_snapshot(uuid,jsonb,numeric,uuid[],numeric,uuid[],text,text)',
         'EXECUTE') AS exec_record,
       has_function_privilege(r.rolname,
         'public.get_profitability_snapshot(uuid,integer)', 'EXECUTE') AS exec_get
  FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
 ORDER BY r.rolname;
```

### 4.7 Triggers — append-only enforcement

```sql
-- Expect exactly 4 rows.
SELECT c.relname AS table_name, t.tgname, pg_get_triggerdef(t.oid) AS definition
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname LIKE 'profitability%' AND NOT t.tgisinternal
 ORDER BY c.relname, t.tgname;
```

Expected:

| table | trigger | fires |
|---|---|---|
| `profitability_snapshot_lines` | `profitability_snapshot_lines_forbid_mutation` | BEFORE DELETE OR UPDATE, FOR EACH ROW |
| `profitability_snapshot_sources` | `profitability_snapshot_sources_forbid_mutation` | BEFORE DELETE OR UPDATE, FOR EACH ROW |
| `profitability_snapshots` | `profitability_snapshots_forbid_delete` | BEFORE DELETE, FOR EACH ROW |
| `profitability_snapshots` | `profitability_snapshots_guard_update` | BEFORE UPDATE, FOR EACH ROW |

The only permitted UPDATE anywhere is `superseded_by_snapshot_id` moving from
NULL to a value, once. Everything else raises
`P3: profitability_ledger_is_append_only`.

### 4.8 Snapshot uniqueness, constraints and indexes

```sql
-- Expect: UNIQUE (accountability_round_id, revision), UNIQUE (dedupe_key),
-- UNIQUE (superseded_by_snapshot_id), FK -> accountability_rounds(id),
-- and profitability_snapshots_certified_iff_no_reasons.
SELECT c.conrelid::regclass AS table_name, c.conname, c.contype,
       pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public' AND t.relname LIKE 'profitability%'
 ORDER BY table_name, c.conname;
```

Rehearsal returned **48** constraint rows across the three tables. The five that
carry the architecture:

| Constraint | Meaning |
|---|---|
| `profitability_snapshots_accountability_round_id_revision_key` | snapshot identity **is** `(accountability_round_id, revision)` — nothing descriptive |
| `profitability_snapshots_dedupe_key_key` | idempotent replay |
| `profitability_snapshots_certified_iff_no_reasons` | `CERTIFIED` ⟺ zero incomplete reasons |
| `profitability_snapshots_certified_is_complete` | a CERTIFIED row may not carry a NULL money term |
| `profitability_snapshots_accountability_round_id_fkey` | the round is the only identity, enforced by the database |

```sql
-- Expect 11 rows.
SELECT tablename, indexname, indexdef FROM pg_indexes
 WHERE schemaname = 'public' AND tablename LIKE 'profitability%'
 ORDER BY tablename, indexname;
```

### 4.9 The constraint P2D and P2E share

```sql
-- Expect movement_type_check with exactly six values (PURCHASE_RECEIPT,
-- REVERSAL, ISSUE, GOOD_RETURN, DAMAGED_WRITE_OFF, ADJUSTMENT) and
-- round_required_check present. Both orders of application produce this.
SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'public.inventory_movements'::regclass
   AND conname IN ('inventory_movements_movement_type_check',
                   'inventory_movements_round_required_check')
 ORDER BY conname;
```

### 4.10 Nothing pre-existing moved

Re-run **§2.5** verbatim. Every `unbound` and `total` must equal the preflight
value exactly. Then:

```sql
-- Expect 0. The migration writes no snapshot.
SELECT count(*) AS snapshots_after_migration FROM public.profitability_snapshots;
```

---

## 5. Production smoke / UAT plan

Minimum safe smoke. Read-only except where a snapshot is deliberately recorded,
and a recorded snapshot is append-only history, not a data mutation of any
existing table.

**Invariants that must hold in every case below:**

- COGS is never coerced to `0`. An unprovable term is `NULL` plus a named reason.
- No inventory movement, movement line, cost movement or cost line is created,
  updated or deleted by P3.
- No white sheet, settlement entry or produce row is modified by P3.
- `CERTIFIED` only for a round whose status is `closed`.

Fingerprint before and after any smoke write:

```sql
SELECT (SELECT count(*) FROM public.inventory_movements)            AS movements,
       (SELECT count(*) FROM public.inventory_movement_lines)       AS movement_lines,
       (SELECT count(*) FROM public.inventory_cost_movements)       AS cost_movements,
       (SELECT count(*) FROM public.inventory_cost_movement_lines)  AS cost_lines,
       (SELECT count(*) FROM public.digital_white_sheet_cash_entries) AS white_sheets,
       (SELECT count(*) FROM public.settlement_entries)             AS settlements;
```

### 5.A INCOMPLETE round — only when a real round exists

Pick a legitimate closed round that is missing required provenance: no
round-bound `ISSUE`, or an `ISSUE` with no P2D cost line, or no white sheet of
its own. §2.4 and §2.6 identify candidates. If Production has no closed round,
record no snapshot and do not create or backfill a round for smoke. Verify the
snapshot count remains zero and defer this case until a real round closes.

Read first — this needs no write at all:

```sql
-- Expected: cost_lines = 0 and/or has_own_white_sheet = f for the chosen round.
SELECT r.id, r.status,
       (SELECT count(*) FROM public.inventory_movements m
         WHERE m.accountability_round_id = r.id AND m.movement_type = 'ISSUE') AS issues,
       (SELECT count(*) FROM public.inventory_cost_movement_lines cml
          JOIN public.inventory_movement_lines ml ON ml.id = cml.movement_line_id
          JOIN public.inventory_movements m ON m.id = ml.movement_id
         WHERE m.accountability_round_id = r.id)                               AS cost_lines,
       EXISTS (SELECT 1 FROM public.digital_white_sheet_cash_entries w
                WHERE w.accountability_round_id = r.id)                        AS has_own_white_sheet
  FROM public.accountability_rounds r WHERE r.id = '<ROUND_ID>';
```

Then record one snapshot through the service (or the RPC) and read it back:

```sql
SELECT public.get_profitability_snapshot('<ROUND_ID>');
```

**Expected:**

- `certification_state = "INCOMPLETE"`.
- `incomplete_reasons` non-empty and explicit — e.g. `issue_cost_unvalued`,
  `white_sheet_missing`, `missing_verified_transfers`,
  `purchasing_expenses_unattributable`, `issue_movement_unbound`.
- `cogs_sold_satang = null`. **Not `"0"`.** Likewise `issued_cost_satang`,
  `damage_loss_satang`, `expected_operating_pl_satang`, `realized_pl_satang`.
- `good_return_cost_satang = "0"` is correct when no return happened: `0` means
  *proven to be nothing*, `null` means *unprovable*.
- Quantity fields still populated — a partially calculable round shows what it
  can prove.
- The §5 fingerprint is unchanged.

### 5.B COMPLETE round — only if Production already has one

**Do not create or backfill Production financial history to obtain a COMPLETE
round.** If §2.4 shows no closed round that already has a valued `ISSUE`, its own
finalized white sheet, finalized pending sessions, and every produce item
attributable, then:

- record **no** COMPLETE snapshot in Production;
- rely on the read-only validation above plus the proven disposable-PostgreSQL
  COMPLETE cases (§8), which certify exact satang across the whole money matrix;
- revisit after the next real market round closes naturally.

If such a round does exist, record one snapshot and verify every term:

| Term | Check |
|---|---|
| expected money | `Σ price_satang × sold_quantity` per line |
| COGS | `issued_cost − good_return_cost − damage_loss`, the residual — never a third rounding |
| damage | prorated at the round's own proven issue rate |
| approved expenses | `(location_fee + bag + snack + other) × 100` from **this round's own** white sheet |
| wages | `labor × 100` from **this round's own** white sheet |
| purchasing expenses | caller-supplied with proving receipt ids, or `null` + `purchasing_expenses_unattributable` |
| shortage / overage | `actual_cash − (expected_money − verified_transfers − (wages + expenses))` |
| expected operating P/L | `expected − cogs − damage − expenses − wages − purchasing` |
| realized P/L | `expected_operating_pl + shortage_overage` |
| certification | `CERTIFIED` and `incomplete_reasons = []` |

Then confirm append-only and idempotency in Production:

```sql
-- Expect 1: the snapshot is not deletable and not updatable.
SELECT count(*) FROM public.profitability_snapshots WHERE accountability_round_id = '<ROUND_ID>';
```

Re-record with identical inputs. **Expected:** `replayed: true`, the same
`snapshot_id`, and no second revision.

### 5.C Cancelled round — only if Production has one

A cancelled round is terminal but is **not a result**. Cancelling voids no
produce session, movement, cost line or white sheet, so every figure stays
provable — which is exactly why the refusal must be verified in Production.

```sql
-- Find one, if Production has one.
SELECT id, business_date, market_label_normalized FROM public.accountability_rounds
 WHERE status = 'cancelled' ORDER BY business_date DESC LIMIT 5;
```

If no cancelled round exists, create none. Run the standing invariant below and
rely on the disposable-PostgreSQL cancelled/closed twin case until a real
cancelled round exists. Otherwise record a snapshot for it and read it back.
**Expected:**

- `certification_state = "INCOMPLETE"`.
- `incomplete_reasons` contains `accountability_round_cancelled`.
- Money terms may be fully populated and it is **still** refused certification.
- Re-recording replays rather than laundering: the round status is in the input
  digest.

```sql
-- Standing invariant. Expect 0, forever.
SELECT count(*) AS cancelled_but_certified
  FROM public.profitability_snapshots s
  JOIN public.accountability_rounds r ON r.id = s.accountability_round_id
 WHERE s.certification_state = 'CERTIFIED' AND r.status <> 'closed';
```

### 5.D Cross-round isolation spot check

```sql
-- Expect 0 rows: no snapshot may cite an artifact bound to a different round.
SELECT s.id AS snapshot_id, x.artifact_kind, x.artifact_id
  FROM public.profitability_snapshots s
  JOIN public.profitability_snapshot_sources x ON x.snapshot_id = s.id
  LEFT JOIN public.digital_white_sheet_cash_entries w
         ON w.id = x.artifact_id AND x.artifact_kind = 'white_sheet_cash_entry'
  LEFT JOIN public.settlement_entries e
         ON e.id = x.artifact_id AND x.artifact_kind = 'settlement_entry'
 WHERE (w.id IS NOT NULL AND w.accountability_round_id IS DISTINCT FROM s.accountability_round_id)
    OR (e.id IS NOT NULL AND e.accountability_round_id IS DISTINCT FROM s.accountability_round_id);
```

### 5.E White Sheet read surface — after application deploy

Required once the P3 **application** is deployed (case D). This is a read-only
page-model check: loading the White Sheet must never record a snapshot.

Pick a closed round that already has a snapshot from §5.A or §5.B, with a known
`accountability_round_id`. Load the White Sheet page/API for that round's scope
(the caller that already threads `accountabilityRoundId` into
`loadDigitalWhiteSheetPageModel` / `loadServerDigitalWhiteSheetPageModel`).

If Production still has no real round/snapshot, test only the legacy
`round_unbound` page state and prove page load writes nothing. Defer the bound
states; never create financial history merely to exercise rendering.

**Expected:**

| Scope | `pageModel.profitability` |
|---|---|
| Valid round UUID + snapshot exists | `state: "available"` — `formatted` matches `formatProfitabilitySnapshot`; CERTIFIED or INCOMPLETE is visibly distinct; NULL money terms show as unprovable, never ฿0 |
| Valid round UUID + no snapshot | `state: "not_calculated"` — UI shows `ยังไม่มีผลคำนวณกำไร/ขาดทุน` |
| Legacy scope (`accountabilityRoundId` undefined/null) | `state: "round_unbound"` — no profitability figures invented; no `get_profitability_snapshot` fallback by source/market/date |

Also confirm:

- White Sheet hard-stop warnings still block `requireTrustedWhiteSheetSummary`
  when present — P3 display does not override that.
- The §5 fingerprint is unchanged by a page load (no inventory, cost, settlement,
  white-sheet, or profitability write).
- Application logs / network show `get_profitability_snapshot` only — never
  `record_profitability_snapshot` on render.

---

## 6. Reversible vs irreversible steps

| Step | Reversible? | Note |
|---|---|---|
| Apply the P3 migration | Technically yes (DROP the three tables and two functions), but **do not** once any snapshot exists | Snapshots are financial history |
| Deploy the P3 application | Yes | Redeploy the previous build; returns to case C |
| Record a snapshot | **No** | Append-only by design; there is no delete path and the trigger blocks one |
| Supersede a snapshot | **No** | `superseded_by_snapshot_id` moves NULL → value exactly once |
| Grants / RLS | Yes | Re-runnable REVOKE/GRANT |

---

## 7. Rollback / failure plan

### 7.1 Migration applied, app deploy fails

**Leave the schema in place.** This is exactly case C, verified safe: the
migration is additive and no pre-existing object changed. The old app cannot see
the three new tables and never calls the two RPCs. There is nothing to undo and
no urgency.

Retry the deploy. Do not roll the migration back to "get back to a known state" —
the state with the migration applied and the old app running *is* a known,
verified state.

### 7.2 Should the P3 schema stay if P3 is abandoned?

**Yes, keep it.** Reasons:

- Dropping it is the only destructive option in this release and it destroys
  financial history if any snapshot exists.
- An empty, unreferenced, additive schema costs nothing and is invisible to
  every deployed code path.
- Re-applying later would require a new migration version anyway.

If the schema truly must go and **`profitability_snapshots` is empty**, the only
acceptable removal is a new forward migration, reviewed like any other, that
drops the three tables and both functions. Never hand-edit or delete the applied
migration file, and never fabricate migration history.

### 7.3 Disabling P3 exposure without deleting anything

In escalating order, all non-destructive:

1. **Redeploy the previous application build.** The White Sheet page model reads
   P3 via `get_profitability_snapshot` only; rolling back the app returns to case
   C (schema present, no user-facing read). Recording new snapshots is already a
   separate, explicit caller path — page load never writes.
2. **Revoke EXECUTE** on `record_profitability_snapshot` from `service_role`. New
   snapshots become impossible; existing history stays readable (including the
   White Sheet read surface).
3. **Revoke EXECUTE** on `get_profitability_snapshot` as well. The tables become
   unreachable through the API while the rows remain intact. The White Sheet
   page model will then fail closed on bound-round loads until EXECUTE is
   restored or the previous app build is redeployed.

```sql
-- Kill switch. Reversible with the matching GRANT. Deletes nothing.
REVOKE EXECUTE ON FUNCTION
  public.record_profitability_snapshot(uuid,jsonb,numeric,uuid[],numeric,uuid[],text,text)
  FROM service_role;
```

### 7.4 Never

Never hard-delete a `profitability_snapshots`, `profitability_snapshot_lines`,
`profitability_snapshot_sources`, `inventory_cost_*` or `inventory_movement*`
row. Never `TRUNCATE` any of them. Never drop the append-only triggers to "fix"
data. A wrong snapshot is corrected by recording a new revision, which
supersedes the old one and leaves it byte-identical for audit.

---

## 8. Rehearsal evidence

All on disposable, locally created and dropped PostgreSQL 17.10 databases.
Production was never contacted.

| Rehearsal | What it proves | Result |
|---|---|---|
| **A** — actual Production dependency order: `0053` → P2E EXPAND → P2E CONTRACT → `0054` → P3 | The deployed dependency shape accepts P3 cleanly | 15/15 tests; 465 assertions |
| **B** — fingerprint every non-P3 public column, constraint, index, function, trigger and view before P3, then compare after | P3 changes no pre-existing schema object | Fingerprint identical |
| **C** — append-only and concurrency probes | Mutation is refused; retries and overlapping postings remain deterministic/revisioned | Passed in the 15-test PostgreSQL suite |
| **D** — clean port from exact P2D main | No stale dependency implementation enters the release | 13/13 source patches map exactly in `git range-diff` |

Note for anyone tempted to validate by rebuilding from scratch: the full
`0001..0062` history is **not** replayable on an empty database. `0032` requires
`pending_sessions.close_event_timestamp_ms`, which no migration in this
repository creates. That is a pre-existing repository condition, unrelated to
P3, and it means schema validation must be done by applying new migrations onto
an existing schema — which is what Production does anyway.

Test suites behind this release are recorded in
`docs/handoffs/p3-final-sprint-handoff.md`.
