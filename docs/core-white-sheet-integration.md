# Core white-sheet integration notes

## Canonical contract and field mapping

`src/lib/white-sheet/types.ts` is the only calculated-output contract.
Dashboard components accept `DigitalWhiteSheetSummary` directly, and the LINE
formatter accepts that same object. `WhiteSheetExpenseInput` remains in the
presentation layer because it is an editable request value: it combines
`WhiteSheetExpenses` with `actualCashSubmitted` before recalculation.

Database-to-calculation mappings:

| Current source | Canonical field | Rule |
| --- | --- | --- |
| loader argument `marketKey` | `marketKey` | Caller-supplied calculation grouping key. No authoritative database column currently stores it on produce rows; it is not approved as a persistence identity. |
| normalized `produce_transactions.market_name` | `marketLabel` | Exact comparison after the existing `displayMarketName` normalization. |
| loader argument `businessDate` / `produce_transactions.transaction_date` | `businessDate` | Rows are queried by exact ISO business date. |
| `produce_transactions.product_name` | `transactions[].productName` | Persisted text; calculation applies its existing product normalization. |
| `produce_transactions.unit` | `transactions[].unit` | Persisted unit; incompatible normalized units remain separate calculation groups. |
| `produce_transactions.quantity` | `transactions[].quantity` | Persisted decimal quantity; no integer coercion. |
| `produce_transactions.base_transaction_type` | `transactions[].transactionType` | Only `เบิก`, `คืน`, and `คืนเสีย` are effective inputs. |
| `produce_transactions.price_per_unit` | `transactions[].unitPrice` | Persisted unit price. Required for withdrawal rows. |
| `produce_transactions.basis_quantity` / `basis_price` | `transactions[].basisQuantity` / `basisPrice` | Used together for exact basis-price calculation; the rounded `price_per_unit` approximation is not used for the total. |
| `produce_transactions.raw_message_id` → `raw_messages.source_id` | loader `sourceId` scope | Excludes rows belonging to another LINE source even when market labels collide. |
| verified terminal `slip_checks.transfer_amount` in the source/business-date window **plus** closed `manual_slip_sessions`/`manual_slip_entries` for the same source/business-date/market | `verifiedTransfers` | `verifiedTransfers = market-scoped AI attributed total + market-scoped closed manual-slip total` (same business rule as `checked_slip_total = ai_verified_total + manual_slip_total`). AI half uses the globally earliest accepted non-empty `reference_id`; later duplicates are excluded. BR-02: missing reference IDs are pending and not auto-counted. Manual half counts only `status = closed` sessions whose `normalizedMarketLabel(market_label)` equals the White Sheet market — never another market, and never open sessions. Closing a manual slip does not write `transfer_reconciliations`; White Sheet loads closed sessions directly. |
| validated request input | `expenses`, `actualCashSubmitted` | Calculation-only until the schema gap below is approved. No current table is written. |

The loader reads `produce_transactions`, the repository's primary operational
view. Failed or abandoned pending sessions never create rows in that view.
Legacy persisted `produce_sessions` have no invalid/void status, and the
required base has no void or supersede marker, so the loader does not invent
one. More than one non-additional session for the same scoped market/date
produces a warning because those completed rows can still represent duplicate
business data. Raw rows are never mutated or deleted.

## Pricing business decision (unresolved)

Current technical behavior prices each withdrawal from its persisted withdrawal
lot. When one product/day has withdrawals at multiple prices, the calculation
allocates good and damaged returns against those lots in FIFO order before
calculating sold quantity and expected sales.

The business target under discussion is one central selling price per product
per business day. No authoritative source, approval flow, or conflict rule for
that central price has been agreed. FIFO is therefore the current deterministic
technical behavior, not the final business rule. This integration does not
change the pricing algorithm; persistence and UAT must remain blocked on an
explicit business decision if central-price behavior is required.

## Market identity before persistence

The produce path has no persisted `market_key` source of truth. Its stable
persisted inputs are the LINE `source_id` reached through
`produce_transactions.raw_message_id`, the persisted `transaction_date`, and
the stored `market_name`. The loader deterministically derives a normalized
display label from `market_name`, but that label is not an immutable market ID.

`manual_slip_sessions.market_key` is persisted for manual-slip session
uniqueness, but it is derived from command text (including the `"default"`
fallback) and is not attached to produce rows. The white-sheet loader's
`marketKey` is caller-supplied and currently serves only calculation grouping;
it cannot be treated as an authoritative persisted identity.

Consequently, `source_id + normalized market label + business_date` is the only
currently reproducible white-sheet identity across the produce data path. It
still depends on label normalization and is not a substitute for an approved
market registry. Using caller-supplied `marketKey` in a future uniqueness
constraint could create duplicate white sheets when callers use different keys
for the same source/label/date, or merge distinct markets when a reused default
key collides.

Before any persistence migration, the business must approve either a persisted
market registry/mapping or one canonical derivation and backfill rule. Until
then, no white-sheet persistence key is approved.

## Settlement persistence gap (Local MVP status: implemented)

The proposal below was implemented as a LOCAL-ONLY additive migration:
`supabase/migrations/0038_digital_white_sheet_cash_entries.sql`, persisted
through `src/lib/white-sheet/persist.ts`, composed with the operational
loader in `src/lib/white-sheet/compose.ts`, exposed at
`GET/POST /api/white-sheet`, and wired to `DigitalWhiteSheetExpensesForm` at
the `/white-sheet` Dashboard route. It deliberately diverges from the
original sketch below in one respect: the unique key uses
`market_label_normalized` (the same normalization the calculation loader
already applies), not the unresolved `market_key` — per the "Market identity
before persistence" section above, a caller-supplied `marketKey` was never
approved as a persistence identity. `settlement_entries` and
`settlement_finalizations` are untouched; nothing here dual-writes to them.
This migration has NOT been applied to Production — see the Local UAT
verification report for the exact blocker that prevents a genuinely fresh
database from reaching it today.

