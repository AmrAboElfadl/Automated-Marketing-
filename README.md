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

Already applied to Supabase project `cqlspabncujagkdvzuyt`.
For a fresh project, run `supabase/migrations/001_initial_schema.sql` in the
Supabase SQL Editor.

### 2. Environment variables

| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API (keep secret) |
| `CRON_SECRET` | Generate: `openssl rand -hex 32` |

Add all three to Vercel → Settings → Environment Variables.

### 3. Deploy

Push to GitHub, import into Vercel. `vercel.json` registers the cron jobs
automatically.

**Note:** Vercel's Hobby plan runs cron only once per day. For the 15-minute
schedule you need Pro, or trigger `/api/cron/publish` externally (Supabase
`pg_cron` + `pg_net`, or cron-job.org) with the Bearer header.

### 4. Verify

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-app.vercel.app/api/cron/publish
```

Expected: `{"claimed":0,"message":"nothing due"}` — the pipeline works, the
queue is empty.

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
3. YouTube adapter ← next
4. Instagram + Facebook
5. Pinterest, TikTok, X
6. Metrics + sponsor reporting
