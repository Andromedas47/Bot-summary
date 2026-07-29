# Guided Menu Slice 2.5 catalog review

Discovery date: 2026-07-29 (Asia/Bangkok)

Status: **blocked for business confirmation; migration 0055 remains unseeded.**

## Source and screening

The proposal below comes from read-only queries against Production project
`apjjsqibavjaitcedavn`.

- `produce_sessions`: `staff_name`, `session_title`, and `session_date`
- `pending_sessions`: `staff_label`, `market_label`, and `business_date`

`pending_sessions` has 35 rows but no non-blank seller or market labels, so it
provides no catalog evidence.

The `produce_sessions` screening excluded voided rows, future dates, blank
seller/market values, test or synthetic labels, transaction-derived titles,
and inverted seller/market rows. The first-pass classification was:

| Classification | Sessions | Latest date |
|---|---:|---|
| Candidate business row | 1,256 | 2026-07-26 |
| Blank seller or market | 102 | 2026-07-01 |
| Test or synthetic | 37 | 2026-07-25 |
| Future date | 11 | 2056-12-31 |
| Inverted seller and market | 6 | 2026-07-08 |
| Transaction-derived title | 3 | 2026-06-25 |
| Voided | 1 | 2026-07-25 |

Counts below are conservative: only exact labels and the high-confidence
historical aliases listed here were combined. An entry in this review is not
approval to seed it.

## Proposed canonical sellers

| Proposed code | Display label | Accepted sessions | Latest genuine date |
|---|---|---:|---|
| `tom` | ต้อม | 195 | 2026-07-26 |
| `ki` | กี้ | 187 | 2026-07-26 |
| `noi` | น้อย | 182 | 2026-07-26 |
| `pla` | ปลา | 156 | 2026-07-22 |
| `dam` | ดำ | 118 | 2026-07-25 |
| `toey` | เต้ย | 106 | 2026-07-21 |
| `ohm` | โอม | 73 | 2026-07-26 |
| `nu_lek` | หนูเล็ก | 25 | 2026-06-21 |
| `mint` | มิ้น | 22 | 2026-07-24 |
| `pa_lee` | ป้าลี | 21 | 2026-06-07 |
| `tan` | แทน | 18 | 2026-07-26 |
| `jiew` | จิ๋ว | 15 | 2026-07-26 |
| `wut` | วุฒิ | 8 | 2026-07-26 |
| `kwan` | ขวัญ | 6 | 2026-07-26 |

## Proposed canonical markets

Three rows already exist in Production's authoritative market catalog:
`kee`, `seven_front`, and `wat_taklam`.

| Proposed code | Display label | Source status | Accepted sessions | Latest genuine date |
|---|---|---|---:|---|
| `ratchaphruek` | ราชพฤกษ์ | Proposed | 179 | 2026-07-26 |
| `chaloem_72` | เฉลิมฯ72 | Proposed | 155 | 2026-07-26 |
| `wat_thung_lanna` | วัดทุ่งลานนา | Proposed | 153 | 2026-07-25 |
| `paseo_vegetable` | พาซิโอ้ผัก | Proposed | 148 | 2026-07-26 |
| `wat_taklam` | วัดตะกล่ำ | Existing | 147 | 2026-07-26 |
| `paseo_fruit` | พาซิโอ้ผลไม้ | Proposed | 115 | 2026-07-26 |
| `wihan` | วิหาร | Proposed | 52 | 2026-07-26 |
| `paseo_durian` | พาซิโอ้ทุเรียน | Proposed | 50 | 2026-07-26 |
| `liap_duan` | เลียบด่วน | Proposed | 40 | 2026-07-25 |
| `sap_phun` | ทรัพย์พัน | Proposed, confirmation required | 34 | 2026-07-24 |
| `seven_front` | หน้าเซเวน | Existing | 26 | 2026-06-21 |
| `sap_phun_2` | ทรัพย์พัน2 | Proposed, confirmation required | 16 | 2026-07-26 |
| `rot_re` | รถเร่ | Proposed | 15 | 2026-07-26 |
| `kee` | ตลาดกี้ | Existing | 2 | 2026-06-28 |

## Proposed seller-market assignments

