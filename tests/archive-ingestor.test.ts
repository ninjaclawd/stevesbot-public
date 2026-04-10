import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/store/database.js";
import { ArchiveIngestor } from "../src/history/archive-ingestor.js";

function makeConfig(rootDir: string): AppConfig {
  const transcriptsDir = path.join(rootDir, "data", "transcripts");
  const sqliteDir = path.join(rootDir, "data", "sqlite");
  mkdirSync(transcriptsDir, { recursive: true });
  mkdirSync(sqliteDir, { recursive: true });
  return {
    rootDir,
    manifestsDir: path.join(rootDir, "resources", "manifests"),
    instructionsDir: path.join(rootDir, "resources", "instructions"),
    transcriptsDir,
    sqlitePath: path.join(sqliteDir, "stevesbot.sqlite"),
    logsDir: path.join(rootDir, "logs"),
    repos: [],
    routes: [],
    resourceMap: [],
  };
}

function writeTranscript(dir: string, filename: string, lines: Array<{ content: string; createdAt?: string }>): void {
  const jsonl = lines.map(l => JSON.stringify({ content: l.content, createdAt: l.createdAt ?? "2026-03-01T00:00:00Z" })).join("\n");
  writeFileSync(path.join(dir, filename), jsonl, "utf8");
}

