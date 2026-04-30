import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { type MatchedTrack } from '../matching/searchSpotify';
import { trackEvent } from '../telemetry/appInsights';

export default function Done() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state ?? {}) as {
    playlistUrl: string;
    playlistName: string;
    addedCount: number;
    unmatchedTracks: MatchedTrack[];
  };
  const unmatchedTrackCount = state.unmatchedTracks?.length ?? 0;

  useEffect(() => {
    if (!state.playlistUrl) return;

    trackEvent(
      'playlist_result_viewed',
      { operation: 'spotify_playlist_creation' },
      {
        addedTrackCount: state.addedCount,
        unmatchedTrackCount,
      }
    );
  }, [state.addedCount, state.playlistUrl, unmatchedTrackCount]);

  if (!state.playlistUrl) {
    navigate('/');
    return null;
  }

  const { playlistUrl, playlistName, addedCount, unmatchedTracks } = state;

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4">
      <div className="max-w-xl w-full space-y-8">
        <div className="text-center space-y-4">
          <div className="text-6xl">🎉</div>
          <h1 className="text-3xl font-bold">Playlist Created!</h1>
          <p className="text-gray-400">
            <strong className="text-white">{playlistName}</strong> — {addedCount} tracks added
          </p>
          <a
            href={playlistUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block bg-green-600 hover:bg-green-500 text-white font-semibold py-3 px-8 rounded-lg transition"
          >
            Open in Spotify
          </a>
        </div>

        {unmatchedTracks.length > 0 && (
          <div className="bg-gray-900 rounded-lg p-4 space-y-3">
            <h2 className="text-lg font-semibold text-yellow-400">
              ⚠️ {unmatchedTracks.length} unmatched tracks
            </h2>
            <p className="text-sm text-gray-400">
              These tracks couldn't be found on Spotify. You can search and add them manually.
            </p>
            <ul className="space-y-1">
              {unmatchedTracks.map((track, i) => (
                <li key={i} className="text-sm text-gray-300">
                  {track.extractedArtist} — {track.extractedTitle}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="text-center">
          <button
            onClick={() => navigate('/')}
            className="text-gray-400 hover:text-white transition underline cursor-pointer"
          >
            Convert another
          </button>
        </div>
      </div>
    </div>
  );
}
