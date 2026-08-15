import type { MetricsResult, PublishAdapter, PublishInput, PublishResult } from "./types";
import {
  buildCaption,
  describeFailure,
  getAccessToken,
  graphRequest,
  graphUrl,
  isRecord,
  sleep,
  toCount,
} from "./meta";

/**
 * Instagram adapter — Instagram Graph API (official, documented endpoints only).
 *
 * Publishing is two calls, not one:
 *   1. POST /{ig-user-id}/media          creates a container and starts Meta
 *                                        downloading the media from our URL
 *   2. POST /{ig-user-id}/media_publish  publishes the finished container
 *
 * Between them, a video container has to finish processing. Meta pulls the file
 * from `mediaUrl` on its own schedule, so step 2 fails until `status_code` is
 * FINISHED — the poll below is required, not defensive.
 *
 * `externalAccountId` must be the **Instagram user id** (the Business/Creator
 * account's id), not the Facebook Page id and not the @handle.
 *
 * LIMIT: 50 API-published posts per rolling 24h per account, enforced by Meta.
 * `accounts.daily_post_limit` should stay well under it.
 */

const CAPTION_MAX = 2200; // Instagram's documented caption limit

/**
 * Container polling. Vercel's default function budget is 60s, so this stays
 * comfortably inside it: a container that is not ready by then is reported
 * rather than waited on.
 */
const POLL_INTERVAL_MS = 3_000;
const POLL_BUDGET_MS = 40_000;

interface ContainerStatus {
  code: string;
  detail: string;
}

async function readContainerStatus(
  containerId: string,
  accessToken: string
): Promise<ContainerStatus> {
  const body = await graphRequest(containerId, accessToken, "instagram container status", {
    params: { fields: "status_code,status" },
  });

  return {
    code: typeof body.status_code === "string" ? body.status_code : "UNKNOWN",
    detail: typeof body.status === "string" ? body.status : "",
  };
}

/**
 * Waits for a video container to finish processing.
 *
 * Throws on ERROR/EXPIRED with Meta's own explanation, which is usually about
 * the media itself (unreachable URL, unsupported codec, wrong aspect ratio).
 */
