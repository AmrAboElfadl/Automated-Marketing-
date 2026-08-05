import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client. Bypasses Row Level Security.
 * NEVER import this into anything that runs in the browser.
 *
 * Built lazily on first use rather than at module load. `next build` imports
 * every route to collect page config, so constructing the client at import
 * time made the build itself depend on runtime secrets — a deploy with no
 * environment variables died with "supabaseUrl is required" pointing at a
 * minified chunk, which says nothing about the actual problem.
 *
 * Now the build succeeds, and a genuinely missing variable surfaces at
 * request time with a message that names what to set and where.
 */

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const missing = [
    !url && "SUPABASE_URL",
    !serviceRoleKey && "SUPABASE_SERVICE_ROLE_KEY",
  ].filter((name): name is string => typeof name === "string");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment ${missing.length > 1 ? "variables" : "variable"}: ` +
        `${missing.join(", ")}. Set them in Vercel > Settings > Environment ` +
        `Variables (all environments), then redeploy.`
    );
  }

  client = createClient(url!, serviceRoleKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/**
 * Proxy so every existing `supabaseAdmin.from(...)` call site keeps working
 * unchanged — the real client is created on first property access. Methods are
 * bound to the client so `this` survives the indirection.
 */
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, property) {
    const target = getClient();
    const value = Reflect.get(target, property) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export type Platform =
  | "youtube" | "instagram" | "facebook"
  | "tiktok" | "pinterest" | "x";

export type MediaType = "video" | "image" | "carousel";

export interface PostTarget {
  id: string;
  content_item_id: string;
  account_id: string;
  caption: string | null;
  hashtags: string[];
  scheduled_at: string;
  attempts: number;
}
