import { isRecord } from './isRecord';
import { toNumericStatus } from './toNumericStatus';

export function getErrorStatusCode(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }

  for (const key of ['status', 'statusCode', 'code']) {
    const status = toNumericStatus(error[key]);
    if (status !== null) {
      return status;
    }
  }

  if (isRecord(error.response)) {
    for (const key of ['status', 'statusCode']) {
      const status = toNumericStatus(error.response[key]);
      if (status !== null) {
        return status;
      }
    }
  }

  return null;
}
