-- ============================================================
-- Social Auto-Publisher — Initial Schema
-- Target: Supabase (Postgres 15+)
-- Run in: Supabase Dashboard > SQL Editor
-- ============================================================

-- ---------- ENUMS ----------

create type platform_type as enum (
  'youtube', 'instagram', 'facebook', 'tiktok', 'pinterest', 'x'
);

create type account_status as enum (
  'active', 'token_expired', 'suspended', 'disabled'
);

create type media_type as enum (
  'video', 'image', 'carousel'
);

create type content_source as enum (
  'ai_generated', 'original_shot', 'licensed_stock'
);

create type post_status as enum (
  'draft', 'queued', 'processing', 'published', 'failed', 'cancelled'
);


-- ---------- BRANDS ----------
-- One row per channel identity. Lets you run the abaya brand and
-- faceless channels from the same engine without mixing them up.

create table brands (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  niche         text,
  default_lang  text not null default 'en',   -- 'en' | 'ar'
  cta_url       text,                          -- where traffic funnels to
  contact_email text,                          -- put this in every bio: sponsors DM here
  created_at    timestamptz not null default now()
);


-- ---------- ACCOUNTS ----------
-- One row per social account you own.
-- NOTE: OAuth tokens are NEVER stored here in plaintext.
-- token_secret_name points to a secret in Supabase Vault.

create table accounts (
  id                  uuid primary key default gen_random_uuid(),
  brand_id            uuid not null references brands(id) on delete cascade,
  platform            platform_type not null,
  handle              text not null,
  external_account_id text,          -- channel ID / IG user ID / page ID
  token_secret_name   text,          -- Vault key, e.g. 'yt_token_mainchannel'
  token_expires_at    timestamptz,
  status              account_status not null default 'active',
  daily_post_limit    int not null default 3,
  created_at          timestamptz not null default now(),
  unique (platform, handle)
);


-- ---------- CONTENT ITEMS ----------
-- The master asset. One video/image, reused across many platforms.

create table content_items (
  id             uuid primary key default gen_random_uuid(),
  brand_id       uuid not null references brands(id) on delete cascade,
  title          text not null,
  script         text,
  storage_path   text not null,        -- path in Supabase Storage bucket
  media_type     media_type not null default 'video',
  source         content_source not null,
  duration_secs  int,
  aspect_ratio   text,                 -- '9:16', '1:1', '16:9'
  is_approved    boolean not null default false,
  created_at     timestamptz not null default now()
);


-- ---------- POST TARGETS ----------
-- The scheduling queue. One row = one piece of content going to
-- one account at one time, with its own caption.

create table post_targets (
  id               uuid primary key default gen_random_uuid(),
  content_item_id  uuid not null references content_items(id) on delete cascade,
  account_id       uuid not null references accounts(id) on delete cascade,
  caption          text,
  hashtags         text[] default '{}',
  scheduled_at     timestamptz not null,
  status           post_status not null default 'queued',
  attempts         int not null default 0,
  max_attempts     int not null default 3,
  locked_at        timestamptz,          -- concurrency guard
  external_post_id text,                 -- platform's ID once published
  published_at     timestamptz,
  error_message    text,
  created_at       timestamptz not null default now()
);

-- The index that makes the scheduler fast
create index idx_post_targets_due
  on post_targets (scheduled_at)
  where status = 'queued';

create index idx_post_targets_account on post_targets (account_id);

-- Never schedule the same content twice to the same account
create unique index idx_no_duplicate_posts
  on post_targets (content_item_id, account_id)
  where status <> 'cancelled';


-- ---------- POST METRICS ----------
-- Time-series performance. This is what you show sponsors.

create table post_metrics (
  id                uuid primary key default gen_random_uuid(),
  post_target_id    uuid not null references post_targets(id) on delete cascade,
  captured_at       timestamptz not null default now(),
  views             bigint default 0,
  likes             bigint default 0,
  comments          bigint default 0,
  shares            bigint default 0,
  saves             bigint default 0,
  watch_time_secs   bigint default 0,
  follower_count    bigint,               -- account size at capture time
  raw               jsonb                 -- full API response, for later analysis
);

create index idx_metrics_post on post_metrics (post_target_id, captured_at desc);


-- ============================================================
-- ATOMIC JOB CLAIMING
-- Prevents the same post being published twice if two cron runs
-- overlap. FOR UPDATE SKIP LOCKED is the critical piece.
-- ============================================================

create or replace function claim_due_posts(batch_size int default 10)
returns setof post_targets
language plpgsql
as $$
begin
  return query
  update post_targets pt
  set status    = 'processing',
      locked_at = now(),
      attempts  = pt.attempts + 1
  where pt.id in (
    select id from post_targets
    where status = 'queued'
      and scheduled_at <= now()
      and attempts < max_attempts
    order by scheduled_at
    limit batch_size
    for update skip locked
  )
  returning pt.*;
end;
$$;


-- Recover jobs stuck in 'processing' (e.g. a cron run timed out)
create or replace function release_stale_locks(stale_after interval default '15 minutes')
returns int
language plpgsql
as $$
declare released int;
begin
  update post_targets
  set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
      locked_at = null
  where status = 'processing'
    and locked_at < now() - stale_after;
  get diagnostics released = row_count;
  return released;
end;
$$;


-- ============================================================
-- ROW LEVEL SECURITY
-- Locked down by default. The scheduler uses the service_role key,
-- which bypasses RLS. Nothing else can read this data.
-- ============================================================

alter table brands        enable row level security;
alter table accounts      enable row level security;
alter table content_items enable row level security;
alter table post_targets  enable row level security;
alter table post_metrics  enable row level security;


-- ============================================================
-- STORAGE BUCKET (create via Dashboard > Storage, or run this)
-- ============================================================

insert into storage.buckets (id, name, public)
values ('content-media', 'content-media', false)
on conflict (id) do nothing;
