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

## 1b. Why the duplicate open rounds exist

`ต้อม-พาชิโอ้ ชั่งคืน 10/8/2569` is refused in Production with
`⛔ มีรอบที่เปิดค้างอยู่มากกว่า 1 รอบ`. Read-only, the three rounds are:

| round | created | creation key suffix | tx | produce sessions | pending |
|---|---|---|---|---|---|
| `ac51a41b` | 13:25:12 | `…:0d51347c` | 0 | 0 | 0 |
| `d740e9d5` | 13:33:55 | `…:9a691b1f` | 0 | 0 | 0 |
| `924fd122` | 13:34:51 | `…:cc758591` | 19 | 1 | 0 |

All three carry `created_line_event_id = 'plaintext:<one session_key>:<generation>'`
with the SAME session_key — one LINE group, one typist. They differ only in the
pending generation. `พาชิโอ้รวม` repeats the shape: `f60d8598` (09:05:13, empty)
then `f46b3d90` (09:07:24, 43 transactions), two minutes apart. Across the whole
database every empty open round — 4 of 20 — is a `plaintext:` round.

The lifecycle that produces them:

1. `runPlainTextCloseGate` (and the deferred finalizer) call
   `bindPlainTextRound` **before** the entry gate that decides whether the
   document may persist. A withdrawal therefore commits its round first.
2. The gate blocks (P4A tier, or a price review awaiting its second close).
   `markClose` is reset to `false`; nothing persists. The round stays open and
   empty.
3. The operator re-sends the corrected document. It carries the header, and the
   accumulated text already ends in a closer, so
   `requiresFreshPendingGeneration` is true and `replaceGeneration` rotates to a
   new `session_generation`. The one-shot path
   (`startAdditionalPendingSession`) rotates unconditionally.
4. Round creation is idempotent per **generation** —
   `v_creation_key = 'plaintext:' || session_key || ':' || session_generation` —
   so the new generation mints a second round. It has to be per generation: P2E
   allows a seller to open two genuine withdrawal rounds for the same market and
   day, so the key cannot be seller/market/date.
5. The first round is now unreachable. Its generation no longer exists, no
   pending row points at it, and nothing was ever persisted into it. Its only
   remaining effect is to sit in Trust 2's candidate set and make the day's
   ชั่งคืน `ambiguous`.

Not the cause: session-generation rotation itself (it is correct and required),
stale `pending_sessions.accountability_round_id` (the column is repointed at the
new round), or the propagation trigger. A parse-level failure creates nothing —
both callers skip binding when `getWeighSessionFinalizationErrors` is non-empty —
so only documents that parsed cleanly and were then refused leak a round.

**Fix.** Creating a round retires the round the previous generation of the same
plain-text session left behind, when that round holds nothing: no produce
session, no pending generation. Status becomes `cancelled` with the successor's
creation key as the closing event — terminalized, never deleted. It is scoped to
one session_key, one seller, one business date and one reviewed market, so a
seller running several markets in one group keeps every one of them, and a
legitimate second withdrawal round is safe because by then the first one has
persisted its session. Discovery is untouched: ambiguity still fails closed, and
the binding never prefers "the round with transactions".

This is prevention, not repair. The four rounds already in Production stay
exactly as they are; the next ต้อม/พาชิโอ้ withdrawal retires the two empties as
a side effect of the ordinary lifecycle. To unblock the 2026-08-10 return before
that, an admin closes the unused rounds — which is what the existing refusal
already tells the operator to do.

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
- Creating a round cancels the empty round left by a previous generation of the
  same plain-text session (see §1b).

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

**UAT C — a blocked withdrawal retry leaves one round.** In a test group, send a
withdrawal whose product spelling P4A refuses, with its closer, so the gate
blocks. Then re-send the whole corrected document including the header. Verify
read-only that for that seller/market/business date exactly ONE
`accountability_rounds` row is `open`, and that the first one is `cancelled`
with `closed_line_event_id` equal to the second one's `created_line_event_id`.
Then send the ชั่งคืน: it must be accepted, not
`⛔ มีรอบที่เปิดค้างอยู่มากกว่า 1 รอบ`.
