import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/store/database.js";
import { gatherData, buildChorePrompt, shouldRunNow, loadSkillManifest, maybeShortCircuitSkillResult, matchesCronSchedule, buildScriptSkillEnv } from "../src/chore-runner.js";
import path from "node:path";
import os from "node:os";
import fsSync from "node:fs";

function createTempDb(): { db: AppDatabase; cleanup: () => void } {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "stevesbot-chore-test-"));
  const dbPath = path.join(tmpDir, "test.sqlite");
  const db = new AppDatabase(dbPath);
  return {
    db,
    cleanup: () => {
      db.close();
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("upsertChore creates and retrieves a chore", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.upsertChore({ id: "test-chore", skillId: "test-skill", name: "Test", schedule: "*/30 * * * *" });
    const chore = db.getChore("test-chore");
    assert.ok(chore);
    assert.equal(chore.id, "test-chore");
    assert.equal(chore.skillId, "test-skill");
    assert.equal(chore.enabled, true);
    assert.equal(chore.runCount, 0);
    assert.equal(chore.lastRunAt, null);
  } finally {
    cleanup();
  }
});

test("listChores returns all chores", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.upsertChore({ id: "a", skillId: "s1", name: "A", schedule: "*/5 * * * *" });
    db.upsertChore({ id: "b", skillId: "s2", name: "B", schedule: "0 9 * * *" });
    const list = db.listChores();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, "a");
    assert.equal(list[1].id, "b");
  } finally {
    cleanup();
  }
});

test("recordChoreRun updates chore and creates log entry", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.upsertChore({ id: "c", skillId: "s1", name: "C", schedule: "*/30 * * * *" });
    db.recordChoreRun({
      choreId: "c",
      skillId: "s1",
      status: "ok",
      result: "All systems operational",
      durationMs: 1500,
      modelUsed: "local-qwen",
    });

    const chore = db.getChore("c");
    assert.ok(chore);
    assert.equal(chore.runCount, 1);
    assert.equal(chore.lastStatus, "ok");
    assert.ok(chore.lastResult!.includes("All systems operational"));
    assert.ok(chore.lastRunAt);

    const logs = db.getRecentChoreLogs("c");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].choreId, "c");
    assert.equal(logs[0].status, "ok");
    assert.equal(logs[0].durationMs, 1500);
  } finally {
    cleanup();
  }
});

test("upsertChore updates existing chore on conflict", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.upsertChore({ id: "d", skillId: "s1", name: "Old", schedule: "*/5 * * * *" });
    db.upsertChore({ id: "d", skillId: "s2", name: "New", schedule: "*/10 * * * *" });
    const chore = db.getChore("d");
    assert.ok(chore);
    assert.equal(chore.skillId, "s2");
    assert.equal(chore.name, "New");
    assert.equal(chore.schedule, "*/10 * * * *");
  } finally {
    cleanup();
  }
});

test("chore admin helpers update enabled state and schedule", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.upsertChore({ id: "admin-test", skillId: "skill", name: "Admin Test", schedule: "0 9 * * *" });
    db.setChoreEnabled("admin-test", false);
    db.updateChoreSchedule("admin-test", "0 18 * * 0");
    const chore = db.getChore("admin-test");
    assert.ok(chore);
    assert.equal(chore.enabled, false);
    assert.equal(chore.schedule, "0 18 * * 0");
    assert.ok(chore.createdAt);
  } finally {
    cleanup();
  }
});

test("shouldRunNow returns true when never run", () => {
  const now = new Date(2026, 2, 30, 9, 30, 0, 0);
  assert.equal(shouldRunNow("*/30 * * * *", null, now), true);
});

test("shouldRunNow respects interval", () => {
  const now = new Date(2026, 2, 30, 10, 34, 0, 0);
  const thirtyOneMinAgo = new Date(now.getTime() - 31 * 60_000).toISOString();
  const threeMinAgo = new Date(now.getTime() - 3 * 60_000).toISOString();
  assert.equal(shouldRunNow("*/30 * * * *", thirtyOneMinAgo, now), true);
  assert.equal(shouldRunNow("*/30 * * * *", threeMinAgo, now), false);
});

test("gatherData runs shell queries", () => {
  const data = gatherData([
    { id: "echo_test", type: "shell", command: "echo hello" },
  ], "/tmp");
  assert.equal(data.echo_test, "hello");
});

test("gatherData handles shell errors gracefully", () => {
  const data = gatherData([
    { id: "bad_cmd", type: "shell", command: "nonexistent_command_xyz 2>&1" },
  ], "/tmp");
  assert.ok(data.bad_cmd.includes("[shell error]"));
});

test("buildScriptSkillEnv injects stable node and tsx paths for script skills", () => {
  const rootDir = "/tmp/stevesbot-root";
  const env = buildScriptSkillEnv(rootDir, { CUSTOM_FLAG: "1", PATH: "/usr/bin" });
  const pathEntries = (env.PATH ?? "").split(path.delimiter);

  assert.equal(env.STEVESBOT_ROOT, rootDir);
  assert.equal(env.STEVESBOT_NODE, process.execPath);
  assert.equal(env.STEVESBOT_TSX_LOADER, path.join(rootDir, "node_modules", "tsx", "dist", "loader.mjs"));
  assert.equal(env.CUSTOM_FLAG, "1");
  assert.equal(pathEntries[0], path.join(rootDir, "node_modules", ".bin"));
  assert.equal(pathEntries[1], path.dirname(process.execPath));
  assert.ok(pathEntries.includes("/usr/bin"));
});

