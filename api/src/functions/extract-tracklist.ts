import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { z } from "zod";
import { extractTracks } from "../ai";
import { checkRateLimit } from "../rateLimit";
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
  try {
    const rateLimit = checkRateLimit(request);
    if (!rateLimit.allowed) {
      if (rateLimit.reason === "missing-client") {
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

    const extraction = await extractTracks(sourceResult, videoId, context);
    if (extraction.kind === "upstream-error") {
      return jsonResponse(502, { error: extraction.error });
    }

    if (extraction.kind === "no-tracks") {
      return jsonResponse(404, { error: "No tracklist could be extracted from the video." });
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
