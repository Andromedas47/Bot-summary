# bot-summary

Production-ready dashboard for parsing and visualising LINE messages via the LINE Messaging API webhook.

## Quick start

### 1. Clone and install

```bash
git clone <repo-url>
cd bot-summary
npm install
```

### 2. Set up environment variables

```bash
cp .env.example .env.local
```

Fill in the values in `.env.local`.

### 3. Run the database migration

In your Supabase SQL editor, paste and run:

```
supabase/migrations/0001_initial_schema.sql
```

Or with the Supabase CLI:

```bash
npx supabase db push
```

### 4. Start the dev server

```bash
npm run dev
```

Open http://localhost:3000.

### 5. Configure the LINE webhook

1. In LINE Developers Console, open your channel.
2. Go to Messaging API → Webhook settings.
3. Set the webhook URL:
   - Local dev: use ngrok → `https://your-ngrok-id.ngrok.io/api/webhook/line`
   - Production: `https://your-domain.com/api/webhook/line`
4. Enable **Use webhook** and click **Verify**.

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 (strict) |
| Styling | Tailwind CSS v4 |
| Database | Supabase (PostgreSQL + RLS) |
| Messaging | LINE Messaging API |

## Deployment (Vercel)

Set all environment variables in your Vercel project settings, then:

```bash
vercel --prod
```

## Produce-session deferred finalizer (Release B)

`จบรายการ` no longer finalizes a pending produce session inside the LINE
webhook request. The webhook stores the first close boundary and replies
immediately that pending items are being checked.

An external durable scheduler must call:

```text
GET /api/cron/finalize-pending-produce-sessions
Authorization: Bearer <CRON_SECRET>
```

Call the route no more than once per minute from exactly one durable scheduler.
Do not poll this endpoint from a browser, configure a second scheduler, or retry
immediately after an error. The route coalesces overlapping work in a warm
instance and skips database work when called again within 60 seconds, but the
caller cadence is the guard that prevents serverless invocation cost. Release B
deliberately does not create a Supabase Cron job, and `vercel.json` remains empty
because this repository's Vercel plan does not support the required schedule.

User-visible timing:

- With no late webhook, finalization becomes eligible 8 seconds after close and
  starts on the next scheduler call (normally within 60 seconds).
- Every eligible late item rearms eligibility to 8 seconds after that item,
  capped at 30 seconds after the first close.
- `จบรายการ N รายการ` waits for every indexed number `1..N`. At the first due
  check it reports exact missing numbers; at the 30-second deadline it fails
  closed without produce writes if any remain.
- Bare `จบรายการ` is quiet-window best-effort and has no indexed-completeness
  guarantee.

Database state remains due when a scheduler request fails, so a later scheduler
call retries it. Finalization is generation-, sender-, and revision-pinned and
is idempotent under concurrent calls. Per Release B scope there is no
notification outbox: if the database transaction succeeds but the later LINE
push fails, the failure is logged and the database result remains authoritative.
