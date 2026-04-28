export interface ExtractedTrack {
  artist: string;
  title: string;
  timestamp: string | null;
}

export interface ExtractTracklistResponse {
  videoId: string;
  videoTitle: string;
  channelTitle: string;
  source: 'description' | 'pinned_comment' | 'top_comment';
  confidence: 'high' | 'medium' | 'low';
  tracks: ExtractedTrack[];
}

export async function extractTracklist(youtubeUrl: string): Promise<ExtractTracklistResponse> {
  const res = await fetch('/api/extract-tracklist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ youtubeUrl }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Request failed with status ${res.status}`);
  }

  return res.json();
}
