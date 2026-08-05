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
   pointer. Read them with `readSecret()` from `lib/vault.ts` — never log the
   value.
4. **Never commit secrets.** No `.env`, no service-role keys, no tokens in code,
   comments, tests, or example values.
5. **Respect per-platform rate limits and daily post caps.**
   `accounts.daily_post_limit` is enforced inside `claim_due_posts` — see the
   scheduler section. Keep it that way; do not add a code path that publishes
   without going through the claim.
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

`claim_due_posts` is also where `daily_post_limit` is enforced (migration 003).
It counts today's `published` **and** in-flight `processing` rows per account,
so overlapping runs cannot each claim a full allowance, and it skips accounts
that are not `active` so their posts wait instead of burning retries. The
allowance resets at 00:00 UTC. Enforcing the cap in the loop instead would
claim the post first and so still spend an attempt — keep it in the claim.

### Adapters

Every platform implements `PublishAdapter` in `lib/adapters/types.ts` and
registers in `lib/adapters/index.ts`. The scheduler is platform-agnostic and
must stay that way — no `if (platform === 'youtube')` branches in the route.

`mockAdapter` exists so the pipeline can be tested end-to-end without any real
credentials. Keep it working. Set `MOCK_PUBLISH=true` and every platform
resolves to it — including `fetchMetrics`, so the metrics cron is testable too.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Schema + storage | done |
| 2 | Scheduler + mock adapter | done |
| 3 | YouTube adapter (Data API v3, resumable upload) | done |
| 4 | Instagram + Facebook (Meta Graph API) | next |
| 5 | Pinterest, TikTok, X | pending |
| 6 | Metrics collection + sponsor-facing reporting | stub exists |

**Phase 3 notes:** `lib/adapters/youtube.ts`. Chunked resumable upload, buffered
in one invocation and capped by `YOUTUBE_MAX_MEDIA_BYTES` (256 MiB default) —
oversized media fails loudly rather than uploading truncated. Raising it means
raising `maxDuration` to 300 on Vercel Pro, or moving the upload to a Supabase
Edge Function.

The binding constraint is **API quota, not `daily_post_limit`**: 10,000
units/day per Cloud project and ~1,600 per `videos.insert` is ~6 uploads/day
across every channel sharing that project.

Watch time and shares are not in Data API v3 — they come from the YouTube
Analytics API under a separate `yt-analytics.readonly` scope, so
`fetchMetrics` treats them as best-effort and still returns
views/likes/comments if that scope was never granted.

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
npm test            # vitest run — also run before every commit
npm run test:watch  # vitest, watching
npm run build       # production build

npm run add-account -- --help   # register an account you already own
npm run add-content  -- --help   # upload media and queue it
npx tsx scripts/seed.ts          # seed test data

# Trigger the scheduler manually
curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/publish
```

## Environment variables

See `.env.example`. Required now: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`. Platform credentials are added per
phase.

## Tests

`vitest`, run by CI. Files are colocated as `*.test.ts`.

`lib/adapters/youtube.test.ts` drives the adapter against a stubbed `fetch`, so
it covers the resumable-upload protocol, metadata limits, the publish guards and
the error mapping with no credentials. Note the `loadAdapter()` helper: it calls
`vi.resetModules()` before importing, because the adapter caches access tokens at
module scope and a shared cache silently skips the token-refresh paths the error
tests exist to check. New adapters should follow the same shape.

Not covered anywhere: the Supabase round-trip and Storage uploads in
`scripts/`, which need the service-role key.

## Working style

- Run `npm run typecheck` and `npm test` before proposing a commit.
- Open pull requests. Do not push directly to `main`.
- When a change affects the schema, include the migration in the same PR.
- If a task would require breaking one of the hard rules above, stop and say so
  instead of finding a workaround.
