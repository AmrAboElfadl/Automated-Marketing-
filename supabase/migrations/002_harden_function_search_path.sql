-- ============================================================
-- 002 — Harden function search_path
--
-- Fixes two WARN-level findings from the Supabase security advisor:
--   function_search_path_mutable on claim_due_posts
--   function_search_path_mutable on release_stale_locks
--
-- Without a pinned search_path, a role with a modified search_path
-- could shadow the objects these functions reference and change what
-- they actually execute. These functions decide what gets published
-- to live social accounts, so that matters.
--
-- STATUS: already applied to project cqlspabncujagkdvzuyt.
-- This file exists so the repo matches the live database.
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


create or replace function release_stale_locks(stale_after interval default '15 minutes')
returns int
language plpgsql
security invoker
set search_path = public, pg_temp
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
