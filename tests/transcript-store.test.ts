import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildThreadKey, TranscriptStore } from "../src/store/transcript-store.js";
import type { AppConfig } from "../src/config.js";
import type { DiscordEventRecord, RouteConfig } from "../src/types.js";

function makeEvent(overrides: Partial<DiscordEventRecord> = {}): DiscordEventRecord {
  return {
    guildId: "guild1",
    channelId: "chan1",
    messageId: "msg-" + Math.random().toString(36).slice(2, 8),
    authorId: "user1",
    authorName: "TestUser",
    content: "Hello world",
    createdAt: "2026-03-16T00:00:00Z",
    ...overrides,
  };
}

function makeRoute(overrides: Partial<RouteConfig> = {}): RouteConfig {
  return {
    id: "test-route",
    guildId: "guild1",
    channelId: "chan1",
    mode: "channel" as const,
    instructionRef: "test-instructions",
    repoScopes: ["test-repo"],
    enabled: true,
    ...overrides,
  };
}

function makeConfig(tempDir: string): AppConfig {
  return {
    rootDir: tempDir,
    manifestsDir: path.join(tempDir, "resources", "manifests"),
    instructionsDir: path.join(tempDir, "resources", "instructions"),
    transcriptsDir: path.join(tempDir, "data", "transcripts"),
    sqlitePath: path.join(tempDir, "data", "sqlite", "stevesbot.sqlite"),
    logsDir: path.join(tempDir, "logs"),
    repos: [],
    routes: [],
    resourceMap: [],
  };
}

test("buildThreadKey returns channel-based key for channel mode", () => {
  const route = makeRoute({ id: "vdo-misc", channelId: "c123", mode: "channel" });
  const event = makeEvent();
  assert.equal(buildThreadKey(route, event), "vdo-misc:c123");
});

test("buildThreadKey returns thread-based key for thread mode", () => {
  const route = makeRoute({ id: "vdo-support", mode: "thread" });
  const event = makeEvent({ threadId: "t456" });
  assert.equal(buildThreadKey(route, event), "vdo-support:t456");
});

test("buildThreadKey uses 'unthreaded' when threadId is missing in thread mode", () => {
  const route = makeRoute({ id: "vdo-support", mode: "thread" });
  const event = makeEvent();
  assert.equal(buildThreadKey(route, event), "vdo-support:unthreaded");
});

test("TranscriptStore.append creates transcript file and returns metadata", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-ts-"));
  try {
    const config = makeConfig(tempDir);
    const store = new TranscriptStore(config);
    const route = makeRoute({ guildId: "g1", channelId: "c1" });
    const event = makeEvent({ guildId: "g1", channelId: "c1" });

    const result = await store.append(route, event);
    assert.ok(result.filePath.endsWith("c1.jsonl"));
    assert.equal(result.threadKey, "test-route:c1");

    const content = readFileSync(result.filePath, "utf8");
    const parsed = JSON.parse(content.trim());
    assert.equal(parsed.content, "Hello world");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("TranscriptStore.append writes to thread-specific file for thread mode", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-ts-"));
  try {
    const config = makeConfig(tempDir);
    const store = new TranscriptStore(config);
    const route = makeRoute({ mode: "thread", guildId: "g1", channelId: "c1" });
    const event = makeEvent({ guildId: "g1", channelId: "c1", threadId: "t789" });

    const result = await store.append(route, event);
    assert.ok(result.filePath.includes("threads"));
    assert.ok(result.filePath.endsWith("t789.jsonl"));
    assert.equal(result.threadKey, "test-route:t789");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("TranscriptStore.append appends multiple events to same file", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-ts-"));
  try {
    const config = makeConfig(tempDir);
    const store = new TranscriptStore(config);
    const route = makeRoute({ guildId: "g1", channelId: "c1" });

    await store.append(route, makeEvent({ content: "First message" }));
    await store.append(route, makeEvent({ content: "Second message" }));
    const { filePath } = await store.append(route, makeEvent({ content: "Third message" }));

    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).content, "First message");
    assert.equal(JSON.parse(lines[2]).content, "Third message");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("TranscriptStore.getContext returns empty for nonexistent transcript", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-ts-"));
  try {
    const config = makeConfig(tempDir);
    const store = new TranscriptStore(config);
    const route = makeRoute();
    const event = makeEvent();

    const ctx = await store.getContext(route, event);
    assert.equal(ctx.recentMessages.length, 0);
    assert.equal(ctx.currentMessage, event);
    assert.equal(ctx.route, route);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("TranscriptStore.getContext returns recent messages from transcript", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-ts-"));
  try {
    const config = makeConfig(tempDir);
    const store = new TranscriptStore(config);
    const route = makeRoute({ guildId: "g1", channelId: "c1" });

    // Write 3 messages
    for (let i = 0; i < 3; i++) {
      await store.append(route, makeEvent({ content: "Message " + i }));
    }

    const event = makeEvent({ content: "Current" });
    const ctx = await store.getContext(route, event);
    assert.equal(ctx.recentMessages.length, 3);
    assert.equal(ctx.recentMessages[0].content, "Message 0");
    assert.equal(ctx.recentMessages[2].content, "Message 2");
    assert.equal(ctx.currentMessage.content, "Current");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("TranscriptStore.getContext limits to last 10 messages", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-ts-"));
  try {
    const config = makeConfig(tempDir);
    const store = new TranscriptStore(config);
    const route = makeRoute({ guildId: "g1", channelId: "c1" });

    // Write 15 messages
    for (let i = 0; i < 15; i++) {
      await store.append(route, makeEvent({ content: "Message " + i }));
    }

    const event = makeEvent();
    const ctx = await store.getContext(route, event);
    assert.equal(ctx.recentMessages.length, 10);
    assert.equal(ctx.recentMessages[0].content, "Message 5");
    assert.equal(ctx.recentMessages[9].content, "Message 14");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("TranscriptStore.getContext includes firstMessage for thread mode", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-ts-"));
  try {
    const config = makeConfig(tempDir);
    const store = new TranscriptStore(config);
    const route = makeRoute({ mode: "thread", guildId: "g1", channelId: "c1" });

    const firstEvent = makeEvent({ threadId: "t100", content: "Thread opener" });
    await store.append(route, firstEvent);
    await store.append(route, makeEvent({ threadId: "t100", content: "Reply 1" }));

    const current = makeEvent({ threadId: "t100", content: "Current" });
    const ctx = await store.getContext(route, current);
    assert.ok(ctx.firstMessage);
    assert.equal(ctx.firstMessage!.content, "Thread opener");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("TranscriptStore.getContext does not set firstMessage for channel mode", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-ts-"));
  try {
    const config = makeConfig(tempDir);
    const store = new TranscriptStore(config);
    const route = makeRoute({ mode: "channel", guildId: "g1", channelId: "c1" });

    await store.append(route, makeEvent({ content: "First in channel" }));
    const current = makeEvent({ content: "Current" });
    const ctx = await store.getContext(route, current);
    assert.equal(ctx.firstMessage, undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
