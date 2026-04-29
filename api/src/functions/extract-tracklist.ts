import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { isIP } from "node:net";
import OpenAI from "openai";
import { z } from "zod";

const OPENAI_V1_PATH = "v1";
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 5;
const DEFAULT_CACHE_TTL_SECONDS = 60 * 60 * 6;
const DEFAULT_MAX_SOURCE_TEXT_CHARS = 12_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;
const DEFAULT_MAX_RATE_LIMIT_CLIENTS = 1_000;
const DEFAULT_MAX_CACHE_ENTRIES = 100;
const CLEANUP_INTERVAL_MS = 60_000;
const AI_OUTPUT_PREVIEW_CHARS = 800;

interface RateLimitEntry {
  windowStart: number;
  count: number;
  createdAt: number;
}

interface CachedTracklist {
  expiresAt: number;
  cachedAt: number;
  body: unknown;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const tracklistCache = new Map<string, CachedTracklist>();
let lastRateLimitPruneAt = 0;
let lastTracklistCachePruneAt = 0;

// --- Request validation ---
const RequestSchema = z.object({
  youtubeUrl: z.string().url().max(2048),
});

// --- LLM response validation ---
const TrackSchema = z.object({
  artist: z.string(),
  title: z.string(),
  timestamp: z.string().nullable(),
});

const LLMResponseSchema = z.object({
  confidence: z.enum(["high", "medium", "low"]),
  tracks: z.array(TrackSchema),
});

// --- YouTube URL parsing ---
function extractVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);

    if (parsed.hostname.includes("youtube.com") && parsed.pathname === "/watch") {
      return parsed.searchParams.get("v");
    }

    if (parsed.hostname === "youtu.be") {
      return parsed.pathname.slice(1) || null;
    }

    const match = parsed.pathname.match(/^\/(shorts|live)\/([^/?]+)/);
    if (parsed.hostname.includes("youtube.com") && match) {
      return match[2];
    }

    return null;
  } catch {
    return null;
  }
}

// --- YouTube API helpers ---
interface YouTubeVideoListResponse {
  items?: Array<{
    snippet?: {
      title?: string;
      channelTitle?: string;
      description?: string;
    };
  }>;
}

