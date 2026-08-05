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

export interface QueueSnapshot {
  counts: ReadonlyArray<readonly [string, number]>;
  /** Null when the read succeeded. */
  error: string | null;
  /** Required variables that are unset on this deployment. */
  missingEnv: readonly string[];
}

/**
 * Never throws. A misconfigured deployment used to take the whole page down
 * with an opaque "Application error … Digest: …", hiding the one thing the
 * operator needed to read. A dashboard that cannot reach the database should
 * say so on the page instead.
 */
export async function loadQueueSnapshot(): Promise<QueueSnapshot> {
  const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);

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

    return { counts, error: null, missingEnv };
  } catch (err) {
    return {
      counts: [],
      error: err instanceof Error ? err.message : String(err),
      missingEnv,
    };
  }
}
