import type { Platform } from "../supabase";
import { mockAdapter, type PublishAdapter } from "./types";
import { youtubeAdapter } from "./youtube";

/**
 * Adapter registry. The scheduler resolves platforms through here and knows
 * nothing about any individual one.
 */
const registry: Partial<Record<Platform, PublishAdapter>> = {
  youtube: youtubeAdapter,
  // instagram: instagramAdapter,   <- Phase 4
  // facebook:  facebookAdapter,    <- Phase 4
  // tiktok:    tiktokAdapter,      <- Phase 5
  // pinterest: pinterestAdapter,   <- Phase 5
  // x:         xAdapter,           <- Phase 5
};

/**
 * With MOCK_PUBLISH=true every platform resolves to the mock adapter, so the
 * full claim → publish → mark-published pipeline can be exercised without a
 * single real credential. Never set this in production.
 */
const useMock = process.env.MOCK_PUBLISH === "true";

export function getAdapter(platform: Platform): PublishAdapter {
  if (useMock) return { ...mockAdapter, platform };

  const adapter = registry[platform];
  if (!adapter) throw new Error(`No adapter registered for platform: ${platform}`);
  return adapter;
}

export function registeredPlatforms(): Platform[] {
  return Object.keys(registry) as Platform[];
}
