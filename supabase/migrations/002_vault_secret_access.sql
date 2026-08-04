-- ============================================================
-- Vault secret access
-- Target: Supabase (Postgres 15+)
-- Run in: Supabase Dashboard > SQL Editor
-- ============================================================
--
-- Hard rule: OAuth tokens are never stored in table columns.
-- `accounts.token_secret_name` is a pointer to a secret in Supabase Vault.
--
-- PostgREST does not expose the `vault` schema, so the scheduler cannot read
-- `vault.decrypted_secrets` directly. This SECURITY DEFINER function is the
-- only bridge, and only `service_role` may call it.
-- ============================================================

create or replace function public.read_secret(secret_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  found_secret text;
begin
  select ds.decrypted_secret
    into found_secret
  from vault.decrypted_secrets ds
  where ds.name = secret_name
  limit 1;

  return found_secret;   -- null when the secret does not exist
end;
$$;

comment on function public.read_secret(text) is
  'Reads one Supabase Vault secret by name. service_role only — this is the '
  'scheduler''s path to per-account OAuth refresh tokens.';

-- Lock it down: anon/authenticated must never reach this.
revoke all on function public.read_secret(text) from public;
revoke all on function public.read_secret(text) from anon;
revoke all on function public.read_secret(text) from authenticated;
grant execute on function public.read_secret(text) to service_role;


-- ============================================================
-- Storing a token (run by a human, once per account)
-- ============================================================
--
-- 1. Complete Google's OAuth consent flow manually and copy the refresh token.
-- 2. Put it in Vault and point the account row at it:
--
--    select vault.create_secret(
--      'PASTE_REFRESH_TOKEN_HERE',
--      'yt_token_mainchannel',
--      'YouTube refresh token for @mainchannel'
--    );
--
--    update accounts
--       set token_secret_name = 'yt_token_mainchannel'
--     where platform = 'youtube' and handle = '@mainchannel';
--
-- 3. To rotate later, update the secret in place (the pointer does not change):
--
--    select vault.update_secret(
--      (select id from vault.secrets where name = 'yt_token_mainchannel'),
--      'PASTE_NEW_REFRESH_TOKEN_HERE'
--    );
--
-- Never paste a real token into this file or any other tracked file.
