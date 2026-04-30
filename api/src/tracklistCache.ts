import { getPositiveIntegerEnv } from "./env";

const DEFAULT_CACHE_TTL_SECONDS = 60 * 60 * 6;
const DEFAULT_MAX_CACHE_ENTRIES = 100;
const CLEANUP_INTERVAL_MS = 60_000;

interface CachedTracklist {
  expiresAt: number;
  cachedAt: number;
  body: unknown;
}

const tracklistCache = new Map<string, CachedTracklist>();
let lastTracklistCachePruneAt = 0;

export function getCachedTracklist(videoId: string): unknown | null {
  const cached = tracklistCache.get(videoId);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    tracklistCache.delete(videoId);
    return null;
  }

  return cached.body;
}

export function setCachedTracklist(videoId: string, body: unknown) {
  const ttlSeconds = getPositiveIntegerEnv("TRACKLIST_CACHE_TTL_SECONDS", DEFAULT_CACHE_TTL_SECONDS);
  const maxEntries = getPositiveIntegerEnv("TRACKLIST_CACHE_MAX_ENTRIES", DEFAULT_MAX_CACHE_ENTRIES);
  const now = Date.now();

  if (now - lastTracklistCachePruneAt >= CLEANUP_INTERVAL_MS) {
    for (const [cachedVideoId, cached] of tracklistCache) {
      if (cached.expiresAt <= now) {
        tracklistCache.delete(cachedVideoId);
      }
    }
    lastTracklistCachePruneAt = now;
  }

  if (!tracklistCache.has(videoId) && tracklistCache.size >= maxEntries) {
    let oldestVideoId: string | null = null;
    let oldestCachedAt = Number.POSITIVE_INFINITY;

    for (const [cachedVideoId, cached] of tracklistCache) {
      if (cached.cachedAt < oldestCachedAt) {
        oldestCachedAt = cached.cachedAt;
        oldestVideoId = cachedVideoId;
      }
    }

    if (oldestVideoId) {
      tracklistCache.delete(oldestVideoId);
    }
  }

  tracklistCache.set(videoId, {
    expiresAt: now + ttlSeconds * 1000,
    cachedAt: now,
    body,
  });
}
