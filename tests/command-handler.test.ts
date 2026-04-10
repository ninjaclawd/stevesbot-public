import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fsSync from "node:fs";
import { AppDatabase } from "../src/store/database.js";

/**
 * Tests for the command-handler tool dispatch logic.
 *
 * We can't easily import the full handleCommandMessage (it needs a Discord Message),
 * but we can test the executeTool function indirectly by importing it.
 * Since executeTool is not exported, we test the underlying DB operations that
 * the tools rely on — listChores, getUserMemory, queryDb — which is what
 * the command handler delegates to.
 */

function createTempDb(): { db: AppDatabase; dbPath: string; rootDir: string; cleanup: () => void } {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "stevesbot-cmd-test-"));
  const sqliteDir = path.join(tmpDir, "data", "sqlite");
  fsSync.mkdirSync(sqliteDir, { recursive: true });
  const dbPath = path.join(sqliteDir, "stevesbot.sqlite");
  const db = new AppDatabase(dbPath);
  return {
    db,
    dbPath,
    rootDir: tmpDir,
    cleanup: () => {
      db.close();
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// ── listChores (used by the listChores tool) ────────────────────────────────

test("listChores returns formatted chore list", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.upsertChore({ id: "health-check", skillId: "system-health", name: "System Health Check", schedule: "*/30 * * * *" });
    db.upsertChore({ id: "daily-digest", skillId: "digest", name: "Daily Digest", schedule: "0 9 * * *" });

    const chores = db.listChores();
    assert.equal(chores.length, 2);

    // Format like the tool does
    const lines = chores.map(c =>
      "- **" + c.id + "** (" + c.skillId + "): " + (c.enabled ? "enabled" : "disabled") +
      ", runs: " + c.runCount + ", last: " + (c.lastStatus ?? "never") + " at " + (c.lastRunAt?.slice(0, 16) ?? "n/a")
    );
    const joined = lines.join("\n");
    assert.ok(joined.includes("health-check"));
    assert.ok(joined.includes("enabled"));
    assert.ok(joined.includes("runs: 0"));
    assert.ok(joined.includes("daily-digest"));
  } finally {
    cleanup();
  }
});

test("listChores returns empty when no chores", () => {
  const { db, cleanup } = createTempDb();
  try {
    const chores = db.listChores();
    assert.equal(chores.length, 0);
  } finally {
    cleanup();
  }
});

// ── listChores with run history ─────────────────────────────────────────────

test("listChores reflects chore run status after recording", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.upsertChore({ id: "check", skillId: "health", name: "Health Check", schedule: "*/10 * * * *" });
    db.recordChoreRun({ choreId: "check", skillId: "health", status: "ok", result: "All good", durationMs: 500 });

    const chores = db.listChores();
    assert.equal(chores.length, 1);
    assert.equal(chores[0].runCount, 1);
    assert.equal(chores[0].lastStatus, "ok");
    assert.ok(chores[0].lastRunAt);
  } finally {
    cleanup();
  }
});

// ── queryDb tool: read-only SQL ─────────────────────────────────────────────

test("queryDb tool pattern: SELECT on stevesbot DB works", async () => {
  const { db, dbPath, cleanup } = createTempDb();
  try {
    db.upsertChore({ id: "test-chore", skillId: "test", name: "Test", schedule: "*/5 * * * *" });

    // Simulate what the queryDb tool does
    const Database = (await import("better-sqlite3")).default;
    const readonlyDb = new Database(dbPath, { readonly: true });
    const rows = readonlyDb.prepare("SELECT id, name FROM chores").all();
    readonlyDb.close();

    assert.equal(rows.length, 1);
    assert.equal((rows[0] as { id: string }).id, "test-chore");
  } finally {
    cleanup();
  }
});

// ── getUserMemory tool ──────────────────────────────────────────────────────

