import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import type { DiscordEventRecord, RouteConfig } from "../src/types.js";
import { DiscordReviewPublisher } from "../src/review-publisher.js";

const route: RouteConfig = {
  id: "vdo-ninja-support",
  guildId: "444444444444444444",
  channelId: "555555555555555555",
  mode: "thread",
  instructionRef: "/tmp/instruction.md",
  repoScopes: ["vdo-ninja"],
  enabled: true,
};

function makeConfig(reviewEnabled = true): AppConfig {
  return {
    rootDir: "/tmp/test",
    manifestsDir: "/tmp/test/resources/manifests",
    instructionsDir: "/tmp/test/resources/instructions",
    transcriptsDir: "/tmp/test/data/transcripts",
    sqlitePath: "/tmp/test/stevesbot.sqlite",
    logsDir: "/tmp/test/logs",
    repos: [],
    routes: [route],
    reviewChannel: reviewEnabled
      ? { guildId: "222222222222222222", channelId: "333333333333333333", enabled: true }
      : undefined,
    resourceMap: [],
  };
}

function makeEvent(): DiscordEventRecord {
  return {
    guildId: route.guildId,
    channelId: route.channelId,
    threadId: "thread-1",
    messageId: "msg-1",
    authorId: "user-1",
    authorName: "testuser",
    content: "How do I add a relay?",
    createdAt: "2026-03-16T00:00:00Z",
    sourceUrl: "https://discord.com/channels/guild/thread/msg",
  };
}

test("DiscordReviewPublisher throws when review channel is not enabled", async () => {
  const config = makeConfig(false);
  const publisher = new DiscordReviewPublisher(config, "fake-token");
  await assert.rejects(
    () => publisher.publish(route, makeEvent(), "Draft response"),
    /not enabled/,
  );
});

test("DiscordReviewPublisher sends message with usage buttons when runId provided", async () => {
  const config = makeConfig(true);
  let capturedBody: Record<string, unknown> | undefined;
  let capturedUrl: string | undefined;
  let capturedHeaders: Record<string, string> | undefined;

  // Mock global fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedHeaders = Object.fromEntries(
      Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)]),
    );
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "review-msg-123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const publisher = new DiscordReviewPublisher(config, "test-bot-token");
    const result = await publisher.publish(route, makeEvent(), "Here is a draft", 42);

    assert.equal(result.channelId, "333333333333333333");
    assert.equal(result.messageId, "review-msg-123");
    assert.ok(capturedUrl?.includes("/channels/333333333333333333/messages"));
    assert.equal(capturedHeaders?.["Authorization"], "Bot test-bot-token");
    assert.ok(capturedBody?.content);
    // Should have components (buttons) when runId is provided
    const components = capturedBody?.components as Array<{ components: Array<{ custom_id: string }> }>;
    assert.ok(Array.isArray(components), "Should have components array");
    const buttonIds = components[0]?.components.map((c) => c.custom_id);
    assert.ok(buttonIds?.includes("draft_used:42"));
    assert.ok(buttonIds?.includes("draft_modified:42"));
    assert.ok(buttonIds?.includes("draft_skipped:42"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DiscordReviewPublisher omits buttons when no runId", async () => {
  const config = makeConfig(true);
  let capturedBody: Record<string, unknown> | undefined;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "review-msg-456" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const publisher = new DiscordReviewPublisher(config, "test-bot-token");
    const result = await publisher.publish(route, makeEvent(), "Draft without buttons");

    assert.equal(result.messageId, "review-msg-456");
    assert.equal(capturedBody?.components, undefined, "Should NOT have components when no runId");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DiscordReviewPublisher throws on Discord API error", async () => {
  const config = makeConfig(true);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const publisher = new DiscordReviewPublisher(config, "bad-token");
    await assert.rejects(
      () => publisher.publish(route, makeEvent(), "Draft"),
      /review delivery failed.*401/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DiscordReviewPublisher throws when response has no message id", async () => {
  const config = makeConfig(true);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const publisher = new DiscordReviewPublisher(config, "test-token");
    await assert.rejects(
      () => publisher.publish(route, makeEvent(), "Draft"),
      /review delivery failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
