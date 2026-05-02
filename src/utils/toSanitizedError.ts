import { getErrorCategory } from '../telemetry/appInsights';

export function toSanitizedError(error: unknown): Error {
  const sanitized = new Error(getErrorCategory(error));
  sanitized.name = error instanceof Error && error.name ? error.name : 'TelemetryError';
  return sanitized;
}
