import type {
  MetricsResult,
  PublishAdapter,
  PublishInput,
  PublishResult,
} from "./types";
import { readSecret } from "../vault";

/**
 * YouTube adapter — Data API v3 (official, documented endpoints only).
 *
 *   publish()      videos.insert via the resumable upload protocol
 *   fetchMetrics()  videos.list + channels.list, plus a best-effort
 *                   YouTube Analytics API call for watch time
 *
 * Auth: the per-account OAuth *refresh* token lives in Supabase Vault under
 * `accounts.token_secret_name`. The client ID/secret are app-level and come
 * from the environment. Access tokens are minted per run and never persisted.
 *
 * QUOTA — the constraint that actually bites: a Data API project gets 10,000
 * units/day by default and `videos.insert` costs ~1,600. That is roughly six
 * uploads per day across every channel sharing the project, regardless of what
 * `accounts.daily_post_limit` says. Request a quota increase from Google, or
 * use a separate Cloud project per channel.
 *
 * VERCEL DURATION — see MAX_MEDIA_BYTES below. A 60s function cannot push an
 * arbitrarily large file. This adapter refuses oversized media with a clear
 * error rather than uploading a truncated video.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos";
const DATA_API = "https://www.googleapis.com/youtube/v3";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports";

// YouTube's documented metadata limits. Exceeding any of them is a hard 400.
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
const TAGS_TOTAL_MAX = 450; // API caps the joined tag string at 500; leave headroom

// Resumable upload chunk size. Must be a multiple of 256 KiB.
const CHUNK_SIZE = 8 * 1024 * 1024;
const CHUNK_RETRIES = 3;

/**
 * Upper bound on media size. The whole file is buffered in memory and pushed
 * inside a single function invocation, so this guards both memory and the
 * platform's wall-clock limit. Vercel Hobby caps functions at 60s; with
 * `maxDuration = 300` on Pro this can be raised. Beyond that, move the upload
 * to a Supabase Edge Function — do not just bump the number and hope.
 */
