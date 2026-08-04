import { supabaseAdmin } from "./supabase";

/**
 * Reads OAuth tokens out of Supabase Vault.
 *
 * Tokens are never stored in table columns — `accounts.token_secret_name` is
 * only a pointer. The `read_secret` RPC (migration 002) is the sole bridge to
 * the vault schema and is executable by service_role alone.
 *
 * Nothing here ever logs a secret value.
 */

const CACHE_TTL_MS = 60_000;

const cache = new Map<string, { value: string; expiresAt: number }>();

export async function readSecret(name: string): Promise<string> {
  const hit = cache.get(name);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const { data, error } = await supabaseAdmin.rpc("read_secret", {
    secret_name: name,
  });

  if (error) {
    throw new Error(
      `vault read failed for "${name}": ${error.message} — has migration 002 been applied?`
    );
  }

  if (typeof data !== "string" || data.length === 0) {
    throw new Error(
      `vault secret "${name}" is missing or empty — create it with ` +
        `select vault.create_secret('<token>', '${name}');`
    );
  }

  cache.set(name, { value: data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

/** Drops a cached secret so the next read hits Vault. Call after a rotation. */
export function invalidateSecret(name: string): void {
  cache.delete(name);
}
