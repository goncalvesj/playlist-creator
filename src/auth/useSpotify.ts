import { useState, useEffect, useCallback, useRef } from 'react';
import { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { SPOTIFY_CLIENT_ID, SPOTIFY_REDIRECT_URI, SPOTIFY_SCOPES } from './spotifyAuth';
import { getErrorCategory, trackEvent, trackException } from '../telemetry/appInsights';

export function useSpotify() {
  const [sdk] = useState(() =>
    SpotifyApi.withUserAuthorization(SPOTIFY_CLIENT_ID, SPOTIFY_REDIRECT_URI, SPOTIFY_SCOPES)
  );
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const hasCode = params.has('code');

    if (hasCode) {
      // Returning from Spotify callback — exchange code for token
      sdk
        .authenticate()
        .then(() => {
          trackEvent('spotify_login_completed', { operation: 'spotify_auth' });
          setIsAuthenticated(true);
          window.history.replaceState({}, '', '/');
        })
        .catch((error: unknown) => {
          trackEvent('spotify_login_failed', {
            errorCategory: getErrorCategory(error),
            operation: 'spotify_auth',
          });
          trackException(error, { operation: 'spotify_auth' });
          console.error(error);
        })
        .finally(() => setIsLoading(false));
    } else {
      // Check for cached token without triggering a redirect
      sdk
        .getAccessToken()
        .then((token) => {
          if (token) {
            trackEvent('spotify_session_restored', { operation: 'spotify_auth' });
            setIsAuthenticated(true);
          }
        })
        .catch((error: unknown) => {
          trackEvent('spotify_session_restore_failed', {
            errorCategory: getErrorCategory(error),
            operation: 'spotify_auth',
          });
        })
        .finally(() => setIsLoading(false));
    }
  }, [sdk]);

  const login = useCallback(() => {
    trackEvent('spotify_login_started', { operation: 'spotify_auth' });
    void Promise.resolve(sdk.authenticate()).catch((error: unknown) => {
      trackEvent('spotify_login_failed', {
        errorCategory: getErrorCategory(error),
        operation: 'spotify_auth',
      });
      trackException(error, { operation: 'spotify_auth' });
    });
  }, [sdk]);

  const logout = useCallback(() => {
    trackEvent('spotify_logout', { operation: 'spotify_auth' });
    sdk.logOut();
    setIsAuthenticated(false);
  }, [sdk]);

  return {
    sdk: isAuthenticated ? sdk : null,
    isAuthenticated,
    isLoading,
    login,
    logout,
  };
}
