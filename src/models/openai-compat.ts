import type { AgentAction, IterativeModelClient } from "./agent-loop.js";
import { renderAgentActionFormat, validateAgentAction } from "./agent-loop.js";
import type { ModelClientDescriptor, ModelInvocationTrace, QueryTraceEntry } from "../types.js";

// ──── Circuit breaker ────
// Tracks providers that recently failed with rate-limit (429) or quota errors.
// Skips them for a cooldown period to avoid wasting time cycling through unavailable providers.

const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

type CircuitState = {
  lastFailedAt: number;
  consecutiveFailures: number;
};

const circuitBreakerState = new Map<string, CircuitState>();

function circuitBreakerKey(provider: { baseUrl: string; model: string }): string {
  return provider.baseUrl + "::" + provider.model;
}

function recordProviderFailure(provider: { baseUrl: string; model: string }): void {
  const key = circuitBreakerKey(provider);
  const existing = circuitBreakerState.get(key);
  circuitBreakerState.set(key, {
    lastFailedAt: Date.now(),
    consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
  });
}

function isProviderCircuitOpen(provider: { baseUrl: string; model: string }): boolean {
  const key = circuitBreakerKey(provider);
  const state = circuitBreakerState.get(key);
  if (!state) {
    return false;
  }
  // Exponential backoff: 5min → 10min → 20min → 40min → 60min (capped)
  // Reduces wasted API calls when providers are rate-limited for hours
  const backoffMultiplier = Math.min(Math.pow(2, state.consecutiveFailures - 1), 12);
  const cooldownMs = Math.min(CIRCUIT_BREAKER_COOLDOWN_MS * backoffMultiplier, 60 * 60 * 1000);
  const elapsed = Date.now() - state.lastFailedAt;
  if (elapsed > cooldownMs) {
    // Allow retry — don't clear state. recordProviderSuccess will clear on success;
    // recordProviderFailure will extend the backoff on another failure.
    return false;
  }
  return true;
}

function recordProviderSuccess(provider: { baseUrl: string; model: string }): void {
  const key = circuitBreakerKey(provider);
  circuitBreakerState.delete(key);
}

/** Clear all circuit breaker state. Exported for test isolation. */
export function resetCircuitBreakerState(): void {
  circuitBreakerState.clear();
}

type OpenAiCompatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type ChatContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image_url";
      image_url: {
        url: string;
      };
    };

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
};

type ValidatedJsonRequest<T> = {
  messages: ChatMessage[];
  schemaName: string;
  validate: (value: unknown) => T;
  buildRepairPrompt: (rawContent: string, errorText: string, nextAttemptNumber: number) => string;
  traceRecorder?: (trace: ModelInvocationTrace) => void;
  maxAttempts?: number;
  reasoningBudget?: number;
};

type CompletionResult = {
  content: string;
  trace: ModelInvocationTrace;
};

export type OpenAiCompatProviderOptions = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  clientLabel: string;
  requestTimeoutMs?: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function extractFirstJsonObject(text: string): string | undefined {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function parseJsonContent<T>(content: string): T {
  const trimmed = content.trim();
  const candidates = new Set<string>([trimmed]);
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.add(fenced[1].trim());
  }
  const firstObject = extractFirstJsonObject(trimmed);
  if (firstObject) {
    candidates.add(firstObject.trim());
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }

  throw new Error(`Model content was not valid JSON: ${trimmed.slice(0, 400)}`);
}

function validatePassthrough<T>(value: unknown): T {
  return value as T;
}

function sanitizeTraceValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) {
      return `[data image elided: ${value.slice(0, 32)}... chars=${value.length}]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeTraceValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeTraceValue(entry)]),
    );
  }
  return value;
}

function shouldFallbackToNextProvider(statusCode: number | undefined, errorText: string): boolean {
  if (statusCode !== undefined) {
    return statusCode === 404 || statusCode === 408 || statusCode === 409 || statusCode === 423 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
  }

  return /timed out|timeout|fetch failed|network|econn|enotfound|eai_again|quota|usage limit|rate limit|temporarily unavailable|socket hang up/i.test(
    errorText,
  );
}

export class OpenAiCompatJsonClient implements IterativeModelClient {
  public constructor(
    private readonly options: OpenAiCompatProviderOptions & {
      systemRoleLabel: string;
      fallbackProviders?: OpenAiCompatProviderOptions[];
    },
  ) {}

  public describe(): ModelClientDescriptor {
    return {
      clientLabel: this.options.clientLabel,
      model: this.options.model,
      baseUrl: this.options.baseUrl,
    };
  }

  public async nextAction(input: {
    systemPrompt: string;
    conversation: string;
    toolTrace: QueryTraceEntry[];
    toolCatalog: string[];
    traceRecorder?: (trace: ModelInvocationTrace) => void;
  }): Promise<AgentAction> {
    const prompt = [
      input.systemPrompt,
      renderAgentActionFormat(input.toolCatalog),
      "Conversation and prior tool results:",
      input.conversation,
      "Prior tool trace:",
      JSON.stringify(input.toolTrace, null, 2),
    ].join("\n\n");

    return this.requestValidatedJson<AgentAction>({
      messages: [
        {
          role: "system",
          content: `${this.options.systemRoleLabel}\nRespond using JSON only.`,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      schemaName: "agent action",
      validate: (value) => validateAgentAction(value, input.toolCatalog),
      buildRepairPrompt: (_rawContent, errorText, nextAttemptNumber) =>
        [
          `Your previous response failed agent action validation: ${errorText}`,
          `Repair attempt: ${nextAttemptNumber}`,
          renderAgentActionFormat(input.toolCatalog),
          "Reply again with exactly one valid JSON object and nothing else.",
        ].join("\n\n"),
      traceRecorder: input.traceRecorder,
      maxAttempts: 3,
    });
  }

  public async generateJson<T>(input: {
    systemPrompt: string;
    userPrompt: string;
    traceRecorder?: (trace: ModelInvocationTrace) => void;
    validate?: (value: unknown) => T;
    schemaName?: string;
    repairHint?: string;
    maxAttempts?: number;
    reasoningBudget?: number;
  }): Promise<T> {
    return this.requestValidatedJson<T>({
      messages: [
        {
          role: "system",
          content: input.systemPrompt,
        },
        {
          role: "user",
          content: input.userPrompt,
        },
      ],
      reasoningBudget: input.reasoningBudget,
      schemaName: input.schemaName ?? "json response",
      validate: input.validate ?? validatePassthrough<T>,
      buildRepairPrompt: (_rawContent, errorText, nextAttemptNumber) =>
        [
          `Your previous response failed ${input.schemaName ?? "json response"} validation: ${errorText}`,
          `Repair attempt: ${nextAttemptNumber}`,
          input.repairHint ?? "Return one valid JSON object that matches the requested output schema.",
          "Reply again with JSON only.",
        ].join("\n\n"),
      traceRecorder: input.traceRecorder,
      maxAttempts: input.maxAttempts ?? 3,
    });
  }

  public async generateJsonWithImage<T>(input: {
    systemPrompt: string;
    userPrompt: string;
    imageDataUrl: string;
    traceRecorder?: (trace: ModelInvocationTrace) => void;
    validate?: (value: unknown) => T;
    schemaName?: string;
    repairHint?: string;
    maxAttempts?: number;
  }): Promise<T> {
    return this.requestValidatedJson<T>({
      messages: [
        {
          role: "system",
          content: input.systemPrompt,
        },
        {
          role: "user",
          content: [
            { type: "text", text: input.userPrompt },
            { type: "image_url", image_url: { url: input.imageDataUrl } },
          ],
        },
      ],
      schemaName: input.schemaName ?? "json response",
      validate: input.validate ?? validatePassthrough<T>,
      buildRepairPrompt: (_rawContent, errorText, nextAttemptNumber) =>
        [
          `Your previous response failed ${input.schemaName ?? "json response"} validation: ${errorText}`,
          `Repair attempt: ${nextAttemptNumber}`,
          input.repairHint ?? "Return one valid JSON object that matches the requested output schema.",
          "Reply again with JSON only.",
        ].join("\n\n"),
      traceRecorder: input.traceRecorder,
      maxAttempts: input.maxAttempts ?? 3,
    });
  }

  private listProviders(): OpenAiCompatProviderOptions[] {
    const seen = new Set<string>();
    const providers = [
      {
        baseUrl: this.options.baseUrl,
        apiKey: this.options.apiKey,
        model: this.options.model,
        clientLabel: this.options.clientLabel,
        requestTimeoutMs: this.options.requestTimeoutMs,
      },
      ...(this.options.fallbackProviders ?? []),
    ];

    return providers.filter((provider) => {
      const key = `${provider.baseUrl}::${provider.model}::${provider.clientLabel}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private async requestValidatedJson<T>(params: ValidatedJsonRequest<T>): Promise<T> {
    const maxAttempts = params.maxAttempts ?? 3;
    const messages = [...params.messages];
    let lastRequestError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let completion: CompletionResult;
      try {
        completion = await this.requestCompletion(messages, attempt, params.schemaName, params.traceRecorder, params.reasoningBudget);
      } catch (error) {
        lastRequestError = error;
        if (attempt >= maxAttempts) {
          throw error;
        }
        continue;
      }

      try {
        const parsed = parseJsonContent<unknown>(completion.content);
        const validated = params.validate(parsed);
        params.traceRecorder?.({
          ...completion.trace,
          ok: true,
          validationSchema: params.schemaName,
        });
        return validated;
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        params.traceRecorder?.({
          ...completion.trace,
          ok: false,
          errorText,
          validationSchema: params.schemaName,
          validationErrorText: errorText,
        });

        if (attempt >= maxAttempts) {
          throw new Error(`${params.schemaName} validation failed after ${maxAttempts} attempts: ${errorText}`);
        }

        messages.push(
          {
            role: "assistant",
            content: completion.content,
          },
          {
            role: "user",
            content: params.buildRepairPrompt(completion.content, errorText, attempt + 1),
          },
        );
      }
    }

    throw lastRequestError instanceof Error
      ? lastRequestError
      : new Error(`Unreachable ${params.schemaName} validation state.`);
  }

  private async requestCompletion(
    messages: ChatMessage[],
    attemptNumber: number,
    schemaName: string,
    traceRecorder?: (trace: ModelInvocationTrace) => void,
    reasoningBudget?: number,
  ): Promise<CompletionResult> {
    const providers = this.listProviders();
    let lastFailure: Error | undefined;

    // Filter out circuit-broken providers (but always keep the last one as final fallback)
    const activeProviders = providers.filter((p, i) => i === providers.length - 1 || !isProviderCircuitOpen(p));

    for (let index = 0; index < activeProviders.length; index += 1) {
      const provider = activeProviders[index]!;
      try {
        const result = await this.requestCompletionFromProvider(provider, messages, attemptNumber, schemaName, reasoningBudget);
        recordProviderSuccess(provider);
        return result;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const failureTrace = (failure as Error & { trace?: ModelInvocationTrace }).trace;
        if (failureTrace) {
          traceRecorder?.(failureTrace);
        }
        lastFailure = failure;
        const statusCode = failureTrace?.statusCode;
        // Record failures in circuit breaker:
        // - 429/quota/rate-limit errors (API overloaded)
        // - Network errors (WAN down, DNS failure, connection refused)
        // This prevents cycling through all cloud providers when the network is unavailable.
        if (
          statusCode === 429 ||
          /quota|usage limit|rate limit/i.test(failure.message) ||
          /enotfound|econnrefused|econnreset|enetunreach|eai_again|fetch failed|timed out/i.test(failure.message)
        ) {
          recordProviderFailure(provider);
        }
        if (index >= activeProviders.length - 1 || !shouldFallbackToNextProvider(statusCode, failure.message)) {
          throw failure;
        }
      }
    }

    throw lastFailure ?? new Error("No model providers available.");
  }

  private async requestCompletionFromProvider(
    provider: OpenAiCompatProviderOptions,
    messages: ChatMessage[],
    attemptNumber: number,
    schemaName: string,
    reasoningBudget?: number,
  ): Promise<CompletionResult> {
    const requestBody: Record<string, unknown> = {
      model: provider.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages,
    };
    if (reasoningBudget !== undefined && reasoningBudget !== 0) {
      requestBody.reasoning_budget = reasoningBudget;
    }
    // Disable Qwen thinking mode for local models — cuts response time dramatically
    if (provider.baseUrl?.includes("11434")) {
      // Prepend /no_think to first user message to disable thinking
      const msgs = [...messages];
      const firstUser = msgs.findIndex((m) => m.role === "user");
      if (firstUser >= 0) {
        msgs[firstUser] = { ...msgs[firstUser], content: "/no_think\n" + msgs[firstUser].content };
      }
      requestBody.messages = msgs;
      // Cap output tokens — server has thinking_forced_open which generates unlimited thinking
      if (!requestBody.max_tokens) {
        requestBody.max_tokens = 1024;
      }
    }
    const traceRequestBody = sanitizeTraceValue(requestBody) as Record<string, unknown>;

    const startedAt = nowIso();
    const startedMs = Date.now();
    const timeoutMs = Math.max(1_000, provider.requestTimeoutMs ?? this.options.requestTimeoutMs ?? 180_000);
    let responseText: string | undefined;
    let responseJson: unknown;
    let statusCode: number | undefined;
    let timedOut = false;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      statusCode = response.status;
      responseText = await response.text();
      try {
        responseJson = responseText ? (JSON.parse(responseText) as unknown) : undefined;
      } catch {
        responseJson = undefined;
      }

      if (!response.ok) {
        throw new Error(`Model request failed (${response.status}): ${responseText}`);
      }
      if (!responseJson || typeof responseJson !== "object") {
        throw new Error("Model returned invalid JSON.");
      }
      const content = (responseJson as OpenAiCompatResponse).choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("Model returned no content.");
      }

      return {
        content,
        trace: {
          clientLabel: provider.clientLabel,
          model: provider.model,
          baseUrl: provider.baseUrl,
          attemptNumber,
          startedAt,
          completedAt: nowIso(),
          durationMs: Date.now() - startedMs,
          statusCode,
          ok: true,
          requestBody: traceRequestBody,
          responseBody: responseJson,
          responseText,
          validationSchema: schemaName,
        },
      };
    } catch (error) {
      const failure = timedOut
        ? new Error(`Model request timed out after ${timeoutMs}ms.`)
        : error instanceof Error
          ? error
          : new Error(String(error));
      const trace: ModelInvocationTrace = {
        clientLabel: provider.clientLabel,
        model: provider.model,
        baseUrl: provider.baseUrl,
        attemptNumber,
        startedAt,
        completedAt: nowIso(),
        durationMs: Date.now() - startedMs,
        statusCode,
        ok: false,
        requestBody: traceRequestBody,
        responseBody: responseJson,
        responseText,
        errorText: failure.message,
        validationSchema: schemaName,
      };
      (failure as Error & { trace?: ModelInvocationTrace }).trace = trace;
      throw failure;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
