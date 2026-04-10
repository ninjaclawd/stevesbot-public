import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initKnowledgeDb, ensureFtsSync, loadMinedThreads, searchKnowledgeBase } from "../src/knowledge-base.js";

function makeTempDir() {
  return mkdtempSync(path.join(tmpdir(), "stevesbot-kb-"));
}

function makeThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    qwenProcessed: true,
    threadId: "thread-" + Math.random().toString(36).slice(2, 8),
    threadName: "Test thread",
    channelName: "vdo-ninja-support",
    sourceUrl: "https://discord.com/channels/1/2/3",
    createdAt: "2026-03-01T00:00:00.000Z",
    lastMessageAt: "2026-03-02T00:00:00.000Z",
    messageCount: 5,
    participantCount: 2,
    participants: ["user1", "user2"],
    summary: "User had trouble with audio in OBS browser source",
    problemStatement: "Audio not working when using OBS browser source with VDO.Ninja",
    solution: "Add &proaudio to the URL to enable pro audio mode",
    resolved: true,
    keywords: ["audio", "OBS", "browser source", "proaudio"],
    products: ["vdo-ninja"],
    platforms: ["browser"],
    errorSignals: [],
    category: "troubleshooting",
    ...overrides,
  };
}

function writeJsonl(dir: string, filename: string, threads: Record<string, unknown>[]): string {
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, threads.map(t => JSON.stringify(t)).join("\n"), "utf8");
  return filePath;
}

// ─── initKnowledgeDb ─────────────────────────────────────────────────────────

