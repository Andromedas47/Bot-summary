# Produce business-duplicate protection — read-only UAT

Every query here is **SELECT only**. Nothing in this document mutates Production.
Historical repair is a separate, explicitly authorized task — see
"Historical cleanup plan" at the end.

Business date under investigation: **2026-08-14**.

---

## 1. แทน — ราชพฤก : the exact duplicate

Round A `d5ae8a20-6e41-4293-8065-dcfab9ff2b97` (source `Cf3f0437…`)
Round B `0874d4f3-9e6a-4aba-afad-02f6c848fcaf` (source `C629b6b6…`)

### 1a. The two withdrawal sessions, side by side

```sql
SELECT ps.id                       AS produce_session_id,
       ps.accountability_round_id,
       ar.source_id,
       ps.line_user_id,
       ps.total_items,
       SUM(pi.quantity * pi.price_per_unit) AS withdrawal_amount
FROM   produce_sessions ps
JOIN   accountability_rounds ar ON ar.id = ps.accountability_round_id
JOIN   produce_items pi ON pi.session_id = ps.id AND pi.transaction_type = 'เบิก'
WHERE  ps.accountability_round_id IN (
         'd5ae8a20-6e41-4293-8065-dcfab9ff2b97',
         '0874d4f3-9e6a-4aba-afad-02f6c848fcaf')
  AND  ps.voided_at IS NULL
GROUP  BY 1,2,3,4,5
ORDER  BY ps.finalized_at;
```

Expected: two rows, 16 items and 7,187.00 each, different `source_id`, same
`line_user_id`.

### 1b. Why the deployed blocker missed it

```sql
WITH w AS (
  SELECT ps.accountability_round_id AS rid,
         pi.product_name, pi.unit, pi.quantity, pi.price_per_unit
  FROM   produce_sessions ps
  JOIN   produce_items pi ON pi.session_id = ps.id
  WHERE  ps.accountability_round_id IN (
           'd5ae8a20-6e41-4293-8065-dcfab9ff2b97',
           '0874d4f3-9e6a-4aba-afad-02f6c848fcaf')
    AND  pi.transaction_type = 'เบิก'
    AND  ps.voided_at IS NULL
)
SELECT product_name, unit, quantity, price_per_unit, count(DISTINCT rid) AS rounds
FROM   w
GROUP  BY 1,2,3,4
HAVING count(DISTINCT rid) = 1;
```

Expected: exactly two rows — `อะโวคาโด` and `อะโวคาโด้`. Every other line is
identical across both rounds. The old `session_hash` hashed the raw product
string, so one tone mark produced two hashes for one business withdrawal.

### 1c. Inflation this caused

```sql
SELECT SUM(total_amount) FILTER (WHERE base_transaction_type = 'เบิก')     AS withdrawal,
       SUM(total_amount) FILTER (WHERE base_transaction_type = 'คืน')      AS returned,
       SUM(total_amount) FILTER (WHERE base_transaction_type = 'คืนเสีย')  AS damaged
FROM   produce_transactions
WHERE  transaction_date = '2026-08-14'
  AND  accountability_round_id IN (
         'd5ae8a20-6e41-4293-8065-dcfab9ff2b97',
         '0874d4f3-9e6a-4aba-afad-02f6c848fcaf');
```

Expected: withdrawal 14,374.00 (7,187 counted twice), returned 5,207.00,
damaged 332.50 → calculated sales 8,834.50, i.e. **7,187.00 too high**.

**After this change** the two documents produce ONE business fingerprint, so a
future second submission is classified `duplicate` and persists nothing.

---

## 2. ป้าลี / ขวัญ / โด้ : the composite overlap

ป้าลี round `1846c8a3-3c46-4181-92b7-fc85a1834c20` (30 items, 19,571.50)
ขวัญ round `69e0770b-9cea-4273-99c3-2ae40d98ca9e` (27 items, 15,901.50)
โด้ round `bbf1c5bf-460f-451f-a64a-41f2a43a1338` (3 items, 3,670.00)

```sql
WITH s AS (
  SELECT ps.id, ps.accountability_round_id AS rid
  FROM   produce_sessions ps
  WHERE  ps.accountability_round_id IN (
           '1846c8a3-3c46-4181-92b7-fc85a1834c20',
           '69e0770b-9cea-4273-99c3-2ae40d98ca9e',
           'bbf1c5bf-460f-451f-a64a-41f2a43a1338')
    AND  ps.voided_at IS NULL
), i AS (
  SELECT CASE WHEN s.rid = '1846c8a3-3c46-4181-92b7-fc85a1834c20'
              THEN 'whole' ELSE 'parts' END AS side,
         pi.product_name || '|' || pi.unit || '|' ||
         pi.quantity::text || '|' || pi.price_per_unit::text AS line
  FROM   s JOIN produce_items pi ON pi.session_id = s.id
  WHERE  pi.transaction_type = 'เบิก'
), w AS (SELECT line, count(*) c FROM i WHERE side = 'whole' GROUP BY line),
   p AS (SELECT line, count(*) c FROM i WHERE side = 'parts' GROUP BY line)
SELECT coalesce(w.line, p.line) AS line,
       coalesce(w.c, 0) AS whole_count,
       coalesce(p.c, 0) AS part_count
FROM   w FULL OUTER JOIN p ON w.line = p.line
WHERE  coalesce(w.c, 0) <> coalesce(p.c, 0);
```

