# P2C Purchase Capture — Production activation and UAT runbook

Everything below is executed by a human operator in LINE. Nothing in this
document may be run against a live market group.

Production project: `apjjsqibavjaitcedavn`. Merge commit under test: `dab404b`
plus the allowlist change in this branch.

---

## 0. Preconditions (verify before touching any flag)

| Check | Expected | How |
|---|---|---|
| Purchase operational tables empty | `0` rows in `purchase_capture_sessions`, `purchase_capture_session_ingests`, `purchase_capture_notifications`, `purchase_receipts`, `purchase_receipt_items`, `inventory_movements`, `inventory_movement_lines` | SQL below |
| Slice C1 RPCs present | `begin_purchase_capture_confirmation`, `complete_purchase_capture_posting` exist, `SECURITY DEFINER`, granted to `service_role` only | SQL below |
| RLS deny-all | every purchase/inventory table has `relrowsecurity = true` and **zero** policies | SQL below |
| Registry seeded | products `หมอนทอง`, `ส้มไต้หวัน`; unit `โล`; location `MAIN` | SQL below |

```sql
select relname, n_live_tup
from pg_stat_user_tables
where schemaname = 'public'
  and (relname like 'purchase%' or relname like 'inventory%')
order by relname;
```

```sql
select p.proname, p.prosecdef,
       pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('begin_purchase_capture_confirmation',
                    'complete_purchase_capture_posting')
order by p.proname;
```

```sql
select c.relname, c.relrowsecurity,
       (select count(*) from pg_policies pp
         where pp.schemaname = 'public' and pp.tablename = c.relname) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and (c.relname like 'purchase%' or c.relname like 'inventory%')
order by c.relname;
```

---

## 1. Activation

Two independent fail-closed gates. **Both** must be set, and each one alone
does nothing.

| Vercel Production env var | Value | Meaning |
|---|---|---|
| `PURCHASE_CAPTURE_WEBHOOK_ENABLED` | `true` | the feature flag; only this exact string enables it |
| `PURCHASE_CAPTURE_LINE_GROUP_IDS` | *the dedicated UAT group ID* | the source allowlist; empty means no source is allowed |
| `PURCHASE_CAPTURE_CRON_ENABLED` | leave **unset** for now | enabled only at step 11 |

`PURCHASE_CAPTURE_LINE_GROUP_IDS` has no default on purpose. Physical Inventory
ships a baked-in default group; purchase capture writes stock into MAIN, so its
permitted sources are always an explicit Production decision.

Set both, redeploy, and confirm the deployment is READY before sending any
message.

### Rollback

Clear `PURCHASE_CAPTURE_LINE_GROUP_IDS` (or set `PURCHASE_CAPTURE_WEBHOOK_ENABLED`
to anything other than `true`) and redeploy. Routing stops immediately and the
handler returns before its first database call. No data is written or removed by
rollback — receipts and movements already posted stay posted, which is correct:
they are real stock.

---

## 2. Message grammar

Exact forms accepted by the parser ([classify.ts:14](../src/lib/purchases/classify.ts:14)).
Dates are Buddhist-era `d/m/yyyy`.

```
เริ่มซื้อ 7/8/2569 09:15
ผู้ขาย: ร้านทดสอบ UAT
ใบอ้างอิง: UAT-001
ปลายทาง: MAIN
```

```
ซื้อรายการ 1
สินค้า: หมอนทอง
จำนวน: 10 โล
ราคา: 85 บาท/โล
```

```
สรุปค่าใช้จ่ายซื้อ
ค่าขนส่ง: 0 บาท
ค่าจัดการ: 0 บาท
ส่วนลด: 0 บาท
ภาษีมูลค่าเพิ่ม: ไม่มี
```

```
ปิดซื้อ 1 รายการ
```

Confirmation commands — **exact normalized match only**, no trailing particles:

| Command | Effect |
|---|---|
| `ยืนยันซื้อ` | confirm, post to MAIN, deliver posted-success |
| `ตรวจใบซื้อใหม่` | rebuild the draft from the durable ingests and re-preview |
| `ยกเลิกซื้อ` | cancel, only while cancellation is still permitted |

`ยืนยันซื้อครับ` deliberately does **not** match.

---

## 3. UAT sequence

Registry state in Production today: `หมอนทอง` and `ส้มไต้หวัน` resolve; `โล`
resolves to `kg`. Any other product or unit is unresolved, which is what
scenario 5 relies on.

Record the LINE group ID, both operator LINE user IDs, and the wall-clock start
time before you begin. Keep every screenshot — see §5.