async function fetchVideoMetadata(videoId: string, apiKey: string) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API error: ${res.status}`);
  const data = (await res.json()) as YouTubeVideoListResponse;
  const snippet = data.items?.[0]?.snippet;
  if (!snippet?.title || !snippet.channelTitle) return null;
  return {
    title: snippet.title,
    channelTitle: snippet.channelTitle,
    description: snippet.description ?? "",
  };
}

// --- Source text selection ---
const TRACK_LINE_PATTERN = /(\d{1,2}:\d{2})|(\s[-–]\s)/;

function looksLikeTracklist(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const trackLines = lines.filter((l) => TRACK_LINE_PATTERN.test(l));
  return trackLines.length >= 3;
}

function pickDescriptionSourceText(description: string): { text: string; source: "description" } | null {
  if (looksLikeTracklist(description)) {
    return { text: description, source: "description" };
  }

  return null;
}

// --- LLM prompt & schema ---
const SYSTEM_PROMPT = `You extract DJ set tracklists from a YouTube video description.
Return ONLY tracks present in the input — never invent tracks.
Normalize each track into { artist, title, timestamp }.
- artist: the primary artist; if multiple, join with " & ".
- title: include remix/edit info in parentheses if present (e.g. "Song (Extended Mix)").
- timestamp: HH:MM:SS or MM:SS if present in the source line, else null.
Strip leading numbering (e.g. "1.", "01)", "Track 3:").
If the input does not contain a tracklist, return tracks: [] and confidence: "low".
Set confidence to "high" if the list is clearly delimited and consistently formatted,
"medium" if mostly clear but some lines are ambiguous, "low" otherwise.`;

const TRACK_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tracks", "confidence"],
  properties: {
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    tracks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["artist", "title", "timestamp"],
        properties: {
          artist: { type: "string" },
          title: { type: "string" },
          timestamp: { type: ["string", "null"] },
        },
      },
    },
  },
};

const TRACK_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  name: "tracklist",
  strict: true,
  schema: TRACK_JSON_SCHEMA,
};


function getPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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
  const trimmed = candidate.trim().replace(/^"|"$/g, "");
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

function getClientKey(request: HttpRequest): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const forwardedIps = forwardedFor
      .split(",")
      .map(normalizeClientIp)
      .filter((ip): ip is string => ip !== null);
    return forwardedIps[0] ?? null;
  }

  return null;
}

function checkRateLimit(
  request: HttpRequest
): { allowed: true } | { allowed: false; retryAfterSeconds: number } | { allowed: false; missingClient: true } {
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
    return { allowed: false, missingClient: true };
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
      retryAfterSeconds: Math.max(1, Math.ceil((entry.windowStart + windowMs - now) / 1000)),
    };
  }

  entry.count += 1;
  return { allowed: true };
}

function trimSourceText(text: string): string {
  const maxChars = getPositiveIntegerEnv("MAX_SOURCE_TEXT_CHARS", DEFAULT_MAX_SOURCE_TEXT_CHARS);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function getCachedTracklist(videoId: string): unknown | null {
  const cached = tracklistCache.get(videoId);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    tracklistCache.delete(videoId);
    return null;
  }

  return cached.body;
}

function setCachedTracklist(videoId: string, body: unknown) {
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

  while (!tracklistCache.has(videoId) && tracklistCache.size >= maxEntries) {
    let oldestVideoId: string | null = null;
    let oldestCachedAt = Number.POSITIVE_INFINITY;

    for (const [cachedVideoId, cached] of tracklistCache) {
      if (cached.cachedAt < oldestCachedAt) {
        oldestCachedAt = cached.cachedAt;
        oldestVideoId = cachedVideoId;
      }
    }

    if (!oldestVideoId) break;
    tracklistCache.delete(oldestVideoId);
  }

  if (tracklistCache.has(videoId)) {
    tracklistCache.delete(videoId);
  }
  tracklistCache.set(videoId, {
    expiresAt: now + ttlSeconds * 1000,
    cachedAt: now,
    body,
  });
}

function jsonResponse(status: number, jsonBody: unknown, headers: Record<string, string> = {}): HttpResponseInit {
  return {
    status,
    headers: { ...JSON_HEADERS, ...headers },
    jsonBody,
  };
}

function normalizeOpenAIBaseUrl(targetUri: string): string {
  const url = new URL(targetUri.trim());
  url.search = "";
  url.hash = "";

  const trimmedPath = url.pathname.replace(/\/+$/, "");
  const withoutResponses = trimmedPath.endsWith("/responses")
    ? trimmedPath.slice(0, -"/responses".length)
    : trimmedPath;

  if (/\/openai\/v\d+$/i.test(withoutResponses)) {
    url.pathname = `${withoutResponses}/`;
    return url.toString();
  }

  url.pathname = `${withoutResponses}/openai/${OPENAI_V1_PATH}/`;
  return url.toString();
}

function getFoundryConfig() {
  const targetUri =
    process.env.AZURE_OPENAI_TARGET_URI ||
    process.env.AZURE_OPENAI_BASE_URL ||
    process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const model = process.env.AZURE_OPENAI_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT;

  return {
    apiKey,
    baseUrl: targetUri ? normalizeOpenAIBaseUrl(targetUri) : undefined,
    model,
  };
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

interface AIResponseStatus {
  id?: string;
  model?: string;
  status?: "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete";
  incomplete_details: { reason?: "max_output_tokens" | "content_filter" } | null;
  error?: unknown;
  output?: unknown[];
  output_text: string;
  usage?: unknown;
}

function getResponseStatusError(completion: AIResponseStatus): string | null {
  if (completion.status === "completed" || !completion.status) {
    return null;
  }

  if (completion.status === "incomplete") {
    if (completion.incomplete_details?.reason === "max_output_tokens") {
      return "AI response was too long to process. Try a shorter video or tracklist.";
    }

    if (completion.incomplete_details?.reason === "content_filter") {
      return "AI model output was stopped by Azure content filtering.";
    }

    return "AI model returned an incomplete response.";
  }

  return "AI model did not complete the request.";
}

function shouldLogAIOutputPreview(): boolean {
  return process.env.AZURE_OPENAI_LOG_OUTPUT_PREVIEW === "true";
}

function textPreview(text: string, maxLength = AI_OUTPUT_PREVIEW_CHARS): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function summarizeContentPart(part: unknown, index: number) {
  if (!isRecord(part)) {
    return { index, type: typeof part };
  }

  const text = getStringField(part, "text");
  const refusal = getStringField(part, "refusal");
  const annotations = part.annotations;

  return {
    index,
    type: getStringField(part, "type"),
    textLength: text?.length,
    refusal: refusal ? textPreview(refusal, 300) : undefined,
    annotationCount: Array.isArray(annotations) ? annotations.length : undefined,
  };
}

function summarizeOutputItem(item: unknown, index: number) {
  if (!isRecord(item)) {
    return { index, type: typeof item };
  }

  const content = item.content;

  return {
    index,
    id: getStringField(item, "id"),
    type: getStringField(item, "type"),
    status: getStringField(item, "status"),
    role: getStringField(item, "role"),
    content:
      Array.isArray(content) ? content.map((part, partIndex) => summarizeContentPart(part, partIndex)) : undefined,
  };
}

function collectDiagnosticFields(
  value: unknown,
  path = "$",
  depth = 0,
  fields: Record<string, unknown> = {}
): Record<string, unknown> {
  if (depth > 6 || !isRecord(value)) {
    return fields;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (["text", "output_text", "input", "instructions"].includes(lowerKey)) {
      continue;
    }

    const nextPath = `${path}.${key}`;
    const isDiagnosticKey = /(filter|safety|refusal|incomplete|blocked|severity|category|error|status|finish)/i.test(
      key
    );

    if (isDiagnosticKey) {
      if (typeof nestedValue === "string") {
        fields[nextPath] = textPreview(nestedValue, 300);
      } else if (
        typeof nestedValue === "number" ||
        typeof nestedValue === "boolean" ||
        nestedValue === null ||
        nestedValue === undefined
      ) {
        fields[nextPath] = nestedValue;
      } else if (Array.isArray(nestedValue)) {
        fields[nextPath] = nestedValue.length;
      } else if (isRecord(nestedValue)) {
        fields[nextPath] = Object.keys(nestedValue).sort();
      }
    }

    if (isRecord(nestedValue)) {
      collectDiagnosticFields(nestedValue, nextPath, depth + 1, fields);
    } else if (Array.isArray(nestedValue)) {
      nestedValue.slice(0, 10).forEach((item, index) => {
        collectDiagnosticFields(item, `${nextPath}[${index}]`, depth + 1, fields);
      });
    }
  }

  return fields;
}

interface AIResponseRequestIds {
  openAIRequestId: string | null;
  azureApimRequestId: string | null;
  azureRequestId: string | null;
}

function getAIResponseDiagnostics(completion: AIResponseStatus, requestIds: AIResponseRequestIds) {
  const includeOutputPreview = shouldLogAIOutputPreview();

  return {
    requestIds,
    responseId: completion.id,
    model: completion.model,
    status: completion.status,
    incompleteReason: completion.incomplete_details?.reason,
    responseError: completion.error,
    usage: completion.usage,
    outputLength: completion.output_text.length,
    outputPreview: includeOutputPreview ? textPreview(completion.output_text) : undefined,
    outputTail: includeOutputPreview ? textPreview(completion.output_text.slice(-AI_OUTPUT_PREVIEW_CHARS)) : undefined,
    outputItems: completion.output?.map((item, index) => summarizeOutputItem(item, index)),
    topLevelResponseKeys: Object.keys(completion).sort(),
    diagnosticFields: collectDiagnosticFields(completion),
  };
}

function getSourceDiagnostics(sourceResult: { text: string; source: string }, videoId: string) {
  const lines = sourceResult.text.split("\n").filter((line) => line.trim().length > 0);

  return {
    videoId,
    source: sourceResult.source,
    sourceLength: sourceResult.text.length,
    sourceLineCount: lines.length,
    trackLikeLineCount: lines.filter((line) => TRACK_LINE_PATTERN.test(line)).length,
  };
}

// --- Main function ---
export async function extractTracklist(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const rateLimit = checkRateLimit(request);
    if (!rateLimit.allowed) {
      if ("missingClient" in rateLimit) {
        return jsonResponse(400, { error: "Could not identify the client for rate limiting." });
      }

      return jsonResponse(
        429,
        {
          error: "Too many requests. Please wait before trying again.",
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        { "Retry-After": rateLimit.retryAfterSeconds.toString() }
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "Invalid JSON body." });
    }

    const parseResult = RequestSchema.safeParse(body);
    if (!parseResult.success) {
      return jsonResponse(400, { error: "Invalid request. Provide a valid youtubeUrl." });
    }

    const { youtubeUrl } = parseResult.data;

    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) {
      return jsonResponse(400, { error: "Could not extract video ID from URL." });
    }

    const cachedBody = getCachedTracklist(videoId);
    if (cachedBody) {
      return jsonResponse(200, cachedBody);
    }

    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      return jsonResponse(502, { error: "YouTube API key not configured." });
    }

    const metadata = await fetchVideoMetadata(videoId, apiKey);
    if (!metadata) {
      return jsonResponse(404, { error: "Video not found." });
    }

    const sourceResult = pickDescriptionSourceText(metadata.description);
    if (!sourceResult) {
      return jsonResponse(404, { error: "No tracklist found in video description." });
    }

    const foundryConfig = getFoundryConfig();
    if (!foundryConfig.baseUrl || !foundryConfig.apiKey || !foundryConfig.model) {
      return jsonResponse(502, { error: "Azure AI Foundry configuration is incomplete." });
    }

    const openaiClient = new OpenAI({
      baseURL: foundryConfig.baseUrl,
      apiKey: foundryConfig.apiKey,
    });

    const { data: completion, response, request_id: requestId } = await openaiClient.responses
      .create({
        model: foundryConfig.model,
        instructions: SYSTEM_PROMPT,
        input: `SOURCE: ${sourceResult.source}\n\n${trimSourceText(sourceResult.text)}`,
        max_output_tokens: getPositiveIntegerEnv("AZURE_OPENAI_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS),
        text: { format: TRACK_RESPONSE_FORMAT },
        temperature: 0,
      })
      .withResponse();
    const aiResponseRequestIds = {
      openAIRequestId: requestId,
      azureApimRequestId: response.headers.get("apim-request-id"),
      azureRequestId: response.headers.get("x-ms-request-id"),
    };

    const statusError = getResponseStatusError(completion);
    if (statusError) {
      context.warn("Azure AI Foundry response did not complete.", {
        aiResponse: getAIResponseDiagnostics(completion, aiResponseRequestIds),
        selectedSource: getSourceDiagnostics(sourceResult, videoId),
      });
      return jsonResponse(502, { error: statusError });
    }

    const rawContent = completion.output_text;
    if (!rawContent) {
      return jsonResponse(502, { error: "No response from AI model." });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch (error) {
      context.error("Azure AI Foundry returned invalid JSON.", {
        parseError: error instanceof Error ? error.message : String(error),
        aiResponse: getAIResponseDiagnostics(completion, aiResponseRequestIds),
        selectedSource: getSourceDiagnostics(sourceResult, videoId),
      });
      return jsonResponse(502, { error: "AI model returned an invalid tracklist response." });
    }

    const validated = LLMResponseSchema.safeParse(parsed);

    if (!validated.success || validated.data.tracks.length === 0) {
      return jsonResponse(404, { error: "No tracklist could be extracted from the video." });
    }

    const responseBody = {
      videoId,
      videoTitle: metadata.title,
      channelTitle: metadata.channelTitle,
      source: sourceResult.source,
      confidence: validated.data.confidence,
      tracks: validated.data.tracks,
    };
    setCachedTracklist(videoId, responseBody);
    return jsonResponse(200, responseBody);
  } catch (error) {
    context.error("extract-tracklist error:", error);
    return jsonResponse(502, { error: "An upstream service error occurred." });
  }
}

app.http("extract-tracklist", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "extract-tracklist",
  handler: extractTracklist,
});