test("ArchiveIngestor ingests multi-line JSONL transcripts", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-ingestor-"));
  try {
    const config = makeConfig(tempDir);
    const db = new AppDatabase(config.sqlitePath);
    writeTranscript(config.transcriptsDir, "thread1.jsonl", [
      { content: "How do I add a relay?", createdAt: "2026-03-01T10:00:00Z" },
      { content: "Use &relay in the URL", createdAt: "2026-03-01T10:05:00Z" },
    ]);
    writeTranscript(config.transcriptsDir, "thread2.jsonl", [
      { content: "My camera is not working", createdAt: "2026-03-02T10:00:00Z" },
      { content: "Try a different browser", createdAt: "2026-03-02T10:05:00Z" },
      { content: "That fixed it, thanks!", createdAt: "2026-03-02T10:10:00Z" },
    ]);

    const ingestor = new ArchiveIngestor(config, db);
    const count = await ingestor.ingestHistoricalThreads("vdo-ninja-support");
    assert.equal(count, 2, "Should ingest 2 transcripts");

    const records = db.findHistoricalSupport("relay", "vdo-ninja-support", 10);
    assert.ok(records.length >= 1, "Should find relay record via search");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ArchiveIngestor skips files with fewer than 2 lines", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-ingestor-"));
  try {
    const config = makeConfig(tempDir);
    const db = new AppDatabase(config.sqlitePath);

    // Single-line file
    writeTranscript(config.transcriptsDir, "single.jsonl", [
      { content: "Just one message" },
    ]);
    // Empty file
    writeFileSync(path.join(config.transcriptsDir, "empty.jsonl"), "", "utf8");

    const ingestor = new ArchiveIngestor(config, db);
    const count = await ingestor.ingestHistoricalThreads("vdo-ninja-support");
    assert.equal(count, 0, "Should not ingest single-line or empty files");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ArchiveIngestor skips transcripts with empty content", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-ingestor-"));
  try {
    const config = makeConfig(tempDir);
    const db = new AppDatabase(config.sqlitePath);

    // First line has empty content
    const jsonl = [
      JSON.stringify({ content: "", createdAt: "2026-03-01T00:00:00Z" }),
      JSON.stringify({ content: "Some answer", createdAt: "2026-03-01T00:01:00Z" }),
    ].join("\n");
    writeFileSync(path.join(config.transcriptsDir, "empty-q.jsonl"), jsonl, "utf8");

    const ingestor = new ArchiveIngestor(config, db);
    const count = await ingestor.ingestHistoricalThreads("vdo-ninja-support");
    assert.equal(count, 0, "Should skip when first line has empty content");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ArchiveIngestor ignores non-JSONL files", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-ingestor-"));
  try {
    const config = makeConfig(tempDir);
    const db = new AppDatabase(config.sqlitePath);

    writeFileSync(path.join(config.transcriptsDir, "readme.md"), "# Not a transcript", "utf8");
    writeFileSync(path.join(config.transcriptsDir, "data.json"), '{"not": "jsonl"}', "utf8");
    writeTranscript(config.transcriptsDir, "valid.jsonl", [
      { content: "Question?" },
      { content: "Answer." },
    ]);

    const ingestor = new ArchiveIngestor(config, db);
    const count = await ingestor.ingestHistoricalThreads("vdo-ninja-support");
    assert.equal(count, 1, "Should only ingest the .jsonl file");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ArchiveIngestor walks subdirectories recursively", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-ingestor-"));
  try {
    const config = makeConfig(tempDir);
    const db = new AppDatabase(config.sqlitePath);

    const subDir = path.join(config.transcriptsDir, "vdo-ninja-support", "thread-123");
    mkdirSync(subDir, { recursive: true });
    writeTranscript(subDir, "transcript.jsonl", [
      { content: "Nested question" },
      { content: "Nested answer" },
    ]);

    const ingestor = new ArchiveIngestor(config, db);
    const count = await ingestor.ingestHistoricalThreads("vdo-ninja-support");
    assert.equal(count, 1, "Should find transcripts in subdirectories");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ArchiveIngestor uses first and last lines as question and answer", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-ingestor-"));
  try {
    const config = makeConfig(tempDir);
    const db = new AppDatabase(config.sqlitePath);

    writeTranscript(config.transcriptsDir, "thread.jsonl", [
      { content: "My screen is black when I join" },
      { content: "Middle message - troubleshooting" },
      { content: "Middle message - more info" },
      { content: "Try adding &codec=h264 to your URL" },
    ]);

    const ingestor = new ArchiveIngestor(config, db);
    await ingestor.ingestHistoricalThreads("vdo-ninja-support");

    // Search for the question content
    const byQ = db.findHistoricalSupport("black screen join", "vdo-ninja-support", 10);
    assert.ok(byQ.length >= 1, "Should find by question content");

    // Search for the answer content
    const byA = db.findHistoricalSupport("codec h264", "vdo-ninja-support", 10);
    assert.ok(byA.length >= 1, "Should find by answer content");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ArchiveIngestor handles empty transcript directory gracefully", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-ingestor-"));
  try {
    const config = makeConfig(tempDir);
    const db = new AppDatabase(config.sqlitePath);

    const ingestor = new ArchiveIngestor(config, db);
    const count = await ingestor.ingestHistoricalThreads("vdo-ninja-support");
    assert.equal(count, 0, "Should handle empty directory");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ─── Archive Search ──────────────────────────────────────────────────────────

import { initArchiveDb, searchArchive, searchArchiveThreads } from "../src/discord-archive.js";

test("searchArchive finds messages by FTS keyword match", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stevesbot-archive-search-"));
  try {
    const db = initArchiveDb(path.join(dir, "archive.sqlite"));

    // Insert test messages
    db.prepare(`INSERT INTO archived_messages (message_id, channel_id, thread_id, thread_name, guild_id, author_id, author_name, content, created_at, source_url, route_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "msg-1", "chan-1", "thread-1", "Audio issues", "guild-1", "user-1", "alice", "I can't hear any audio in OBS browser source", "2026-03-01T10:00:00.000Z", "https://discord.com/test/1", "vdo-ninja-support"
    );
    db.prepare(`INSERT INTO archived_messages (message_id, channel_id, thread_id, thread_name, guild_id, author_id, author_name, content, created_at, source_url, route_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "msg-2", "chan-1", "thread-1", "Audio issues", "guild-1", "user-2", "steve", "Try adding &proaudio to your URL", "2026-03-01T10:05:00.000Z", "https://discord.com/test/2", "vdo-ninja-support"
    );
    db.prepare(`INSERT INTO archived_messages (message_id, channel_id, thread_id, thread_name, guild_id, author_id, author_name, content, created_at, source_url, route_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "msg-3", "chan-1", "thread-2", "Screen share", "guild-1", "user-3", "bob", "Screen sharing is frozen on my iPad", "2026-03-02T10:00:00.000Z", "https://discord.com/test/3", "vdo-ninja-support"
    );

    const results = searchArchive(db, "audio OBS");
    assert.ok(results.length >= 1, "should find audio-related messages");
    assert.ok(results.some(r => r.content.includes("audio")), "should match audio content");

    // Test route filtering
    const routeResults = searchArchive(db, "audio", { routeId: "vdo-ninja-support" });
    assert.ok(routeResults.length >= 1);

    // Test empty query
    const emptyResults = searchArchive(db, "");
    assert.deepEqual(emptyResults, []);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchArchiveThreads groups messages by thread and returns preview", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stevesbot-archive-threads-"));
  try {
    const db = initArchiveDb(path.join(dir, "archive.sqlite"));

    // Insert a thread with multiple messages
    const msgs = [
      { id: "m1", thread: "t1", name: "TikTok chat broken", author: "user1", content: "TikTok chat not loading at all", time: "2026-03-01T10:00:00.000Z" },
      { id: "m2", thread: "t1", name: "TikTok chat broken", author: "steve", content: "Try switching to WebSocket mode", time: "2026-03-01T10:05:00.000Z" },
      { id: "m3", thread: "t1", name: "TikTok chat broken", author: "user1", content: "That fixed it, thanks!", time: "2026-03-01T10:10:00.000Z" },
      { id: "m4", thread: "t2", name: "Camera frozen", author: "user2", content: "My camera freezes every few seconds", time: "2026-03-02T10:00:00.000Z" },
    ];

    const insert = db.prepare(`INSERT INTO archived_messages (message_id, channel_id, thread_id, thread_name, guild_id, author_id, author_name, content, created_at, source_url, route_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const m of msgs) {
      insert.run(m.id, "chan-1", m.thread, m.name, "guild-1", m.author, m.author, m.content, m.time, `https://discord.com/test/${m.id}`, "vdo-ninja-support");
    }

    const threads = searchArchiveThreads(db, "TikTok chat", { limit: 5 });
    assert.ok(threads.length >= 1, "should find the TikTok thread");

    const tiktokThread = threads.find(t => t.threadName === "TikTok chat broken");
    assert.ok(tiktokThread, "should find TikTok chat broken thread");
    assert.equal(tiktokThread.messageCount, 3, "thread should have 3 messages");
    assert.ok(tiktokThread.participants.includes("user1"), "should include user1");
    assert.ok(tiktokThread.participants.includes("steve"), "should include steve");
    assert.ok(tiktokThread.previewMessages.length > 0, "should include preview messages");
    assert.ok(tiktokThread.previewMessages[0].content.includes("TikTok"), "first preview should mention TikTok");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchArchiveThreads respects limit", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stevesbot-archive-limit-"));
  try {
    const db = initArchiveDb(path.join(dir, "archive.sqlite"));

    // Create 5 threads about audio
    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO archived_messages (message_id, channel_id, thread_id, thread_name, guild_id, author_id, author_name, content, created_at, source_url, route_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        `msg-${i}`, "chan-1", `thread-${i}`, `Audio issue ${i}`, "guild-1", "user-1", "alice", `I have an audio problem variant ${i}`, `2026-03-0${i + 1}T10:00:00.000Z`, `https://test/${i}`, "vdo-ninja-support"
      );
    }

    const threads = searchArchiveThreads(db, "audio problem", { limit: 2 });
    assert.ok(threads.length <= 2, "should respect limit of 2");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