test("buildChorePrompt substitutes named placeholders, data block, and date", () => {
  const skill = {
    type: "declarative" as const,
    id: "test", name: "Test", description: "", schedule: "", uses_llm: true,
    model_preference: "local-qwen", data_queries: [],
    prompt_template: "Data: {{data}}\nDisk: {{disk}}\nMissing: {{missing_key}}\nDate: {{date}}",
    output_format: "text", report_to: "review_channel",
  };
  const prompt = buildChorePrompt(skill, { disk: "65%", mem: "1GB/16GB" });
  assert.ok(prompt.includes("disk:"));
  assert.ok(prompt.includes("65%"));
  assert.ok(prompt.includes("mem:"));
  assert.ok(prompt.includes("Disk: 65%"));
  assert.ok(prompt.includes("Missing: [missing:missing_key]"));
  assert.ok(prompt.includes(new Date().toISOString().slice(0, 10)));
});

test("maybeShortCircuitSkillResult suppresses empty FAQ output", () => {
  assert.equal(
    maybeShortCircuitSkillResult("faq-auto-builder", { repeated_questions: "(no rows)" }),
    "No strong new FAQ candidates today.",
  );
  assert.equal(
    maybeShortCircuitSkillResult("faq-auto-builder", { repeated_questions: "[sql error] boom" }),
    "FAQ auto-builder query failed; no FAQ candidates generated.",
  );
  assert.equal(maybeShortCircuitSkillResult("issue-trend-monitor", { repeated_questions: "(no rows)" }), null);
});

test("loadSkillManifest parses a declarative skill.yaml", async () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "skill-test-"));
  const skillDir = path.join(tmpDir, "test-skill");
  fsSync.mkdirSync(skillDir);
  fsSync.writeFileSync(path.join(skillDir, "skill.yaml"), [
    "type: declarative",
    "id: test-skill",
    "name: Test Skill",
    "description: A test",
    "schedule: '*/5 * * * *'",
    "uses_llm: false",
    "model_preference: local-qwen",
    "data_queries:",
    "  - id: echo",
    "    type: shell",
    "    command: echo hi",
    "prompt_template: '{{data}}'",
    "output_format: text",
    "report_to: review_channel",
  ].join("\n"));

  try {
    const skill = await loadSkillManifest(skillDir);
    assert.equal(skill.id, "test-skill");
    assert.equal(skill.type, "declarative");
    if (skill.type === "declarative") {
      assert.equal(skill.uses_llm, false);
      assert.equal(skill.data_queries.length, 1);
      assert.equal(skill.data_queries[0].type, "shell");
    }
  } finally {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadSkillManifest parses a script skill.yaml", async () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "skill-test-"));
  const skillDir = path.join(tmpDir, "test-script");
  fsSync.mkdirSync(skillDir);
  fsSync.writeFileSync(path.join(skillDir, "skill.yaml"), [
    "type: script",
    "id: test-script",
    "name: Test Script",
    "description: A test script skill",
    "schedule: ''",
    "interpreter: python3",
    "entrypoint: run.py",
    "timeout: 60000",
    "report_to: review_channel",
  ].join("\n"));

  try {
    const skill = await loadSkillManifest(skillDir);
    assert.equal(skill.id, "test-script");
    assert.equal(skill.type, "script");
    if (skill.type === "script") {
      assert.equal(skill.interpreter, "python3");
      assert.equal(skill.entrypoint, "run.py");
      assert.equal(skill.timeout, 60000);
      assert.equal(skill._skillDir, skillDir);
    }
  } finally {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test("shouldRunNow handles daily schedules with local time", () => {
  const now = new Date(2026, 2, 30, 10, 15, 0, 0);
  const beforeTodaySlot = new Date(2026, 2, 29, 9, 0, 0, 0).toISOString();
  const afterTodaySlot = new Date(2026, 2, 30, 9, 5, 0, 0).toISOString();

  assert.equal(shouldRunNow("0 9 * * *", beforeTodaySlot, now), true);
  assert.equal(shouldRunNow("0 9 * * *", afterTodaySlot, now), false);
});

test("shouldRunNow respects day-of-week", () => {
  const sundayAfternoon = new Date(2026, 2, 29, 15, 0, 0, 0);
  const previousWeek = new Date(2026, 2, 22, 18, 0, 0, 0).toISOString();
  assert.equal(shouldRunNow("0 18 * * 0", previousWeek, sundayAfternoon), false);
  assert.equal(shouldRunNow("0 14 * * 0", previousWeek, sundayAfternoon), true);
});

test("matchesCronSchedule handles stepped hours and first-Sunday style constraints", () => {
  assert.equal(matchesCronSchedule("0 */4 * * *", new Date(2026, 2, 30, 8, 0, 0, 0)), true);
  assert.equal(matchesCronSchedule("0 */4 * * *", new Date(2026, 2, 30, 9, 0, 0, 0)), false);

  assert.equal(matchesCronSchedule("0 15 1-7 * 0", new Date(2026, 2, 1, 15, 0, 0, 0)), true);
  assert.equal(matchesCronSchedule("0 15 1-7 * 0", new Date(2026, 2, 8, 15, 0, 0, 0)), false);
});

test("shouldRunNow does not backfill a never-run chore before its first matching slot after creation", () => {
  const beforeSlot = new Date(2026, 2, 30, 8, 0, 0, 0);
  const afterSlot = new Date(2026, 2, 30, 9, 5, 0, 0);
  const createdToday = new Date(2026, 2, 30, 7, 0, 0, 0).toISOString();

  assert.equal(shouldRunNow("0 9 * * *", null, beforeSlot, createdToday), false);
  assert.equal(shouldRunNow("0 9 * * *", null, afterSlot, createdToday), true);
});
