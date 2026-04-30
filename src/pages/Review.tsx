import { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { matchAllTracks, type MatchedTrack } from '../matching/searchSpotify';
import { type ExtractTracklistResponse } from '../api/extractTracklist';
import TrackRow from '../components/TrackRow';
import {
  getErrorCategory,
  trackAsyncDependency,
  trackEvent,
  trackException,
} from '../telemetry/appInsights';

interface ReviewProps {
  sdk: SpotifyApi;
}

export default function Review({ sdk }: ReviewProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { tracklistData, youtubeUrl } = (location.state ?? {}) as {
    tracklistData: ExtractTracklistResponse;
    youtubeUrl: string;
  };

  const [tracks, setTracks] = useState<MatchedTrack[]>([]);
  const [isMatching, setIsMatching] = useState(true);
  const [matchProgress, setMatchProgress] = useState({ completed: 0, total: 0 });
  const [playlistName, setPlaylistName] = useState(tracklistData?.videoTitle ?? '');
  const [isPublic, setIsPublic] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tracklistData) return;
    matchAllTracks(sdk, tracklistData.tracks, (completed, total) => {
      setMatchProgress({ completed, total });
    })
      .then((matched) => {
        setTracks(matched);
        setIsMatching(false);
      })
      .catch((err: unknown) => {
        trackException(err, { operation: 'spotify_track_matching' });
        setError('Failed to match tracks on Spotify');
        setIsMatching(false);
      });
  }, [sdk, tracklistData]);

  const toggleTrack = useCallback((index: number) => {
    setTracks((prev) =>
      prev.map((t, i) => (i === index ? { ...t, selected: !t.selected } : t))
    );
  }, []);

  const createPlaylist = async () => {
    setIsCreating(true);
    setError(null);
    const uris = tracks
      .filter((t) => t.selected && t.spotifyTrack)
      .map((t) => t.spotifyTrack!.uri);
    const unmatchedTracks = tracks.filter((t) => !t.selected || !t.spotifyTrack);
    trackEvent(
      'playlist_creation_started',
      {
        isPublic: String(isPublic),
        operation: 'spotify_playlist_creation',
      },
      {
        selectedTrackCount: uris.length,
        unmatchedTrackCount: unmatchedTracks.length,
      }
    );

    try {
      const profile = await trackAsyncDependency(
        {
          name: 'Spotify current user profile',
          target: 'api.spotify.com',
          type: 'Spotify',
          data: 'GET /v1/me',
          properties: { operation: 'spotify_playlist_creation' },
        },
        () => sdk.currentUser.profile()
      );

      const playlist = await trackAsyncDependency(
        {
          name: 'Spotify create playlist',
          target: 'api.spotify.com',
          type: 'Spotify',
          data: 'POST /v1/users/{user_id}/playlists',
          properties: {
            isPublic: String(isPublic),
            operation: 'spotify_playlist_creation',
          },
        },
        () =>
          sdk.playlists.createPlaylist(profile.id, {
            name: playlistName,
            public: isPublic,
            description: `Source: ${youtubeUrl}`,
          })
      );

      // Add tracks in batches of 100
      for (let i = 0; i < uris.length; i += 100) {
        const batch = uris.slice(i, i + 100);
        await trackAsyncDependency(
          {
            name: 'Spotify add playlist items',
            target: 'api.spotify.com',
            type: 'Spotify',
            data: 'POST /v1/playlists/{playlist_id}/tracks',
            properties: {
              batchIndex: String(i / 100 + 1),
              operation: 'spotify_playlist_creation',
            },
            measurements: { batchSize: batch.length },
          },
          () => sdk.playlists.addItemsToPlaylist(playlist.id, batch)
        );
      }

      trackEvent(
        'playlist_creation_completed',
        {
          isPublic: String(isPublic),
          operation: 'spotify_playlist_creation',
        },
        {
          addedTrackCount: uris.length,
          unmatchedTrackCount: unmatchedTracks.length,
        }
      );
      navigate('/done', {
        state: {
          playlistUrl: playlist.external_urls.spotify,
          playlistName,
          addedCount: uris.length,
          unmatchedTracks,
        },
      });
    } catch (err) {
      trackEvent(
        'playlist_creation_failed',
        {
          errorCategory: getErrorCategory(err),
          isPublic: String(isPublic),
          operation: 'spotify_playlist_creation',
        },
        {
          selectedTrackCount: uris.length,
          unmatchedTrackCount: unmatchedTracks.length,
        }
      );
      trackException(err, { operation: 'spotify_playlist_creation' });
      setError(err instanceof Error ? err.message : 'Failed to create playlist');
    } finally {
      setIsCreating(false);
    }
  };

  if (!tracklistData) {
    navigate('/');
    return null;
  }

  const selectedCount = tracks.filter((t) => t.selected && t.spotifyTrack).length;
  const autoCount = tracks.filter((t) => t.status === 'auto').length;
  const reviewCount = tracks.filter((t) => t.status === 'review').length;
  const notFoundCount = tracks.filter((t) => t.status === 'not_found').length;

  return (
    <div className="min-h-screen bg-gray-950 text-white p-4">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-2xl font-bold">Review Tracklist</h1>
          <div className="text-sm text-gray-400">
            Source:{' '}
            <span className="text-gray-300">{tracklistData.source.replace('_', ' ')}</span>
            {' · '}
            Confidence:{' '}
            <span
              className={
                tracklistData.confidence === 'high'
                  ? 'text-green-400'
                  : tracklistData.confidence === 'medium'
                    ? 'text-yellow-400'
                    : 'text-red-400'
              }
            >
              {tracklistData.confidence}
            </span>
          </div>
        </div>

        {/* Playlist settings */}
        <div className="bg-gray-900 rounded-lg p-4 space-y-3">
          <div className="flex gap-4 items-end flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Playlist name
              </label>
              <input
                type="text"
                value={playlistName}
                onChange={(e) => setPlaylistName(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer pb-2">
              <input
                type="checkbox"
                checked={isPublic}
                onChange={(e) => setIsPublic(e.target.checked)}
                className="rounded"
              />
              <span className="text-sm text-gray-300">Public</span>
            </label>
          </div>
        </div>

        {/* Status summary */}
        {!isMatching && (
          <div className="flex gap-4 text-sm flex-wrap">
            <span className="text-green-400">✅ {autoCount} auto-matched</span>
            <span className="text-yellow-400">⚠️ {reviewCount} needs review</span>
            <span className="text-red-400">❌ {notFoundCount} not found</span>
            <span className="text-gray-400 ml-auto">{selectedCount} selected</span>
          </div>
        )}

        {/* Progress bar while matching */}
        {isMatching && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm text-gray-400">
              <span>Searching Spotify…</span>
              <span>
                {matchProgress.completed}/{matchProgress.total}
              </span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-2">
              <div
                className="bg-green-500 h-2 rounded-full transition-all"
                style={{
                  width: `${matchProgress.total ? (matchProgress.completed / matchProgress.total) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Track table */}
        <div className="bg-gray-900 rounded-lg overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-sm text-gray-400 border-b border-gray-800">
                <th className="p-3 w-8">#</th>
                <th className="p-3">Extracted</th>
                <th className="p-3">Spotify Match</th>
                <th className="p-3 w-20 text-center">Score</th>
                <th className="p-3 w-20 text-center">Status</th>
                <th className="p-3 w-16 text-center">Use</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((track, index) => (
                <TrackRow
                  key={index}
                  index={index}
                  track={track}
                  onToggle={() => toggleTrack(index)}
                />
              ))}
            </tbody>
          </table>
          {isMatching && tracks.length === 0 && (
            <div className="p-8 text-center text-gray-500">Loading tracks…</div>
          )}
        </div>

        {/* Create playlist button */}
        {!isMatching && (
          <div className="flex justify-end gap-4">
            <button
              onClick={() => navigate('/')}
              className="text-gray-400 hover:text-white transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={createPlaylist}
              disabled={isCreating || selectedCount === 0}
              className="bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold py-3 px-8 rounded-lg transition cursor-pointer disabled:cursor-not-allowed"
            >
              {isCreating ? 'Creating…' : `Create playlist (${selectedCount} tracks)`}
            </button>
          </div>
        )}

        {error && (
          <div className="bg-red-900/50 border border-red-700 rounded-lg p-4 text-red-200">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
