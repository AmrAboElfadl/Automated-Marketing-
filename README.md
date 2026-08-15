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

   That pre-upload check needs a **read** scope — `channels.list(mine=true)` is
   not covered by `youtube.upload`. Add
   `https://www.googleapis.com/auth/youtube.readonly` when you authorise if you
   want it. Without that scope the adapter logs a warning, uploads anyway, and
   compares the channel id that `videos.insert` returns — so a mismatch is
   still reported, just after the upload instead of before it.

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

## Day-to-day: adding accounts and content

Two scripts cover the whole operator workflow. Both need `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` in the environment (`.env.local`, or inline).

### Register an account you own

This records an account — it never creates one. Creating social accounts is a
manual human step (hard rule 1) and must stay that way.

```bash
npm run add-account -- \
  --brand "Abaya Brand" \
  --platform youtube \
  --handle "@abayabrand" \
  --channel-id UCxxxxxxxxxxxxxxxxxxxxxx \
  --secret yt_token_abaya \
  --daily-limit 3
```

It checks the Vault secret exists and warns if it does not, rather than letting
a dangling pointer surface as a wasted publish attempt later. Re-running with
the same `--platform`/`--handle` updates that account instead of failing, so it
is safe for fixing a typo or pointing at a rotated secret.

### Upload and schedule content

```bash
npm run add-content -- \
  --file ./clip.mp4 \
  --brand "Abaya Brand" \
  --title "Three ways to style an abaya" \
  --source original_shot \
  --caption "Which one is your favourite?" \
  --hashtags Shorts,abaya,modestfashion \
  --at 2026-08-06T18:00:00Z \
  --stagger 30 \
  --approve
```

This uploads to Storage, creates the `content_items` row, and queues one
`post_targets` row per account — defaulting to every active account on the
brand, or use `--accounts "@one,@two"`.

- `--source` is mandatory and has no default. Hard rule 6 forbids reused
  third-party content, so provenance gets declared every time.
- `--approve` sets `is_approved`. Without it the scheduler refuses the post
  with "content not approved" — deliberate, so nothing publishes by accident.
- `--stagger <minutes>` spaces the same content across accounts.
- `--dry-run` prints the plan and writes nothing.

If any step after the upload fails, the uploaded object and the
`content_items` row are removed, so a failed run leaves nothing orphaned in
Storage.

Add `--help` to either script for the full option list.

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
4. ~~Instagram + Facebook~~
5. Pinterest, TikTok, X ← next
6. Metrics + sponsor reporting

## Connecting Instagram and Facebook

Accounts are created by hand, as always. Per brand:

1. **Instagram** — convert the account to **Business** or **Creator**. The API
   refuses to publish to personal accounts.
2. **Facebook Page** — create one and link the Instagram account to it.
   Publishing goes through the Page, not a personal profile.
3. **Meta app** — create one at [developers.facebook.com](https://developers.facebook.com),
   add the Instagram and Pages products, and grant your own accounts a role on
   it. Publishing to accounts you control works in Development mode; App Review
   is only needed to serve other people.
4. **Long-lived token** — exchange the short-lived token, then store it:

   ```sql
   select vault.create_secret('<token>', 'ig_token_main');
   ```

   ```sql
   update accounts
      set token_secret_name   = 'ig_token_main',
          external_account_id = '<instagram user id>'
    where platform = 'instagram' and handle = '@yourhandle';
   ```

`external_account_id` differs per platform: the **Instagram user id** (numeric,
not the @handle) for Instagram, the **Page id** for Facebook. Facebook also
needs a **Page** access token specifically — a user token authenticates but
cannot post as the Page.

### Two limits worth knowing

- **Instagram caps API publishing at 50 posts per rolling 24h** per account,
  independent of `accounts.daily_post_limit`.
- **Meta tokens do not refresh.** Google exchanges a refresh token for a fresh
  access token on every run; Meta's long-lived token is sent directly and
  eventually dies with no automatic recovery. When it does, the adapter reports
  error code 190 and names rotation as the fix.