| # | Step | Send | Expect |
|---|---|---|---|
| 1 | open session | the `เริ่มซื้อ` block alone | one `purchase_capture_sessions` row, `status = 'open'` |
| 2 | multi-message capture | the `ซื้อรายการ 1` block, then the `สรุปค่าใช้จ่ายซื้อ` block, as separate messages | one `purchase_capture_session_ingests` row per message, session still `open` |
| 3 | close | `ปิดซื้อ 1 รายการ` | session moves to `closing`; the close boundary is frozen |
| 4 | finalize + preview | wait for the quiet window (8s) to elapse | session `awaiting_confirmation`; a `purchase_receipts` row in `draft`; `preview_ready` parts in `purchase_capture_notifications`, all delivered; the preview arrives in LINE |
| 5 | blocked confirmation | in a **second** session (steps 1–4 again) use `สินค้า: มะนาว` — not in the registry — then send `ยืนยันซื้อ` | refusal quoting a blocking blocker; receipt still `draft`; **zero** new `inventory_movements`; **zero** `purchase_receipt_lifecycle_events` confirmation row |
| 6 | registry correction | add the missing product to `purchase_intake_product_registry` (SQL below) | row present and `active = true` |
| 7 | recheck | `ตรวจใบซื้อใหม่` | draft rebuilt from the durable ingests, `draft_revision` increments, a fresh preview is delivered, blocker gone |
| 8 | successful confirmation | `ยืนยันซื้อ` on the session from step 7 | receipt `confirmed`; **exactly one** `inventory_movements` row with `movement_type = 'PURCHASE_RECEIPT'`; session `posted`; posted-success message delivered |
| 9 | one-message capture | a single message containing header + item + costs + `ปิดซื้อ` blocks separated by blank lines, then confirm | same result as 1–8 in one message; one movement |
| 10 | duplicate confirm | send `ยืนยันซื้อ` again on the posted session | idempotent replay: same movement id echoed, **no second movement**, **no second MAIN balance increase** |
| 11 | cron recovery | only now set `PURCHASE_CAPTURE_CRON_ENABLED=true`, redeploy, and invoke the cron route with `CRON_SECRET` | route returns work counts instead of `{ok:true, disabled:true}`; a session left mid-flight is recovered |

### Step 6 — registry correction SQL

```sql
insert into public.purchase_intake_product_registry (product_key, raw_product_text, active)
values ('lime', 'มะนาว', true)
on conflict do nothing;
```

### Interrupted-recovery check (do this between steps 8 and 10)

Open, capture, close, finalize and send `ยืนยันซื้อ` on a fresh session, then —
while it is still working — confirm the session reached `confirming`:

```sql
select id, status, receipt_id, draft_revision, movement_id, updated_at
from public.purchase_capture_sessions
order by created_at desc
limit 5;
```

A session that stays `confirming` for more than one minute is picked up by the
recovery sweep. It resumes from the bound receipt and never re-runs
`begin_purchase_capture_confirmation`. The end state must still be exactly one
movement.

---

## 4. Quantity and balance proof

Run after step 8, again after step 9, and again after step 10. The counts must
not change between step 8's reading and step 10's reading.

```sql
select m.id, m.movement_type, m.source_document_type, m.source_document_id,
       m.reversal_of_movement_id, m.dedupe_key, m.created_at
from public.inventory_movements m
order by m.created_at;
```

```sql
select * from public.get_inventory_balances(
  p_location_code => 'MAIN',
  p_product_key   => null,
  p_unit_key      => null,
  p_include_zero  => false
);
```

```sql
-- one movement per confirmed receipt, never more
select source_document_id, count(*) as movements
from public.inventory_movements
where movement_type = 'PURCHASE_RECEIPT'
group by source_document_id
having count(*) > 1;
-- must return zero rows
```

Pass criteria:

- `MAIN / durian-monthong / kg` increases by exactly the confirmed quantity, **once**.
- The duplicate-confirm query returns zero rows.
- `purchase_capture_notifications` has no part left undelivered after the sweep.

---

## 5. Evidence to keep

Do not delete any of this — it is the audit record for the release.

- LINE screenshots of every step, including the refusal at step 5.
- The output of every SQL block in §4, before and after the duplicate confirm.
- The `purchase_capture_sessions` and `purchase_receipts` rows for each session,
  with `status`, `draft_revision` and `movement_id`.
- The cron route response from step 11.
- The exact env var values used (group ID is not a secret; **never** record
  `CRON_SECRET` or the LINE channel access token).
