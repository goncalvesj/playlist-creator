import {
  ApplicationInsights,
  SeverityLevel,
  type IDependencyTelemetry,
} from '@microsoft/applicationinsights-web';
import { onCLS, onFCP, onINP, onLCP, onTTFB, type MetricType } from 'web-vitals';

type TelemetryProperties = Record<string, string>;
type TelemetryMeasurements = Record<string, number>;

interface DependencyTelemetryInput {
  id?: string;
  name: string;
  target: string;
  type: string;
  data: string;
  durationMs: number;
  success: boolean;
  responseCode?: number | null;
  properties?: TelemetryProperties;
  measurements?: TelemetryMeasurements;
}

const CONNECTION_STRING =
  import.meta.env.VITE_APPLICATIONINSIGHTS_CONNECTION_STRING ||
  import.meta.env.VITE_APPINSIGHTS_CONNECTION_STRING ||
  '';
const CLOUD_ROLE_NAME = import.meta.env.VITE_APPINSIGHTS_CLOUD_ROLE_NAME || 'playlist-creator-web';
const APP_VERSION = import.meta.env.VITE_APP_VERSION || import.meta.env.VITE_BUILD_SHA || 'local';
const BUILD_SHA = import.meta.env.VITE_BUILD_SHA || 'local';
const ENVIRONMENT = import.meta.env.VITE_APP_ENVIRONMENT || import.meta.env.MODE || 'unknown';

let appInsights: ApplicationInsights | null = null;
let webVitalsStarted = false;

function baseProperties(): TelemetryProperties {
  return {
    appVersion: APP_VERSION,
    buildSha: BUILD_SHA,
    cloudRoleName: CLOUD_ROLE_NAME,
    environment: ENVIRONMENT,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumericStatus(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

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

export function getErrorCategory(error: unknown): string {
  const status = getErrorStatusCode(error);
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'not_found';
  if (status !== null && status >= 500) return 'upstream_error';

  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'aborted';
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('rate limit') || message.includes('too many requests')) return 'rate_limited';
  if (message.includes('network') || message.includes('fetch')) return 'network_error';
  if (message.includes('auth') || message.includes('token') || message.includes('permission')) {
    return 'auth_failed';
  }

  return 'unexpected_error';
}

export function createCorrelationId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toSanitizedError(error: unknown): Error {
  const sanitized = new Error(getErrorCategory(error));
  sanitized.name = error instanceof Error && error.name ? error.name : 'TelemetryError';
  return sanitized;
}

function getTelemetryProperties(properties?: TelemetryProperties): TelemetryProperties {
  return {
    ...baseProperties(),
    ...properties,
  };
}

function trackWebVital(metric: MetricType) {
  const properties = getTelemetryProperties({
    metricName: metric.name,
    metricRating: metric.rating,
    navigationType: metric.navigationType,
  });
  const measurements = {
    value: metric.value,
    delta: metric.delta,
  };

  appInsights?.trackMetric({
    name: `web_vital_${metric.name.toLowerCase()}`,
    average: metric.value,
    properties,
    measurements,
  });
  trackEvent('web_vital_recorded', properties, measurements);
}

function startWebVitals() {
  if (webVitalsStarted) return;
  webVitalsStarted = true;

  onCLS(trackWebVital);
  onFCP(trackWebVital);
  onINP(trackWebVital);
  onLCP(trackWebVital);
  onTTFB(trackWebVital);
}

export function initializeTelemetry() {
  if (!CONNECTION_STRING || appInsights) {
    return;
  }

  appInsights = new ApplicationInsights({
    config: {
      connectionString: CONNECTION_STRING,
      autoTrackPageVisitTime: false,
      disableFetchTracking: false,
      enableAjaxErrorStatusText: true,
      enableCorsCorrelation: true,
      enableRequestHeaderTracking: false,
      enableResponseHeaderTracking: false,
      correlationHeaderDomains: [window.location.host],
      excludeRequestFromAutoTrackingPatterns: [
        /^https:\/\/api\.spotify\.com\//i,
        /^https:\/\/accounts\.spotify\.com\//i,
      ],
    },
  });

  appInsights.loadAppInsights();

  appInsights.addTelemetryInitializer((item) => {
    item.tags = {
      ...item.tags,
      'ai.cloud.role': CLOUD_ROLE_NAME,
    };

    item.baseData = item.baseData ?? {};
    item.baseData.properties = {
      ...baseProperties(),
      ...(item.baseData.properties ?? {}),
    };
  });

  trackEvent('app_started');
  startWebVitals();
}

export function trackPageView(pathname: string) {
  appInsights?.trackPageView({
    name: pageNameFor(pathname),
    uri: pathname,
    properties: getTelemetryProperties({ route: pathname }),
  });
}

function pageNameFor(pathname: string) {
  return pathname === '/' ? 'home' : pathname.replace(/^\//, '');
}

export function startPageView(pathname: string) {
  appInsights?.startTrackPage(pageNameFor(pathname));
}

export function stopPageView(pathname: string) {
  appInsights?.stopTrackPage(
    pageNameFor(pathname),
    pathname,
    getTelemetryProperties({ route: pathname })
  );
}

export function trackEvent(
  name: string,
  properties?: TelemetryProperties,
  measurements?: TelemetryMeasurements
) {
  appInsights?.trackEvent({
    name,
    properties: getTelemetryProperties(properties),
    measurements,
  });
}

export function trackException(error: unknown, properties?: TelemetryProperties) {
  appInsights?.trackException(
    {
      exception: toSanitizedError(error),
      severityLevel: SeverityLevel.Error,
    },
    getTelemetryProperties({
      errorCategory: getErrorCategory(error),
      ...properties,
    })
  );
}

export function trackDependency(input: DependencyTelemetryInput) {
  const dependency: IDependencyTelemetry = {
    id: input.id ?? createCorrelationId(),
    name: input.name,
    target: input.target,
    type: input.type,
    data: input.data,
    duration: input.durationMs,
    success: input.success,
    responseCode: input.responseCode ?? (input.success ? 200 : 0),
    properties: getTelemetryProperties({
      resultCode: String(input.responseCode ?? (input.success ? 200 : 0)),
      ...input.properties,
    }),
    measurements: {
      durationMs: input.durationMs,
      ...input.measurements,
    },
  };

  appInsights?.trackDependencyData(dependency);
}

export async function trackAsyncDependency<T>(
  input: Omit<DependencyTelemetryInput, 'durationMs' | 'success' | 'responseCode'>,
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();

  try {
    const result = await operation();
    trackDependency({
      ...input,
      durationMs: performance.now() - startedAt,
      success: true,
      responseCode: 200,
    });
    return result;
  } catch (error) {
    const statusCode = getErrorStatusCode(error);
    trackDependency({
      ...input,
      durationMs: performance.now() - startedAt,
      success: false,
      responseCode: statusCode,
      properties: {
        errorCategory: getErrorCategory(error),
        ...(input.properties ?? {}),
      },
    });
    throw error;
  }
}
