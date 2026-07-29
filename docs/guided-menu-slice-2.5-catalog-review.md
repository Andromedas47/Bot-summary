# Guided Menu Slice 2.5 catalog review

Discovery date: 2026-07-29 (Asia/Bangkok)

Status: **approved business decisions encoded in migration 0055; ready for code
review.**

## Source and screening

This review combines the approved business decisions dated 2026-07-29 with
read-only discovery from Production project `apjjsqibavjaitcedavn`:

- `produce_sessions.staff_name`, `session_title`, and `session_date`
- `pending_sessions.staff_label`, `market_label`, and `business_date`

No Production writes were performed. `pending_sessions` had 35 rows but no
non-blank seller or market labels. Production screening excluded voided,
future-dated, blank, test/synthetic, transaction-derived, malformed, and
seller/market-inverted rows.

| Classification | Sessions | Latest date |
|---|---:|---|
| Candidate business row | 1,256 | 2026-07-26 |
| Blank seller or market | 102 | 2026-07-01 |
| Test or synthetic | 37 | 2026-07-25 |
| Future date | 11 | 2056-12-31 |
| Inverted seller and market | 6 | 2026-07-08 |
| Transaction-derived title | 3 | 2026-06-25 |
| Voided | 1 | 2026-07-25 |

Counts below are historical evidence, not a rule that permits new catalog rows.
Only explicitly reviewed rows are seeded.

## Reviewed active sellers

| Code | Display label | Genuine sessions | Latest genuine date |
|---|---|---:|---|
| `ki` | กี้ | 187 | 2026-07-26 |
| `ohm` | โอม | 73 | 2026-07-26 |
| `jiew` | จิ๋ว | 15 | 2026-07-26 |
| `noi` | น้อย | 182 | 2026-07-26 |
| `tan` | แทน | 18 | 2026-07-26 |
| `tom` | ต้อม | 195 | 2026-07-26 |
| `wut` | วุฒิ | 8 | 2026-07-26 |
| `kwan` | ขวัญ | 6 | 2026-07-26 |
| `mint` | มิ้น | 22 | 2026-07-24 |
| `phi_dam` | พี่ดำ | 118 | 2026-07-25 |
| `pla` | ปลา | 156 | 2026-07-22 |
| `toey` | เต้ย | 106 | 2026-07-21 |
| `nu_lek` | หนูเล็ก | 25 | 2026-06-21 |
| `ja` | จ๋า | 4 | 2026-07-17 |
| `pa_lee` | ป้าลี | 21 | 2026-06-07 |
| `nang` | นาง | 0 direct reliable pairs | — |

`จ๋า` is approved as a seller, but its four genuine rows use ambiguous bare
`พาสิโอ้`; no assignment is inferred. `นาง` is approved as a seller, but the
observed row is inverted and does not support an assignment.

## Reviewed active markets

| Code | Display label | Genuine sessions | Latest genuine date |
|---|---|---:|---|
| `ratchaphruek` | ราชพฤกษ์ | 179 | 2026-07-26 |
| `chaloem_72` | เฉลิมฯ72 | 155 | 2026-07-26 |
| `wat_thung_lanna` | วัดทุ่งลานนา | 153 | 2026-07-25 |
| `paseo_vegetable` | พาซิโอ้ผัก | 148 | 2026-07-26 |
| `wat_taklam` | วัดตะกล่ำ | 147 | 2026-07-26 |
| `paseo_fruit` | พาซิโอ้ผลไม้ | 115 | 2026-07-26 |
| `wihan` | วิหาร | 52 | 2026-07-26 |
| `paseo_durian` | พาซิโอ้ทุเรียน | 50 | 2026-07-26 |
| `liap_duan` | เลียบด่วน | 40 | 2026-07-25 |
| `sap_phun` | ทรัพย์พัน | 50 | 2026-07-26 |
| `seven_front` | หน้าเซเวน | 26 | 2026-06-21 |
| `rot_re` | รถเร่ | 15 | 2026-07-26 |

The three Pasio categories are distinct markets. `ทรัพย์พัน2` evidence is
included in the `ทรัพย์พัน` total because it is an approved alias.
`ตลาดกี้` is not a market and migration 0055 removes the malformed 0051 row.

## Reviewed active seller-market assignments

A seller may have multiple simultaneous active markets. This supports the
normal workflow where one seller works different markets at different times
of day.