test("initKnowledgeDb creates mined_threads and FTS tables", () => {
  const dir = makeTempDir();
  try {
    const db = initKnowledgeDb(path.join(dir, "kb.sqlite"));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    assert.ok(names.includes("mined_threads"), "mined_threads table should exist");
    assert.ok(names.includes("mined_threads_fts"), "mined_threads_fts table should exist");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("initKnowledgeDb is idempotent", () => {
  const dir = makeTempDir();
  try {
    const dbPath = path.join(dir, "kb.sqlite");
    const db1 = initKnowledgeDb(dbPath);
    db1.close();
    const db2 = initKnowledgeDb(dbPath);
    const count = (db2.prepare("SELECT COUNT(*) as c FROM mined_threads").get() as { c: number }).c;
    assert.equal(count, 0);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── loadMinedThreads ────────────────────────────────────────────────────────

test("loadMinedThreads loads JSONL into database and FTS", () => {
  const dir = makeTempDir();
  try {
    const db = initKnowledgeDb(path.join(dir, "kb.sqlite"));
    const jsonlPath = writeJsonl(dir, "threads.jsonl", [
      makeThread({ threadId: "t1", summary: "Audio issue with OBS" }),
      makeThread({ threadId: "t2", summary: "Video freezing on mobile" }),
    ]);
    const loaded = loadMinedThreads(db, jsonlPath);
    assert.equal(loaded, 2);

    const dbCount = (db.prepare("SELECT COUNT(*) as c FROM mined_threads").get() as { c: number }).c;
    assert.equal(dbCount, 2);

    const ftsCount = (db.prepare("SELECT COUNT(*) as c FROM mined_threads_fts").get() as { c: number }).c;
    assert.equal(ftsCount, 2);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadMinedThreads skips entries without qwenProcessed or summary", () => {
  const dir = makeTempDir();
  try {
    const db = initKnowledgeDb(path.join(dir, "kb.sqlite"));
    const jsonlPath = writeJsonl(dir, "threads.jsonl", [
      makeThread({ threadId: "t1" }),
      { threadId: "t2", summary: "no qwen" }, // missing qwenProcessed
      { qwenProcessed: true, threadId: "t3" }, // missing summary
    ]);
    const loaded = loadMinedThreads(db, jsonlPath);
    assert.equal(loaded, 1, "only the valid thread should load");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadMinedThreads replaces existing threads on reload", () => {
  const dir = makeTempDir();
  try {
    const db = initKnowledgeDb(path.join(dir, "kb.sqlite"));
    const jsonlPath = writeJsonl(dir, "threads.jsonl", [
      makeThread({ threadId: "t1", summary: "Original summary" }),
    ]);
    loadMinedThreads(db, jsonlPath);

    // Reload with updated summary
    const jsonlPath2 = writeJsonl(dir, "threads2.jsonl", [
      makeThread({ threadId: "t1", summary: "Updated summary" }),
    ]);
    loadMinedThreads(db, jsonlPath2);

    const row = db.prepare("SELECT summary FROM mined_threads WHERE thread_id = 't1'").get() as { summary: string };
    assert.equal(row.summary, "Updated summary");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── ensureFtsSync ───────────────────────────────────────────────────────────

test("ensureFtsSync rebuilds FTS when rows are missing", () => {
  const dir = makeTempDir();
  try {
    const db = initKnowledgeDb(path.join(dir, "kb.sqlite"));
    const jsonlPath = writeJsonl(dir, "threads.jsonl", [
      makeThread({ threadId: "t1", summary: "Cache clearing issue" }),
      makeThread({ threadId: "t2", summary: "Relay server problem" }),
    ]);
    loadMinedThreads(db, jsonlPath);

    // Deliberately delete FTS rows to simulate desync
    db.exec("DELETE FROM mined_threads_fts");
    const ftsBefore = (db.prepare("SELECT COUNT(*) as c FROM mined_threads_fts").get() as { c: number }).c;
    assert.equal(ftsBefore, 0);

    // ensureFtsSync should detect and fix
    ensureFtsSync(db);

    const ftsAfter = (db.prepare("SELECT COUNT(*) as c FROM mined_threads_fts").get() as { c: number }).c;
    assert.equal(ftsAfter, 2);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureFtsSync is a no-op when already synced", () => {
  const dir = makeTempDir();
  try {
    const db = initKnowledgeDb(path.join(dir, "kb.sqlite"));
    const jsonlPath = writeJsonl(dir, "threads.jsonl", [
      makeThread({ threadId: "t1" }),
    ]);
    loadMinedThreads(db, jsonlPath);

    // Should not throw and not change counts
    ensureFtsSync(db);

    const ftsCount = (db.prepare("SELECT COUNT(*) as c FROM mined_threads_fts").get() as { c: number }).c;
    assert.equal(ftsCount, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── searchKnowledgeBase ─────────────────────────────────────────────────────

test("searchKnowledgeBase finds threads by keyword", () => {
  const dir = makeTempDir();
  try {
    const db = initKnowledgeDb(path.join(dir, "kb.sqlite"));
    const jsonlPath = writeJsonl(dir, "threads.jsonl", [
      makeThread({ threadId: "t1", summary: "Audio not working in OBS browser source", keywords: ["audio", "OBS"] }),
      makeThread({ threadId: "t2", summary: "Video freezing on mobile Safari", keywords: ["video", "mobile", "Safari"] }),
      makeThread({ threadId: "t3", summary: "Screen share has no audio in Chrome", keywords: ["screen share", "audio", "Chrome"] }),
    ]);
    loadMinedThreads(db, jsonlPath);

    const results = searchKnowledgeBase(db, "audio OBS");
    assert.ok(results.length >= 1, "should find at least one result");
    assert.ok(results.some(r => r.threadId === "t1"), "should find the OBS audio thread");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchKnowledgeBase OR mode finds broader results", () => {
  const dir = makeTempDir();
  try {
    const db = initKnowledgeDb(path.join(dir, "kb.sqlite"));
    const jsonlPath = writeJsonl(dir, "threads.jsonl", [
      makeThread({ threadId: "t1", summary: "Audio crackling in Firefox" }),
      makeThread({ threadId: "t2", summary: "Video latency problems" }),
      makeThread({ threadId: "t3", summary: "Audio delay on mobile" }),
    ]);
    loadMinedThreads(db, jsonlPath);

    const andResults = searchKnowledgeBase(db, "audio mobile");
    const orResults = searchKnowledgeBase(db, "audio mobile", { orMode: true });
    assert.ok(orResults.length >= andResults.length, "OR mode should return same or more results");
    assert.ok(orResults.length >= 2, "OR mode should find audio AND mobile threads");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchKnowledgeBase returns empty for empty/short query", () => {
  const dir = makeTempDir();
  try {
    const db = initKnowledgeDb(path.join(dir, "kb.sqlite"));
    const jsonlPath = writeJsonl(dir, "threads.jsonl", [
      makeThread({ threadId: "t1" }),
    ]);
    loadMinedThreads(db, jsonlPath);

    assert.deepEqual(searchKnowledgeBase(db, ""), []);
    assert.deepEqual(searchKnowledgeBase(db, "a"), [], "single-char tokens should be filtered");
    assert.deepEqual(searchKnowledgeBase(db, "! @# $"), [], "punctuation-only should return empty");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchKnowledgeBase filters by category", () => {
  const dir = makeTempDir();
  try {
    const db = initKnowledgeDb(path.join(dir, "kb.sqlite"));
    const jsonlPath = writeJsonl(dir, "threads.jsonl", [
      makeThread({ threadId: "t1", summary: "Audio issue in OBS", category: "troubleshooting" }),
      makeThread({ threadId: "t2", summary: "Audio feature request for OBS", category: "feature-request" }),
    ]);
    loadMinedThreads(db, jsonlPath);

    const results = searchKnowledgeBase(db, "audio OBS", { category: "troubleshooting" });
    assert.equal(results.length, 1);
    assert.equal(results[0].category, "troubleshooting");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchKnowledgeBase filters by resolvedOnly", () => {
  const dir = makeTempDir();
  try {
    const db = initKnowledgeDb(path.join(dir, "kb.sqlite"));
    const jsonlPath = writeJsonl(dir, "threads.jsonl", [
      makeThread({ threadId: "t1", summary: "Resolved audio issue", resolved: true }),
      makeThread({ threadId: "t2", summary: "Unresolved audio problem", resolved: false }),
    ]);
    loadMinedThreads(db, jsonlPath);

    const results = searchKnowledgeBase(db, "audio", { resolvedOnly: true });
    assert.ok(results.every(r => r.resolved), "all results should be resolved");
    assert.ok(results.some(r => r.threadId === "t1"));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchKnowledgeBase respects limit", () => {
  const dir = makeTempDir();
  try {
    const db = initKnowledgeDb(path.join(dir, "kb.sqlite"));
    const threads = Array.from({ length: 10 }, (_, i) =>
      makeThread({ threadId: `t${i}`, summary: `Audio problem variant ${i}` })
    );
    const jsonlPath = writeJsonl(dir, "threads.jsonl", threads);
    loadMinedThreads(db, jsonlPath);

    const results = searchKnowledgeBase(db, "audio problem", { limit: 3 });
    assert.ok(results.length <= 3, "should respect limit");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchKnowledgeBase limit is capped at 15", () => {
  const dir = makeTempDir();
  try {
    const db = initKnowledgeDb(path.join(dir, "kb.sqlite"));
    const threads = Array.from({ length: 20 }, (_, i) =>
      makeThread({ threadId: `t${i}`, summary: `Cache clearing variant ${i}` })
    );
    const jsonlPath = writeJsonl(dir, "threads.jsonl", threads);
    loadMinedThreads(db, jsonlPath);

    const results = searchKnowledgeBase(db, "cache clearing", { limit: 100 });
    assert.ok(results.length <= 15, "limit should be capped at 15");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchKnowledgeBase returns correct result shape", () => {
  const dir = makeTempDir();
  try {
    const db = initKnowledgeDb(path.join(dir, "kb.sqlite"));
    const jsonlPath = writeJsonl(dir, "threads.jsonl", [
      makeThread({
        threadId: "t1",
        threadName: "OBS audio thread",
        channelName: "vdo-ninja-support",
        sourceUrl: "https://discord.com/channels/1/2/3",
        summary: "OBS audio not working",
        problemStatement: "No audio in OBS",
        solution: "Use proaudio parameter",
        resolved: true,
        keywords: ["audio", "OBS"],
        products: ["vdo-ninja"],
        category: "troubleshooting",
      }),
    ]);
    loadMinedThreads(db, jsonlPath);

    const results = searchKnowledgeBase(db, "audio OBS");
    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.threadId, "t1");
    assert.equal(r.threadName, "OBS audio thread");
    assert.equal(r.channelName, "vdo-ninja-support");
    assert.equal(r.sourceUrl, "https://discord.com/channels/1/2/3");
    assert.equal(r.summary, "OBS audio not working");
    assert.equal(r.problemStatement, "No audio in OBS");
    assert.equal(r.solution, "Use proaudio parameter");
    assert.equal(r.resolved, true);
    assert.deepEqual(r.keywords, ["audio", "OBS"]);
    assert.deepEqual(r.products, ["vdo-ninja"]);
    assert.equal(r.category, "troubleshooting");
    assert.equal(typeof r.relevanceScore, "number");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchKnowledgeBase handles special characters in query gracefully", () => {
  const dir = makeTempDir();
  try {
    const db = initKnowledgeDb(path.join(dir, "kb.sqlite"));
    const jsonlPath = writeJsonl(dir, "threads.jsonl", [
      makeThread({ threadId: "t1", summary: "Error with &proaudio parameter" }),
    ]);
    loadMinedThreads(db, jsonlPath);

    // Should not throw — special chars stripped by buildSafeFtsQuery
    const results = searchKnowledgeBase(db, "&proaudio (error)");
    assert.ok(Array.isArray(results));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
