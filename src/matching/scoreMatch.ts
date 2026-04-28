import { fuzzy } from 'fast-fuzzy';

export interface MatchScore {
  score: number;
  artistScore: number;
  titleScore: number;
}

export function scoreMatch(
  extractedArtist: string,
  extractedTitle: string,
  candidateArtist: string,
  candidateTitle: string
): MatchScore {
  const artistScore = fuzzy(extractedArtist.toLowerCase(), candidateArtist.toLowerCase());
  const titleScore = fuzzy(extractedTitle.toLowerCase(), candidateTitle.toLowerCase());
  const score = artistScore * 0.4 + titleScore * 0.6;
  return { score, artistScore, titleScore };
}

export type MatchStatus = 'auto' | 'review' | 'not_found';

export function getMatchStatus(score: number): MatchStatus {
  if (score >= 0.85) return 'auto';
  if (score >= 0.65) return 'review';
  return 'not_found';
}
