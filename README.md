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