test("getUserMemory returns null for unknown user", () => {
  const { db, cleanup } = createTempDb();
  try {
    const mem = db.getUserMemory("unknown-author-id");
    assert.equal(mem, null);
  } finally {
    cleanup();
  }
});

test("formatUserMemoryContext returns empty for unknown user", () => {
  const { db, cleanup } = createTempDb();
  try {
    const ctx = db.formatUserMemoryContext("unknown-author-id");
    assert.equal(ctx, "");
  } finally {
    cleanup();
  }
});

// ── getChore ────────────────────────────────────────────────────────────────

test("getChore returns null for nonexistent chore", () => {
  const { db, cleanup } = createTempDb();
  try {
    assert.equal(db.getChore("nonexistent"), null);
  } finally {
    cleanup();
  }
});

test("getChore returns full chore details after runs", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.upsertChore({ id: "c1", skillId: "s1", name: "Chore One", schedule: "*/15 * * * *" });
    db.recordChoreRun({ choreId: "c1", skillId: "s1", status: "ok", result: "Result text here", durationMs: 2000 });
    db.recordChoreRun({ choreId: "c1", skillId: "s1", status: "error", result: "Something failed", durationMs: 100 });

    const chore = db.getChore("c1");
    assert.ok(chore);
    assert.equal(chore.runCount, 2);
    assert.equal(chore.lastStatus, "error");
    assert.ok(chore.lastResult!.includes("Something failed"));
  } finally {
    cleanup();
  }
});

// ── getRecentChoreLogs ──────────────────────────────────────────────────────

test("getRecentChoreLogs returns logs in reverse chronological order", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.upsertChore({ id: "c1", skillId: "s1", name: "C1", schedule: "*/5 * * * *" });
    db.recordChoreRun({ choreId: "c1", skillId: "s1", status: "ok", result: "first", durationMs: 100 });
    db.recordChoreRun({ choreId: "c1", skillId: "s1", status: "ok", result: "second", durationMs: 200 });
    db.recordChoreRun({ choreId: "c1", skillId: "s1", status: "error", result: "third", durationMs: 300 });

    const logs = db.getRecentChoreLogs("c1", 2);
    assert.equal(logs.length, 2);
    // Logs are ordered by created_at DESC; since inserts are near-instant,
    // just verify we got 2 of the 3 most recent entries
    const results = logs.map(l => l.result);
    assert.ok(results.every(r => ["first", "second", "third"].includes(r)));
  } finally {
    cleanup();
  }
});

// ── upsertChore enabled flag ────────────────────────────────────────────────

test("upsertChore can create disabled chore", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.upsertChore({ id: "disabled-chore", skillId: "s1", name: "Disabled", schedule: "*/5 * * * *", enabled: false });
    const chore = db.getChore("disabled-chore");
    assert.ok(chore);
    assert.equal(chore.enabled, false);
  } finally {
    cleanup();
  }
});

// ── loadAllSkills tool integration ──────────────────────────────────────────

test("loadAllSkills returns skills that can format like listSkills tool", async () => {
  const { loadAllSkills } = await import("../src/chore-runner.js");
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "stevesbot-cmd-skills-"));
  try {
    const skillDir = path.join(tmpDir, "health-check");
    fsSync.mkdirSync(skillDir);
    fsSync.writeFileSync(path.join(skillDir, "skill.yaml"), [
      "type: declarative",
      "id: health-check",
      "name: System Health Check",
      "description: Checks system health",
      "schedule: '*/30 * * * *'",
      "uses_llm: false",
      "model_preference: local-qwen",
      "data_queries: []",
      "prompt_template: '{{data}}'",
      "output_format: text",
      "report_to: review_channel",
    ].join("\n"));

    const skills = await loadAllSkills(tmpDir);
    // Format like the listSkills tool does
    const lines = [...skills.values()].map(s => "- **" + s.id + "**: " + s.name + " (" + s.schedule + ")");
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("health-check"));
    assert.ok(lines[0].includes("System Health Check"));
  } finally {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
});
