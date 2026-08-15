import type { MetricsResult, PublishAdapter, PublishInput, PublishResult } from "./types";
import {
  buildCaption,
  describeFailure,
  getAccessToken,
  graphRequest,
  graphUrl,
  isRecord,
  toCount,
} from "./meta";

/**
 * Facebook Page adapter — Meta Graph API (official, documented endpoints only).
 *
 * Simpler than Instagram: a single call per post, and Meta fetches the media
 * from our URL synchronously enough that no container polling is needed.
 *
 *   video →  POST /{page-id}/videos   file_url + description
 *   image →  POST /{page-id}/photos   url + caption
 *
 * `externalAccountId` must be the **Page id**, and `tokenSecretName` must point
 * at a **Page access token** — a user token will authenticate but will not be
 * allowed to post as the Page.
 *
 * METRICS ARE LIMITED HERE ON PURPOSE. `/{page-id}/videos` returns a *video*
 * id, which is not the id of the post that appears in the Page feed, and the
 * mapping between them is not something this adapter can derive reliably. Reads
 * are therefore restricted to what can be fetched from the returned id itself,
 * and anything unavailable is reported as zero rather than guessed at.
 */

const DESCRIPTION_MAX = 5000;

async function publish(input: PublishInput): Promise<PublishResult> {
  if (input.mediaType === "carousel") {
    throw new Error(
      "carousel posts need each photo uploaded unpublished and then attached to a feed " +
        "post; this adapter publishes single media only"
    );
  }

  if (!input.externalAccountId) {
    throw new Error(
      "accounts.external_account_id must hold the Facebook Page id, and token_secret_name " +
        "must point at a Page access token rather than a user token"
    );
  }

  const accessToken = await getAccessToken(input.tokenSecretName);
  const pageId = input.externalAccountId;
  const text = buildCaption(input.caption, input.hashtags, DESCRIPTION_MAX);
  const isVideo = input.mediaType === "video";

  const path = isVideo ? `${pageId}/videos` : `${pageId}/photos`;
  const params: Record<string, string> = isVideo
    ? { file_url: input.mediaUrl, description: text, title: input.title }
    : { url: input.mediaUrl, caption: text };

  const body = await graphRequest(
    path,
    accessToken,
    `facebook publish ${isVideo ? "video" : "photo"}`,
    { method: "POST", params }
  );

  // /photos returns post_id alongside id; /videos returns only id.
  const postId =
    typeof body.post_id === "string"
      ? body.post_id
      : typeof body.id === "string"
        ? body.id
        : null;

  if (!postId) {
    throw new Error(`facebook publish returned no id for the created ${isVideo ? "video" : "photo"}`);
  }

  return { externalPostId: postId, publishedAt: new Date().toISOString() };
}

/**
 * Engagement counts. `likes.summary(true)` and `comments.summary(true)` return
 * totals without paging through every edge, which matters on a popular post.
 */
async function fetchMetrics(
  externalPostId: string,
  tokenSecretName: string | null
): Promise<MetricsResult> {
  const accessToken = await getAccessToken(tokenSecretName);

  const node = await graphRequest(externalPostId, accessToken, "facebook post fields", {
    params: {
      fields: "likes.summary(true).limit(0),comments.summary(true).limit(0),shares",
    },
  });

  const summaryTotal = (value: unknown): number => {
    if (!isRecord(value) || !isRecord(value.summary)) return 0;
    return toCount(value.summary.total_count);
  };

  const shares = isRecord(node.shares) ? toCount(node.shares.count) : 0;
  const views = await fetchVideoViews(externalPostId, accessToken);

  return {
    views,
    likes: summaryTotal(node.likes),
    comments: summaryTotal(node.comments),
    shares,
    // Facebook has no "saves" equivalent exposed for Page posts.
    saves: 0,
    watchTimeSecs: 0,
    // Page follower count needs a separate Page-level read; not attributable to
    // a single post, and omitted rather than reported inaccurately.
    followerCount: null,
    raw: node,
  };
}

/**
 * Best-effort view count. `video_insights` only exists on video nodes, so a
 * photo post or an id that is not a video returns nothing — which is expected,
 * not an error worth failing metrics collection over.
 */
async function fetchVideoViews(postId: string, accessToken: string): Promise<number> {
  try {
    const res = await fetch(
      `${graphUrl(`${postId}/video_insights`)}?metric=total_video_views`,
      { headers: { authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) {
      const failure = await describeFailure(res, "facebook video_insights");
      console.warn(`[facebook] view count unavailable for ${postId}: ${failure.message}`);
      return 0;
    }

    const body: unknown = await res.json();
    const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
    const entry = data.find(
      (item): item is Record<string, unknown> =>
        isRecord(item) && item.name === "total_video_views"
    );
    if (!entry) return 0;

    const values = Array.isArray(entry.values) ? entry.values : [];
    const first = values.find(isRecord);
    return first ? toCount(first.value) : 0;
  } catch (err) {
    console.warn(
      `[facebook] video_insights request failed for ${postId}:`,
      err instanceof Error ? err.message : err
    );
    return 0;
  }
}

export const facebookAdapter: PublishAdapter = {
  platform: "facebook",
  publish,
  fetchMetrics,
};
