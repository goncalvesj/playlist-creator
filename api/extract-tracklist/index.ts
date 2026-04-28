import { AzureFunction, Context, HttpRequest } from "@azure/functions";
import { AzureOpenAI } from "openai";
import { z } from "zod";

const DEFAULT_OPENAI_API_VERSION = "v1";

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
      channelId?: string;
    };
  }>;
}

async function fetchVideoMetadata(videoId: string, apiKey: string) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API error: ${res.status}`);
  const data = (await res.json()) as YouTubeVideoListResponse;
  const snippet = data.items?.[0]?.snippet;
  if (!snippet?.title || !snippet.channelTitle || !snippet.channelId) return null;
  return {
    title: snippet.title,
    channelTitle: snippet.channelTitle,
    description: snippet.description ?? "",
    channelId: snippet.channelId,
  };
}

interface YouTubeCommentThreadListResponse {
  items?: Array<{
    snippet?: {
      topLevelComment?: {
        snippet?: {
          textOriginal?: string;
          authorChannelId?: { value?: string };
          likeCount?: number;
        };
      };
    };
  }>;
}

async function fetchTopComments(videoId: string, apiKey: string) {
  const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&order=relevance&maxResults=20&key=${apiKey}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as YouTubeCommentThreadListResponse;
    return (data.items ?? [])
      .map((item): Comment | null => {
        const snippet = item.snippet?.topLevelComment?.snippet;
        if (!snippet?.textOriginal) return null;
        return {
          text: snippet.textOriginal,
          authorChannelId: snippet.authorChannelId?.value,
          likeCount: snippet.likeCount ?? 0,
        };
      })
      .filter((comment): comment is Comment => comment !== null);
  } catch {
    return [];
  }
}

// --- Source text selection ---
const TRACK_LINE_PATTERN = /(\d{1,2}:\d{2})|(\s[-–]\s)/;

function looksLikeTracklist(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const trackLines = lines.filter((l) => TRACK_LINE_PATTERN.test(l));
  return trackLines.length >= 3;
}

interface Comment {
  text: string;
  authorChannelId?: string;
  likeCount: number;
}

function pickSourceText(
  description: string,
  comments: Comment[],
  videoChannelId: string
): { text: string; source: "description" | "pinned_comment" | "top_comment" } | null {
  if (looksLikeTracklist(description)) {
    return { text: description, source: "description" };
  }

  const authorComments = comments.filter((c) => c.authorChannelId === videoChannelId);
  for (const comment of authorComments) {
    if (looksLikeTracklist(comment.text)) {
      return { text: comment.text, source: "pinned_comment" };
    }
  }

  const sortedByLikes = [...comments].sort((a, b) => b.likeCount - a.likeCount);
  for (const comment of sortedByLikes) {
    if (looksLikeTracklist(comment.text)) {
      return { text: comment.text, source: "top_comment" };
    }
  }

  return null;
}

// --- LLM prompt & schema ---
const SYSTEM_PROMPT = `You extract DJ set tracklists from YouTube video text (description or comment).
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
  const trimmed = targetUri.trim().replace(/\/+$/, "");
  const withoutResponses = trimmed.endsWith("/responses")
    ? trimmed.slice(0, -"/responses".length)
    : trimmed;

  if (/\/openai\/v\d+$/i.test(withoutResponses)) {
    return `${withoutResponses}/`;
  }

  return `${withoutResponses}/openai/${DEFAULT_OPENAI_API_VERSION}/`;
}

function getFoundryConfig() {
  const targetUri =
    process.env.AZURE_OPENAI_TARGET_URI ||
    process.env.AZURE_OPENAI_BASE_URL ||
    process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const model = process.env.AZURE_OPENAI_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || DEFAULT_OPENAI_API_VERSION;

  return {
    apiKey,
    apiVersion,
    baseUrl: targetUri ? normalizeOpenAIBaseUrl(targetUri) : undefined,
    model,
  };
}

// --- Main function ---
const httpTrigger: AzureFunction = async function (
  context: Context,
  req: HttpRequest
): Promise<void> {
  try {
    const parseResult = RequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Invalid request. Provide a valid youtubeUrl." },
      };
      return;
    }

    const { youtubeUrl } = parseResult.data;

    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Could not extract video ID from URL." },
      };
      return;
    }

    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      context.res = {
        status: 502,
        headers: { "Content-Type": "application/json" },
        body: { error: "YouTube API key not configured." },
      };
      return;
    }

    // Fetch video metadata
    const metadata = await fetchVideoMetadata(videoId, apiKey);
    if (!metadata) {
      context.res = {
        status: 404,
        headers: { "Content-Type": "application/json" },
        body: { error: "Video not found." },
      };
      return;
    }

    // Fetch comments
    const comments = await fetchTopComments(videoId, apiKey);

    // Pick source text
    const sourceResult = pickSourceText(metadata.description, comments, metadata.channelId);
    if (!sourceResult) {
      context.res = {
        status: 404,
        headers: { "Content-Type": "application/json" },
        body: { error: "No tracklist found in video description or comments." },
      };
      return;
    }

    const foundryConfig = getFoundryConfig();
    if (!foundryConfig.baseUrl || !foundryConfig.apiKey || !foundryConfig.model) {
      context.res = {
        status: 502,
        headers: { "Content-Type": "application/json" },
        body: { error: "Azure AI Foundry configuration is incomplete." },
      };
      return;
    }

    // Call Azure AI Foundry v1 Responses API
    const openaiClient = new AzureOpenAI({
      baseURL: foundryConfig.baseUrl,
      apiKey: foundryConfig.apiKey,
      apiVersion: foundryConfig.apiVersion,
    });

    const completion = await openaiClient.responses.create({
      model: foundryConfig.model,
      instructions: SYSTEM_PROMPT,
      input: `SOURCE: ${sourceResult.source}\n\n${sourceResult.text}`,
      text: { format: TRACK_RESPONSE_FORMAT },
      temperature: 0,
    });

    const rawContent = completion.output_text;
    if (!rawContent) {
      context.res = {
        status: 502,
        headers: { "Content-Type": "application/json" },
        body: { error: "No response from AI model." },
      };
      return;
    }

    // Parse and validate LLM response
    const parsed = JSON.parse(rawContent);
    const validated = LLMResponseSchema.safeParse(parsed);

    if (!validated.success || validated.data.tracks.length === 0) {
      context.res = {
        status: 404,
        headers: { "Content-Type": "application/json" },
        body: { error: "No tracklist could be extracted from the video." },
      };
      return;
    }

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        videoId,
        videoTitle: metadata.title,
        channelTitle: metadata.channelTitle,
        source: sourceResult.source,
        confidence: validated.data.confidence,
        tracks: validated.data.tracks,
      },
    };
  } catch (error) {
    context.log.error("extract-tracklist error:", error);
    context.res = {
      status: 502,
      headers: { "Content-Type": "application/json" },
      body: { error: "An upstream service error occurred." },
    };
  }
};

export default httpTrigger;
