# P2E release-blocker remediation

## Status

- Verdict: blockers remediated locally; commit/push/required CI still pending.
- PR: #38, branch `feat/p2e-accountability-round-identity`.
- Starting head: `310bd25d7680cc66b0e93b2c3415c9eebc5a28ee`.
- Production Supabase, deployment, merge, and LINE delivery remain untouched.

## Blockers and root causes

1. White Sheet and open-slip journey reads use the descriptive tuple without applying `accountability_round_id`, so a same-description round can observe another round.
2. `settlement_entries` has RLS disabled and grants direct table access to `anon` and `authenticated`, although all application paths use server-side service-role clients.
3. Guided LINE return/damaged continuation does not pass the durable round UUID already retained in the pending guided session, so the opener correctly refuses it.

## Decisions

- Scope round-aware reads by exact UUID. An explicit `null` means genuinely legacy-unbound rows only; no UUID-to-tuple fallback.
- Enable RLS on `settlement_entries`; revoke direct `anon`/`authenticated` access; grant only required service-role operations.
- Reuse the existing durable pending guided-session association. Do not add free-text UUID input or infer a round from seller/market/date.
- Amend the unpublished P2E migration; do not add a follow-up migration.
- Replace legacy tuple uniqueness with round-aware `UNIQUE NULLS NOT DISTINCT`
  keys for settlement/finalization/reconciliation; keep one partial NULL-only
  legacy White Sheet key.

## Files

- Runtime: guided journey/UX, White Sheet load/compose/persistence/LINE close,
  reconciliation, settlement submit/finalizer/API, generated database types.
- Database: unpublished P2E migration and production-shaped PostgreSQL bootstrap.
- Regressions: P2E PostgreSQL, White Sheet cash/produce, actual Guided Menu
  continuation, same-description slip/settlement/reconciliation, signed settlement.

## Migration and security

- Application access audit: settlement API routes, dashboard server components, PDF routes, reconciliation/finalization services all receive `createServiceClient()` or an injected service-role client. No browser/anon settlement table path found.
- Implemented privileges: `settlement_entries` RLS enabled; `PUBLIC`, `anon`, and
  `authenticated` revoked; `service_role` retains SELECT/INSERT/UPDATE only.
- Read-only production verification confirmed exact legacy constraint/index names,
  `service_role.rolbypassrls = true`, and no source/date duplicates that block the
  new round-aware keys. Production remained unmodified.

## Validation

- Passed: White Sheet persistence 32 tests; Guided Menu opener 23; two-round
  slip/settlement app contract 12; focused guided/settlement/reconciliation 184;
  settlement API/reconcile/finalizer/signed flow 91; slip/manual-slip 49;
  White Sheet loader 13.
- Passed: P2E PostgreSQL migration/security suite, 46 assertions, including two
  same-description rounds, A/B continuations, cash/slip/settlement/finalization/
  reconciliation isolation, real conflict targets, anon denial, and service-role access.
- Passed: typecheck, lint (0 errors; 65 pre-existing warnings), `git diff --check`.
- Build: Next compile and TypeScript passed; local prerender stops at `/overview`
  because this worktree intentionally has no Supabase URL. Required Vercel CI remains
  the environment-backed build authority.
- Remaining: commit, push PR #38, wait for all required CI, fix P2E-only failures.

## Git state

- Starting head `310bd25d`; remediation changes are unstaged and uncommitted.

## Exact next step

Review final staged diff, commit the remediation, push the existing PR branch, and
wait for required PostgreSQL and Vercel checks. Do not merge or deploy.
