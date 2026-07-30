# Guided Menu Slice 2 Evidence

Committed LINE Messaging API message objects for UX review.

- `line-messages.json` — built by `buildSlice2EvidenceMessages()` with
  **deterministic** `gpm1:` tokens (not random).
- Covers: transaction type, two-page seller selection, market, date, confirm
  preview, cancel/back, no active seller market, invalid/expired, unmapped, and
  the no-write placeholder.
- Verified path: `กี้ → วัดทุ่งลานนา → เบิก → 25/07/2569`.
- Focused tests compare against this file and must leave the worktree clean.
- Do not regenerate during ordinary test runs.
- No merge, migration apply, deploy, or real LINE send.