const MAX_MEDIA_BYTES = (() => {
  // A malformed override must not silently disable the cap.
  const configured = Number(process.env.YOUTUBE_MAX_MEDIA_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : 256 * 1024 * 1024;
})();

const VALID_PRIVACY = ["public", "unlisted", "private"] as const;
type PrivacyStatus = (typeof VALID_PRIVACY)[number];

/**
 * Actionable hints keyed by Google's error `reason`. These land in
 * `post_targets.error_message`, so they have to tell the operator what to do.
 */
const ERROR_HINTS: Record<string, string> = {
  invalid_grant:
    "the stored refresh token was revoked or expired — re-run the OAuth consent flow and rotate the Vault secret",
  invalid_client:
    "check YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET",
  unauthorized_client:
    "this OAuth client is not authorised for the refresh_token grant — check the Cloud Console credential type",
  quotaExceeded:
    "the Cloud project's daily Data API quota is exhausted (videos.insert costs ~1,600 of 10,000 units); it resets at midnight Pacific",
  uploadLimitExceeded:
    "the channel hit YouTube's own daily upload cap — lower accounts.daily_post_limit",
  rateLimitExceeded: "sending too fast; the scheduler will retry this post",
  userRateLimitExceeded: "sending too fast; the scheduler will retry this post",
  youtubeSignupRequired:
    "the Google account has no YouTube channel — create one in the YouTube UI first",
  forbidden:
    "the token lacks the youtube.upload scope, or this channel is not owned by the authorised account",
  authError:
    "the access token was rejected — it will be re-minted on the next attempt",
  invalidVideoMetadata:
    "YouTube rejected the title/description/tags — check for oversized or disallowed values",
  failedPrecondition:
    "the request was well-formed but the channel is not in a state that allows uploads (often: unverified account)",
  mediaBodyRequired: "the media file arrived empty — check the storage path",
  invalidCategoryId:
    "YOUTUBE_CATEGORY_ID is not a category valid in this channel's region",
};

// ---------------------------------------------------------------- utilities

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drains a response we aren't going to read, so the socket is released. */
async function discard(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* nothing left to drain */
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * Turns a failed Google response into one readable Error.
 *
 * Two different error shapes have to be handled: the OAuth endpoint returns
 * `{ error: "invalid_grant", error_description: "..." }` (error is a string)
 * while the Data API returns `{ error: { code, message, errors: [...] } }`
 * (error is an object).
 */
async function describeFailure(res: Response, context: string): Promise<Error> {
  const raw = await res.text().catch(() => "");
  let reason = "";
  let detail = "";

  try {
    const body: unknown = JSON.parse(raw);
    if (isRecord(body)) {
      const err = body.error;

      if (typeof err === "string") {
        reason = err;
        detail =
          typeof body.error_description === "string" ? body.error_description : "";
      } else if (isRecord(err)) {
        detail = typeof err.message === "string" ? err.message : "";
        const list = err.errors;
        if (Array.isArray(list) && list.length > 0 && isRecord(list[0])) {
          const first = list[0];
          if (typeof first.reason === "string") reason = first.reason;
        }
        if (!reason && typeof err.status === "string") reason = err.status;
      }
    }
  } catch {
    detail = raw.slice(0, 200);
  }

  const parts = [
    `${context} failed (HTTP ${res.status}${reason ? ` ${reason}` : ""})`,
  ];
  if (detail) parts.push(detail);

  const hint = ERROR_HINTS[reason];
  if (hint) parts.push(hint);

  return new Error(parts.join(" — "));
}

// ------------------------------------------------------------------- oauth

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/** Keyed by Vault secret name so multi-account runs don't cross wires. */
const tokenCache = new Map<string, CachedToken>();

async function refreshTokenFor(tokenSecretName: string | null): Promise<string> {
  if (tokenSecretName) return readSecret(tokenSecretName);

  // Single-channel setups may keep the refresh token in the environment
  // instead of Vault. Both satisfy the no-tokens-in-tables rule.
  const fromEnv = process.env.YOUTUBE_REFRESH_TOKEN;
  if (fromEnv) return fromEnv;

  throw new Error(
    "no YouTube credentials: accounts.token_secret_name is null and YOUTUBE_REFRESH_TOKEN is unset"
  );
}

async function getAccessToken(tokenSecretName: string | null): Promise<string> {
  const cacheKey = tokenSecretName ?? "__env__";

  // 60s of slack so a token can't expire mid-upload.
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.accessToken;

  const refreshToken = await refreshTokenFor(tokenSecretName);

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("YOUTUBE_CLIENT_ID"),
      client_secret: requireEnv("YOUTUBE_CLIENT_SECRET"),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    tokenCache.delete(cacheKey);
    throw await describeFailure(res, "youtube token refresh");
  }

  const body: unknown = await res.json();
  if (!isRecord(body) || typeof body.access_token !== "string") {
    throw new Error("youtube token refresh returned no access_token");
  }

  const ttlSecs = typeof body.expires_in === "number" ? body.expires_in : 3600;
  tokenCache.set(cacheKey, {
    accessToken: body.access_token,
    expiresAt: Date.now() + ttlSecs * 1000,
  });

  return body.access_token;
}

// ---------------------------------------------------------------- metadata

/** YouTube rejects angle brackets in title and description outright. */
function stripBrackets(text: string): string {
  return text.replace(/[<>]/g, "");
}

function buildTitle(rawTitle: string): string {
  const clean = stripBrackets(rawTitle).replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("content_items.title is empty — YouTube requires a title");
  return clean.length > TITLE_MAX ? clean.slice(0, TITLE_MAX - 1).trimEnd() + "…" : clean;
}

function buildDescription(caption: string, hashtags: string[]): string {
  const tagLine = hashtags
    .map((tag) => tag.trim().replace(/^#+/, ""))
    .filter(Boolean)
    .map((tag) => `#${tag}`)
    .join(" ");

  const body = [stripBrackets(caption).trim(), stripBrackets(tagLine)]
    .filter(Boolean)
    .join("\n\n");

  return body.length > DESCRIPTION_MAX ? body.slice(0, DESCRIPTION_MAX) : body;
}

/** Tags are capped as one joined string, so fill until the budget runs out. */
function buildTags(hashtags: string[]): string[] {
  const tags: string[] = [];
  let used = 0;

  for (const raw of hashtags) {
    const tag = raw.trim().replace(/^#+/, "");
    if (!tag) continue;

    const cost = tag.length + (tags.length > 0 ? 1 : 0);
    if (used + cost > TAGS_TOTAL_MAX) break;

    tags.push(tag);
    used += cost;
  }

  return tags;
}

function privacyStatus(): PrivacyStatus {
  const configured = process.env.YOUTUBE_PRIVACY_STATUS;
  if (!configured) return "public";

  const match = VALID_PRIVACY.find((value) => value === configured);
  if (!match) {
    throw new Error(
      `YOUTUBE_PRIVACY_STATUS="${configured}" is invalid — use one of ${VALID_PRIVACY.join(", ")}`
    );
  }
  return match;
}

// ------------------------------------------------------------------ upload

interface Media {
  /**
   * A Uint8Array explicitly backed by ArrayBuffer — Buffer, and a Uint8Array
   * left generic over ArrayBufferLike, are both rejected by fetch's BodyInit.
   */
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
}

async function downloadMedia(mediaUrl: string): Promise<Media> {
  const res = await fetch(mediaUrl);
  if (!res.ok) {
    throw new Error(
      `media download failed (HTTP ${res.status}) — the signed storage URL may have expired`
    );
  }

  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
    throw oversized(declared);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error("media file is empty — check content_items.storage_path");
  }
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw oversized(bytes.byteLength);

  const contentType = res.headers.get("content-type") ?? "video/*";
  return { bytes, contentType };
}

function oversized(size: number): Error {
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return new Error(
    `media is ${mb(size)}, over the ${mb(MAX_MEDIA_BYTES)} limit for a single ` +
      `function invocation — raise maxDuration to 300 on Vercel Pro and ` +
      `YOUTUBE_MAX_MEDIA_BYTES with it, or move the upload to a Supabase Edge Function`
  );
}

/** Confirms the token really controls the channel we intend to post to. */
async function assertChannelMatches(
  accessToken: string,
  expectedChannelId: string
): Promise<void> {
  const res = await fetch(`${DATA_API}/channels?part=id&mine=true`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw await describeFailure(res, "youtube channels.list(mine)");

  const body: unknown = await res.json();
  const items = isRecord(body) && Array.isArray(body.items) ? body.items : [];
  const owned = items
    .filter(isRecord)
    .map((item) => (typeof item.id === "string" ? item.id : null))
    .filter((id): id is string => id !== null);

  if (owned.length === 0) {
    throw new Error(
      "the authorised Google account owns no YouTube channel — create one before publishing"
    );
  }

  if (!owned.includes(expectedChannelId)) {
    throw new Error(
      `channel mismatch: accounts.external_account_id is ${expectedChannelId} but ` +
        `this token owns ${owned.join(", ")} — refusing to publish to the wrong channel`
    );
  }
}

async function startResumableSession(
  accessToken: string,
  metadata: unknown,
  size: number,
  contentType: string
): Promise<string> {
  const res = await fetch(`${UPLOAD_ENDPOINT}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(size),
      "x-upload-content-type": contentType,
    },
    body: JSON.stringify(metadata),
  });

  if (!res.ok) throw await describeFailure(res, "youtube resumable session init");

  const location = res.headers.get("location");
  if (!location) {
    throw new Error("youtube resumable session init returned no Location header");
  }
  return location;
}

/**
 * Pushes the file to the session URL in chunks, honouring the resumable
 * protocol: 308 means "keep going, here is how far I got", 2xx means done and
 * carries the video resource.
 */
async function uploadInChunks(
  sessionUrl: string,
  accessToken: string,
  media: Media
): Promise<string> {
  const total = media.bytes.byteLength;
  let offset = 0;
  let retries = 0;

  while (offset < total) {
    const end = Math.min(offset + CHUNK_SIZE, total);

    const res = await fetch(sessionUrl, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": media.contentType,
        "content-range": `bytes ${offset}-${end - 1}/${total}`,
      },
      body: media.bytes.subarray(offset, end),
    });

    // 308 Resume Incomplete — the Range header says what YouTube has stored.
    if (res.status === 308) {
      const range = res.headers.get("range");
      await discard(res);

      const confirmed = range ? Number(range.split("-").pop()) : NaN;
      const next = Number.isFinite(confirmed) ? confirmed + 1 : end;

      if (next <= offset) {
        throw new Error(
          "youtube upload stalled — the server stopped acknowledging new bytes"
        );
      }
      offset = next;
      retries = 0;
      continue;
    }

    if (res.ok) {
      const body: unknown = await res.json();
      if (isRecord(body) && typeof body.id === "string") return body.id;
      throw new Error("youtube upload completed but returned no video id");
    }

    // Transient server-side failures are retried against the same offset.
    if (res.status >= 500 && retries < CHUNK_RETRIES) {
      await discard(res);
      retries += 1;
      await sleep(2 ** retries * 500);
      continue;
    }

    throw await describeFailure(res, "youtube chunk upload");
  }

  throw new Error("youtube upload sent every byte but never got a completion response");
}

async function publish(input: PublishInput): Promise<PublishResult> {
  if (input.mediaType !== "video") {
    throw new Error(
      `YouTube's Data API only accepts video uploads; this content item is "${input.mediaType}"`
    );
  }

  const accessToken = await getAccessToken(input.tokenSecretName);

  if (input.externalAccountId) {
    await assertChannelMatches(accessToken, input.externalAccountId);
  }

  const media = await downloadMedia(input.mediaUrl);

  const metadata = {
    snippet: {
      title: buildTitle(input.title),
      description: buildDescription(input.caption, input.hashtags),
      tags: buildTags(input.hashtags),
      categoryId: process.env.YOUTUBE_CATEGORY_ID ?? "22", // People & Blogs
    },
    status: {
      privacyStatus: privacyStatus(),
      // COPPA: YouTube requires an explicit declaration.
      selfDeclaredMadeForKids: process.env.YOUTUBE_MADE_FOR_KIDS === "true",
    },
  };

  const sessionUrl = await startResumableSession(
    accessToken,
    metadata,
    media.bytes.byteLength,
    media.contentType
  );

  const videoId = await uploadInChunks(sessionUrl, accessToken, media);

  return {
    externalPostId: videoId,
    publishedAt: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------- metrics

async function fetchSubscriberCount(
  accessToken: string,
  channelId: string
): Promise<number | null> {
  const res = await fetch(
    `${DATA_API}/channels?part=statistics&id=${encodeURIComponent(channelId)}`,
    { headers: { authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    await discard(res);
    return null;
  }

  const body: unknown = await res.json();
  const items = isRecord(body) && Array.isArray(body.items) ? body.items : [];
  const first = items.find(isRecord);
  if (!first || !isRecord(first.statistics)) return null;

  const count = first.statistics.subscriberCount;
  return count === undefined ? null : toCount(count);
}

interface AnalyticsSlice {
  watchTimeSecs: number;
  shares: number;
  saves: number;
  raw: unknown;
}

const NO_ANALYTICS: AnalyticsSlice = {
  watchTimeSecs: 0,
  shares: 0,
  saves: 0,
  raw: null,
};

/**
 * Watch time and shares are not in the Data API — they live in the YouTube
 * Analytics API, which needs the separate `yt-analytics.readonly` scope.
 *
 * Best effort by design: if that scope was never granted, metrics collection
 * still succeeds with views/likes/comments rather than failing the whole row.
 * `saves` is approximated by `videosAddedToPlaylists`; YouTube exposes no
 * literal save count.
 */
async function fetchAnalytics(
  accessToken: string,
  videoId: string
): Promise<AnalyticsSlice> {
  const params = new URLSearchParams({
    ids: "channel==MINE",
    startDate: "2005-02-01", // predates YouTube itself: "all time"
    endDate: new Date().toISOString().slice(0, 10),
    metrics: "estimatedMinutesWatched,shares,videosAddedToPlaylists",
    filters: `video==${videoId}`,
  });

  try {
    const res = await fetch(`${ANALYTICS_API}?${params.toString()}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      await discard(res);
      console.warn(
        `[youtube] analytics unavailable for ${videoId} (HTTP ${res.status}) — ` +
          "watch time and shares will read 0; grant the yt-analytics.readonly scope to populate them"
      );
      return NO_ANALYTICS;
    }

    const body: unknown = await res.json();
    const rows = isRecord(body) && Array.isArray(body.rows) ? body.rows : [];
    const row = rows.find(Array.isArray);
    if (!row) return { ...NO_ANALYTICS, raw: body };

    return {
      watchTimeSecs: Math.round(toCount(row[0]) * 60), // API reports minutes
      shares: toCount(row[1]),
      saves: toCount(row[2]),
      raw: body,
    };
  } catch (err) {
    console.warn(
      `[youtube] analytics request failed for ${videoId}:`,
      err instanceof Error ? err.message : err
    );
    return NO_ANALYTICS;
  }
}

async function fetchMetrics(
  externalPostId: string,
  tokenSecretName: string | null
): Promise<MetricsResult> {
  const accessToken = await getAccessToken(tokenSecretName);

  const res = await fetch(
    `${DATA_API}/videos?part=statistics,snippet&id=${encodeURIComponent(externalPostId)}`,
    { headers: { authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw await describeFailure(res, "youtube videos.list");

  const body: unknown = await res.json();
  const items = isRecord(body) && Array.isArray(body.items) ? body.items : [];
  const video = items.find(isRecord);

  if (!video) {
    throw new Error(
      `youtube video ${externalPostId} not found — it may have been deleted, or is still processing`
    );
  }

  const stats = isRecord(video.statistics) ? video.statistics : {};
  const snippet = isRecord(video.snippet) ? video.snippet : {};
  const channelId = typeof snippet.channelId === "string" ? snippet.channelId : null;

  const [followerCount, analytics] = await Promise.all([
    channelId ? fetchSubscriberCount(accessToken, channelId) : Promise.resolve(null),
    fetchAnalytics(accessToken, externalPostId),
  ]);

  return {
    views: toCount(stats.viewCount),
    likes: toCount(stats.likeCount),
    comments: toCount(stats.commentCount),
    shares: analytics.shares,
    saves: analytics.saves,
    watchTimeSecs: analytics.watchTimeSecs,
    followerCount,
    raw: { statistics: stats, analytics: analytics.raw },
  };
}

export const youtubeAdapter: PublishAdapter = {
  platform: "youtube",
  publish,
  fetchMetrics,
};
