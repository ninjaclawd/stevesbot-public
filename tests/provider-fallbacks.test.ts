import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenCodeFallbackProviders, buildPreferredLocalQwenProviders } from "../src/models/provider-fallbacks.js";

test("buildPreferredLocalQwenProviders prefers the vLLM host and keeps the legacy fallback", () => {
  const providers = buildPreferredLocalQwenProviders({}, "local-qwen");
  assert.equal(providers.length, 2);
  assert.deepEqual(
    providers.map((provider) => ({ baseUrl: provider.baseUrl, model: provider.model })),
    [
      { baseUrl: "http://127.0.0.1:8000/v1", model: "local-qwen-primary" },
      { baseUrl: "http://127.0.0.1:11434/v1", model: "local-qwen-fallback" },
    ],
  );
});

test("buildPreferredLocalQwenProviders respects explicit primary and legacy overrides", () => {
  const env = {
    LOCAL_QWEN_BASE_URL: "http://192.168.1.50:8000/v1",
    LOCAL_QWEN_MODEL: "smart-primary",
    LOCAL_QWEN_FALLBACK_BASE_URL: "http://192.168.1.60:11434/v1",
    LOCAL_QWEN_FALLBACK_MODEL: "safe-legacy",
  };
  const providers = buildPreferredLocalQwenProviders(env as any, "local-qwen");
  assert.deepEqual(
    providers.map((provider) => ({ baseUrl: provider.baseUrl, model: provider.model })),
    [
      { baseUrl: "http://192.168.1.50:8000/v1", model: "smart-primary" },
      { baseUrl: "http://192.168.1.60:11434/v1", model: "safe-legacy" },
    ],
  );
});

test("buildPreferredLocalQwenProviders deduplicates identical primary and legacy targets", () => {
  const env = {
    LOCAL_QWEN_BASE_URL: "http://192.168.1.50:8000/v1",
    LOCAL_QWEN_MODEL: "same-model",
    LOCAL_QWEN_FALLBACK_BASE_URL: "http://192.168.1.50:8000/v1",
    LOCAL_QWEN_FALLBACK_MODEL: "same-model",
  };
  const providers = buildPreferredLocalQwenProviders(env as any, "local-qwen");
  assert.equal(providers.length, 1);
});

test("buildOpenCodeFallbackProviders returns current cloud and local defaults", () => {
  const providers = buildOpenCodeFallbackProviders({}, "test");
  assert.equal(providers.length, 4); // 2 cloud fallbacks + preferred local host + legacy local fallback
  assert.equal(providers[0].model, "deepseek-v4-flash-free");
  assert.equal(providers[1].model, "big-pickle");
  assert.equal(providers[2].model, "local-qwen-primary");
  assert.match(providers[3].model, /qwen/i);
});

