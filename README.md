# bot-summary

Production-ready dashboard for parsing and visualising LINE messages via the LINE Messaging API webhook.

## Architecture overview

```
src/
├── app/
│   ├── (dashboard)/           # Dashboard route group (overview + messages)
│   │   ├── layout.tsx         # Sidebar shell
│   │   ├── page.tsx           # Overview stats + recent events
│   │   └── messages/page.tsx  # Paginated event table
│   ├── api/webhook/line/
│   │   └── route.ts           # LINE webhook — verifies signature, stores events, dispatches parsers
│   ├── layout.tsx             # Root layout (font, metadata)
│   └── globals.css            # Tailwind v4 + theme tokens
├── components/
│   ├── ui/                    # Primitive components: Button, Card, Badge
│   ├── dashboard/             # Sidebar, TopBar, StatCard
│   └── messages/              # MessageTable
├── lib/
│   ├── supabase/              # client.ts (browser) + server.ts (SSR + service role)
│   ├── line/                  # types.ts (full webhook typings) + verify.ts (HMAC)
│   └── parsers/               # base.ts (Parser interface) + registry.ts (plug-in parsers here)
├── types/
│   ├── database.ts            # Supabase table types (hand-maintained; replace with supabase gen types)
│   └── index.ts               # Shared domain types
supabase/migrations/
└── 0001_initial_schema.sql    # line_raw_events + parsed_messages + RLS
```

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

Fill in the values in `.env.local`:

| Variable | Where to find it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API (keep secret!) |
| `LINE_CHANNEL_SECRET` | LINE Developers → your channel → Basic settings |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers → Messaging API tab |

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

## Adding a parser

Parsers live in `src/lib/parsers/`. To add one:

1. Create `src/lib/parsers/your-parser.ts` extending `BaseParser`:

```typescript
import { BaseParser, ParseResult } from './base'
import type { LineMessageEvent } from '@/lib/line/types'

export class OrderParser extends BaseParser {
  name = 'order'
  version = '1.0.0'
  supportedTypes = ['text']

  async parse(event: LineMessageEvent): Promise<ParseResult> {
    return this.result({ /* structured data */ })
  }
}
```

2. Register it in `src/lib/parsers/registry.ts`:

```typescript
import { OrderParser } from './order-parser'
parserRegistry.register(new OrderParser())
```

The webhook handler automatically routes matching events to the first registered parser that `canHandle()` returns true.

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
