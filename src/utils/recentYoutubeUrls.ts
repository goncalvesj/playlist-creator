import { isRecord } from './isRecord';

const RECENT_YOUTUBE_URLS_KEY = 'playlist-creator:recent-youtube-urls';
const MAX_RECENT_YOUTUBE_URLS = 5;

export interface RecentYoutubeUrl {
  title: string;
  url: string;
}

function normalizeRecentYoutubeUrls(value: unknown): RecentYoutubeUrl[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries: RecentYoutubeUrl[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.title !== 'string' || typeof item.url !== 'string') {
      continue;
    }

    const url = item.url.trim();
    if (url && !entries.some((entry) => entry.url === url)) {
      entries.push({ title: item.title.trim(), url });
    }
  }

  return entries.slice(0, MAX_RECENT_YOUTUBE_URLS);
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

export function saveRecentYoutubeUrl(url: string, title: string) {
  const trimmedUrl = url.trim();
  const trimmedTitle = title.trim();
  const recentUrls = getRecentYoutubeUrls();

  if (!trimmedUrl) {
    return recentUrls;
  }

  const nextRecentUrls = [
    { title: trimmedTitle, url: trimmedUrl },
    ...recentUrls.filter((recentUrl) => recentUrl.url !== trimmedUrl),
  ].slice(0, MAX_RECENT_YOUTUBE_URLS);

  try {
    localStorage.setItem(RECENT_YOUTUBE_URLS_KEY, JSON.stringify(nextRecentUrls));
  } catch (error) {
    console.warn('Could not save recent YouTube URL history.', error);
  }

  return nextRecentUrls;
}
