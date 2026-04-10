import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiCompatJsonClient, resetCircuitBreakerState } from "../src/models/openai-compat.js";

function makeClient(overrides: Partial<ConstructorParameters<typeof OpenAiCompatJsonClient>[0]> = {}) {
  return new OpenAiCompatJsonClient({
    baseUrl: "http://example.invalid/v1",
    model: "gpt-test",
    systemRoleLabel: "You are a test client.",
    clientLabel: "gpt-test",
    ...overrides,
  });
}

function withMockedFetch(
  responses: string[],
  fn: (calls: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push(body);
    const next = responses.shift();
    if (!next) {
      throw new Error("No mocked response remaining.");
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: next,
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  return fn(calls).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test("OpenAiCompatJsonClient tolerates trailing text after a JSON payload", async () => {
  await withMockedFetch(
    ['{"kind":"final","draft":"Use meshcast.","supportRecordIds":[1],"repoRefs":["vdo-ninja:README.md"]}\n\nextra trailing text'],
    async () => {
      const action = await makeClient().nextAction({
        systemPrompt: "System prompt",
        conversation: "Conversation",
        toolTrace: [],
        toolCatalog: ["searchSupport"],
      });

      assert.deepEqual(action, {
        kind: "final",
        draft: "Use meshcast.",
        supportRecordIds: [1],
        repoRefs: ["vdo-ninja:README.md"],
      });
    },
  );
});

test("OpenAiCompatJsonClient extracts the first valid JSON object from concatenated content", async () => {
  await withMockedFetch(
    [
      '{"kind":"tool","tool":"searchSupport","args":{"query":"relay issues","limit":5},"reason":"search first"}' +
        '{"kind":"final","draft":"bad second object"}',
    ],
    async () => {
      const action = await makeClient().nextAction({
        systemPrompt: "System prompt",
        conversation: "Conversation",
        toolTrace: [],
        toolCatalog: ["searchSupport"],
      });

      assert.deepEqual(action, {
        kind: "tool",
        tool: "searchSupport",
        args: { query: "relay issues", limit: 5 },
        reason: "search first",
      });
    },
  );
});

test("OpenAiCompatJsonClient retries a timed out request and succeeds on a later attempt", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    if (calls === 1) {
      const signal = init?.signal as AbortSignal | undefined;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      });
    }

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"kind":"final","draft":"Use a second dock page and share the exact link.","supportRecordIds":[1],"repoRefs":["vdo-ninja:README.md"]}',
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const action = await makeClient({ requestTimeoutMs: 25 }).nextAction({
      systemPrompt: "System prompt",
      conversation: "Conversation",
      toolTrace: [],
      toolCatalog: ["searchSupport"],
    });

    assert.deepEqual(action, {
      kind: "final",
      draft: "Use a second dock page and share the exact link.",
      supportRecordIds: [1],
      repoRefs: ["vdo-ninja:README.md"],
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAiCompatJsonClient repairs an invalid action and retries until it matches the allowed schema", async () => {
  const traces: Array<{ attempt?: number; ok: boolean; error?: string }> = [];
  await withMockedFetch(
    [
      '{"kind":"tool","tool":"totally-made-up","args":{}}',
      '{"kind":"final","draft":"Post the exact error screenshot and app version.","supportRecordIds":["7"],"repoRefs":["vdo-ninja:README.md"]}',
    ],
    async (calls) => {
      const action = await makeClient().nextAction({
        systemPrompt: "System prompt",
        conversation: "Conversation",
        toolTrace: [],
        toolCatalog: ["searchSupport", "openSupportRecord"],
        traceRecorder: (trace) => {
          traces.push({
            attempt: trace.attemptNumber,
            ok: trace.ok,
            error: trace.validationErrorText ?? trace.errorText,
          });
        },
      });

      assert.deepEqual(action, {
        kind: "final",
        draft: "Post the exact error screenshot and app version.",
        supportRecordIds: [7],
        repoRefs: ["vdo-ninja:README.md"],
      });
      assert.equal(calls.length, 2);
      assert.match(JSON.stringify(calls[1]), /failed agent action validation/i);
      assert.deepEqual(traces, [
        {
          attempt: 1,
          ok: false,
          error: 'Tool "totally-made-up" is not in the allowed tool catalog.',
        },
        {
          attempt: 2,
          ok: true,
          error: undefined,
        },
      ]);
    },
  );
});

test("OpenAiCompatJsonClient repairs invalid generic JSON against a validator", async () => {
  await withMockedFetch(
    [
      '{"needsReply":"yes","confidence":2,"category":5,"rationale":false}',
      '{"needsReply":true,"confidence":0.91,"category":"support-needed","rationale":"Direct unresolved support ask."}',
    ],
    async (calls) => {
      const result = await makeClient().generateJson({
        systemPrompt: "Router",
        userPrompt: "Return JSON only.",
        schemaName: "triage decision",
        repairHint:
          'Return JSON with exactly this shape: {"needsReply":boolean,"confidence":0.0,"category":"string","rationale":"string"}',
        validate: (value) => {
          const record = value as Record<string, unknown>;
          if (typeof record.needsReply !== "boolean") {
            throw new Error("needsReply must be a boolean.");
          }
          if (typeof record.confidence !== "number") {
            throw new Error("confidence must be a number.");
          }
          if (typeof record.category !== "string") {
            throw new Error("category must be a string.");
          }
          if (typeof record.rationale !== "string") {
            throw new Error("rationale must be a string.");
          }
          return {
            needsReply: record.needsReply,
            confidence: record.confidence,
            category: record.category,
            rationale: record.rationale,
          };
        },
      });

      assert.deepEqual(result, {
        needsReply: true,
        confidence: 0.91,
        category: "support-needed",
        rationale: "Direct unresolved support ask.",
      });
      assert.equal(calls.length, 2);
      assert.match(JSON.stringify(calls[1]), /triage decision validation/i);
    },
  );
});

test("OpenAiCompatJsonClient fails after exhausting repair attempts", async () => {
  await withMockedFetch(
    ['{"kind":"tool","tool":"bad-1","args":{}}', '{"kind":"tool","tool":"bad-2","args":{}}', '{"kind":"tool","tool":"bad-3","args":{}}'],
    async () => {
      await assert.rejects(
        () =>
          makeClient().nextAction({
            systemPrompt: "System prompt",
            conversation: "Conversation",
            toolTrace: [],
            toolCatalog: ["searchSupport"],
          }),
        /agent action validation failed after 3 attempts/i,
      );
    },
  );
});


test("OpenAiCompatJsonClient falls back to a secondary provider on quota errors", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    calls.push(String(body.model));
    if (body.model === "gpt-primary") {
      return new Response(
        JSON.stringify({ type: "error", error: { type: "SubscriptionUsageLimitError", message: "Subscription quota exceeded." } }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"kind":"final","draft":"Use relay mode for the viewer.","supportRecordIds":[2],"repoRefs":["vdo-ninja:README.md"]}',
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const action = await makeClient({
      model: "gpt-primary",
      fallbackProviders: [
        {
          baseUrl: "http://example.invalid/v1",
          model: "minimax-m2.5-free",
          clientLabel: "gpt-test:fallback:minimax-m2.5-free",
        },
      ],
    }).nextAction({
      systemPrompt: "System prompt",
      conversation: "Conversation",
      toolTrace: [],
      toolCatalog: ["searchSupport"],
    });

    assert.deepEqual(action, {
      kind: "final",
      draft: "Use relay mode for the viewer.",
      supportRecordIds: [2],
      repoRefs: ["vdo-ninja:README.md"],
    });
    assert.deepEqual(calls, ["gpt-primary", "minimax-m2.5-free"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAiCompatJsonClient can fall back through multiple providers until local Qwen succeeds", async () => {
  resetCircuitBreakerState();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    calls.push(String(body.model));
    if (body.model === "gpt-primary") {
      return new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (body.model === "minimax-m2.5-free") {
      return new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"kind":"final","draft":"Ask them for the exact blank-screen error.","supportRecordIds":[],"repoRefs":[]}',
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const action = await makeClient({
      model: "gpt-primary",
      fallbackProviders: [
        {
          baseUrl: "http://example.invalid/v1",
          model: "minimax-m2.5-free",
          clientLabel: "gpt-test:fallback:minimax-m2.5-free",
        },
        {
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "local-qwen-fallback",
          clientLabel: "gpt-test:fallback:local-qwen",
        },
      ],
    }).nextAction({
      systemPrompt: "System prompt",
      conversation: "Conversation",
      toolTrace: [],
      toolCatalog: ["searchSupport"],
    });

    assert.deepEqual(action, {
      kind: "final",
      draft: "Ask them for the exact blank-screen error.",
      supportRecordIds: [],
      repoRefs: [],
    });
    assert.deepEqual(calls, ["gpt-primary", "minimax-m2.5-free", "local-qwen-fallback"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAiCompatJsonClient does not hide bad-request errors behind fallbacks", async () => {
  resetCircuitBreakerState();
  const originalFetch = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    models.push(String(body.model));
    return new Response(JSON.stringify({ error: { message: "bad prompt payload" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await assert.rejects(
      () =>
        makeClient({
          model: "gpt-primary",
          fallbackProviders: [
            {
              baseUrl: "http://example.invalid/v1",
              model: "minimax-m2.5-free",
              clientLabel: "gpt-test:fallback:minimax-m2.5-free",
            },
          ],
        }).nextAction({
          systemPrompt: "System prompt",
          conversation: "Conversation",
          toolTrace: [],
          toolCatalog: ["searchSupport"],
        }),
      /Model request failed \(400\)/i,
    );
    assert.deepEqual(models, ["gpt-primary", "gpt-primary", "gpt-primary"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAiCompatJsonClient network errors trigger circuit breaker and skip providers on subsequent calls", async () => {
  resetCircuitBreakerState();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    calls.push(String(body.model));

    // Cloud providers fail with DNS error (WAN down)
    if (body.model === "gpt-primary" || body.model === "minimax-free") {
      throw new Error("getaddrinfo ENOTFOUND api.opencode.ai");
    }

    // Local Qwen always succeeds
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"kind":"final","draft":"Local fallback answer.","supportRecordIds":[],"repoRefs":[]}' } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const client = makeClient({
      model: "gpt-primary",
      fallbackProviders: [
        { baseUrl: "http://minimax.invalid/v1", model: "minimax-free", clientLabel: "gpt-test:fallback:minimax-free" },
        { baseUrl: "http://127.0.0.1:11434/v1", model: "local-qwen", clientLabel: "gpt-test:fallback:local-qwen" },
      ],
    });

    // First call: tries all 3 providers (gpt-primary fails, minimax fails, local-qwen succeeds)
    const action1 = await client.nextAction({
      systemPrompt: "System prompt",
      conversation: "Conversation",
      toolTrace: [],
      toolCatalog: ["searchSupport"],
    });
    assert.equal(action1.kind, "final");
    assert.deepEqual(calls, ["gpt-primary", "minimax-free", "local-qwen"]);

    // Second call: circuit breaker should skip the failed cloud providers, going straight to local-qwen
    calls.length = 0;
    const action2 = await client.nextAction({
      systemPrompt: "System prompt",
      conversation: "Conversation",
      toolTrace: [],
      toolCatalog: ["searchSupport"],
    });
    assert.equal(action2.kind, "final");
    // Should only call local-qwen (the last provider is always kept as final fallback,
    // but the first two should be circuit-broken)
    assert.deepEqual(calls, ["local-qwen"]);
  } finally {
    globalThis.fetch = originalFetch;
    resetCircuitBreakerState();
  }
});
