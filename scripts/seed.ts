/**
 * Seeds one brand, one account, one content item and one post target
 * scheduled for right now — so the mock adapter fires on the next cron run.
 *
 * Run: npx tsx scripts/seed.ts
 */
import { createClient } from "@supabase/supabase-js";

const db = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function main() {
  const { data: brand, error: be } = await db
    .from("brands")
    .insert({
      name: "Test Brand",
      niche: "test",
      default_lang: "en",
      contact_email: "business@example.com",
    })
    .select()
    .single();
  if (be) throw be;

  const { data: account, error: ae } = await db
    .from("accounts")
    .insert({
      brand_id: brand.id,
      platform: "youtube",
      handle: "@testchannel",
      status: "active",
    })
    .select()
    .single();
  if (ae) throw ae;

  const { data: content, error: ce } = await db
    .from("content_items")
    .insert({
      brand_id: brand.id,
      title: "Seed test video",
      storage_path: "test/placeholder.mp4",
      media_type: "video",
      source: "original_shot",
      is_approved: true,
    })
    .select()
    .single();
  if (ce) throw ce;

  const { error: pe } = await db.from("post_targets").insert({
    content_item_id: content.id,
    account_id: account.id,
    caption: "Seed test caption",
    hashtags: ["test"],
    scheduled_at: new Date().toISOString(),
    status: "queued",
  });
  if (pe) throw pe;

  console.log("Seeded. Now hit /api/cron/publish with your CRON_SECRET.");
  console.log("NOTE: it will fail on the signed-URL step until you upload");
  console.log("a real file to the content-media bucket at test/placeholder.mp4.");
}

main().catch((e) => { console.error(e); process.exit(1); });
