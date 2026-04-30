import type { HttpRequest } from "@azure/functions";
import { isIP } from "node:net";
import { getPositiveIntegerEnv } from "./env";

const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 5;
const DEFAULT_MAX_RATE_LIMIT_CLIENTS = 1_000;
const CLEANUP_INTERVAL_MS = 60_000;
const LOCAL_DEVELOPMENT_CLIENT_KEY = "local-development";

interface RateLimitEntry {
  windowStart: number;
  count: number;
  createdAt: number;
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: "rate-limited"; retryAfterSeconds: number }
  | { allowed: false; reason: "missing-client" };

const rateLimitStore = new Map<string, RateLimitEntry>();
let lastRateLimitPruneAt = 0;

function pruneExpiredRateLimitEntries(now: number, windowMs: number) {
  for (const [clientKey, entry] of rateLimitStore) {
    if (now - entry.windowStart >= windowMs) {
      rateLimitStore.delete(clientKey);
    }
  }
}

function removeOldestRateLimitEntry() {
  let oldestClientKey: string | null = null;
  let oldestCreatedAt = Number.POSITIVE_INFINITY;

  for (const [clientKey, entry] of rateLimitStore) {
    if (entry.createdAt < oldestCreatedAt) {
      oldestCreatedAt = entry.createdAt;
      oldestClientKey = clientKey;
    }
  }

  if (oldestClientKey) {
    rateLimitStore.delete(oldestClientKey);
  }
}

function normalizeClientIp(candidate: string): string | null {
  const trimmed = candidate.trim().replace(/^"(.*)"$/, "$1");
  const bracketedIpv6 = trimmed.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketedIpv6?.[1] && isIP(bracketedIpv6[1])) {
    return bracketedIpv6[1];
  }

  if (isIP(trimmed)) {
    return trimmed;
  }

  const lastColonIndex = trimmed.lastIndexOf(":");
  const hasSingleColon = lastColonIndex > -1 && trimmed.indexOf(":") === lastColonIndex;
  if (hasSingleColon) {
    const possibleIp = trimmed.slice(0, lastColonIndex);
    const possiblePort = trimmed.slice(lastColonIndex + 1);
    if (/^\d+$/.test(possiblePort) && isIP(possibleIp)) {
      return possibleIp;
    }
  }

  return null;
}

function isLocalDevelopmentEnvironment(): boolean {
  // `AZURE_FUNCTIONS_ENVIRONMENT` is set to `Development` by the Azure Functions
  // Core Tools (`func start`). `WEBSITE_INSTANCE_ID` is injected by the Azure
  // App Service runtime in deployed environments. Requiring both signals
  // ensures the local-dev fallback cannot be tripped in production by a
  // misconfigured environment variable.
  return (
    process.env.AZURE_FUNCTIONS_ENVIRONMENT === "Development" &&
    !process.env.WEBSITE_INSTANCE_ID
  );
}

function getClientKey(request: HttpRequest): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const forwardedIps = forwardedFor
      .split(",")
      .map(normalizeClientIp)
      .filter((ip): ip is string => ip !== null);
    if (forwardedIps[0]) {
      return forwardedIps[0];
    }
  }

  for (const headerName of ["x-azure-clientip", "x-real-ip"]) {
    const value = request.headers.get(headerName);
    if (!value) continue;
    const normalized = normalizeClientIp(value);
    if (normalized) {
      return normalized;
    }
  }

  if (isLocalDevelopmentEnvironment()) {
    return LOCAL_DEVELOPMENT_CLIENT_KEY;
  }

  return null;
}

export function checkRateLimit(request: HttpRequest): RateLimitResult {
  const maxRequests = getPositiveIntegerEnv(
    "API_RATE_LIMIT_MAX_REQUESTS",
    DEFAULT_RATE_LIMIT_MAX_REQUESTS
  );
  const windowSeconds = getPositiveIntegerEnv(
    "API_RATE_LIMIT_WINDOW_SECONDS",
    DEFAULT_RATE_LIMIT_WINDOW_SECONDS
  );
  const windowMs = windowSeconds * 1000;
  const now = Date.now();
  const maxClients = getPositiveIntegerEnv(
    "API_RATE_LIMIT_MAX_CLIENTS",
    DEFAULT_MAX_RATE_LIMIT_CLIENTS
  );
  const clientKey = getClientKey(request);
  if (!clientKey) {
    return { allowed: false, reason: "missing-client" };
  }

  if (now - lastRateLimitPruneAt >= CLEANUP_INTERVAL_MS) {
    pruneExpiredRateLimitEntries(now, windowMs);
    lastRateLimitPruneAt = now;
  }

  const entry = rateLimitStore.get(clientKey);

  if (!entry || now - entry.windowStart >= windowMs) {
    if (!entry && rateLimitStore.size >= maxClients) {
      removeOldestRateLimitEntry();
    }

    if (entry) {
      rateLimitStore.delete(clientKey);
    }
    rateLimitStore.set(clientKey, { windowStart: now, count: 1, createdAt: now });
    return { allowed: true };
  }

  if (entry.count >= maxRequests) {
    return {
      allowed: false,
      reason: "rate-limited",
      retryAfterSeconds: Math.max(1, Math.ceil((entry.windowStart + windowMs - now) / 1000)),
    };
  }

  entry.count += 1;
  return { allowed: true };
}
