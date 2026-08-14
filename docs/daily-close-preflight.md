# Daily Close Preflight

One deterministic answer to "can business date `YYYY-MM-DD` be reported cleanly?",
shared by the 08:00 stock report, the 08:10 sales report and the operator command
`ตรวจความพร้อม`. Before it existed each of those three re-derived "unresolved" for
itself, and they drifted.

```
raw daily operations
  → produce validation / round binding      (unchanged, P4A)
  → Daily Close Preflight                   (this document)
  → 08:00 stock / good-return report
  → 08:10 sales report
```

No new table, no new column, no migration. Every fact below is derived from
records the system already keeps.

## Modules

| File | Role |
| --- | --- |
| `src/lib/produce/failure-lifecycle.ts` | Pure rules: is a failed attempt still live? |
| `src/lib/produce/failure-lifecycle-source.ts` | Turns Production rows into those rules' inputs |
| `src/lib/produce/central-price-candidates.ts` | Which prices were entered, and what is approved |
| `src/lib/produce/daily-close-preflight.ts` | Pure readiness classification + its loaders |
| `src/lib/produce/preflight-service.ts` | The single entry point every surface calls |
| `src/lib/produce/preflight-message.ts` | Thai LINE presentation |
| `src/lib/produce/preflight-command.ts` | `ตรวจความพร้อม [DD/MM/YYYY]` |

## Readiness

| Status | Meaning |
| --- | --- |
| `ready` | Nothing outstanding. |
| `ready_with_warnings` | Only audit/context warnings remain (a sold-out round, a retired duplicate round, a superseded failure). |
| `blocked` | At least one genuine unresolved issue: a refused or open ชั่งคืน, an active failed document, an unresolved central price, or an integrity fault. |

Per round: `ready` / `partial` (value incomplete only) / `blocked`.

Issue codes are stable: `missing_successful_return`, `active_failed_produce_session`,
`pending_produce_session`, `unresolved_central_price`,
`duplicate_open_accountability_round`, `unbound_produce_transaction`,
`superseded_failed_session`, `abandoned_failed_session`, `round_identity_ambiguity`.
Every issue carries `evidenceIds`, so no count is unexplainable.

## Failure lifecycle

A refused document is **never** downgraded unless a specific successful document
can be pointed at.

- **`superseded`** — a later `main` produce session with the same intent landed.
  Two identity paths, and only two:
  - the attempt names an accountability round → same round + same transaction
    kind + strictly later;
  - no round → source **and** business date **and** market **and** seller **and**
    transaction kind must all match explicitly, and any unknown dimension
    disqualifies the match.
- **`abandoned`** — the attempt's accountability round was retired
  (`status = 'cancelled'`, migration `20260811090000`).
- **`active_failed`** — everything else, including two candidate successors
  (reported as `round_identity_ambiguity`, never resolved by guess).

An additional batch (`เบิกเพิ่ม` / `ชั่งคืนเพิ่ม`) is additive and can never be a
replacement. A voided session is not a successful outcome.

Nothing is written, no audit row is removed, no `is_processed` flag is repaired.
Supersession lives entirely in the reporting layer.

## Central price

Identity is `product_key + unit_key + business_date`, global across markets
(BR-01). Candidates come from the day's withdrawal rows through the same
`centralPriceKey` the calculator prices with.

| Status | Condition |
| --- | --- |
| `missing` | Withdrawals exist, no stored price. |
| `seeded` | One candidate, established by the deployed first-withdrawal seed. |
| `unresolved` | Several candidates, still on the seeded price. Blocks the date. |
| `approved` | An administrator set it (`set_central_selling_price`, audited in `central_selling_price_corrections`). |

No majority rule, no latest-wins, no min/max. Approving a price never rewrites a
withdrawal — the raw transaction keeps the price that was entered.

Review the candidates: `GET /api/admin/central-price?review=1&businessDate=YYYY-MM-DD`.
Approve one: the existing admin `POST /api/admin/central-price`.

## What one "รายการ" is

One market + product + unit identity after canonical product/unit resolution —
exactly one `SalesIdentityRow`. Not a transaction row, not a message, not a
session. `ยืนยันได้` and `ยืนยันไม่ได้` partition that set, and every
`ยืนยันไม่ได้` row is printed by name inside its market block.
`ถือว่าขายหมดเพราะไม่มีรายการคืน` is a subset, never a third bucket.

## Report shape

One block per market label, one verdict:

```
🏪 เลียบด่วน
✅ ยืนยันครบ
ยอดขายรวม 990.00 บาท

🏪 ตลาด72
⚠️ ยืนยันได้บางส่วน
ยอดที่ยืนยันแล้ว 8,186.50 บาท
ยังไม่รวม:
• อะโวคาโด (กิโล) — ราคากลางขัดแย้ง รอผู้ดูแลยืนยัน
```

Market labels are merged for presentation only: one real market can reach the
calculator under a round-keyed identity and a legacy (source + label) identity,
which is what produced Production's confusing pair of lines for `ตลาด72`. The
calculator keys stay distinct.

## Sold-out inference

`ถือว่าขายหมดเพราะไม่มีรายการคืน` requires that nothing is known to be missing
for that round (`returnEvidenceIncomplete` false). A round with a refused or
still-open ชั่งคืน keeps its quantities but is never called sold out.
