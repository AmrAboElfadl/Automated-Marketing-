# Social Publisher

Auto-publishes content to multiple social platforms on a schedule, via official
platform APIs.

## Setup

```bash
npm install
cp .env.example .env.local     # then fill in the values
npm run dev
```

### 1. Database

Run the files in `supabase/migrations/` in order, in the Supabase SQL Editor.
Migration `001` (schema) is already applied to project `cqlspabncujagkdvzuyt`.
Still to apply:

- `002` — Vault secret access. Required before the YouTube adapter can read a
  token.
- `003` — enforces `accounts.daily_post_limit` in the atomic claim. Without it
  the column is ignored and nothing stops the scheduler from over-posting.

### 2. Environment variables

| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API (keep secret) |
| `CRON_SECRET` | Generate: `openssl rand -hex 32` |

Add all three to Vercel → Settings → Environment Variables. See
`.env.example` for the per-platform variables added in later phases.

### 3. Deploy

Push to GitHub and import into Vercel. Import the repo **once** — two Vercel
projects pointing at the same repo both build on every push and both run the
scheduler. The atomic claim stops that from double-posting, but it wastes
builds and makes logs confusing.

### 4. Schedule the scheduler

`vercel.json` deliberately registers **no** cron jobs, because Vercel's Hobby
plan triggers cron only **once per day** — which would ignore `scheduled_at`
entirely and post everything in one daily burst. Trigger the endpoints
externally instead.

Any scheduler works ([cron-job.org](https://cron-job.org) is free). Two jobs:

| Job | URL | Interval |
|---|---|---|
| publish | `https://<your-app>.vercel.app/api/cron/publish` | every 15 min |
| metrics | `https://<your-app>.vercel.app/api/cron/metrics` | every 6 hours |

Both need a request header — this is the only thing protecting the endpoints,
so treat it like a password:

```
Authorization: Bearer <your CRON_SECRET>
```

Overlapping or duplicated triggers are safe by design: `claim_due_posts` uses
`FOR UPDATE SKIP LOCKED`, so a second concurrent run claims nothing.

**On Vercel Pro instead?** Add the crons to `vercel.json` and Vercel injects
the `Authorization` header itself:

```json
"crons": [
  { "path": "/api/cron/publish", "schedule": "*/15 * * * *" },
  { "path": "/api/cron/metrics", "schedule": "0 */6 * * *" }
]
```

Pro also allows raising `maxDuration` to 300 in the route files, which is what
lets `YOUTUBE_MAX_MEDIA_BYTES` go above the default 256 MiB.

### 5. Verify

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-app.vercel.app/api/cron/publish
```

Expected: `{"claimed":0,"message":"nothing due"}` — the pipeline works, the
queue is empty.

To exercise the full claim → publish → mark-published path without touching a
real platform, set `MOCK_PUBLISH=true`, run `npx tsx scripts/seed.ts`, then hit
the endpoint again.

## Connecting a YouTube channel

Accounts are created by hand — the engine never registers them. Per channel:

1. **Google Cloud project** — enable *YouTube Data API v3*. Create an OAuth 2.0
   Client ID and put it in `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`.
2. **Consent, once, as a human** — authorise the channel's Google account for
   scope `https://www.googleapis.com/auth/youtube.upload` (add
   `https://www.googleapis.com/auth/yt-analytics.readonly` to get watch time and
   shares in `post_metrics`). Keep the refresh token.
3. **Store the token in Vault**, never in a column:

   ```sql
   select vault.create_secret('<refresh-token>', 'yt_token_mainchannel');

   update accounts
      set token_secret_name   = 'yt_token_mainchannel',
          external_account_id = '<UC... channel id>'
    where platform = 'youtube' and handle = '@mainchannel';
   ```

   `external_account_id` is optional but recommended: the adapter checks the
   token actually owns that channel and aborts on a mismatch, so a mixed-up
   secret can't publish to the wrong channel.

### Two limits worth knowing before you schedule anything

- **API quota, not the post cap, is the real ceiling.** A Cloud project gets
  10,000 units/day and `videos.insert` costs ~1,600 — about **six uploads/day**
  shared across every channel on that project, whatever
  `accounts.daily_post_limit` says. Request more quota from Google, or use one
  Cloud project per channel.
- **Function duration.** The upload runs inside one invocation and is capped at
  256 MiB (`YOUTUBE_MAX_MEDIA_BYTES`); oversized media fails with a clear error
  instead of uploading a truncated video. Vercel Hobby allows 60s. For bigger
  files, raise `maxDuration` to 300 on Pro and lift the cap to match, or move
  the upload to a Supabase Edge Function.

Uploads land as `public` by default (`YOUTUBE_PRIVACY_STATUS`). Note that
YouTube locks uploads from an **unverified** API project to private regardless
of what is requested — verify the project if posts appear private.

## Claude Code

- `CLAUDE.md` — project context, architecture, and hard rules
- `/adapter <platform>` — implement a new platform adapter
- `/review` — safety review before merging
- `/status` — build health and roadmap position

For GitHub automation, install the Claude GitHub App and add `ANTHROPIC_API_KEY`
to repository secrets. Then tag `@claude` in any issue or PR.

## Roadmap

1. ~~Schema + storage~~
2. ~~Scheduler + mock adapter~~
3. ~~YouTube adapter~~
4. Instagram + Facebook ← next
5. Pinterest, TikTok, X
6. Metrics + sponsor reporting
