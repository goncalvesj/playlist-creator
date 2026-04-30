import { createCorrelationId, getErrorCategory, trackEvent } from '../telemetry/appInsights';

export interface ExtractedTrack {
  artist: string;
  title: string;
  timestamp: string | null;
}

export interface ExtractTracklistResponse {
  videoId: string;
  videoTitle: string;
  channelTitle: string;
  source: 'description';
  confidence: 'high' | 'medium' | 'low';
  tracks: ExtractedTrack[];
}

function getFailureCategory(status: number): string {
  if (status === 400) return 'invalid_request';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'request_failed';
}

export async function extractTracklist(youtubeUrl: string): Promise<ExtractTracklistResponse> {
  const correlationId = createCorrelationId();
  const startedAt = performance.now();
  trackEvent('tracklist_extraction_started', {
    correlationId,
    operation: 'extract_tracklist',
  });

  const res = await fetch('/api/extract-tracklist', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-request-id': correlationId,
    },
    body: JSON.stringify({ youtubeUrl }),
  });
  const responseCorrelationId = res.headers.get('x-correlation-id') ?? correlationId;
  const durationMs = performance.now() - startedAt;

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Unknown error' }));
    const message = error.error || `Request failed with status ${res.status}`;
    trackEvent(
      'tracklist_extraction_failed',
      {
        correlationId: responseCorrelationId,
        errorCategory: getErrorCategory({ status: res.status }),
        operation: 'extract_tracklist',
        resultCategory: getFailureCategory(res.status),
        statusCode: String(res.status),
      },
      { durationMs }
    );
    throw new Error(message);
  }

  const data = (await res.json()) as ExtractTracklistResponse;
  trackEvent(
    'tracklist_extraction_completed',
    {
      correlationId: responseCorrelationId,
      confidence: data.confidence,
      hasTracks: String(data.tracks.length > 0),
      operation: 'extract_tracklist',
      source: data.source,
      statusCode: String(res.status),
    },
    {
      durationMs,
      trackCount: data.tracks.length,
    }
  );
  return data;
}
