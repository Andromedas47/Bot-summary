# Guided Menu → 0049 Integration Boundary

Planning document only. Does **not** authorize merge, deploy, webhook wiring, or DB writes.

Preview branch: `feat/guided-produce-menu-preview`  
0049 candidate (do not merge from here): `feat/produce-structured-session-foundation`

---

## 1. Preview state → 0049 command field mapping

| Preview confirmation / session | `OpenProduceSessionCommand` field | Notes |
|---|---|---|
| `sessionKind` fixed | `sessionKind = "main"` | V1 menu opens main sessions only |
| UI เบิก / ชั่งคืน / คืนเสีย → `TX_CODE_TO_BASE` | `initialTransactionType` | Canonical map: ชั่งคืน → `คืน` |
| — | `declaredTransactionType = null` | Main sessions |
| — | `additionalOpener = null` | Main sessions |
| Resolved ISO business date | `businessDate` | Operator sees Buddhist Era; command stays ISO |
| LINE event clock (preview placeholder) | `transactionTime` | `HH:mm` Bangkok |
| Preview default | `transactionTimeSource = "line_event"` | Operator-declared time deferred |
| Preview staff label / future identity | `staffLabel` | Placeholder today; 0050 later |
| Config market label from `mid` | `marketLabel` | Never trust raw label from postback |
| Preview placeholder | `lineEventId` | Real webhook `event.id` |
| Preview clock / event | `lineTimestampMs` | Real webhook timestamp |

Close / finalize preview maps to `CloseProduceSessionCommand` with `expectedItemCount = parsedItemCount`.

Adapter module: `src/lib/line/guided-menu/guided-menu-command-adapter.ts` (re-exports `command-adapter.ts`).

---

## 2. Fields available from LINE webhook

Available without new tables:

- `event.type` (`postback` / `message`)
- `event.replyToken`
- `event.source` (user / group / room + ids)
- `event.timestamp`
- `event.postback.data` (must be `gpm.v1.*` and validated)
- text message body for forwarded / pasted produce lines
- message / event identity used for admission / ingest (0049 ledger)

---

## 3. Fields requiring operator identity resolution

- `staffLabel` (คนขาย / ผู้เปิดรายการ)
- attribution for session ownership (`lineUserId` on command source)
- future display name vs accounting staff label split

**TODO(0050-integration):** `line_operator_identities` (or equivalent) must resolve these. Preview uses `PREVIEW_STAFF_LABEL` only.

---

## 4. Fields requiring 0050 opaque state token

Postback field `tok` is reserved.

Needed for:

- multi-step menu continuity without stuffing trusted metadata into editable postbacks
- binding mid-flow selections to server-side menu state
- preventing label smuggling via client-edited postback strings

Until 0050, preview encodes validated codes (`tx`, `mid`, `dm`, `iso`) only and re-validates on every step.

---

## 5. How forwarded text continues through pending-session ingest

Guided open emits a typed open command (not a synthetic Thai header).

Subsequent LINE text events (forwarded or pasted) should:

1. admit by immutable event id
2. ingest matched text into the structured pending session
3. append items via existing deterministic parser path with structured seed metadata

Preview simulates received messages + reconstructed items via fixtures only.

---

## 6. How status / readiness would be queried

Status should report:

- received / admitted message count
- ingested count
- reconstructed item count
- blocking issue count + exact raw examples

Readiness for review-and-close requires admitted/ingested set parity (0049 close barrier). Preview models this with `closeBarrierStatus` + counts.

---

## 7. How review-and-close maps to close command

Operator flow:

1. `ตรวจและจบรายการ` → establish close / generation boundary (waiting)
2. wait until admitted == ingested
3. build review from reconstructed items
4. if blocking → no persist action
5. if valid → explicit `ยืนยันบันทึก`
6. emit close/finalize command with expected item count

Preview: `review_close` → `close_barrier` → `barrier_ready` → `review_*` → `confirm_persist` → `finalize`.

---

## 8. Why final confirmation must be idempotent

LINE may retry postbacks. Operators may tap twice.

Final persistence must:

- key on event id / generation / session key
- return the same success outcome on duplicate confirm
- never double-write produce rows

Preview mirrors this with `persistedSimulated` + repeated `finalize` staying on `success`.

---

## 9. Required failure behavior

Fail closed when:

- missing / invalid postback
- unknown market id
- missing transaction type (no silent เบิก default)
- barrier not ready
- blocking parse issues present
- ownership / generation conflict (0049)
- blank / unmatched / duplicate events (0049)

Never say `บันทึกแล้ว` unless persistence (or simulated success) completed.

---

## 10. Explicitly deferred work

- merge / apply 0049
- implement 0050 menu state + operator identity tables
- wire `webhook-service` postback handling
- real LINE send
- real close-barrier DB ledger
- item correction persistence
- LIFF
- purchase / physical inventory guided UX
- replacing preview types with real 0049 imports (same repo after merge only)

---

## Integration checklist (future)

1. 0049 approved and applied
2. Swap `PreviewOpenProduceSessionCommand` → real type via adapter only
3. Resolve staffLabel from identity service
4. Bind postback `tok` to 0050 state rows
5. Route postbacks in webhook without synthesizing Thai headers
6. Keep legacy typed open/close paths working in parallel