Expected: exactly two rows, again only the `อะโวคาโด` / `อะโวคาโด้` spelling.
Under the canonical product identity the multisets are **equal**: 30 = 27 + 3.

The detector reports this as `possible_composite_duplicate` with all three
session ids, all three round ids, both seller/market labels and the item counts.
It does **not** merge, rebind or void anything — the seller identities are
genuinely different and only a human can decide what happened.

---

## 3. จิ๋ว — ราชพฤก : the empty duplicate round

Legitimate `fb919686-0005-4128-a7d9-ae85cffe79a0`
Empty duplicate `bfb2ea7b-ee79-43af-be87-303f07d071a1`

```sql
SELECT ar.id, ar.status, ar.seller_label, ar.market_label, ar.owner_line_user_id,
       ar.created_line_event_id,
       (SELECT count(*) FROM produce_sessions s WHERE s.accountability_round_id = ar.id) AS sessions,
       (SELECT count(*) FROM produce_transactions t WHERE t.accountability_round_id = ar.id) AS transactions,
       (SELECT count(*) FROM pending_sessions p WHERE p.accountability_round_id = ar.id) AS pending
FROM   accountability_rounds ar
WHERE  ar.id IN ('fb919686-0005-4128-a7d9-ae85cffe79a0',
                 'bfb2ea7b-ee79-43af-be87-303f07d071a1');
```

Expected: `fb919686` open with 3 sessions; `bfb2ea7b` **open** with 0 sessions,
0 transactions and 1 pending session (the one classified duplicate). The two
rounds have different `owner_line_user_id`, which is exactly why the deployed
creator-scoped retry cleanup could not reach the orphan.

**After this change** the duplicate finalization calls
`cancel_duplicate_plain_text_round`, which cancels a round matching this
profile — and refuses on any round holding a produce session, a produce
transaction, or another pending generation.

The existing `bfb2ea7b` row is **NOT** repaired by this hotfix. It stays exactly
as it is until the historical cleanup below is authorized.

---

## 4. Every duplicate the new rules would find on a date

```sql
-- What the read-only detector consumes. Feed the result to
-- detectDuplicateAnomalies(businessDate, rows), or run the daily-close
-- preflight for the date, which now includes it.
SELECT session_id, accountability_round_id, staff_name, market_name,
       product_name, unit, quantity, price_per_unit, transaction_type,
       basis_quantity, basis_unit, basis_price
FROM   produce_transactions
WHERE  transaction_date = '2026-08-14'
ORDER  BY session_id, id;
```

---

## Historical cleanup plan (separate, explicitly authorized task)

Not performed here. Recommended order:

1. Freeze: run the preflight for 2026-08-14 and export the
   `exact_duplicate_withdrawal` and `possible_composite_duplicate` evidence.
2. แทน: a human confirms which of `d5ae8a20` / `0874d4f3` is the real
   withdrawal. Round B also holds the return and damaged return, so the
   **withdrawal session of round A** (`c180b94d-…`) is the likely candidate to
   void — via the existing `produce_sessions` void path (0037), never DELETE.
3. Re-run the preflight; the duplicate blocker should clear, and calculated
   sales for แทน — ราชพฤก should fall by 7,187.00.
4. ป้าลี / ขวัญ / โด้: business decision first. If ป้าลี's round is the
   superseded one, void that session; if the split is the correction, void
   nothing and record the decision. Do not auto-merge sellers.
5. จิ๋ว: close or cancel `bfb2ea7b` through the ordinary round-close path.
6. Settlement rows for the date are **not** touched by any of the above — see
   the follow-up below.

## Follow-up: Settlement accountability-round binding

Observed, not fixed here: every 2026-08-14 settlement row has
`source_id = NULL` and `accountability_round_id = NULL`. Settlement therefore
aggregates by seller/market/date, which is what let two produce rounds for one
seller/market/date be summed into one settlement figure — the duplicated
withdrawal flowed straight through.

Two settlement anomalies of the same shape were also observed:

* `ดำ — วัดตะกล่ำ` (transfer 975 / cash 3240 / expenses 1790) and a reversed
  `วัดตะกล่ำ — ดำ` row with identical values — seller and market swapped.
* `มิ้น — 72ทุเรียน` and `โด้ — 72ทุเรียน`, seconds apart, both transfer 300 /
  cash 500, where only โด้ has a corresponding produce round.

Recommendation for a separate PR:

1. Bind settlement rows to `accountability_round_id` (and `source_id`) at
   capture time, the way produce sessions are.
2. Reject a settlement whose seller/market cannot be resolved to exactly one
   round for the date — the reversed `วัดตะกล่ำ — ดำ` row would fail that test.
3. Reuse the canonical seller/market normalization from
   `business-fingerprint.ts` so a swapped pair is detectable rather than
   silently a second identity.
4. Surface unbound settlement rows in the daily-close preflight, alongside
   `unbound_produce_transaction`.

This hotfix deliberately does none of it: the code is not shared, and the change
would not be small.
