import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getAdapter } from "@/lib/adapters";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Collects performance data for published posts.
 * This is what you show sponsors — do not skip it.
 * Runs every 6 hours for posts published in the last 30 days.
 */
export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();

  const { data: posts, error } = await supabaseAdmin
    .from("post_targets")
    .select("id, external_post_id, account_id, accounts(platform, token_secret_name)")
    .eq("status", "published")
    .gte("published_at", cutoff)
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let captured = 0;

  for (const post of posts ?? []) {
    try {
      const account = Array.isArray(post.accounts) ? post.accounts[0] : post.accounts;
      if (!account || !post.external_post_id) continue;

      const adapter = getAdapter(account.platform);
      if (!adapter.fetchMetrics) continue;   // adapter not implemented yet

      const m = await adapter.fetchMetrics(post.external_post_id, account.token_secret_name);

      await supabaseAdmin.from("post_metrics").insert({
        post_target_id: post.id,
        views: m.views,
        likes: m.likes,
        comments: m.comments,
        shares: m.shares,
        saves: m.saves,
        watch_time_secs: m.watchTimeSecs,
        follower_count: m.followerCount,
        raw: m.raw,
      });
      captured++;
    } catch (err) {
      console.error("metrics failed:", err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json({ checked: posts?.length ?? 0, captured });
}
