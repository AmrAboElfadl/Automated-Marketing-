import { NextResponse } from "next/server";
import { supabaseAdmin, type PostTarget } from "@/lib/supabase";
import { getAdapter } from "@/lib/adapters";

export const maxDuration = 60;     // seconds. Raise to 300 on Vercel Pro.
export const dynamic = "force-dynamic";

const BATCH_SIZE = 5;
const MAX_ATTEMPTS = 3;

export async function GET(req: Request) {
  // --- Auth: only Vercel Cron, or you holding the secret ---
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // --- Recover jobs orphaned by a timed-out previous run ---
  await supabaseAdmin.rpc("release_stale_locks", { stale_after: "15 minutes" });

  // --- Atomically claim due posts (FOR UPDATE SKIP LOCKED under the hood) ---
  const { data: claimed, error: claimErr } =
    await supabaseAdmin.rpc("claim_due_posts", { batch_size: BATCH_SIZE });

  if (claimErr) {
    console.error("claim failed:", claimErr);
    return NextResponse.json({ error: claimErr.message }, { status: 500 });
  }

  const targets = (claimed ?? []) as PostTarget[];
  if (targets.length === 0) {
    return NextResponse.json({ claimed: 0, message: "nothing due" });
  }

  const results: unknown[] = [];

  for (const target of targets) {
    try {
      const { data: content } = await supabaseAdmin
        .from("content_items")
        .select("title, storage_path, media_type, is_approved")
        .eq("id", target.content_item_id)
        .single();

      const { data: account } = await supabaseAdmin
        .from("accounts")
        .select("platform, handle, external_account_id, token_secret_name, status")
        .eq("id", target.account_id)
        .single();

      if (!content) throw new Error("content_item not found");
      if (!account) throw new Error("account not found");
      if (!content.is_approved) throw new Error("content not approved");
      if (account.status !== "active") throw new Error(`account status: ${account.status}`);

      // Signed URL so the platform API can pull the media directly
      const { data: signed, error: signErr } = await supabaseAdmin
        .storage.from("content-media")
        .createSignedUrl(content.storage_path, 3600);

      if (signErr || !signed) throw new Error(`sign url failed: ${signErr?.message}`);

      const adapter = getAdapter(account.platform);
      const result = await adapter.publish({
        title: content.title,
        caption: target.caption ?? "",
        hashtags: target.hashtags ?? [],
        mediaUrl: signed.signedUrl,
        mediaType: content.media_type,
        externalAccountId: account.external_account_id,
        tokenSecretName: account.token_secret_name,
      });

      await supabaseAdmin.from("post_targets").update({
        status: "published",
        external_post_id: result.externalPostId,
        published_at: result.publishedAt,
        locked_at: null,
        error_message: null,
      }).eq("id", target.id);

      results.push({ id: target.id, ok: true, externalPostId: result.externalPostId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const exhausted = target.attempts >= MAX_ATTEMPTS;

      await supabaseAdmin.from("post_targets").update({
        status: exhausted ? "failed" : "queued",
        locked_at: null,
        error_message: msg,
      }).eq("id", target.id);

      console.error(`publish failed for ${target.id}:`, msg);
      results.push({ id: target.id, ok: false, error: msg, willRetry: !exhausted });
    }
  }

  return NextResponse.json({ claimed: targets.length, results });
}
