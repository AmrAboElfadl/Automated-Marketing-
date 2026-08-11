import { supabaseAdmin } from "./supabase";

/**
 * Backs the queue dashboard.
 *
 * Kept out of the page component so it can be tested without a JSX transform,
 * and so the never-throws guarantee lives somewhere explicit.
 */

export const QUEUE_STATUSES = ["queued", "processing", "published", "failed"] as const;

/**
 * Variables the dashboard needs. Only presence is ever reported — never a
 * value, since one of these is the service-role key.
 */
export const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
] as const;

/** How many recent failures to surface. Enough to spot a pattern. */
const FAILURE_LIMIT = 5;

export interface FailedPost {
  title: string;
  handle: string;
  attempts: number;
  error: string;
}

export interface AccountRow {
  handle: string;
  platform: string;
  status: string;
  hasToken: boolean;
}

export interface QueueSnapshot {
  counts: ReadonlyArray<readonly [string, number]>;
  /** Most recent failures, with the reason. Empty when nothing has failed. */
  failures: readonly FailedPost[];
  /** Accounts and whether each is publishable. */
  accounts: readonly AccountRow[];
  /** Null when the read succeeded. */
  error: string | null;
  /** Required variables that are unset on this deployment. */
  missingEnv: readonly string[];
}

function firstOf<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Never throws. A misconfigured deployment used to take the whole page down
 * with an opaque "Application error … Digest: …", hiding the one thing the
 * operator needed to read. A dashboard that cannot reach the database should
 * say so on the page instead.
 */
export async function loadQueueSnapshot(): Promise<QueueSnapshot> {
  const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
  const empty = { counts: [], failures: [], accounts: [], missingEnv };

  try {
    const counts = await Promise.all(
      QUEUE_STATUSES.map(async (status) => {
        const { count, error } = await supabaseAdmin
          .from("post_targets")
          .select("*", { count: "exact", head: true })
          .eq("status", status);

        if (error) throw new Error(error.message);
        return [status, count ?? 0] as const;
      })
    );

    // Why a post failed matters more than how many did. Without this the
    // operator sees "failed: 3" and has to go to SQL to learn anything.
    const { data: failedRows, error: failedError } = await supabaseAdmin
      .from("post_targets")
      .select("attempts, error_message, content_items(title), accounts(handle)")
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(FAILURE_LIMIT);

    if (failedError) throw new Error(failedError.message);

    const failures: FailedPost[] = (failedRows ?? []).map((row) => {
      const content = firstOf(row.content_items as { title?: string } | null);
      const account = firstOf(row.accounts as { handle?: string } | null);
      return {
        title: content?.title ?? "(unknown content)",
        handle: account?.handle ?? "(unknown account)",
        attempts: row.attempts ?? 0,
        error: row.error_message ?? "(no reason recorded)",
      };
    });

    // An account that is not active, or has no Vault pointer, silently stops
    // publishing — the claim skips it and nothing appears in the failed count.
    const { data: accountRows, error: accountsError } = await supabaseAdmin
      .from("accounts")
      .select("handle, platform, status, token_secret_name")
      .order("handle");

    if (accountsError) throw new Error(accountsError.message);

    const accounts: AccountRow[] = (accountRows ?? []).map((row) => ({
      handle: row.handle,
      platform: row.platform,
      status: row.status,
      hasToken: Boolean(row.token_secret_name),
    }));

    return { counts, failures, accounts, error: null, missingEnv };
  } catch (err) {
    return {
      ...empty,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