| Seller | Market | Sessions | Latest genuine date |
|---|---|---:|---|
| กี้ | วัดทุ่งลานนา | 142 | 2026-07-25 |
| กี้ | วัดตะกล่ำ | 38 | 2026-07-26 |
| กี้ | วิหาร | 5 | 2026-06-08 |
| โอม | พาซิโอ้ผลไม้ | 72 | 2026-07-26 |
| โอม | พาซิโอ้ผัก | 1 | 2026-07-02 |
| จิ๋ว | รถเร่ | 15 | 2026-07-26 |
| น้อย | วัดตะกล่ำ | 107 | 2026-07-16 |
| น้อย | ทรัพย์พัน | 47 | 2026-07-26 |
| น้อย | เลียบด่วน | 24 | 2026-06-08 |
| น้อย | หน้าเซเวน | 4 | 2026-06-06 |
| แทน | วิหาร | 9 | 2026-07-26 |
| แทน | เลียบด่วน | 7 | 2026-07-20 |
| แทน | พาซิโอ้ทุเรียน | 2 | 2026-07-17 |
| ต้อม | พาซิโอ้ผัก | 137 | 2026-07-26 |
| ต้อม | พาซิโอ้ทุเรียน | 48 | 2026-07-26 |
| ต้อม | พาซิโอ้ผลไม้ | 10 | 2026-06-15 |
| วุฒิ | ราชพฤกษ์ | 6 | 2026-07-26 |
| วุฒิ | วัดตะกล่ำ | 2 | 2026-07-22 |
| ขวัญ | เฉลิมฯ72 | 6 | 2026-07-26 |
| มิ้น | เฉลิมฯ72 | 22 | 2026-07-24 |
| พี่ดำ | เฉลิมฯ72 | 48 | 2026-07-16 |
| พี่ดำ | พาซิโอ้ผลไม้ | 19 | 2026-07-21 |
| พี่ดำ | ราชพฤกษ์ | 17 | 2026-07-25 |
| พี่ดำ | วิหาร | 12 | 2026-07-15 |
| พี่ดำ | วัดทุ่งลานนา | 10 | 2026-06-29 |
| พี่ดำ | เลียบด่วน | 9 | 2026-07-25 |
| พี่ดำ | ทรัพย์พัน | 3 | 2026-07-13 |
| ปลา | ราชพฤกษ์ | 156 | 2026-07-22 |
| เต้ย | เฉลิมฯ72 | 79 | 2026-07-15 |
| เต้ย | วิหาร | 26 | 2026-07-21 |
| เต้ย | วัดทุ่งลานนา | 1 | 2026-06-25 |
| หนูเล็ก | หน้าเซเวน | 22 | 2026-06-21 |
| หนูเล็ก | พาซิโอ้ผลไม้ | 3 | 2026-06-01 |
| ป้าลี | พาซิโอ้ผลไม้ | 11 | 2026-06-07 |
| ป้าลี | พาซิโอ้ผัก | 10 | 2026-06-02 |

The corrected historical use case is
`กี้ -> วัดทุ่งลานนา -> เบิก -> 25/07/2569`. No assignment is created from
the malformed `ตลาดกี้` history.

## Reviewed historical aliases

Seller aliases:

| Historical label | Canonical seller | Evidence |
|---|---|---|
| กี่ | กี้ | Approved business correction; 1 session, latest 2026-05-30 |
| โอ | โอม | Approved business correction; 16 sessions, latest 2026-06-13 |
| ดำ | พี่ดำ | Approved display identity; 37 sessions, latest 2026-07-25 |

Market aliases with an explicit market identity:

