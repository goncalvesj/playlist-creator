import { useState, useEffect, useCallback, useRef } from 'react';
import { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { SPOTIFY_CLIENT_ID, SPOTIFY_REDIRECT_URI, SPOTIFY_SCOPES } from './spotifyAuth';

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
          setIsAuthenticated(true);
          window.history.replaceState({}, '', '/');
        })
        .catch(console.error)
        .finally(() => setIsLoading(false));
    } else {
      // Check for cached token without triggering a redirect
      sdk
        .getAccessToken()
        .then((token) => {
          if (token) setIsAuthenticated(true);
        })
        .catch(() => {})
        .finally(() => setIsLoading(false));
    }
  }, [sdk]);

  const login = useCallback(() => {
    sdk.authenticate();
  }, [sdk]);

  const logout = useCallback(() => {
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
