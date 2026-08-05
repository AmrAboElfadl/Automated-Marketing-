/**
 * Registers a brand and one social account in the database.
 *
 * IMPORTANT — this does not create a social account anywhere. Hard rule 1: the
 * account is created by a human, once, by hand. This script only records an
 * account you already own, and stores the *name* of the Vault secret holding
 * its OAuth refresh token. The token itself never passes through here.
 *
 * Usage:
 *   npx tsx scripts/add-account.ts \
 *     --brand "Abaya Brand" \
 *     --platform youtube \
 *     --handle "@abayabrand" \
 *     --channel-id UCxxxxxxxxxxxxxxxxxxxxxx \
 *     --secret yt_token_abaya \
 *     [--daily-limit 3] [--niche "modest fashion"] \
 *     [--cta-url https://…] [--contact-email business@…] [--lang en] \
 *     [--status active] [--dry-run]
 *
 * Re-running with the same --platform/--handle updates that account's pointers
 * rather than failing, so it is safe to use to fix a typo or rotate a secret
 * name.
 */
import { supabaseAdmin } from "../lib/supabase";
import {
  fail,
  flag,
  integer,
  oneOf,
  optional,
  parseArgs,
  required,
  usage,
} from "./_cli";

const PLATFORMS = ["youtube", "instagram", "facebook", "tiktok", "pinterest", "x"] as const;
const STATUSES = ["active", "token_expired", "suspended", "disabled"] as const;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (flag(args, "help") || process.argv.length <= 2) {
    usage([
      "",
      "  Register a brand and an account you already own.",
      "",
      "  Required:",
      "    --brand      <name>     brand identity this account belongs to",
      "    --platform   <platform> one of: " + PLATFORMS.join(", "),
      "    --handle     <@handle>  the account's handle",
      "",
      "  Recommended:",
      "    --channel-id <id>       platform account id (YouTube: UC…). The adapter",
      "                            refuses to publish if the token does not own it.",
      "    --secret     <name>     Vault secret name holding the refresh token",
      "",
      "  Optional:",
      "    --daily-limit <n>       posts per UTC day (default 3)",
      "    --niche, --cta-url, --contact-email, --lang, --status",
      "    --dry-run               print what would happen, write nothing",
      "",
    ]);
    return;
  }

  const brandName = required(args, "brand");
  const platform = oneOf(args, "platform", PLATFORMS);
  const handle = required(args, "handle");
  const channelId = optional(args, "channel-id");
  const secretName = optional(args, "secret");
  const status = oneOf(args, "status", STATUSES, "active");
  const dailyLimit = integer(args, "daily-limit", 3);
  const dryRun = flag(args, "dry-run");

  if (dailyLimit === 0) {
    fail("--daily-limit 0 would block every post for this account");
  }

  // Verify the Vault secret before wiring the account to it. A dangling
  // pointer only surfaces at publish time otherwise, one wasted attempt later.
  if (secretName) {
    const { data, error } = await supabaseAdmin.rpc("read_secret", {
      secret_name: secretName,
    });

    if (error) {
      fail(
        `could not check Vault secret "${secretName}": ${error.message}\n` +
          `    Has migration 002_vault_secret_access.sql been applied?`
      );
    }
    if (typeof data !== "string" || data.length === 0) {
      console.warn(
        `\n  ! Vault secret "${secretName}" does not exist yet.\n` +
          `    Recording the pointer anyway. Create it before publishing:\n` +
          `      select vault.create_secret('<refresh-token>', '${secretName}');\n`
      );
    } else {
      console.log(`  ✓ Vault secret "${secretName}" exists`);
    }
  }

  if (dryRun) {
    console.log("\n  [dry run] would ensure:");
    console.log(`    brand   ${brandName}`);
    console.log(`    account ${platform} ${handle}`);
    console.log(`            external_account_id = ${channelId ?? "(none)"}`);
    console.log(`            token_secret_name   = ${secretName ?? "(none)"}`);
    console.log(`            status = ${status}, daily_post_limit = ${dailyLimit}\n`);
    return;
  }

  // ---- brand: reuse by name so repeated runs don't fork duplicates ----
  const { data: existingBrand, error: brandLookupError } = await supabaseAdmin
    .from("brands")
    .select("id")
    .eq("name", brandName)
    .maybeSingle();

  if (brandLookupError) fail(`brand lookup failed: ${brandLookupError.message}`);

  let brandId: string;

  if (existingBrand) {
    brandId = existingBrand.id;
    console.log(`  · reusing brand "${brandName}"`);
  } else {
    const { data: created, error } = await supabaseAdmin
      .from("brands")
      .insert({
        name: brandName,
        niche: optional(args, "niche") ?? null,
        default_lang: optional(args, "lang") ?? "en",
        cta_url: optional(args, "cta-url") ?? null,
        contact_email: optional(args, "contact-email") ?? null,
      })
      .select("id")
      .single();

    if (error || !created) fail(`brand insert failed: ${error?.message}`);
    brandId = created.id;
    console.log(`  ✓ created brand "${brandName}"`);
  }

  // ---- account: unique on (platform, handle), so upsert on that pair ----
  const { data: account, error: accountError } = await supabaseAdmin
    .from("accounts")
    .upsert(
      {
        brand_id: brandId,
        platform,
        handle,
        external_account_id: channelId ?? null,
        token_secret_name: secretName ?? null,
        status,
        daily_post_limit: dailyLimit,
      },
      { onConflict: "platform,handle" }
    )
    .select("id, platform, handle, status, daily_post_limit")
    .single();

  if (accountError || !account) fail(`account upsert failed: ${accountError?.message}`);

  console.log(`  ✓ account ${account.platform} ${account.handle} ready`);
  console.log(`    id=${account.id}`);
  console.log(`    status=${account.status} daily_post_limit=${account.daily_post_limit}`);

  if (!channelId) {
    console.warn(
      `\n  ! No --channel-id set. The YouTube adapter can then not verify the\n` +
        `    token owns this channel, so a misconfigured secret could publish to\n` +
        `    the wrong one. Get it from youtube.com/account_advanced and re-run.`
    );
  }
  if (!secretName) {
    console.warn(
      `\n  ! No --secret set. Publishing falls back to YOUTUBE_REFRESH_TOKEN,\n` +
        `    which only works for a single channel.`
    );
  }

  console.log(
    `\n  Reminder: this recorded an account you already own. Creating social\n` +
      `  accounts is a manual, human step and must stay that way.\n`
  );
}

main().catch((err: unknown) => {
  console.error("\n  ✗", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
