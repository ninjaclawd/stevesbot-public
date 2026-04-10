import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/store/database.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function createTempDb(): { db: AppDatabase; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stevesbot-test-"));
  const dbPath = path.join(tmpDir, "test.sqlite");
  const db = new AppDatabase(dbPath);
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("getUserMemory returns null for unknown user", () => {
  const { db, cleanup } = createTempDb();
  try {
    const result = db.getUserMemory("unknown-user-123");
    assert.equal(result, null);
  } finally {
    cleanup();
  }
});

test("updateUserMemory creates new user record on first interaction", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.updateUserMemory({
      authorId: "user-1",
      authorName: "TestUser",
      routeId: "vdo-ninja-support",
      category: "troubleshooting",
      rationale: "User cannot share camera in Chrome",
      resolved: false,
    });

    const mem = db.getUserMemory("user-1");
    assert.ok(mem);
    assert.equal(mem.authorId, "user-1");
    assert.equal(mem.authorName, "TestUser");
    assert.equal(mem.interactionCount, 1);
    assert.deepEqual(mem.products, ["vdo-ninja"]);
    assert.equal(mem.recentIssues.length, 1);
    assert.equal(mem.recentIssues[0].category, "troubleshooting");
    assert.equal(mem.recentIssues[0].resolved, false);
    assert.equal(mem.resolvedCount, 0);
    assert.equal(mem.unresolvedCount, 1);
  } finally {
    cleanup();
  }
});

test("updateUserMemory increments counts and adds products across interactions", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.updateUserMemory({
      authorId: "user-2",
      authorName: "Alice",
      routeId: "vdo-ninja-support",
      category: "troubleshooting",
      rationale: "Camera issue",
      resolved: false,
    });

    db.updateUserMemory({
      authorId: "user-2",
      authorName: "Alice",
      routeId: "social-stream-support",
      category: "how-to",
      rationale: "How to add TikTok chat",
      resolved: true,
    });

    db.updateUserMemory({
      authorId: "user-2",
      authorName: "Alice",
      routeId: "vdo-ninja-bug-report",
      category: "bug-report",
      rationale: "Black screen on relay",
      resolved: false,
    });

    const mem = db.getUserMemory("user-2");
    assert.ok(mem);
    assert.equal(mem.interactionCount, 3);
    assert.equal(mem.resolvedCount, 1);
    assert.equal(mem.unresolvedCount, 2);
    // Products should include vdo-ninja, social-stream, vdo-ninja (deduped via Set)
    assert.ok(mem.products.includes("vdo-ninja"));
    assert.ok(mem.products.includes("social-stream"));
    assert.equal(mem.recentIssues.length, 3);
    // Most recent first
    assert.equal(mem.recentIssues[0].category, "bug-report");
    assert.equal(mem.recentIssues[1].category, "how-to");
    assert.equal(mem.recentIssues[2].category, "troubleshooting");
  } finally {
    cleanup();
  }
});

test("updateUserMemory caps recent issues at 5", () => {
  const { db, cleanup } = createTempDb();
  try {
    for (let i = 0; i < 7; i++) {
      db.updateUserMemory({
        authorId: "user-3",
        authorName: "Bob",
        routeId: "vdo-ninja-support",
        category: "issue-" + i,
        rationale: "Issue number " + i,
        resolved: i % 2 === 0,
      });
    }

    const mem = db.getUserMemory("user-3");
    assert.ok(mem);
    assert.equal(mem.interactionCount, 7);
    assert.equal(mem.recentIssues.length, 5);
    // Most recent should be issue-6
    assert.equal(mem.recentIssues[0].category, "issue-6");
    assert.equal(mem.recentIssues[4].category, "issue-2");
  } finally {
    cleanup();
  }
});

test("formatUserMemoryContext returns empty string for unknown user", () => {
  const { db, cleanup } = createTempDb();
  try {
    const ctx = db.formatUserMemoryContext("nobody");
    assert.equal(ctx, "");
  } finally {
    cleanup();
  }
});

test("formatUserMemoryContext produces readable context string", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.updateUserMemory({
      authorId: "user-4",
      authorName: "Charlie",
      routeId: "vdo-ninja-support",
      category: "troubleshooting",
      rationale: "Camera not working in Firefox",
      resolved: true,
    });

    db.updateUserMemory({
      authorId: "user-4",
      authorName: "Charlie",
      routeId: "social-stream-support",
      category: "how-to",
      rationale: "Setup YouTube chat integration",
      resolved: false,
    });

    const ctx = db.formatUserMemoryContext("user-4");
    assert.ok(ctx.includes("Charlie"));
    assert.ok(ctx.includes("user-4"));
    assert.ok(ctx.includes("Interactions: 2"));
    assert.ok(ctx.includes("vdo-ninja"));
    assert.ok(ctx.includes("social-stream"));
    assert.ok(ctx.includes("Resolved: 1 of 2"));
    assert.ok(ctx.includes("troubleshooting"));
    assert.ok(ctx.includes("how-to"));
    assert.ok(ctx.includes("Camera not working in Firefox"));
  } finally {
    cleanup();
  }
});

test("updateUserMemory strips route suffixes to extract product names", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.updateUserMemory({
      authorId: "user-5",
      authorName: "Dave",
      routeId: "raspberry-ninja-channel",
      category: "configuration",
      rationale: "Pi setup",
      resolved: true,
    });

    const mem = db.getUserMemory("user-5");
    assert.ok(mem);
    assert.deepEqual(mem.products, ["raspberry-ninja"]);
  } finally {
    cleanup();
  }
});
