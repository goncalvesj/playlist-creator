import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { z } from "zod";
import { extractTracks } from "../ai";
import { checkRateLimit } from "../rateLimit";
import {
  correlationProperties,
  durationMs,
  getErrorCategory,
  getErrorStatusCode,
  getRequestCorrelation,
  hashIdentifier,
  trackDependency,
  trackEvent,
  trackException,
} from "../telemetry";
import { getCachedTracklist, setCachedTracklist } from "../tracklistCache";
import { extractVideoId, fetchVideoMetadata, pickDescriptionSourceText } from "../youtube";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const RequestSchema = z.object({
  youtubeUrl: z.string().url().max(2048),
});

function jsonResponse(
  status: number,
  jsonBody: unknown,
  headers: Record<string, string> = {}
): HttpResponseInit {
  return {
    status,
    headers: { ...JSON_HEADERS, ...headers },
    jsonBody,
  };
}

export async function extractTracklist(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const startedAt = Date.now();
  const correlation = getRequestCorrelation(request);
  const baseTelemetryProperties = {
    ...correlationProperties(correlation),
    operation: "extract_tracklist",
    route: "POST /api/extract-tracklist",
  };
  const responseHeaders = { "x-correlation-id": correlation.correlationId };
  const respond = (
    status: number,
    jsonBody: unknown,
    properties: Record<string, string> = {},
    measurements: Record<string, number> = {},
    headers: Record<string, string> = {}
  ) => {
    const success = status < 400;
    trackEvent(
      success ? "extract_tracklist_request_completed" : "extract_tracklist_request_failed",
      {
        ...baseTelemetryProperties,
        ...properties,
        resultCategory: properties.resultCategory ?? (success ? "success" : "request_failed"),
        statusCode: String(status),
      },
      {
        durationMs: durationMs(startedAt),
        ...measurements,
      }
    );

    return jsonResponse(status, jsonBody, { ...responseHeaders, ...headers });
  };

  trackEvent("extract_tracklist_request_started", baseTelemetryProperties);

  try {
    const rateLimit = checkRateLimit(request);
    if (!rateLimit.allowed) {
      if (rateLimit.reason === "missing-client") {
        return respond(400, { error: "Could not identify the client for rate limiting." }, {
          resultCategory: "client_identification_failed",
        });
      }

      trackEvent("api_rate_limited", {
        ...baseTelemetryProperties,
        resultCategory: "rate_limited",
      });

      return respond(
        429,
        {
          error: "Too many requests. Please wait before trying again.",
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        { resultCategory: "rate_limited" },
        { retryAfterSeconds: rateLimit.retryAfterSeconds },
        { "Retry-After": rateLimit.retryAfterSeconds.toString() }
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return respond(400, { error: "Invalid JSON body." }, { resultCategory: "invalid_json" });
    }

    const parseResult = RequestSchema.safeParse(body);
    if (!parseResult.success) {
      return respond(400, { error: "Invalid request. Provide a valid youtubeUrl." }, {
        resultCategory: "invalid_request",
      });
    }

    const { youtubeUrl } = parseResult.data;

    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) {
      return respond(400, { error: "Could not extract video ID from URL." }, {
        resultCategory: "invalid_video_url",
      });
    }
    const videoIdHash = hashIdentifier(videoId);

    const cachedBody = getCachedTracklist(videoId);
    if (cachedBody) {
      trackEvent("tracklist_cache_hit", {
        ...baseTelemetryProperties,
        resultCategory: "cache_hit",
        videoIdHash,
      });
      return respond(200, cachedBody, { cacheHit: "true", resultCategory: "success", videoIdHash });
    }

    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      return respond(503, { error: "The service is temporarily unavailable. Please try again later." }, {
        resultCategory: "configuration_error",
        videoIdHash,
      });
    }

    const youtubeDependencyStartedAt = Date.now();
    let metadata;
    try {
      metadata = await fetchVideoMetadata(videoId, apiKey);
      trackDependency({
        name: "YouTube Data API videos.list",
        target: "youtube.googleapis.com",
        dependencyTypeName: "YouTube Data API",
        data: "GET /youtube/v3/videos",
        startedAt: youtubeDependencyStartedAt,
        success: true,
        resultCode: 200,
        properties: {
          ...baseTelemetryProperties,
          videoIdHash,
        },
      });
    } catch (error) {
      const statusCode = getErrorStatusCode(error);
      trackDependency({
        name: "YouTube Data API videos.list",
        target: "youtube.googleapis.com",
        dependencyTypeName: "YouTube Data API",
        data: "GET /youtube/v3/videos",
        startedAt: youtubeDependencyStartedAt,
        success: false,
        resultCode: statusCode,
        properties: {
          ...baseTelemetryProperties,
          errorCategory: getErrorCategory(error),
          videoIdHash,
        },
      });
      throw error;
    }

    if (!metadata) {
      return respond(404, { error: "Video not found." }, {
        resultCategory: "video_not_found",
        videoIdHash,
      });
    }

    const sourceResult = pickDescriptionSourceText(metadata.description);
    if (!sourceResult) {
      return respond(404, { error: "No tracklist found in video description." }, {
        resultCategory: "tracklist_not_found",
        videoIdHash,
      });
    }

    const extraction = await extractTracks(sourceResult, videoId, context);
    if (extraction.kind === "unprocessable") {
      return respond(422, { error: extraction.error }, {
        resultCategory: "ai_unprocessable",
        videoIdHash,
      });
    }
    if (extraction.kind === "upstream-error") {
      return respond(502, { error: extraction.error }, {
        resultCategory: "ai_upstream_error",
        videoIdHash,
      });
    }

    if (extraction.kind === "no-tracks") {
      return respond(404, { error: "No tracklist could be extracted from the video." }, {
        resultCategory: "no_tracks",
        videoIdHash,
      });
    }

    const responseBody = {
      videoId,
      videoTitle: metadata.title,
      channelTitle: metadata.channelTitle,
      source: sourceResult.source,
      confidence: extraction.confidence,
      tracks: extraction.tracks,
    };
    setCachedTracklist(videoId, responseBody);
    return respond(
      200,
      responseBody,
      {
        confidence: extraction.confidence,
        resultCategory: "success",
        source: sourceResult.source,
        videoIdHash,
      },
      { trackCount: extraction.tracks.length }
    );
  } catch (error) {
    context.error("extract-tracklist error:", error);
    trackException(error, baseTelemetryProperties);
    return respond(502, { error: "We couldn't process this video right now. Please try again." }, {
      errorCategory: getErrorCategory(error),
      resultCategory: "unhandled_exception",
    });
  }
}

app.http("extract-tracklist", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "extract-tracklist",
  handler: extractTracklist,
});
