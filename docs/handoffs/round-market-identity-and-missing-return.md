# Market identity consistency + missing-return guard

Business date of the evidence: **2026-08-10** (10 สิงหาคม 2569). Production was
read with `SELECT` only; nothing was mutated, backfilled, or repaired.

## 1. What Production actually held

| seller / market | round | withdrawal | return state |
|---|---|---|---|
| ดำ / ทุ่งลานนา | `d96d2898-43f7-4eeb-9477-5e8b942da477` | 32 | landed, but filed under `วัดทุ่งลานนา` |
| มิ้น / ทรัพย์พัน2 | `b0e8b69f-…` | 33 | full ชั่งคืน document with its closer, refused by P4A, pending row never finalized |
| ต้อม / พาชิโอ้ | `924fd122-…` | 19 | no return sent; the later retry was a *withdrawal* (`ต้อม-พาชิโอ้รวม เบิก`) that failed parse validation |
| ต้อม / พาชิโอ้ทุเรียน | `767113ba-…` | 3 | no return activity |
| ต้อม / พาชิโอ้ผลไม้ | `85bb210e-…` | 21 | no return activity |
| ขวัญ / ราชพฤกษ์ | `9fbe4b88-…` | 16 | open document at 07:44 on 2026-08-11, finalized 07:51 the same morning |

Duplicate open rounds exist for ต้อม/พาชิโอ้ (3) and มิ้น/ทรัพย์พัน2 (2); only
one of each carries transactions. Any "clear the binding and rediscover" repair
would hit `ambiguous` on those, which is why none is proposed.

## 2. Root causes

**Market drift.** `bind_plain_text_accountability_round` compared normalized
market LABELS. `ทุ่งลานนา` and `วัดทุ่งลานนา` are the same market — the reviewed
catalog (`line_guided_menu_market_aliases`, migration 0055) says so explicitly —
but the label comparison failed both trust paths and returned `no_round`. On a
business date before the `2026-08-11` enforcement cutover the caller degraded
that to `unbound`, and the RPC does not clear
`pending_sessions.accountability_round_id`. The BEFORE INSERT trigger
`propagate_produce_session_accountability_round` then copied the withdrawal's
round onto the return session anyway. One round, two market labels.

**False `เบิก 0`.** `buildDailyGoodReturnValueReport` keyed cells on
`cleanMarketName(market_name)` and never read `accountability_round_id`, so the
return cells had no withdrawal and raised `ไม่พบรายการเบิกที่ตรงกัน`. Daily
Sales had the same disease through `rowMarketKey = sourceId + label`.

**Blocked return read as sold out.** `isSoldOutByAbsentReturn` inspected
persisted rows only. Unresolved pending sessions reached Sales as an anonymous
day-wide count (`unresolved_pending_session`) that demoted totals but left every
identity `TRUSTED`, so `✅ ถือว่าขายหมดเพราะไม่มีรายการคืน` still counted them.

## 3. What changed

Migration `20260811090000_round_market_identity_consistency.sql` (additive; two
new helper functions, one `CREATE OR REPLACE` of the existing RPC; no table, no
column, no data change):

- `accountability_round_market_code(label)` — reviewed canonical code, or NULL.
- `accountability_round_same_market(a, b)` — normalized-equal, or both mapped to
  one catalog code. Never fuzzy, never similarity-based.
- The binding RPC uses that equality in both trust paths and gains a
  `market_mismatch` outcome that names the round's market.

Application:

- `bindPlainTextRound` refuses `market_mismatch` on **every** business date and
  returns the round's canonical `marketLabel` on success.
- `src/lib/produce/round-return-status.ts` classifies each round's return as
  `persisted` / `blocked` / `pending` / `none` from `pending_sessions`.
- The 08:00 good-return report and the 08:10 Sales report key reconciliation on
  `accountability_round_id` when present, display the round's canonical label,
  and fall back to the legacy `(source + label)` identity for NULL-round rows.
- Sales withdraws the sold-out reading — and only that reading — for a round
  whose return is `blocked` or `pending`.
- The 08:00 report gains `⚠️ ตลาดที่มีเบิกแต่ยังไม่มีรายการคืนที่บันทึกสำเร็จ`
  with per-round detail. The old day-wide count stays for documents no round can
  claim.

## 4. Deliberately NOT done

- No historical repair. The 2026-08-10 rows are evidence and stay as they are;
  round-keyed reporting reconciles them correctly without rewriting anything.
- `propagate_produce_session_accountability_round` is unchanged. Round-keyed
  reporting is robust to it, and tightening the trigger risks hard-failing
  legitimate finalizations whose market the catalog does not cover.
- P4A validation tiers, the unit vocabulary, the quantity invariant, and the
  second-close confirmation are untouched.

## 5. Production UAT

Run after deploy, in the operator's own LINE group. Do not reuse the P4A UAT
evidence.

**UAT A — canonical market consistency.** In ดำ's group, open a withdrawal with
the canonical spelling and close the return with the alias spelling:

```
ดำ-วัดทุ่งลานนา เบิก 12/8/2569
1.หมอนทอง100บาท
2โล
จบรายการเบิก
```

```
ดำ-ทุ่งลานนา ชั่งคืน 12/8/2569
1.หมอนทอง100บาท
1โล
จบรายการชั่งคืน
```

Expected: the return is **accepted** and lands in the withdrawal's round. Verify
read-only that both sessions share one `accountability_round_id`, then check the
08:00 report shows one market and no `ไม่พบรายการเบิกที่ตรงกัน`.

Then, in the same group, send a return naming a different market:

```
ดำ-ราชพฤกษ์ ชั่งคืน 12/8/2569
1.หมอนทอง100บาท
1โล
จบรายการชั่งคืน
```

Expected: refused with `⛔ ตลาดไม่ตรงกับรอบเบิกที่เปิดอยู่` naming the round's
market, and `ระบบยังไม่ได้บันทึกอะไร`. No new transaction rows.

**UAT B — missing/blocked return reporting.** In a test group, persist a
withdrawal, then send a return with a product spelling the withdrawal does not
contain (the `แอปเปิ้ล` / `แอปเปิ่ล` shape) and close it. P4A refuses; nothing
persists. Then call the 08:00 report for that business date with `?debug=1` and
confirm the market appears under
`⚠️ ตลาดที่มีเบิกแต่ยังไม่มีรายการคืนที่บันทึกสำเร็จ` with
`พบการส่งชั่งคืน แต่ยังบันทึกไม่สำเร็จ`, and that Daily Sales does **not** count
it under `✅ ถือว่าขายหมดเพราะไม่มีรายการคืน`.
