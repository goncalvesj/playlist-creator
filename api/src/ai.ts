import type { InvocationContext } from "@azure/functions";
import OpenAI from "openai";
import { z } from "zod";
import { getPositiveIntegerEnv } from "./env";
import { getSourceDiagnostics, type DescriptionSourceText } from "./youtube";

const DEFAULT_MAX_SOURCE_TEXT_CHARS = 12_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;
const AI_OUTPUT_PREVIEW_CHARS = 800;

const SYSTEM_PROMPT = `You extract DJ set tracklists from a YouTube video description.
Return ONLY tracks present in the input — never invent tracks.
Normalize each track into { artist, title, timestamp }.
- artist: the primary artist; if multiple, join with " & ".
- title: include remix/edit info in parentheses if present (e.g. "Song (Extended Mix)").
- timestamp: HH:MM:SS or MM:SS if present in the source line, else null.
Strip leading numbering (e.g. "1.", "01)", "Track 3:").
If the input does not contain a tracklist, return tracks: [] and confidence: "low".
Set confidence to "high" if the list is clearly delimited and consistently formatted,
"medium" if mostly clear but some lines are ambiguous, "low" otherwise.`;

const TRACK_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tracks", "confidence"],
  properties: {
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    tracks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["artist", "title", "timestamp"],
        properties: {
          artist: { type: "string" },
          title: { type: "string" },
          timestamp: { type: ["string", "null"] },
        },
      },
    },
  },
};

const TRACK_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  name: "tracklist",
  strict: true,
  schema: TRACK_JSON_SCHEMA,
};

const LLMResponseSchema = z.object({
  confidence: z.enum(["high", "medium", "low"]),
  tracks: z.array(
    z.object({
      artist: z.string(),
      title: z.string(),
      timestamp: z.string().nullable(),
    })
  ),
});

interface AIResponseStatus {
  id?: string;
  model?: string;
  status?: "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete";
  incomplete_details: { reason?: "max_output_tokens" | "content_filter" } | null;
  error?: unknown;
  output?: unknown[];
  output_text: string;
  usage?: unknown;
}

interface AIResponseRequestIds {
  openAIRequestId: string | null;
  azureApimRequestId: string | null;
  azureRequestId: string | null;
}

export type ExtractTracksResult =
  | {
      kind: "tracks";
      confidence: "high" | "medium" | "low";
      tracks: Array<{ artist: string; title: string; timestamp: string | null }>;
    }
  | { kind: "no-tracks" }
  | { kind: "upstream-error"; error: string };

function getResponseStatusError(completion: AIResponseStatus): string | null {
  if (completion.status === "completed" || !completion.status) {
    return null;
  }

  if (completion.status === "incomplete") {
    if (completion.incomplete_details?.reason === "max_output_tokens") {
      return "AI response was too long to process. Try a shorter video or tracklist.";
    }

    if (completion.incomplete_details?.reason === "content_filter") {
      return "AI model output was stopped by Azure content filtering.";
    }

    return "AI model returned an incomplete response.";
  }

  return "AI model did not complete the request.";
}

function textPreview(text: string, maxLength = AI_OUTPUT_PREVIEW_CHARS): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function summarizeContentPart(part: unknown, index: number) {
  if (!isRecord(part)) {
    return { index, type: typeof part };
  }

  const text = getStringField(part, "text");
  const refusal = getStringField(part, "refusal");
  const annotations = part.annotations;

  return {
    index,
    type: getStringField(part, "type"),
    textLength: text?.length,
    refusal: refusal ? textPreview(refusal, 300) : undefined,
    annotationCount: Array.isArray(annotations) ? annotations.length : undefined,
  };
}

function summarizeOutputItem(item: unknown, index: number) {
  if (!isRecord(item)) {
    return { index, type: typeof item };
  }

  const content = item.content;

  return {
    index,
    id: getStringField(item, "id"),
    type: getStringField(item, "type"),
    status: getStringField(item, "status"),
    role: getStringField(item, "role"),
    content:
      Array.isArray(content) ? content.map((part, partIndex) => summarizeContentPart(part, partIndex)) : undefined,
  };
}

