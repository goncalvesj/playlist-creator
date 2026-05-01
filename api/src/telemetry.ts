import type { HttpRequest } from "@azure/functions";
import { SpanKind, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
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

interface ActiveDependencyTelemetryInput {
  name: string;
  target: string;
  dependencyTypeName: string;
  data: string;
  resultCode?: string | number | null;
  properties?: TelemetryProperties;
  attributes?: Attributes;
}

const CLOUD_ROLE_NAME =
  process.env.OTEL_SERVICE_NAME || process.env.APPLICATIONINSIGHTS_CLOUD_ROLE_NAME || "playlist-creator-api";
const APP_VERSION = process.env.APP_VERSION || process.env.GITHUB_SHA || process.env.WEBSITE_DEPLOYMENT_ID || "local";
const ENVIRONMENT =
  process.env.APPLICATION_ENVIRONMENT || process.env.AZURE_FUNCTIONS_ENVIRONMENT || process.env.NODE_ENV || "unknown";
const tracer = trace.getTracer("playlist-creator-api", APP_VERSION);

function baseAttributes(): Attributes {
  return {
    appVersion: APP_VERSION,
    cloudRoleName: CLOUD_ROLE_NAME,
    environment: ENVIRONMENT,
    "service.name": CLOUD_ROLE_NAME,
    "service.version": APP_VERSION,
    "deployment.environment.name": ENVIRONMENT,
  };
}

function toAttributes(properties?: TelemetryProperties, measurements?: TelemetryMeasurements): Attributes {
  return {
    ...baseAttributes(),
    ...(properties ?? {}),
    ...(measurements ?? {}),
  };
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

function sanitizedError(error: unknown): Error {
  const sanitized = new Error(getErrorCategory(error));
  sanitized.name = error instanceof Error && error.name ? error.name : "TelemetryError";
  return sanitized;
}

function setErrorAttributes(span: Span, error: unknown) {
  const errorCategory = getErrorCategory(error);
  span.recordException(sanitizedError(error));
  span.setAttributes({
    "error.category": errorCategory,
    errorCategory,
  });
  span.setStatus({ code: SpanStatusCode.ERROR, message: errorCategory });
}

function setResultAttributes(span: Span, success: boolean, resultCode?: string | number | null) {
  const effectiveResultCode = resultCode ?? (success ? "200" : "0");
  const numericStatus = getNumericStatus(effectiveResultCode);

  span.setAttributes({
    resultCode: String(effectiveResultCode),
    success,
  });

  if (numericStatus !== null) {
    span.setAttribute("http.response.status_code", numericStatus);
  }

  span.setStatus({ code: success ? SpanStatusCode.OK : SpanStatusCode.ERROR });
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
  const attributes = {
    ...toAttributes(properties, measurements),
    "event.name": name,
    "telemetry.type": "event",
  };
  const activeSpan = trace.getActiveSpan();
  activeSpan?.addEvent(name, attributes);

  const span = tracer.startSpan(`event ${name}`, {
    kind: SpanKind.INTERNAL,
    attributes,
  });
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

export function trackException(error: unknown, properties?: TelemetryProperties) {
  const attributes = {
    ...toAttributes({
      errorCategory: getErrorCategory(error),
      ...(properties ?? {}),
    }),
    "telemetry.type": "exception",
  };

  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    setErrorAttributes(activeSpan, error);
  }

  const span = tracer.startSpan("exception", {
    kind: SpanKind.INTERNAL,
    attributes,
  });
  setErrorAttributes(span, error);
  span.end();
}

export function trackDependency(input: DependencyTelemetryInput) {
  const endedAt = Date.now();
  const span = tracer.startSpan(input.name, {
    kind: SpanKind.CLIENT,
    startTime: new Date(input.startedAt),
    attributes: {
      ...toAttributes(input.properties),
      "dependency.type": input.dependencyTypeName,
      "dependency.target": input.target,
      "dependency.data": input.data,
      "server.address": input.target,
    },
  });

  setResultAttributes(span, input.success, input.resultCode);
  span.end(new Date(endedAt));
}

export async function runWithDependencySpan<T>(
  input: ActiveDependencyTelemetryInput,
  operation: (span: Span) => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(
    input.name,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        ...toAttributes(input.properties),
        ...(input.attributes ?? {}),
        "dependency.type": input.dependencyTypeName,
        "dependency.target": input.target,
        "dependency.data": input.data,
        "server.address": input.target,
      },
    },
    async (span) => {
      try {
        const result = await operation(span);
        setResultAttributes(span, true, input.resultCode);
        return result;
      } catch (error) {
        setResultAttributes(span, false, getErrorStatusCode(error));
        setErrorAttributes(span, error);
        throw error;
      } finally {
        span.end();
      }
    }
  );
}
