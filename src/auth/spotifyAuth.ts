export const SPOTIFY_CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID || '';
const localhostPort = window.location.port ? `:${window.location.port}` : '';
const defaultRedirectUri =
  window.location.hostname === 'localhost'
    ? `${window.location.protocol}//127.0.0.1${localhostPort}/callback`
    : `${window.location.origin}/callback`;

export const SPOTIFY_REDIRECT_URI =
  import.meta.env.VITE_SPOTIFY_REDIRECT_URI || defaultRedirectUri;
export const SPOTIFY_SCOPES = [
  'playlist-modify-private',
  'playlist-modify-public',
  'user-read-private',
];

function isLoopbackHost(hostname: string) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

export function redirectToSpotifyRedirectOrigin() {
  const redirectUrl = new URL(SPOTIFY_REDIRECT_URI);

  if (
    isLoopbackHost(window.location.hostname) &&
    isLoopbackHost(redirectUrl.hostname) &&
    window.location.origin !== redirectUrl.origin
  ) {
    window.location.replace(
      `${redirectUrl.origin}${window.location.pathname}${window.location.search}${window.location.hash}`
    );
    return true;
  }

  return false;
}