function collectDiagnosticFields(
  value: unknown,
  path = "$",
  depth = 0,
  fields: Record<string, unknown> = {}
): Record<string, unknown> {
  if (depth > 6 || !isRecord(value)) {
    return fields;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (["text", "output_text", "input", "instructions"].includes(lowerKey)) {
      continue;
    }

    const nextPath = `${path}.${key}`;
    const isDiagnosticKey = /(filter|safety|refusal|incomplete|blocked|severity|category|error|status|finish)/i.test(
      key
    );

    if (isDiagnosticKey) {
      if (typeof nestedValue === "string") {
        fields[nextPath] = textPreview(nestedValue, 300);
      } else if (
        typeof nestedValue === "number" ||
        typeof nestedValue === "boolean" ||
        nestedValue === null ||
        nestedValue === undefined
      ) {
        fields[nextPath] = nestedValue;
      } else if (Array.isArray(nestedValue)) {
        fields[nextPath] = nestedValue.length;
      } else if (isRecord(nestedValue)) {
        fields[nextPath] = Object.keys(nestedValue).sort();
      }
    }

    if (isRecord(nestedValue)) {
      collectDiagnosticFields(nestedValue, nextPath, depth + 1, fields);
    } else if (Array.isArray(nestedValue)) {
      nestedValue.slice(0, 10).forEach((item, index) => {
        collectDiagnosticFields(item, `${nextPath}[${index}]`, depth + 1, fields);
      });
    }
  }

  return fields;
}

function getAIResponseDiagnostics(completion: AIResponseStatus, requestIds: AIResponseRequestIds) {
  const includeOutputPreview = process.env.AZURE_OPENAI_LOG_OUTPUT_PREVIEW === "true";

  return {
    requestIds,
    responseId: completion.id,
    model: completion.model,
    status: completion.status,
    incompleteReason: completion.incomplete_details?.reason,
    responseError: completion.error,
    usage: completion.usage,
    outputLength: completion.output_text.length,
    outputPreview: includeOutputPreview ? textPreview(completion.output_text) : undefined,
    outputTail: includeOutputPreview ? textPreview(completion.output_text.slice(-AI_OUTPUT_PREVIEW_CHARS)) : undefined,
    outputItems: completion.output?.map((item, index) => summarizeOutputItem(item, index)),
    topLevelResponseKeys: Object.keys(completion).sort(),
    diagnosticFields: collectDiagnosticFields(completion),
  };
}

export async function extractTracks(
  sourceResult: DescriptionSourceText,
  videoId: string,
  context: InvocationContext
): Promise<ExtractTracksResult> {
  const baseURL =
    process.env.AZURE_OPENAI_TARGET_URI ||
    process.env.AZURE_OPENAI_BASE_URL ||
    process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const model = process.env.AZURE_OPENAI_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT;

  if (!baseURL || !apiKey || !model) {
    return { kind: "upstream-error", error: "Azure AI Foundry configuration is incomplete." };
  }

  const openaiClient = new OpenAI({
    baseURL,
    apiKey,
  });

  const maxSourceTextChars = getPositiveIntegerEnv("MAX_SOURCE_TEXT_CHARS", DEFAULT_MAX_SOURCE_TEXT_CHARS);
  const sourceText =
    sourceResult.text.length > maxSourceTextChars
      ? sourceResult.text.slice(0, maxSourceTextChars)
      : sourceResult.text;

  const { data: completion, response, request_id: requestId } = await openaiClient.responses
    .create({
      model,
      instructions: SYSTEM_PROMPT,
      input: `SOURCE: ${sourceResult.source}\n\n${sourceText}`,
      max_output_tokens: getPositiveIntegerEnv("AZURE_OPENAI_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS),
      text: { format: TRACK_RESPONSE_FORMAT },
      temperature: 0,
    })
    .withResponse();
  const aiResponseRequestIds = {
    openAIRequestId: requestId,
    azureApimRequestId: response.headers.get("apim-request-id"),
    azureRequestId: response.headers.get("x-ms-request-id"),
  };

  const statusError = getResponseStatusError(completion);
  if (statusError) {
    context.warn("Azure AI Foundry response did not complete.", {
      aiResponse: getAIResponseDiagnostics(completion, aiResponseRequestIds),
      selectedSource: getSourceDiagnostics(sourceResult, videoId),
    });
    return { kind: "upstream-error", error: statusError };
  }

  const rawContent = completion.output_text;
  if (!rawContent) {
    return { kind: "upstream-error", error: "No response from AI model." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    context.error("Azure AI Foundry returned invalid JSON.", {
      parseError: error instanceof Error ? error.message : String(error),
      aiResponse: getAIResponseDiagnostics(completion, aiResponseRequestIds),
      selectedSource: getSourceDiagnostics(sourceResult, videoId),
    });
    return { kind: "upstream-error", error: "AI model returned an invalid tracklist response." };
  }

  const validated = LLMResponseSchema.safeParse(parsed);

  if (!validated.success || validated.data.tracks.length === 0) {
    return { kind: "no-tracks" };
  }

  return {
    kind: "tracks",
    confidence: validated.data.confidence,
    tracks: validated.data.tracks,
  };
}
