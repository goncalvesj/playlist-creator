import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import OpenAI from "openai";
import { z } from "zod";

const OPENAI_V1_PATH = "v1";
const AI_MAX_OUTPUT_TOKENS = 4096;
const AI_OUTPUT_PREVIEW_CHARS = 800;

// --- Request validation ---
const RequestSchema = z.object({
  youtubeUrl: z.string().url(),
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

const JSON_HEADERS = { "Content-Type": "application/json" };

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
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return {
        status: 400,
        headers: JSON_HEADERS,
        jsonBody: { error: "Invalid JSON body." },
      };
    }

    const parseResult = RequestSchema.safeParse(body);
    if (!parseResult.success) {
      return {
        status: 400,
        headers: JSON_HEADERS,
        jsonBody: { error: "Invalid request. Provide a valid youtubeUrl." },
      };
    }

    const { youtubeUrl } = parseResult.data;

    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) {
      return {
        status: 400,
        headers: JSON_HEADERS,
        jsonBody: { error: "Could not extract video ID from URL." },
      };
    }

    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      return {
        status: 502,
        headers: JSON_HEADERS,
        jsonBody: { error: "YouTube API key not configured." },
      };
    }

    const metadata = await fetchVideoMetadata(videoId, apiKey);
    if (!metadata) {
      return {
        status: 404,
        headers: JSON_HEADERS,
        jsonBody: { error: "Video not found." },
      };
    }

    const sourceResult = pickDescriptionSourceText(metadata.description);
    if (!sourceResult) {
      return {
        status: 404,
        headers: JSON_HEADERS,
        jsonBody: { error: "No tracklist found in video description." },
      };
    }

    const foundryConfig = getFoundryConfig();
    if (!foundryConfig.baseUrl || !foundryConfig.apiKey || !foundryConfig.model) {
      return {
        status: 502,
        headers: JSON_HEADERS,
        jsonBody: { error: "Azure AI Foundry configuration is incomplete." },
      };
    }

    const openaiClient = new OpenAI({
      baseURL: foundryConfig.baseUrl,
      apiKey: foundryConfig.apiKey,
    });

    const { data: completion, response, request_id: requestId } = await openaiClient.responses
      .create({
        model: foundryConfig.model,
        instructions: SYSTEM_PROMPT,
        input: `SOURCE: ${sourceResult.source}\n\n${sourceResult.text}`,
        max_output_tokens: AI_MAX_OUTPUT_TOKENS,
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
      return {
        status: 502,
        headers: JSON_HEADERS,
        jsonBody: { error: statusError },
      };
    }

    const rawContent = completion.output_text;
    if (!rawContent) {
      return {
        status: 502,
        headers: JSON_HEADERS,
        jsonBody: { error: "No response from AI model." },
      };
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
      return {
        status: 502,
        headers: JSON_HEADERS,
        jsonBody: { error: "AI model returned an invalid tracklist response." },
      };
    }

    const validated = LLMResponseSchema.safeParse(parsed);

    if (!validated.success || validated.data.tracks.length === 0) {
      return {
        status: 404,
        headers: JSON_HEADERS,
        jsonBody: { error: "No tracklist could be extracted from the video." },
      };
    }

    return {
      status: 200,
      headers: JSON_HEADERS,
      jsonBody: {
        videoId,
        videoTitle: metadata.title,
        channelTitle: metadata.channelTitle,
        source: sourceResult.source,
        confidence: validated.data.confidence,
        tracks: validated.data.tracks,
      },
    };
  } catch (error) {
    context.error("extract-tracklist error:", error);
    return {
      status: 502,
      headers: JSON_HEADERS,
      jsonBody: { error: "An upstream service error occurred." },
    };
  }
}

app.http("extract-tracklist", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "extract-tracklist",
  handler: extractTracklist,
});
