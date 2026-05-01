import { AzureFunctionsInstrumentation } from "@azure/functions-opentelemetry-instrumentation";
import { AzureMonitorLogExporter, AzureMonitorTraceExporter } from "@azure/monitor-opentelemetry-exporter";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

class AzureMonitorLogExporterWithForceFlush extends AzureMonitorLogExporter {
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
const serviceName =
  process.env.OTEL_SERVICE_NAME || process.env.APPLICATIONINSIGHTS_CLOUD_ROLE_NAME || "playlist-creator-api";
const serviceVersion = process.env.APP_VERSION || process.env.GITHUB_SHA || process.env.WEBSITE_DEPLOYMENT_ID || "local";
const environment =
  process.env.APPLICATION_ENVIRONMENT || process.env.AZURE_FUNCTIONS_ENVIRONMENT || process.env.NODE_ENV || "unknown";

const resource = resourceFromAttributes({
  "service.name": serviceName,
  "service.version": serviceVersion,
  "deployment.environment.name": environment,
});

const tracerProvider = new NodeTracerProvider({
  resource,
  spanProcessors: connectionString
    ? [new SimpleSpanProcessor(new AzureMonitorTraceExporter({ connectionString }))]
    : [],
});
tracerProvider.register();

const loggerProvider = new LoggerProvider({
  resource,
  processors: connectionString
    ? [new SimpleLogRecordProcessor(new AzureMonitorLogExporterWithForceFlush({ connectionString }))]
    : [],
});

registerInstrumentations({
  tracerProvider,
  loggerProvider,
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-openai": {
        captureMessageContent: false,
      },
    }),
    new AzureFunctionsInstrumentation(),
  ],
});