test("buildOpenCodeFallbackProviders uses default base URL", () => {
  const providers = buildOpenCodeFallbackProviders({}, "test");
  for (const p of providers.slice(0, 2)) {
    assert.equal(p.baseUrl, "https://opencode.ai/zen/v1");
  }
  assert.equal(providers[2].baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(providers[3].baseUrl, "http://127.0.0.1:11434/v1");
});

test("buildOpenCodeFallbackProviders respects custom base URL", () => {
  const env = { OPENCODE_FALLBACK_BASE_URL: "https://custom.api/v1" };
  const providers = buildOpenCodeFallbackProviders(env as any, "test");
  assert.equal(providers[0].baseUrl, "https://custom.api/v1");
});

test("buildOpenCodeFallbackProviders falls back to OPENCODE_BASE_URL", () => {
  const env = { OPENCODE_BASE_URL: "https://shared.api/v1" };
  const providers = buildOpenCodeFallbackProviders(env as any, "test");
  assert.equal(providers[0].baseUrl, "https://shared.api/v1");
});

test("buildOpenCodeFallbackProviders applies custom timeout", () => {
  const env = { OPENCODE_FALLBACK_TIMEOUT_MS: "5000" };
  const providers = buildOpenCodeFallbackProviders(env as any, "test");
  assert.equal(providers[0].requestTimeoutMs, 5000);
});

test("buildOpenCodeFallbackProviders uses STEVESBOT_MODEL_TIMEOUT_MS as fallback", () => {
  const env = { STEVESBOT_MODEL_TIMEOUT_MS: "60000" };
  const providers = buildOpenCodeFallbackProviders(env as any, "test");
  assert.equal(providers[0].requestTimeoutMs, 60000);
});

test("buildOpenCodeFallbackProviders defaults to 180s timeout", () => {
  const providers = buildOpenCodeFallbackProviders({}, "test");
  assert.equal(providers[0].requestTimeoutMs, 180000);
});

test("buildOpenCodeFallbackProviders handles invalid timeout gracefully", () => {
  const env = { OPENCODE_FALLBACK_TIMEOUT_MS: "not-a-number" };
  const providers = buildOpenCodeFallbackProviders(env as any, "test");
  assert.equal(providers[0].requestTimeoutMs, 180000);
});

test("buildOpenCodeFallbackProviders can disable local Qwen", () => {
  const env = { STEVESBOT_ENABLE_LOCAL_QWEN_FALLBACK: "false" };
  const providers = buildOpenCodeFallbackProviders(env as any, "test");
  assert.equal(providers.length, 2); // No local providers
  assert.ok(providers.every(p => !p.clientLabel.includes("local-qwen")));
});

test("buildOpenCodeFallbackProviders includes both local providers by default", () => {
  const providers = buildOpenCodeFallbackProviders({}, "test");
  const localProviders = providers.filter(p => p.clientLabel.includes("local-qwen"));
  assert.equal(localProviders.length, 2);
  assert.equal(localProviders[0]!.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(localProviders[1]!.baseUrl, "http://127.0.0.1:11434/v1");
});

test("buildOpenCodeFallbackProviders respects custom model overrides", () => {
  const env = {
    OPENCODE_FALLBACK_MODEL_1: "custom-model-1",
    OPENCODE_FALLBACK_MODEL_2: "custom-model-2",
    OPENCODE_FALLBACK_MODEL_3: "custom-model-3",
    OPENCODE_FALLBACK_MODEL_4: "custom-model-4",
  };
  const providers = buildOpenCodeFallbackProviders(env as any, "test");
  assert.equal(providers[0].model, "custom-model-1");
  assert.equal(providers[1].model, "custom-model-2");
  assert.equal(providers[2].model, "custom-model-3");
  assert.equal(providers[3].model, "custom-model-4");
});

test("buildOpenCodeFallbackProviders deduplicates providers", () => {
  const env = {
    OPENCODE_FALLBACK_MODEL_1: "same-model",
    OPENCODE_FALLBACK_MODEL_2: "same-model",
  };
  const providers = buildOpenCodeFallbackProviders(env as any, "prefix");
  // same-model appears twice but with different clientLabels, so no dedup
  // (clientLabel includes the model name: "prefix:fallback:same-model")
  // Actually, the key is baseUrl::model::clientLabel, and the models are the same but
  // clientLabels differ because they use the original model names... wait, let me re-check.
  // Actually clientLabel is `${clientLabelPrefix}:fallback:${model}` so both would be
  // "prefix:fallback:same-model" — so they SHOULD be deduped.
  const sameModelProviders = providers.filter(p => p.model === "same-model");
  assert.equal(sameModelProviders.length, 1);
});

test("buildOpenCodeFallbackProviders sets correct clientLabel prefix", () => {
  const providers = buildOpenCodeFallbackProviders({}, "drafter");
  assert.match(providers[0].clientLabel, /^drafter:fallback:/);
  assert.match(providers[2].clientLabel, /^drafter:fallback:local-qwen$/);
  assert.match(providers[3].clientLabel, /^drafter:fallback:local-qwen:legacy$/);
});

test("buildOpenCodeFallbackProviders passes API key to all providers", () => {
  const env = { OPENCODE_FALLBACK_API_KEY: "sk-test-123" };
  const providers = buildOpenCodeFallbackProviders(env as any, "test");
  for (const p of providers.slice(0, 2)) {
    assert.equal(p.apiKey, "sk-test-123");
  }
});

test("buildOpenCodeFallbackProviders uses separate Qwen timeout", () => {
  const env = {
    OPENCODE_FALLBACK_TIMEOUT_MS: "5000",
    LOCAL_QWEN_TIMEOUT_MS: "300000",
  };
  const providers = buildOpenCodeFallbackProviders(env as any, "test");
  assert.equal(providers[0].requestTimeoutMs, 5000);
  const localProviders = providers.filter(p => p.clientLabel.includes("local-qwen"));
  assert.equal(localProviders.length, 2);
  assert.ok(localProviders.every((provider) => provider.requestTimeoutMs === 300000));
});

test("buildOpenCodeFallbackProviders uses custom Qwen base URLs", () => {
  const env = {
    LOCAL_QWEN_BASE_URL: "http://192.168.1.100:8080/v1",
    LOCAL_QWEN_FALLBACK_BASE_URL: "http://192.168.1.101:8080/v1",
  };
  const providers = buildOpenCodeFallbackProviders(env as any, "test");
  const localProviders = providers.filter(p => p.clientLabel.includes("local-qwen"));
  assert.equal(localProviders[0]!.baseUrl, "http://192.168.1.100:8080/v1");
  assert.equal(localProviders[1]!.baseUrl, "http://192.168.1.101:8080/v1");
});

test("buildOpenCodeFallbackProviders filters empty model strings", () => {
  const env = {
    OPENCODE_FALLBACK_MODEL_1: "  ",
    OPENCODE_FALLBACK_MODEL_2: "",
  };
  const providers = buildOpenCodeFallbackProviders(env as any, "test");
  // Empty/whitespace cloud models should be filtered out; local providers still remain.
  assert.ok(providers.length <= 5);
  assert.ok(providers.every(p => p.model.trim().length > 0));
});

test("buildOpenCodeFallbackProviders appends an optional Z.ai coding fallback", () => {
  const providers = buildOpenCodeFallbackProviders({
    ZAI_CODING_BASE_URL: "https://api.example.test/v1",
    ZAI_CODING_MODEL: "coding-lite",
    ZAI_CODING_API_KEY: "test-key",
    STEVESBOT_ENABLE_LOCAL_QWEN_FALLBACK: "false",
  } as any, "test");
  assert.deepEqual(providers.map((provider) => provider.model), [
    "deepseek-v4-flash-free",
    "big-pickle",
    "coding-lite",
  ]);
  assert.equal(providers[2]?.clientLabel, "test:fallback:zai:coding-lite");
});
