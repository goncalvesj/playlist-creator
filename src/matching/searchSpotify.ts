import { SpotifyApi, type Track } from '@spotify/web-api-ts-sdk';
import { scoreMatch, getMatchStatus, type MatchStatus } from './scoreMatch';
import pLimit from 'p-limit';

export interface MatchedTrack {
  extractedArtist: string;
  extractedTitle: string;
  timestamp: string | null;
  spotifyTrack: Track | null;
  alternates: Track[];
  score: number;
  status: MatchStatus;
  selected: boolean;
}

function stripParentheticals(str: string): string {
  return str.replace(/\s*\(.*?\)\s*/g, ' ').trim();
}

async function searchForTrack(
  sdk: SpotifyApi,
  artist: string,
  title: string
): Promise<{ tracks: Track[]; bestScore: number }> {
  // Primary query with field filters
  let results = await sdk.search(`track:"${title}" artist:"${artist}"`, ['track'], undefined, 5);
  let items = results.tracks?.items ?? [];

  // Retry with stripped parentheticals
  if (items.length === 0) {
    const strippedTitle = stripParentheticals(title);
    if (strippedTitle !== title) {
      results = await sdk.search(
        `track:"${strippedTitle}" artist:"${artist}"`,
        ['track'],
        undefined,
        5
      );
      items = results.tracks?.items ?? [];
    }
  }

  // Fallback: plain text query
  if (items.length === 0) {
    results = await sdk.search(`${artist} ${title}`, ['track'], undefined, 5);
    items = results.tracks?.items ?? [];
  }

  if (items.length === 0) {
    return { tracks: [], bestScore: 0 };
  }

  // Score all candidates
  const scored = items.map((track) => {
    const candidateArtist = track.artists.map((a) => a.name).join(' & ');
    const { score } = scoreMatch(artist, title, candidateArtist, track.name);
    return { track, score };
  });

  scored.sort((a, b) => b.score - a.score);

  return {
    tracks: scored.map((s) => s.track),
    bestScore: scored[0]?.score ?? 0,
  };
}

export async function matchAllTracks(
  sdk: SpotifyApi,
  extractedTracks: Array<{ artist: string; title: string; timestamp: string | null }>,
  onProgress?: (completed: number, total: number) => void
): Promise<MatchedTrack[]> {
  const limit = pLimit(5);
  let completed = 0;

  const promises = extractedTracks.map((track) =>
    limit(async (): Promise<MatchedTrack> => {
      try {
        const { tracks, bestScore } = await searchForTrack(sdk, track.artist, track.title);
        const status = getMatchStatus(bestScore);

        completed++;
        onProgress?.(completed, extractedTracks.length);

        return {
          extractedArtist: track.artist,
          extractedTitle: track.title,
          timestamp: track.timestamp,
          spotifyTrack: tracks[0] ?? null,
          alternates: tracks.slice(1),
          score: bestScore,
          status,
          selected: status !== 'not_found',
        };
      } catch {
        completed++;
        onProgress?.(completed, extractedTracks.length);

        return {
          extractedArtist: track.artist,
          extractedTitle: track.title,
          timestamp: track.timestamp,
          spotifyTrack: null,
          alternates: [],
          score: 0,
          status: 'not_found',
          selected: false,
        };
      }
    })
  );

  return Promise.all(promises);
}