| Seller | Market | Sessions | Latest genuine date |
|---|---|---:|---|
| กี้ | วัดทุ่งลานนา | 142 | 2026-07-25 |
| ต้อม | พาซิโอ้ผัก | 137 | 2026-07-26 |
| น้อย | วัดตะกล่ำ | 107 | 2026-07-16 |
| เต้ย | เฉลิมฯ72 | 79 | 2026-07-15 |
| โอม | พาซิโอ้ผลไม้ | 72 | 2026-07-26 |
| ดำ | เฉลิมฯ72 | 48 | 2026-07-16 |
| ต้อม | พาซิโอ้ทุเรียน | 48 | 2026-07-26 |
| กี้ | วัดตะกล่ำ | 38 | 2026-07-26 |
| น้อย | ทรัพย์พัน | 34 | 2026-07-24 |
| เต้ย | วิหาร | 26 | 2026-07-21 |
| น้อย | เลียบด่วน | 24 | 2026-06-08 |
| มิ้น | เฉลิมฯ72 | 22 | 2026-07-24 |
| หนูเล็ก | หน้าเซเวน | 22 | 2026-06-21 |
| ดำ | พาซิโอ้ผลไม้ | 19 | 2026-07-21 |
| ดำ | ราชพฤกษ์ | 17 | 2026-07-25 |
| จิ๋ว | รถเร่ | 15 | 2026-07-26 |
| น้อย | ทรัพย์พัน2 | 13 | 2026-07-26 |
| ดำ | วิหาร | 12 | 2026-07-15 |
| ป้าลี | พาซิโอ้ผลไม้ | 11 | 2026-06-07 |
| ต้อม | พาซิโอ้ผลไม้ | 10 | 2026-06-15 |
| ดำ | วัดทุ่งลานนา | 10 | 2026-06-29 |
| ป้าลี | พาซิโอ้ผัก | 10 | 2026-06-02 |
| ดำ | เลียบด่วน | 9 | 2026-07-25 |
| แทน | วิหาร | 9 | 2026-07-26 |
| แทน | เลียบด่วน | 7 | 2026-07-20 |
| ขวัญ | เฉลิมฯ72 | 6 | 2026-07-26 |
| วุฒิ | ราชพฤกษ์ | 6 | 2026-07-26 |
| กี้ | วิหาร | 5 | 2026-06-08 |
| น้อย | หน้าเซเวน | 4 | 2026-06-06 |
| ดำ | ทรัพย์พัน2 | 3 | 2026-07-13 |
| หนูเล็ก | พาซิโอ้ผลไม้ | 3 | 2026-06-01 |
| กี้ | ตลาดกี้ | 2 | 2026-06-28 |
| แทน | พาซิโอ้ทุเรียน | 2 | 2026-07-17 |
| วุฒิ | วัดตะกล่ำ | 2 | 2026-07-22 |
| โอม | พาซิโอ้ผัก | 1 | 2026-07-02 |
| เต้ย | วัดทุ่งลานนา | 1 | 2026-06-25 |

Low-count and stale assignments are evidence only. They must not be activated
without a business rule for recency and whether a seller may retain multiple
markets.

## High-confidence historical aliases

| Type | Historical label | Proposed canonical label | Sessions | Latest date |
|---|---|---|---:|---|
| Seller | พี่ดำ | ดำ | 81 | 2026-07-23 |
| Seller | พี่ต้อม | ต้อม | 13 | 2026-07-26 |
| Seller | พี่เต้ย | เต้ย | 58 | 2026-06-22 |
| Seller | พี่ปลา | ปลา | 88 | 2026-07-11 |
| Market | ตลาด72 | เฉลิมฯ72 | 22 | 2026-07-09 |
| Market | เฉลิม72 | เฉลิมฯ72 | 5 | 2026-07-23 |
| Market | พาชิโอ้ทุเรียน | พาซิโอ้ทุเรียน | 5 | 2026-07-26 |
| Market | พาสิโอ้ทุเรียน | พาซิโอ้ทุเรียน | 5 | 2026-07-24 |
| Market | พาชิโอ้ ทุเรียน | พาซิโอ้ทุเรียน | 2 | 2026-07-17 |
| Market | พาชิโอ้ผลไม้ | พาซิโอ้ผลไม้ | 32 | 2026-07-26 |
| Market | พาชิโอ้ ผลไม้ | พาซิโอ้ผลไม้ | 8 | 2026-07-21 |
| Market | ตลาดพาซิโอ้ผลไม้ | พาซิโอ้ผลไม้ | 1 | 2026-06-25 |
| Market | พาสิโอ้ผลไม้ | พาซิโอ้ผลไม้ | 1 | 2026-07-06 |
| Market | พาชิโอ้ผัก | พาซิโอ้ผัก | 9 | 2026-07-26 |
| Market | พาสิโอ้ผัก | พาซิโอ้ผัก | 9 | 2026-07-24 |
| Market | ตลาดราชพฤก | ราชพฤกษ์ | 26 | 2026-07-19 |
| Market | ตลาดราชพฤกษ์ | ราชพฤกษ์ | 11 | 2026-07-22 |
| Market | ราชพฤก | ราชพฤกษ์ | 3 | 2026-07-10 |
| Market | เลียบทางด่วน | เลียบด่วน | 24 | 2026-06-08 |
| Market | วัดตะกลํ่า | วัดตะกล่ำ | 27 | 2026-07-07 |
| Market | ตลาดทุ่งลานนา | วัดทุ่งลานนา | 22 | 2026-07-16 |
| Market | ตลาดวัดทุ่งลานนา | วัดทุ่งลานนา | 2 | 2026-07-05 |
| Market | ทุ่งลานนา | วัดทุ่งลานนา | 1 | 2026-07-09 |
| Market | หน้าเซเว่น | หน้าเซเวน | 4 | 2026-06-06 |