| Historical label | Canonical market | Sessions | Latest genuine date |
|---|---|---:|---|
| ตลาด72 | เฉลิมฯ72 | 22 | 2026-07-09 |
| เฉลิม72 | เฉลิมฯ72 | 5 | 2026-07-23 |
| พาชิโอ้ทุเรียน | พาซิโอ้ทุเรียน | 5 | 2026-07-26 |
| พาสิโอ้ทุเรียน | พาซิโอ้ทุเรียน | 5 | 2026-07-24 |
| พาชิโอ้ ทุเรียน | พาซิโอ้ทุเรียน | 2 | 2026-07-17 |
| พาชิโอ้ผลไม้ | พาซิโอ้ผลไม้ | 32 | 2026-07-26 |
| พาชิโอ้ ผลไม้ | พาซิโอ้ผลไม้ | 8 | 2026-07-21 |
| ตลาดพาซิโอ้ผลไม้ | พาซิโอ้ผลไม้ | 1 | 2026-06-25 |
| พาสิโอ้ผลไม้ | พาซิโอ้ผลไม้ | 1 | 2026-07-06 |
| พาชิโอ้ผัก | พาซิโอ้ผัก | 9 | 2026-07-26 |
| พาสิโอ้ผัก | พาซิโอ้ผัก | 9 | 2026-07-24 |
| ตลาดราชพฤก | ราชพฤกษ์ | 26 | 2026-07-19 |
| ตลาดราชพฤกษ์ | ราชพฤกษ์ | 11 | 2026-07-22 |
| ราชพฤก | ราชพฤกษ์ | 3 | 2026-07-10 |
| เลียบทางด่วน | เลียบด่วน | 24 | 2026-06-08 |
| วัดตะกลํ่า | วัดตะกล่ำ | 27 | 2026-07-07 |
| ตลาดทุ่งลานนา | วัดทุ่งลานนา | 22 | 2026-07-16 |
| ตลาดวัดทุ่งลานนา | วัดทุ่งลานนา | 2 | 2026-07-05 |
| ทุ่งลานนา | วัดทุ่งลานนา | 1 | 2026-07-09 |
| หน้าเซเว่น | หน้าเซเวน | 4 | 2026-06-06 |
| ทรัพย์พัน2 | ทรัพย์พัน | 16 | 2026-07-26 |

## Ambiguous, rejected, or pending rows

| Row or group | Sessions / latest | Decision and reason |
|---|---|---|
| ป้าลีนาง / ตลาดใหม่ | 1 / 2026-07-07 | Rejected concatenation of separate sellers ป้าลี and นาง. |
| จ๋า / พาสิโอ้ | 4 / 2026-07-17 | Seller approved; bare market cannot identify a Pasio category. |
| ต้อม / พาสิโอ้ | 42 / 2026-07-22 | Bare misspelling is ambiguous across three categories. |
| โอม / พาสิโอ้ | 1 / 2026-07-07 | Bare misspelling is ambiguous across three categories. |
| Bare ผัก / ผลไม้ / ทุเรียน | 3 observed groups | Not seeded globally because surrounding context is insufficient. |
| ดำ / วิหารหลวงปู่โต | 5 / 2026-07-11 | Market identity unconfirmed; unseeded. |
| น้อย / ทรัพย์เจริญ | 3 / 2026-07-04 | Likely market, but official identity unconfirmed; pending and unseeded. |
| กี้ / ตลาดกี้ | 2 / 2026-06-28 | Malformed history; excluded and removed from the catalog. |
| กี้ / วัดตะกร่ำ | 3 / 2026-06-15 | Likely typo; target not confirmed. |
| กี้ / วัดวานนา | 1 / 2026-06-28 | Likely typo; target not confirmed. |
| กี้ / 2วัดทุ่งลานนา | 1 / 2026-06-14 | Prefix meaning unclear. |
| ปลา / ราชพฤษก | 1 / 2026-06-28 | Likely typo; not automatically normalized. |
| ดำ / พาขิโอ้ผลไม้ | 1 / 2026-07-09 | Likely typo; not automatically normalized. |
| เสือ rows | 7 / 2026-07-25 | Six explicit tests; one title embeds another seller and transaction data. |
| Blank seller or market | 102 / 2026-07-01 | Cannot form an assignment. |
| Future-dated rows | 11 / 2056-12-31 | Excluded from genuine evidence. |
| Inverted seller/market rows | 6 / 2026-07-08 | Seller and market positions are reversed; no inference made. |
| Transaction-derived titles | 3 / 2026-06-25 | Title is transaction text, not a market identity. |

## Future admin-managed seller catalog

The current Guided Menu reads only reviewed active seller, market, and
seller-market rows. It never creates a seller from arbitrary LINE text.

A later admin flow should be restricted to an authorized operator and commit
these fields together: `seller_code`, display label, reviewed aliases, active
status, and active seller-market assignments. It should enforce the existing
code/label constraints and foreign keys, require assignments to active reviewed
markets, and record who approved each change. Deactivation should preserve
history. This migration intentionally adds no speculative admin UI or public
write policy.
