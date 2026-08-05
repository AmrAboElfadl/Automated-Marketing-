/**
 * Uploads one media file and schedules it to one or more accounts.
 *
 * This is the day-to-day entry point: it does the Storage upload, creates the
 * content_items row, and queues a post_target per account — the three steps
 * that otherwise mean hand-written SQL.
 *
 * Usage:
 *   npx tsx scripts/add-content.ts \
 *     --file ./clip.mp4 \
 *     --brand "Abaya Brand" \
 *     --title "Three ways to style an abaya" \
 *     --source original_shot \
 *     --caption "Which one is your favourite?" \
 *     --hashtags Shorts,abaya,modestfashion \
 *     --at 2026-08-06T18:00:00Z \
 *     --stagger 30 \
 *     --approve
 *
 * Defaults to every active account on the brand. Restrict with
 * --accounts "@one,@two".
 *
 * --source is mandatory and unguessable on purpose: hard rule 6 forbids reused
 * third-party content, so provenance is declared every time.
 */
import { basename, extname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { supabaseAdmin } from "../lib/supabase";
import {
  commaList,
  fail,
  flag,
  integer,
  oneOf,
  optional,
  parseArgs,
  required,
  timestamp,
  usage,
} from "./_cli";

const SOURCES = ["ai_generated", "original_shot", "licensed_stock"] as const;
const MEDIA_TYPES = ["video", "image", "carousel"] as const;

const BUCKET = "content-media";

/** Extension → MIME. Supabase Storage stores whatever we declare here. */
const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "brand"
  );
}

interface AccountRow {
  id: string;
  handle: string;
  platform: string;
  status: string;
  daily_post_limit: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (flag(args, "help") || process.argv.length <= 2) {
    usage([
      "",
      "  Upload a media file and queue it to a brand's accounts.",
      "",
      "  Required:",
      "    --file    <path>    local media file",
      "    --brand   <name>    brand that owns the content and accounts",
      "    --title   <text>    used as the YouTube video title (max 100 chars)",
      "    --source  <src>     one of: " + SOURCES.join(", "),
      "",
      "  Optional:",
      "    --caption   <text>      becomes the description body",
      "    --hashtags  a,b,c       no # needed",
      "    --accounts  @a,@b       default: every active account on the brand",
      "    --at        <iso>       first scheduled time (default: now)",
      "    --stagger   <minutes>   gap between accounts (default 0)",
      "    --approve               set is_approved; without it nothing publishes",
      "    --media-type <t>        one of: " + MEDIA_TYPES.join(", "),
      "    --aspect    9:16        --duration <secs>",
      "    --dry-run               print the plan, write nothing",
      "",
    ]);
    return;
  }