## Ambiguous or rejected rows

| Row or group | Sessions / latest | Decision and reason |
|---|---|---|
| `กี่` / วัดทุ่งลานนา | 1 / 2026-05-30 | Rejected as an uncertain alias of กี้. |
| `โอ` / พาซิโอ้ผลไม้ | 16 / 2026-06-13 | Rejected as an uncertain alias of โอม. |
| `จ๋า` / พาสิโอ้ | 4 / 2026-07-17 | Seller may be genuine, but the market is generic and assignment is unclear. |
| `ป้าลีนาง` / ตลาดใหม่ | 1 / 2026-07-07 | Possible merged seller labels; identity is unclear. |
| `ต้อม` / พาสิโอ้ | 42 / 2026-07-22 | Generic market cannot be assigned safely to fruit, vegetable, or durian. |
| `โอม` / พาสิโอ้ | 1 / 2026-07-07 | Generic market cannot be assigned safely. |
| `มิ้น` / ทุเรียน | 1 / 2026-07-23 | Category-only market label is not a confirmed market identity. |
| `ต้อม` / ผัก | 1 / 2026-07-03 | Category-only market label is not a confirmed market identity. |
| `ดำ` / วิหารหลวงปุ่โต | 5 / 2026-07-11 | Could be an alias or a separate market. |
| `น้อย` / ทรัพย์เจริญ | 3 / 2026-07-04 | Could be an alias or a separate market. |
| `กี้` / วัดตะกร่ำ | 3 / 2026-06-15 | Likely typo, but not safe to normalize without confirmation. |
| `กี้` / วัดวานนา | 1 / 2026-06-28 | Likely typo, but target market is uncertain. |
| `กี้` / `2วัดทุ่งลานนา` | 1 / 2026-06-14 | Prefix meaning is unclear. |
| `ปลา` / ราชพฤษก | 1 / 2026-06-28 | Likely typo, but not seeded automatically. |
| `ดำ` / พาขิโอ้ผลไม้ | 1 / 2026-07-09 | Likely typo, but not seeded automatically. |
| `เสือ` rows | 7 / 2026-07-25 | Six are explicit tests; one title embeds another seller, market, and transaction date. |
| Blank seller or market | 102 / 2026-07-01 | Cannot form an assignment. |
| Future-dated rows | 11 / 2056-12-31 | Excluded from genuine historical evidence. |
| Inverted seller/market rows | 6 / 2026-07-08 | Examples include วัดทุ่งลานนา/กี้, ทรัพย์พัน/ดำ, and พาซิโอ้ผลไม้/โอม. |
| Transaction-derived titles | 3 / 2026-06-25 | Titles contain weighing/transaction text rather than a market identity. |

`ทรัพย์พัน` and `ทรัพย์พัน2` are kept separate in the proposal because the
data does not prove whether they are distinct markets or aliases.

## Human confirmations required before seeding

1. Approve the canonical seller list and whether honorifics (`พี่`, `ป้า`) are
   display-label content or historical aliases.
2. Approve the official market spellings/codes, especially the three
   พาซิโอ้ categories and whether `ทรัพย์พัน` and `ทรัพย์พัน2` are distinct.
3. Decide whether generic `พาสิโอ้`, `ผัก`, and `ทุเรียน` rows map to a
   canonical market or remain rejected.
4. Confirm or reject the uncertain identities/aliases `กี่`, `โอ`, `จ๋า`,
   `ป้าลีนาง`, `วิหารหลวงปุ่โต`, and `ทรัพย์เจริญ`.
5. Define which seller-market assignments are currently active, including a
   recency/minimum-evidence rule and the unusual กี้ → ตลาดกี้ assignment.

Until those decisions are recorded, migration 0055 must create schema only and
must not seed seller or seller-market rows.
