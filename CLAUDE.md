# CLAUDE.md

Context for Claude Code working in this repository.

## What this is

A multi-platform social content publisher. One piece of content is uploaded
once, then auto-published on a schedule to multiple social accounts owned by
the operator, using each platform's **official API**.

Purpose: build audience → earn via YouTube ad revenue and brand sponsorships →
funnel traffic to owned properties.

## Hard rules — do not violate these

These are not style preferences. Breaking them gets accounts permanently banned
or creates legal exposure.

1. **Never automate account creation.** No CAPTCHA solving, no SMS/OTP
   verification services, no proxy rotation for signup, no headless-browser
   registration flows. Accounts are created manually by a human, once.
2. **Official APIs only.** No scraping, no undocumented/private endpoints, no
   reverse-engineered mobile API calls, no browser automation to post.
3. **Never store OAuth tokens in table columns.** Tokens live in Supabase Vault
   or Vercel environment variables. Tables store only `token_secret_name`, a
   pointer.
4. **Never commit secrets.** No `.env`, no service-role keys, no tokens in code,
   comments, tests, or example values.
5. **Respect per-platform rate limits and daily post caps.** The `accounts`
   table has `daily_post_limit`. Enforce it.
6. **No reused third-party content.** Content must be operator-created,
   AI-generated, or properly licensed. Re-uploading others' videos gets channels
   demonetized and is copyright infringement.

## Stack

- Next.js 15 (App Router) on Vercel
- Supabase Postgres + Storage
- TypeScript strict mode

Supabase project ref: `cqlspabncujagkdvzuyt` (region eu-west-3)

## Architecture

```
brands ─┬─> accounts ──┐
        │              ├─> post_targets ──> post_metrics
        └─> content_items ──┘
```

- **brands** — one per channel identity. Keeps separate ventures from mixing.
- **accounts** — one per social account owned. Holds the Vault pointer.
- **content_items** — the master asset. Stored once, reused across platforms.
- **post_targets** — the queue. One row = one content item → one account → one
  scheduled time, with its own caption. This is the central table.
- **post_metrics** — time-series performance. This is the sponsorship pitch
  data. Never drop it.

### The scheduler

`app/api/cron/publish/route.ts` runs every 15 min:

1. `release_stale_locks()` — recovers jobs orphaned by timed-out runs
2. `claim_due_posts()` — atomic claim via `FOR UPDATE SKIP LOCKED`
3. For each: load content + account, sign a media URL, dispatch to the adapter
4. Mark `published`, or requeue for retry (max 3 attempts, then `failed`)

**The atomic claim is load-bearing.** Overlapping cron runs would otherwise
double-post. Do not replace it with a plain `SELECT ... WHERE status='queued'`.

### Adapters

Every platform implements `PublishAdapter` in `lib/adapters/types.ts` and
registers in `lib/adapters/index.ts`. The scheduler is platform-agnostic and
must stay that way — no `if (platform === 'youtube')` branches in the route.

`mockAdapter` exists so the pipeline can be tested end-to-end without any real
credentials. Keep it working.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Schema + storage | done |
| 2 | Scheduler + mock adapter | done |
| 3 | YouTube adapter (Data API v3, resumable upload) | next |
| 4 | Instagram + Facebook (Meta Graph API) | pending |
| 5 | Pinterest, TikTok, X | pending |
| 6 | Metrics collection + sponsor-facing reporting | stub exists |

**Phase 3 notes:** YouTube uses resumable upload. Vercel Hobby caps function
duration at 60s — for larger files, either upgrade to Pro (`maxDuration = 300`)
or move upload to a Supabase Edge Function. Flag this rather than silently
truncating.

**Phase 4 notes:** Instagram requires a Business/Creator account linked to a
Facebook Page. Content publishing is a two-step create-container-then-publish
flow, not a single call.

**Phase 5 notes:** TikTok's Content Posting API requires app audit approval
before direct posting is enabled. Unaudited apps can only post to private.

## Conventions

- TypeScript strict. No `any` — use `unknown` and narrow.
- Errors: catch per-post inside the loop. One failed post must never abort the
  batch.
- All DB access through `supabaseAdmin`. Never import it into a client component.
- New tables/columns go in `supabase/migrations/` as a numbered `.sql` file.
  Never edit an already-applied migration; add a new one.

## Commands

```bash
npm run dev         # local dev
npm run typecheck   # tsc --noEmit — run before every commit
npm run build       # production build
npx tsx scripts/seed.ts   # seed test data

# Trigger the scheduler manually
curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/publish
```

## Environment variables

See `.env.example`. Required now: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`. Platform credentials are added per
phase.

## Working style

- Run `npm run typecheck` before proposing a commit.
- Open pull requests. Do not push directly to `main`.
- When a change affects the schema, include the migration in the same PR.
- If a task would require breaking one of the hard rules above, stop and say so
  instead of finding a workaround.