  const filePath = required(args, "file");
  const brandName = required(args, "brand");
  const title = required(args, "title");
  const source = oneOf(args, "source", SOURCES);
  const caption = optional(args, "caption") ?? "";
  const hashtags = commaList(args, "hashtags").map((tag) => tag.replace(/^#+/, ""));
  const startAt = timestamp(args, "at");
  const staggerMins = integer(args, "stagger", 0);
  const approve = flag(args, "approve");
  const dryRun = flag(args, "dry-run");
  const requestedHandles = commaList(args, "accounts");

  // ---- validate the file before touching the database ----
  const info = await stat(filePath).catch(() => null);
  if (!info || !info.isFile()) fail(`--file "${filePath}" is not a readable file`);
  if (info.size === 0) fail(`--file "${filePath}" is empty`);

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_BY_EXT[ext];
  if (!contentType) {
    fail(
      `unsupported file extension "${ext}". Supported: ${Object.keys(MIME_BY_EXT).join(", ")}`
    );
  }

  const mediaType = oneOf(
    args,
    "media-type",
    MEDIA_TYPES,
    contentType.startsWith("video/") ? "video" : "image"
  );

  if (title.length > 100) {
    console.warn(
      `  ! --title is ${title.length} chars; YouTube caps titles at 100 and the` +
        ` adapter will truncate it.`
    );
  }

  // ---- resolve brand and accounts ----
  const { data: brand, error: brandError } = await supabaseAdmin
    .from("brands")
    .select("id, name")
    .eq("name", brandName)
    .maybeSingle();

  if (brandError) fail(`brand lookup failed: ${brandError.message}`);
  if (!brand) {
    fail(`no brand named "${brandName}". Create it with scripts/add-account.ts first.`);
  }

  const { data: allAccounts, error: accountsError } = await supabaseAdmin
    .from("accounts")
    .select("id, handle, platform, status, daily_post_limit")
    .eq("brand_id", brand.id);

  if (accountsError) fail(`account lookup failed: ${accountsError.message}`);

  const accounts = (allAccounts ?? []) as AccountRow[];
  if (accounts.length === 0) {
    fail(`brand "${brandName}" has no accounts. Add one with scripts/add-account.ts.`);
  }

  let targets: AccountRow[];

  if (requestedHandles.length > 0) {
    targets = requestedHandles.map((handle) => {
      const match = accounts.find((a) => a.handle === handle);
      if (!match) {
        fail(
          `"${handle}" is not an account on brand "${brandName}". Known: ` +
            accounts.map((a) => a.handle).join(", ")
        );
      }
      return match;
    });
  } else {
    targets = accounts.filter((a) => a.status === "active");
    if (targets.length === 0) {
      fail(
        `brand "${brandName}" has no *active* accounts ` +
          `(${accounts.map((a) => `${a.handle}=${a.status}`).join(", ")})`
      );
    }
  }

  const inactive = targets.filter((a) => a.status !== "active");
  if (inactive.length > 0) {
    console.warn(
      `  ! ${inactive.map((a) => a.handle).join(", ")} not active — the claim skips` +
        ` non-active accounts, so those posts will wait in 'queued'.`
    );
  }

  // ---- plan ----
  const storagePath = `${slugify(brand.name)}/${Date.now()}-${basename(filePath)}`;
  const schedule = targets.map((account, index) => ({
    account,
    at: new Date(startAt.getTime() + index * staggerMins * 60_000),
  }));

  console.log("");
  console.log(`  file      ${filePath} (${(info.size / 1024 / 1024).toFixed(1)} MiB, ${contentType})`);
  console.log(`  storage   ${BUCKET}/${storagePath}`);
  console.log(`  brand     ${brand.name}`);
  console.log(`  title     ${title}`);
  console.log(`  source    ${source}   media_type ${mediaType}   approved ${approve}`);
  if (hashtags.length > 0) console.log(`  hashtags  ${hashtags.join(", ")}`);
  console.log("  schedule");
  for (const row of schedule) {
    console.log(`    ${row.at.toISOString()}  ${row.account.platform} ${row.account.handle}`);
  }
  console.log("");

  if (dryRun) {
    console.log("  [dry run] nothing written\n");
    return;
  }

  // ---- upload ----
  const bytes = await readFile(filePath);
  const { error: uploadError } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(storagePath, bytes, { contentType, upsert: false });

  if (uploadError) fail(`storage upload failed: ${uploadError.message}`);
  console.log(`  ✓ uploaded`);

  // From here on, any failure must not leave an orphaned object behind.
  const cleanupStorage = async (): Promise<void> => {
    const { error } = await supabaseAdmin.storage.from(BUCKET).remove([storagePath]);
    if (error) {
      console.error(
        `  ! could not remove orphaned upload ${storagePath}: ${error.message}`
      );
    } else {
      console.error(`  · removed orphaned upload ${storagePath}`);
    }
  };

  const { data: content, error: contentError } = await supabaseAdmin
    .from("content_items")
    .insert({
      brand_id: brand.id,
      title,
      storage_path: storagePath,
      media_type: mediaType,
      source,
      is_approved: approve,
      aspect_ratio: optional(args, "aspect") ?? null,
      duration_secs: optional(args, "duration")
        ? integer(args, "duration", 0)
        : null,
    })
    .select("id")
    .single();

  if (contentError || !content) {
    await cleanupStorage();
    fail(`content_items insert failed: ${contentError?.message}`);
  }
  console.log(`  ✓ content_item ${content.id}`);

  // ---- queue one post per account ----
  const { data: queued, error: queueError } = await supabaseAdmin
    .from("post_targets")
    .insert(
      schedule.map((row) => ({
        content_item_id: content.id,
        account_id: row.account.id,
        caption,
        hashtags,
        scheduled_at: row.at.toISOString(),
        status: "queued" as const,
      }))
    )
    .select("id, account_id, scheduled_at");

  if (queueError) {
    // Unique index idx_no_duplicate_posts: same content to same account twice.
    const duplicate = queueError.code === "23505";
    await supabaseAdmin.from("content_items").delete().eq("id", content.id);
    await cleanupStorage();
    fail(
      duplicate
        ? `this content is already queued to one of those accounts — nothing was written`
        : `post_targets insert failed: ${queueError.message}`
    );
  }

  console.log(`  ✓ queued ${queued?.length ?? 0} post(s)\n`);

  if (!approve) {
    console.log(
      `  ! is_approved is false, so the scheduler will fail these with "content not\n` +
        `    approved". Re-run with --approve, or:\n` +
        `      update content_items set is_approved = true where id = '${content.id}';\n`
    );
  }

  const perDay = targets.map((a) => `${a.handle} ${a.daily_post_limit}/day`).join(", ");
  console.log(`  Caps in effect: ${perDay}`);
  console.log(
    `  YouTube quota is usually the tighter limit: ~6 uploads/day per Cloud project.\n`
  );
}

main().catch((err: unknown) => {
  console.error("\n  ✗", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
