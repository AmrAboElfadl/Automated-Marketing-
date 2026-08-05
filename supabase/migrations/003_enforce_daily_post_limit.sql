-- ============================================================
-- Enforce accounts.daily_post_limit in the atomic claim
-- Target: Supabase (Postgres 15+)
-- STATUS: already applied to project cqlspabncujagkdvzuyt.
-- ============================================================
--
-- Until now `daily_post_limit` was a column nobody read: claim_due_posts()
-- took every due post regardless of how many that account had already sent
-- today. Exceeding a platform's tolerated posting rate is how owned accounts
-- get suspended, so this is a correctness fix, not a tuning knob.
--
-- WHAT COUNTS AS A SPENT SLOT
--   published  today  — the post went out
--   processing today  — a run has it in flight and will most likely publish it
-- Counting `processing` is what stops two overlapping cron runs from each
-- claiming a full allowance. If an in-flight post fails it returns to
-- 'queued', stops being counted, and the slot frees up.
--
-- "Today" is date_trunc('day', now()) in the database timezone (UTC on
-- Supabase), so the allowance resets at 00:00 UTC.
--
-- CONCURRENCY
-- FOR UPDATE SKIP LOCKED is preserved and stays load-bearing. It sits inside
-- the LATERAL subquery because a locking clause cannot coexist with the
-- window function that a per-account row_number() would otherwise require.
--
-- NOTE ON ORDERING
-- 002_harden_function_search_path.sql also redefines claim_due_posts, to pin
-- `search_path` against object-shadowing. This migration must run *after*
-- that one, and carries the same `security invoker` + pinned search_path
-- forward. Any future redefinition of this function must keep both.
--
-- BEHAVIOUR CHANGE
-- Posts belonging to an account whose status is not 'active' are no longer
-- claimed at all, so they wait in 'queued' instead of burning retries and
-- being marked 'failed'.
-- ============================================================

create or replace function claim_due_posts(batch_size int default 10)
returns setof post_targets
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  return query
  update post_targets pt
  set status    = 'processing',
      locked_at = now(),
      attempts  = pt.attempts + 1
  where pt.id in (
    select picked.id
    from (
      select claimed.id, claimed.scheduled_at
      from (
        -- Active accounts with at least one slot left in today's allowance.
        select a.id as account_id,
               a.daily_post_limit - coalesce(used.spent, 0) as slots
        from accounts a
        left join (
          select account_id, count(*) as spent
          from post_targets
          where (status = 'published'
                 and published_at >= date_trunc('day', now()))
             or (status = 'processing'
                 and locked_at >= date_trunc('day', now()))
          group by account_id
        ) used on used.account_id = a.id
        where a.status = 'active'
          and a.daily_post_limit - coalesce(used.spent, 0) > 0
      ) elig
      -- Per account, take no more rows than it has slots remaining.
      cross join lateral (
        select due.id, due.scheduled_at
        from post_targets due
        where due.account_id = elig.account_id
          and due.status = 'queued'
          and due.scheduled_at <= now()
          and due.attempts < due.max_attempts
        order by due.scheduled_at
        limit elig.slots
        for update skip locked
      ) claimed
      -- Most overdue posts win when the batch is contested.
      order by claimed.scheduled_at
      limit batch_size
    ) picked
  )
  returning pt.*;
end;
$$;

comment on function claim_due_posts(int) is
  'Atomically claims due posts, never exceeding accounts.daily_post_limit '
  'for the current UTC day. Skips accounts that are not active.';

-- Supports the per-account "spent today" count as post_targets grows.
create index if not exists idx_post_targets_daily_spend
  on post_targets (account_id, published_at)
  where status = 'published';