async function awaitContainerReady(
  containerId: string,
  accessToken: string
): Promise<void> {
  const deadline = Date.now() + POLL_BUDGET_MS;

  for (;;) {
    const status = await readContainerStatus(containerId, accessToken);

    if (status.code === "FINISHED") return;

    if (status.code === "ERROR" || status.code === "EXPIRED") {
      throw new Error(
        `instagram media container ${status.code.toLowerCase()}${
          status.detail ? `: ${status.detail}` : ""
        } — Meta could not process the media. Check the video is H.264/AAC MP4, ` +
          `under 60s for a Reel, and that the signed URL had not expired.`
      );
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `instagram media container ${containerId} still processing after ` +
          `${POLL_BUDGET_MS / 1000}s. It may yet publish on its own; a retry will ` +
          `create a second container, so check the account before requeueing.`
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function publish(input: PublishInput): Promise<PublishResult> {
  if (input.mediaType === "carousel") {
    throw new Error(
      "carousel posts need one container per item plus a parent container; this adapter " +
        "publishes single media only"
    );
  }

  if (!input.externalAccountId) {
    throw new Error(
      "accounts.external_account_id must hold the Instagram user id (a numeric Business/" +
        "Creator account id, not the @handle or the Facebook Page id)"
    );
  }

  const accessToken = await getAccessToken(input.tokenSecretName);
  const igUserId = input.externalAccountId;
  const isVideo = input.mediaType === "video";

  // --- 1. create the container ---
  const containerParams: Record<string, string> = {
    caption: buildCaption(input.caption, input.hashtags, CAPTION_MAX),
  };

  if (isVideo) {
    containerParams.media_type = "REELS"; // the only supported video product
    containerParams.video_url = input.mediaUrl;
  } else {
    containerParams.image_url = input.mediaUrl;
  }

  const container = await graphRequest(
    `${igUserId}/media`,
    accessToken,
    "instagram create media container",
    { method: "POST", params: containerParams }
  );

  const containerId = typeof container.id === "string" ? container.id : null;
  if (!containerId) {
    throw new Error("instagram create media container returned no container id");
  }

  // --- 2. wait for processing (video only; images are ready immediately) ---
  if (isVideo) await awaitContainerReady(containerId, accessToken);

  // --- 3. publish ---
  const published = await graphRequest(
    `${igUserId}/media_publish`,
    accessToken,
    "instagram media_publish",
    { method: "POST", params: { creation_id: containerId } }
  );

  const mediaId = typeof published.id === "string" ? published.id : null;
  if (!mediaId) throw new Error("instagram media_publish returned no media id");

  return { externalPostId: mediaId, publishedAt: new Date().toISOString() };
}

/**
 * Insights metric names vary by media product type and have been renamed across
 * API versions (`plays` became `views` for reels, for example). Rather than
 * guess a set that may not exist on this account's media, insights are
 * best-effort: like/comment counts come from stable node fields, and anything
 * insights adds is a bonus.
 */
async function fetchInsights(
  mediaId: string,
  accessToken: string
): Promise<{ values: Record<string, number>; raw: unknown }> {
  const metrics = ["views", "likes", "comments", "shares", "saved", "reach"].join(",");

  try {
    const res = await fetch(`${graphUrl(`${mediaId}/insights`)}?metric=${metrics}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const failure = await describeFailure(res, "instagram insights");
      console.warn(
        `[instagram] insights unavailable for ${mediaId}: ${failure.message} — ` +
          "falling back to like and comment counts"
      );
      return { values: {}, raw: null };
    }

    const body: unknown = await res.json();
    const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
    const values: Record<string, number> = {};

    for (const entry of data) {
      if (!isRecord(entry) || typeof entry.name !== "string") continue;
      const series = Array.isArray(entry.values) ? entry.values : [];
      const first = series.find(isRecord);
      if (first) values[entry.name] = toCount(first.value);
    }

    return { values, raw: body };
  } catch (err) {
    console.warn(
      `[instagram] insights request failed for ${mediaId}:`,
      err instanceof Error ? err.message : err
    );
    return { values: {}, raw: null };
  }
}

async function fetchMetrics(
  externalPostId: string,
  tokenSecretName: string | null
): Promise<MetricsResult> {
  const accessToken = await getAccessToken(tokenSecretName);

  // Stable node fields, present regardless of media product type.
  const node = await graphRequest(externalPostId, accessToken, "instagram media fields", {
    params: { fields: "like_count,comments_count,owner" },
  });

  const insights = await fetchInsights(externalPostId, accessToken);

  // followers_count lives on the account, not the media.
  let followerCount: number | null = null;
  const owner = isRecord(node.owner) && typeof node.owner.id === "string" ? node.owner.id : null;

  if (owner) {
    try {
      const account = await graphRequest(owner, accessToken, "instagram account fields", {
        params: { fields: "followers_count" },
      });
      followerCount = toCount(account.followers_count);
    } catch {
      followerCount = null; // not fatal — the post's own numbers still count
    }
  }

  return {
    views: insights.values.views ?? insights.values.reach ?? 0,
    likes: insights.values.likes ?? toCount(node.like_count),
    comments: insights.values.comments ?? toCount(node.comments_count),
    shares: insights.values.shares ?? 0,
    saves: insights.values.saved ?? 0,
    // Instagram exposes no watch-time metric comparable to YouTube's.
    watchTimeSecs: 0,
    followerCount,
    raw: { node, insights: insights.raw },
  };
}

export const instagramAdapter: PublishAdapter = {
  platform: "instagram",
  publish,
  fetchMetrics,
};
