import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client. Bypasses Row Level Security.
 * NEVER import this into anything that runs in the browser.
 */
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

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
