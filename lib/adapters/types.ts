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

export interface PublishAdapter {
  platform: Platform;
  publish(input: PublishInput): Promise<PublishResult>;
  fetchMetrics?(externalPostId: string, tokenSecretName: string | null): Promise<MetricsResult>;
}

/**
 * Mock adapter — pretends to publish and returns a fake ID.
 * Lets the whole pipeline be verified before any developer account exists.
 * Real adapters slot in beside it with zero scheduler changes.
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
};
