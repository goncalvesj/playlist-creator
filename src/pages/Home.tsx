import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { extractTracklist } from '../api/extractTracklist';
import { trackEvent } from '../telemetry/appInsights';
import { getRecentYoutubeUrls, saveRecentYoutubeUrl } from '../utils/recentYoutubeUrls';

interface HomeProps {
  isAuthenticated: boolean;
  onLogin: () => void;
  onLogout: () => void;
}

const PENDING_SHARED_URL_KEY = 'playlist-creator:pending-shared-url';

function extractSharedUrl(value: string | null) {
  if (!value) {
    return '';
  }

  const trimmed = value.trim();

  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    const match = trimmed.match(/https?:\/\/[^\s<>"']+/i);
    return match ? match[0].replace(/[),.;!]+$/, '') : '';
  }
}

function getInitialUrl() {
  const params = new URLSearchParams(window.location.search);
  // Prefer the explicit share URL, then fall back to text/title fields that may contain a link.
  const sharedUrl = [params.get('url'), params.get('text'), params.get('title')]
    .map(extractSharedUrl)
    .find(Boolean);

  if (sharedUrl) {
    sessionStorage.setItem(PENDING_SHARED_URL_KEY, sharedUrl);
    return sharedUrl;
  }

  return sessionStorage.getItem(PENDING_SHARED_URL_KEY) || '';
}

export default function Home({ isAuthenticated, onLogin, onLogout }: HomeProps) {
  const [url, setUrl] = useState(getInitialUrl);
  const [recentUrls, setRecentUrls] = useState(getRecentYoutubeUrls);
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: extractTracklist,
    onSuccess: (data, submittedUrl) => {
      sessionStorage.removeItem(PENDING_SHARED_URL_KEY);
      setRecentUrls(saveRecentYoutubeUrl(submittedUrl));
      trackEvent(
        'tracklist_review_started',
        {
          confidence: data.confidence,
          operation: 'extract_tracklist',
          source: data.source,
        },
        { trackCount: data.tracks.length }
      );
      navigate('/review', { state: { tracklistData: data, youtubeUrl: submittedUrl } });
    },
  });

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4">
      <div className="max-w-xl w-full space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold tracking-tight">
            DJ Set → Spotify Playlist
          </h1>
          <p className="text-gray-400">
            Paste a YouTube DJ set URL and we'll create a Spotify playlist from the tracklist.
          </p>
        </div>

        {!isAuthenticated ? (
          <button
            onClick={onLogin}
            className="w-full bg-green-600 hover:bg-green-500 text-white font-semibold py-3 px-6 rounded-lg transition cursor-pointer"
          >
            Sign in with Spotify
          </button>
        ) : (
          <div className="space-y-4">
            <div className="flex justify-end">
              <button
                onClick={onLogout}
                className="text-sm text-gray-500 hover:text-gray-300 transition cursor-pointer"
              >
                Sign out
              </button>
            </div>

            <div>
              <label htmlFor="youtube-url" className="block text-sm font-medium text-gray-300 mb-1">
                YouTube URL
              </label>
              <input
                id="youtube-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && url && !mutation.isPending) {
                    mutation.mutate(url);
                  }
                }}
              />
            </div>

            {recentUrls.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium tracking-wide text-gray-500 uppercase">
                  Recent links
                </p>
                <div className="space-y-2">
                  {recentUrls.map((recentUrl) => (
                    <button
                      key={recentUrl}
                      type="button"
                      onClick={() => setUrl(recentUrl)}
                      title={recentUrl}
                      className="block w-full truncate rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-left text-sm text-gray-300 transition hover:border-gray-700 hover:bg-gray-800 hover:text-white cursor-pointer"
                    >
                      {recentUrl}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={() => mutation.mutate(url)}
              disabled={!url || mutation.isPending}
              className="w-full bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold py-3 px-6 rounded-lg transition cursor-pointer disabled:cursor-not-allowed"
            >
              {mutation.isPending ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Extracting tracklist…
                </span>
              ) : (
                'Extract tracklist'
              )}
            </button>

            {mutation.isError && (
              <div className="bg-red-900/50 border border-red-700 rounded-lg p-4 text-red-200">
                {mutation.error.message}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
