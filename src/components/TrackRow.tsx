import { type MatchedTrack } from '../matching/searchSpotify';

interface TrackRowProps {
  index: number;
  track: MatchedTrack;
  onToggle: () => void;
}

const STATUS_ICONS: Record<string, string> = {
  auto: '✅',
  review: '⚠️',
  not_found: '❌',
};

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export default function TrackRow({ index, track, onToggle }: TrackRowProps) {
  const spotifyTrack = track.spotifyTrack;
  const albumArt =
    spotifyTrack?.album?.images?.[2]?.url || spotifyTrack?.album?.images?.[0]?.url;

  return (
    <tr className="border-b border-gray-800 hover:bg-gray-800/50">
      <td className="p-3 text-gray-500 text-sm">{index + 1}</td>
      <td className="p-3">
        <div className="text-sm font-medium">{track.extractedArtist}</div>
        <div className="text-sm text-gray-400">{track.extractedTitle}</div>
        {track.timestamp && <div className="text-xs text-gray-600">{track.timestamp}</div>}
      </td>
      <td className="p-3">
        {spotifyTrack ? (
          <div className="flex items-center gap-3">
            {albumArt && <img src={albumArt} alt="" className="w-10 h-10 rounded" />}
            <div>
              <div className="text-sm font-medium">
                {spotifyTrack.artists.map((a) => a.name).join(', ')}
              </div>
              <div className="text-sm text-gray-400">{spotifyTrack.name}</div>
              <div className="text-xs text-gray-600">
                {formatDuration(spotifyTrack.duration_ms)}
              </div>
            </div>
          </div>
        ) : (
          <span className="text-sm text-gray-600 italic">No match found</span>
        )}
      </td>
      <td className="p-3 text-center text-sm">
        {track.score > 0 ? (
          <span
            className={
              track.score >= 0.85
                ? 'text-green-400'
                : track.score >= 0.65
                  ? 'text-yellow-400'
                  : 'text-red-400'
            }
          >
            {Math.round(track.score * 100)}%
          </span>
        ) : (
          <span className="text-gray-600">—</span>
        )}
      </td>
      <td className="p-3 text-center">{STATUS_ICONS[track.status]}</td>
      <td className="p-3 text-center">
        {track.spotifyTrack && (
          <input
            type="checkbox"
            checked={track.selected}
            onChange={onToggle}
            className="rounded cursor-pointer"
          />
        )}
      </td>
    </tr>
  );
}
