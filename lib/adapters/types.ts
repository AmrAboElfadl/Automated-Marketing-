import type { Platform, MediaType } from "../supabase";

export interface PublishInput {
  title: string;
  caption: string;
  hashtags: string[];
  mediaUrl: string;                    // short-lived signed URL from Supabase Storage
  mediaType: MediaType;
  externalAccountId: string | null;    // channel ID / IG user ID / page ID
  tokenSecretName: string | null;      // Vault key holding the OAuth token
}

export interface PublishResult {
  externalPostId: string;
  publishedAt: string;
}

export interface MetricsResult {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  watchTimeSecs: number;
  followerCount: number | null;
  raw: unknown;
}

/**
 * Thrown by an adapter when the platform rejected the *credentials* rather than
 * the request — an expired refresh token, a revoked grant, a dead long-lived
 * token.
 *
 * This is worth distinguishing because retrying cannot help: every attempt
 * fails identically until a human rotates the secret. The scheduler uses it to
 * mark the account unhealthy so `claim_due_posts` stops handing it work, which
 * leaves the posts waiting in `queued` instead of burning their attempts and
 * dying as `failed`.
 *
 * Adapters throw it; nothing else should. It carries no platform detail, so the
 * scheduler stays platform-agnostic.
 */
export class AdapterAuthError extends Error {
  readonly isAuthFailure = true as const;

  constructor(message: string) {
    super(message);
    this.name = "AdapterAuthError";
  }
}

/** True for an auth failure thrown by any adapter. */
export function isAuthFailure(err: unknown): err is AdapterAuthError {
  return err instanceof AdapterAuthError;
}

export interface PublishAdapter {
  platform: Platform;
  publish(input: PublishInput): Promise<PublishResult>;
  fetchMetrics?(externalPostId: string, tokenSecretName: string | null): Promise<MetricsResult>;
}

/**
 * Mock adapter — pretends to publish and returns a fake ID.
 * Lets the whole pipeline be verified before any developer account exists.
 * Real adapters slot in beside it with zero scheduler changes.
 *
 * Reached by setting MOCK_PUBLISH=true; `getAdapter` overrides `platform` with
 * whatever was asked for, so the value below is only a placeholder.
 */
export const mockAdapter: PublishAdapter = {
  platform: "youtube",
  async publish(input) {
    console.log("[mock] publish:", input.title, "->", input.mediaUrl.slice(0, 60));
    await new Promise((r) => setTimeout(r, 300));
    return {
      externalPostId: `mock_${Date.now()}`,
      publishedAt: new Date().toISOString(),
    };
  },
  async fetchMetrics(externalPostId) {
    console.log("[mock] fetchMetrics:", externalPostId);
    return {
      views: 100, likes: 10, comments: 2, shares: 1, saves: 1,
      watchTimeSecs: 250, followerCount: 42,
      raw: { mock: true, externalPostId },
    };
  },
};
