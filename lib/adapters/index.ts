import type { Platform } from "../supabase";
import { mockAdapter, type PublishAdapter } from "./types";

/**
 * Adapter registry.
 * Phase 2 swaps `youtube` for a real implementation.
 * Everything else stays mocked until its phase arrives.
 */
const registry: Partial<Record<Platform, PublishAdapter>> = {
  youtube: mockAdapter,
  // instagram: instagramAdapter,   <- Phase 3
  // facebook:  facebookAdapter,    <- Phase 3
  // tiktok:    tiktokAdapter,      <- Phase 4
  // pinterest: pinterestAdapter,   <- Phase 4
};

export function getAdapter(platform: Platform): PublishAdapter {
  const a = registry[platform];
  if (!a) throw new Error(`No adapter registered for platform: ${platform}`);
  return a;
}

export function registeredPlatforms(): Platform[] {
  return Object.keys(registry) as Platform[];
}
