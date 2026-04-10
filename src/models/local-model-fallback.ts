import type { OpenAiCompatProviderOptions } from "./openai-compat.js";
import { buildPreferredLocalQwenProviders } from "./provider-fallbacks.js";

type LocalChatMessage = {
  role: string;
  content: string;
};

function shouldRetryProvider(statusCode: number | undefined, errorText: string): boolean {
  if (statusCode !== undefined) {
    return statusCode === 404 || statusCode === 408 || statusCode === 409 || statusCode === 423 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
  }

  return /timed out|timeout|fetch failed|network|econn|enotfound|eai_again|quota|usage limit|rate limit|temporarily unavailable|socket hang up|no content/i.test(
    errorText,
  );
}

export async function callLocalChatWithFallback(params: {
  env: NodeJS.ProcessEnv;
  clientLabel: string;
  messages: LocalChatMessage[];
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  extraBody?: Record<string, unknown>;
  providers?: OpenAiCompatProviderOptions[];
  errorLabel?: string;
}): Promise<string> {
  const providers = params.providers ?? buildPreferredLocalQwenProviders(params.env, params.clientLabel);
  if (providers.length === 0) {
    throw new Error("No local model providers configured.");
  }

  let lastError: Error | undefined;

  for (const [index, provider] of providers.entries()) {
    const timeoutMs = params.timeoutMs ?? provider.requestTimeoutMs ?? 180_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: provider.model,
          temperature: params.temperature ?? 0.3,
          max_tokens: params.maxTokens ?? 1024,
          messages: params.messages,
          ...(params.extraBody ?? {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const error = new Error(`${params.errorLabel ?? "Local model"} ${response.status}: ${text.slice(0, 200)}`);
        if (index < providers.length - 1 && shouldRetryProvider(response.status, error.message)) {
          lastError = error;
          continue;
        }
        throw error;
      }

      const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content?.replace(/<think>[\s\S]*?<\/think>/g, "").trim() ?? "";
      if (!content) {
        const error = new Error(`${params.errorLabel ?? "Local model"} returned no content.`);
        if (index < providers.length - 1 && shouldRetryProvider(undefined, error.message)) {
          lastError = error;
          continue;
        }
        throw error;
      }

      return content;
    } catch (error) {
      const normalized =
        error instanceof Error && error.name === "AbortError"
          ? new Error(`${params.errorLabel ?? "Local model"} timed out after ${timeoutMs}ms.`)
          : error instanceof Error
            ? error
            : new Error(String(error));

      if (index < providers.length - 1 && shouldRetryProvider(undefined, normalized.message)) {
        lastError = normalized;
        continue;
      }
      throw normalized;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error(`${params.errorLabel ?? "Local model"} failed.`);
}

