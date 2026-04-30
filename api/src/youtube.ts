export interface DescriptionSourceText {
  text: string;
  source: "description";
}

interface YouTubeVideoListResponse {
  items?: Array<{
    snippet?: {
      title?: string;
      channelTitle?: string;
      description?: string;
    };
  }>;
}

export interface YouTubeVideoMetadata {
  title: string;
  channelTitle: string;
  description: string;
}

const TRACK_LINE_PATTERN = /(\d{1,2}:\d{2})|(\s[-–]\s)/;
const YOUTUBE_HOSTNAMES = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

function isYouTubeHostname(hostname: string): boolean {
  return YOUTUBE_HOSTNAMES.has(hostname.toLowerCase());
}

export function extractVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);

    if (isYouTubeHostname(parsed.hostname) && parsed.pathname === "/watch") {
      return parsed.searchParams.get("v");
    }

    if (parsed.hostname === "youtu.be") {
      return parsed.pathname.slice(1) || null;
    }

    const match = parsed.pathname.match(/^\/(shorts|live)\/([^/?]+)/);
    if (isYouTubeHostname(parsed.hostname) && match) {
      return match[2];
    }

    return null;
  } catch {
    return null;
  }
}

export async function fetchVideoMetadata(
  videoId: string,
  apiKey: string
): Promise<YouTubeVideoMetadata | null> {
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

function looksLikeTracklist(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const trackLines = lines.filter((l) => TRACK_LINE_PATTERN.test(l));
  return trackLines.length >= 3;
}

export function pickDescriptionSourceText(description: string): DescriptionSourceText | null {
  if (looksLikeTracklist(description)) {
    return { text: description, source: "description" };
  }

  return null;
}

export function getSourceDiagnostics(sourceResult: { text: string; source: string }, videoId: string) {
  const lines = sourceResult.text.split("\n").filter((line) => line.trim().length > 0);

  return {
    videoId,
    source: sourceResult.source,
    sourceLength: sourceResult.text.length,
    sourceLineCount: lines.length,
    trackLikeLineCount: lines.filter((line) => TRACK_LINE_PATTERN.test(line)).length,
  };
}
