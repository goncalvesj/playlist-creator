import type { HttpRequest } from "@azure/functions";
import * as appInsights from "applicationinsights";
import { createHash, randomUUID } from "node:crypto";

type TelemetryProperties = Record<string, string>;
type TelemetryMeasurements = Record<string, number>;

export interface RequestCorrelation {
  correlationId: string;
  clientRequestId: string | null;
  traceId: string | null;
  traceparent: string | null;
}

interface DependencyTelemetryInput {
  name: string;
  target: string;
  dependencyTypeName: string;
  data: string;
  startedAt: number;
  success: boolean;
  resultCode?: string | number | null;
  properties?: TelemetryProperties;
}

const CLOUD_ROLE_NAME = process.env.APPLICATIONINSIGHTS_CLOUD_ROLE_NAME || "playlist-creator-api";
const APP_VERSION = process.env.APP_VERSION || process.env.GITHUB_SHA || process.env.WEBSITE_DEPLOYMENT_ID || "local";
const ENVIRONMENT =
  process.env.APPLICATION_ENVIRONMENT || process.env.AZURE_FUNCTIONS_ENVIRONMENT || process.env.NODE_ENV || "unknown";

let telemetryInitialized = false;
let telemetryAvailable = false;

function baseProperties(): TelemetryProperties {
  return {
    appVersion: APP_VERSION,
    cloudRoleName: CLOUD_ROLE_NAME,
    environment: ENVIRONMENT,
  };
}

function getTelemetryClient(): appInsights.TelemetryClient | null {
  if (!telemetryInitialized) {
    telemetryInitialized = true;

    const setupString =
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || process.env.APPINSIGHTS_INSTRUMENTATIONKEY;
    if (!setupString) {
      return null;
    }

    appInsights
      .setup(setupString)
      .setAutoCollectRequests(false)
      .setAutoCollectIncomingRequestAzureFunctions(false)
      .setAutoCollectDependencies(false)
      .setAutoCollectExceptions(false)
      .setAutoCollectConsole(false)
      .setAutoCollectPerformance(false, false)
      .setAutoCollectPreAggregatedMetrics(false)
      .setAutoCollectHeartbeat(true)
      .setUseDiskRetryCaching(true)
      .start();

    appInsights.defaultClient.context.tags[appInsights.defaultClient.context.keys.cloudRole] = CLOUD_ROLE_NAME;
    appInsights.defaultClient.commonProperties = baseProperties();

    // Flip success=false for any request/dependency telemetry whose resultCode is a 4xx/5xx.
    // Note: this only affects telemetry emitted by this worker SDK. The Azure Functions host
    // emits its own `requests` rows (Host.Results) which this processor cannot intercept.
    appInsights.defaultClient.addTelemetryProcessor((envelope) => {
      const baseData = (envelope.data as { baseData?: { resultCode?: string | number; success?: boolean } })?.baseData;
      if (baseData && baseData.resultCode !== undefined && baseData.resultCode !== null) {
        const code = getNumericStatus(baseData.resultCode);
        if (code !== null && code >= 400) {
          baseData.success = false;
        }
      }
      return true;
    });

    telemetryAvailable = true;
  }

  return telemetryAvailable ? appInsights.defaultClient : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNumericStatus(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function getErrorStatusCode(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }

  for (const key of ["status", "statusCode", "code"]) {
    const status = getNumericStatus(error[key]);
    if (status !== null) {
      return status;
    }
  }

  if (isRecord(error.response)) {
    for (const key of ["status", "statusCode"]) {
      const status = getNumericStatus(error.response[key]);
      if (status !== null) {
        return status;
      }
    }
  }

  return null;
}

export function getErrorCategory(error: unknown): string {
  const status = getErrorStatusCode(error);
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "not_found";
  if (status !== null && status >= 500) return "upstream_error";

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("rate limit") || message.includes("too many requests")) return "rate_limited";
  if (message.includes("timeout") || message.includes("abort")) return "timeout";
  if (message.includes("network") || message.includes("fetch")) return "network_error";
  if (message.includes("auth") || message.includes("token") || message.includes("permission")) return "auth_failed";

  return "unexpected_error";
}

export function durationMs(startedAt: number): number {
  return Date.now() - startedAt;
}

export function hashIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function sanitizeCorrelationValue(value: string | null): string | null {
  if (!value) return null;

  const trimmed = value.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(trimmed) ? trimmed : null;
}

function getTraceId(traceparent: string | null): string | null {
  const sanitized = sanitizeCorrelationValue(traceparent);
  if (!sanitized) return null;

  const match = sanitized.match(/^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i);
  return match?.[1] ?? null;
}

export function getRequestCorrelation(request: HttpRequest): RequestCorrelation {
  const clientRequestId = sanitizeCorrelationValue(request.headers.get("x-client-request-id"));
  const traceparent = sanitizeCorrelationValue(request.headers.get("traceparent"));
  const traceId = getTraceId(traceparent);

  return {
    correlationId: clientRequestId ?? traceId ?? randomUUID(),
    clientRequestId,
    traceId,
    traceparent,
  };
}

export function correlationProperties(correlation: RequestCorrelation): TelemetryProperties {
  return {
    correlationId: correlation.correlationId,
    clientRequestIdPresent: String(Boolean(correlation.clientRequestId)),
    traceIdPresent: String(Boolean(correlation.traceId)),
  };
}

export function trackEvent(
  name: string,
  properties?: TelemetryProperties,
  measurements?: TelemetryMeasurements
) {
  getTelemetryClient()?.trackEvent({
    name,
    properties: {
      ...baseProperties(),
      ...properties,
    },
    measurements,
  });
}

export function trackException(error: unknown, properties?: TelemetryProperties) {
  const sanitized = new Error(getErrorCategory(error));
  sanitized.name = error instanceof Error && error.name ? error.name : "TelemetryError";

  getTelemetryClient()?.trackException({
    exception: sanitized,
    properties: {
      ...baseProperties(),
      errorCategory: getErrorCategory(error),
      ...properties,
    },
  });
}

export function trackDependency(input: DependencyTelemetryInput) {
  getTelemetryClient()?.trackDependency({
    name: input.name,
    target: input.target,
    dependencyTypeName: input.dependencyTypeName,
    data: input.data,
    duration: durationMs(input.startedAt),
    success: input.success,
    resultCode: input.resultCode ?? (input.success ? "200" : "0"),
    properties: {
      ...baseProperties(),
      resultCode: String(input.resultCode ?? (input.success ? "200" : "0")),
      ...input.properties,
    },
  });
}