Current schema (pre-existing, still unmodified by this work):

- `settlement_entries` is unique by
  `(settlement_date, settlement_time, staff_name, market_name)`.
- It stores `money_transfer`, `money_cash`, aggregate `expenses`, `labor`,
  `notes`, and nullable `source_id`.
- `POST /api/settlement` accepts the same fields, upserts by that four-column
  key, optionally reconciles transfer totals when `source_id` is present, and
  may trigger settlement finalization.
- `settlement_finalizations` is unique by `(source_id, business_date)` but is a
  delivery state machine only; it has no cash or expense columns.

This cannot faithfully store `locationFee`, `bag`, `snack`, `other`, or
`otherNote`. Collapsing them into `expenses` loses itemized meaning, and using
`notes` for `otherNote` overloads a general settlement remark. Although
`money_cash` is close to submitted cash in existing reconciliation, the
existing row key permits multiple seller/time entries for one market/date and
does not provide the required one-record white-sheet semantic. No persistence
adapter is implemented.

### Smallest safe forward-only proposal

Add a dedicated `digital_white_sheet_cash_entries` table:

- `id uuid primary key default gen_random_uuid()`
- `source_id text not null`
- `market_key text not null`
- `market_label text not null`
- `business_date date not null`
- `labor numeric(12,2) not null default 0`
- `location_fee numeric(12,2) not null default 0`
- `bag numeric(12,2) not null default 0`
- `snack numeric(12,2) not null default 0`
- `other numeric(12,2) not null default 0`
- `other_note text`
- `actual_cash_submitted numeric(12,2) not null default 0`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- proposed unique constraint on `(source_id, market_key, business_date)`,
  contingent on resolving the market identity decision above
- check constraints requiring every numeric money field to be non-negative
- optional length constraint `char_length(other_note) <= 1000`

Once an authoritative `market_key` exists, the proposed unique key would give
one itemized cash submission per source/market/business date while allowing one
LINE source to serve multiple markets. A caller-supplied key is not safe for
that purpose. The proposal does not change or reinterpret historical
`settlement_entries`.

API proposal:

1. Add a typed repository that validates all numeric fields and upserts the new
   table by `(source_id, market_key, business_date)`.
2. Add an authenticated server action or dedicated
   `POST /api/settlement/white-sheet` boundary. Its payload uses the canonical
   camelCase expense names and explicitly maps them to the snake_case columns.
3. Read the row in `loadServerDigitalWhiteSheetSummary`; until it exists, the
   current request-time `DigitalWhiteSheetCashInput` remains mandatory.
4. Keep existing `POST /api/settlement` payloads and behavior unchanged for
   backward compatibility. Do not dual-write aggregate `expenses` without a
   separately agreed accounting rule.

Rollout:

1. Approve and apply the additive migration in a separate change.
2. Regenerate database types in that same schema change.
3. Deploy read support first; absence of a row remains an explicit
   "not submitted" state, not zero-filled persisted data.
4. Enable validated writes and then connect the Dashboard expense form.
5. Monitor uniqueness and validation failures before UAT sign-off.

Rollback:

- Roll back application reads/writes while leaving the additive table and its
  data intact.
- Do not drop or rewrite `settlement_entries`.
- A destructive table drop, if ever required, must be a separate approved
  migration after exporting submitted data.

## Slip duplicate enforcement

Reconciliation and batch finalization share the read-time global winner
resolver. The earliest accepted terminal check for a non-empty reference stays
authoritative; later checks are excluded and receive only the generic
`สลิปซ้ำ` warning. The warning includes no account, sender, receiver, or full
reference value. Checks without a reference are not marked as duplicates.

This is best-effort, not concurrency-safe fraud prevention. The required base
has no unique constraint on `slip_checks.reference_id`, so simultaneous checks
can both pass a read-before-write lookup. A separately approved partial unique
index/claim flow remains required for atomic enforcement.

`resolveGloballyAcceptedCheckIds` (src/lib/slips/transaction-dedupe.ts) now
chunks its `.in("reference_id", …)` lookup (500 ids/chunk) instead of sending
one unbounded query. The reference id list — not the result rows — is
partitioned, so every check row for a given reference id is always resolved
from exactly one chunk; the existing earliest-wins ordering and fail-closed
"incomplete resolution" check are unchanged, just applied across the merged
chunk results. See the regression test in transaction-dedupe.test.ts that
forces 3 chunks (1,137 distinct reference ids).

## Weight unit compatibility (Local MVP status: implemented)

`calculateWhiteSheetItems`/`calculateDigitalWhiteSheet`
(src/lib/white-sheet/calculate.ts) now apply the same trusted
`resolveUnitQuantity`/`conversionFactor` table the ingestion parser uses
(src/lib/parsers/weigh-session/units.ts) when grouping transaction rows,
instead of only alias-normalizing the unit string. A withdrawal in `โล` and a
return in `ขีด` for the same product now land in one canonical `โล` group
(quantity and any legacy `unitPrice`/`basisQuantity` rescaled consistently)
rather than being silently split into two groups — which could otherwise
manufacture a phantom negative-sold-quantity row and fail the entire sheet.
No new conversion rule was invented: units with no entry in the existing
`UNIT_CONVERSIONS` table (kg vs. pieces, pack vs. pieces, etc.) still stay in
separate groups, and returns exceeding a converted withdrawal quantity still
fail closed. See the new tests in calculate.test.ts.
