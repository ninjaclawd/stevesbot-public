import test from "node:test";
import assert from "node:assert/strict";
import { callLocalChatWithFallback } from "../src/models/local-model-fallback.js";

test("callLocalChatWithFallback retries the legacy provider on network failure", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    calls.push(`${url}::${body.model}`);

    if (url.includes("127.0.0.1:8000")) {
      throw new Error("fetch failed");
    }

    return new Response(JSON.stringify({
      choices: [{ message: { content: "<think>ignore</think>legacy answer" } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const content = await callLocalChatWithFallback({
      env: {} as NodeJS.ProcessEnv,
      clientLabel: "test-local",
      timeoutMs: 1000,
      providers: [
        { baseUrl: "http://127.0.0.1:8000/v1", model: "primary", clientLabel: "primary" },
        { baseUrl: "http://127.0.0.1:11434/v1", model: "legacy", clientLabel: "legacy" },
      ],
      messages: [{ role: "user", content: "hello" }],
    });

    assert.equal(content, "legacy answer");
    assert.deepEqual(calls, [
      "http://127.0.0.1:8000/v1/chat/completions::primary",
      "http://127.0.0.1:11434/v1/chat/completions::legacy",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callLocalChatWithFallback does not hide non-retryable 400 errors", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: "bad request" },
  }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });

  try {
    await assert.rejects(
      () => callLocalChatWithFallback({
        env: {} as NodeJS.ProcessEnv,
        clientLabel: "test-local",
        timeoutMs: 1000,
        providers: [
          { baseUrl: "http://127.0.0.1:8000/v1", model: "primary", clientLabel: "primary" },
          { baseUrl: "http://127.0.0.1:11434/v1", model: "legacy", clientLabel: "legacy" },
        ],
        errorLabel: "Local model",
        messages: [{ role: "user", content: "hello" }],
      }),
      /Local model 400:/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
