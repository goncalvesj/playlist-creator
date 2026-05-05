const RECENT_YOUTUBE_URLS_KEY = 'playlist-creator:recent-youtube-urls';
const MAX_RECENT_YOUTUBE_URLS = 5;

function normalizeRecentYoutubeUrls(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  const urls: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }

    const url = item.trim();
    if (url && !urls.includes(url)) {
      urls.push(url);
    }
  }

  return urls.slice(0, MAX_RECENT_YOUTUBE_URLS);
}

export function getRecentYoutubeUrls() {
  try {
    const storedUrls = localStorage.getItem(RECENT_YOUTUBE_URLS_KEY);
    return storedUrls ? normalizeRecentYoutubeUrls(JSON.parse(storedUrls)) : [];
  } catch (error) {
    console.warn('Could not read recent YouTube URL history.', error);
    return [];
  }
}

export function saveRecentYoutubeUrl(url: string) {
  const trimmedUrl = url.trim();
  const recentUrls = getRecentYoutubeUrls();

  if (!trimmedUrl) {
    return recentUrls;
  }

  const nextRecentUrls = [
    trimmedUrl,
    ...recentUrls.filter((recentUrl) => recentUrl !== trimmedUrl),
  ].slice(0, MAX_RECENT_YOUTUBE_URLS);

  try {
    localStorage.setItem(RECENT_YOUTUBE_URLS_KEY, JSON.stringify(nextRecentUrls));
  } catch (error) {
    console.warn('Could not save recent YouTube URL history.', error);
  }

  return nextRecentUrls;
}
