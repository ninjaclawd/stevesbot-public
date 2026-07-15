import type { OpenAiCompatProviderOptions } from "./openai-compat.js";

const DEFAULT_LOCAL_QWEN_PRIMARY = {
  baseUrl: "http://127.0.0.1:8000/v1",
  model: "local-qwen-primary",
} as const;

const DEFAULT_LOCAL_QWEN_LEGACY = {
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "local-qwen-fallback",
} as const;

function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

type LocalQwenEndpoint = {
  baseUrl: string;
  model: string;
};

function resolveLocalQwenEndpoints(env: NodeJS.ProcessEnv): LocalQwenEndpoint[] {
  const endpoints: LocalQwenEndpoint[] = [
    {
      baseUrl: env.LOCAL_QWEN_BASE_URL ?? DEFAULT_LOCAL_QWEN_PRIMARY.baseUrl,
      model: env.LOCAL_QWEN_MODEL ?? DEFAULT_LOCAL_QWEN_PRIMARY.model,
    },
    {
      baseUrl: env.LOCAL_QWEN_FALLBACK_BASE_URL ?? DEFAULT_LOCAL_QWEN_LEGACY.baseUrl,
      model: env.LOCAL_QWEN_FALLBACK_MODEL ?? DEFAULT_LOCAL_QWEN_LEGACY.model,
    },
  ];

  const seen = new Set<string>();
  return endpoints.filter((endpoint) => {
    const key = `${endpoint.baseUrl}::${endpoint.model}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function buildPreferredLocalQwenProviders(
  env: NodeJS.ProcessEnv,
  clientLabelPrefix: string,
): OpenAiCompatProviderOptions[] {
  const timeoutMs = parseTimeoutMs(env.LOCAL_QWEN_TIMEOUT_MS ?? env.STEVESBOT_MODEL_TIMEOUT_MS, 180_000);
  return resolveLocalQwenEndpoints(env).map((endpoint, index) => ({
    baseUrl: endpoint.baseUrl,
    apiKey: env.LOCAL_QWEN_API_KEY,
    model: endpoint.model,
    clientLabel: index === 0 ? clientLabelPrefix : `${clientLabelPrefix}:legacy`,
    requestTimeoutMs: timeoutMs,
  }));
}

export function buildPreferredLocalQwenClientOptions(
  env: NodeJS.ProcessEnv,
  clientLabel: string,
): OpenAiCompatProviderOptions & { fallbackProviders: OpenAiCompatProviderOptions[] } {
  const [primary, ...fallbackProviders] = buildPreferredLocalQwenProviders(env, clientLabel);
  return { ...primary, fallbackProviders };
}

export function getPreferredLocalQwenProvider(
  env: NodeJS.ProcessEnv,
  clientLabel = "local-qwen",
): OpenAiCompatProviderOptions {
  return buildPreferredLocalQwenProviders(env, clientLabel)[0];
}

export function buildOpenCodeFallbackProviders(
  env: NodeJS.ProcessEnv,
  clientLabelPrefix: string,
): OpenAiCompatProviderOptions[] {
  const timeoutMs = parseTimeoutMs(env.OPENCODE_FALLBACK_TIMEOUT_MS ?? env.OPENCODE_TIMEOUT_MS ?? env.STEVESBOT_MODEL_TIMEOUT_MS, 180_000);
  const baseUrl = env.OPENCODE_FALLBACK_BASE_URL ?? env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/v1";
  const apiKey = env.OPENCODE_FALLBACK_API_KEY ?? env.OPENCODE_API_KEY;
  const candidates = [
    env.OPENCODE_FALLBACK_MODEL_1 ?? "deepseek-v4-flash-free",
    env.OPENCODE_FALLBACK_MODEL_2 ?? "big-pickle",
    env.OPENCODE_FALLBACK_MODEL_3,
    env.OPENCODE_FALLBACK_MODEL_4,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  const providers: OpenAiCompatProviderOptions[] = candidates.map((model) => ({
    baseUrl,
    apiKey,
    model,
    clientLabel: `${clientLabelPrefix}:fallback:${model}`,
    requestTimeoutMs: timeoutMs,
  }));

  const zaiBaseUrl = env.ZAI_CODING_BASE_URL?.trim();
  const zaiModel = env.ZAI_CODING_MODEL?.trim();
  const enableZai = (env.STEVESBOT_ENABLE_ZAI_FALLBACK ?? "true").trim().toLowerCase() !== "false";
  if (enableZai && zaiBaseUrl && zaiModel) {
    providers.push({
      baseUrl: zaiBaseUrl,
      apiKey: env.ZAI_CODING_API_KEY?.trim() || undefined,
      model: zaiModel,
      clientLabel: `${clientLabelPrefix}:fallback:zai:${zaiModel}`,
      requestTimeoutMs: parseTimeoutMs(env.ZAI_CODING_TIMEOUT_MS ?? env.STEVESBOT_MODEL_TIMEOUT_MS, 180_000),
    });
  }

  const enableLocalQwen = (env.STEVESBOT_ENABLE_LOCAL_QWEN_FALLBACK ?? "true").trim().toLowerCase() !== "false";
  if (enableLocalQwen) {
    providers.push(
      ...buildPreferredLocalQwenProviders(env, `${clientLabelPrefix}:fallback:local-qwen`),
    );
  }

  const seen = new Set<string>();
  return providers.filter((provider) => {
    const key = `${provider.baseUrl}::${provider.model}::${provider.clientLabel}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
