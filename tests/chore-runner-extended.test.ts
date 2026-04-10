import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fsSync from "node:fs";
import { loadSkillManifest, loadAllSkills, shouldRunNow } from "../src/chore-runner.js";

function makeTempDir(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), "stevesbot-chore-ext-"));
}

// ── loadAllSkills ────────────────────────────────────────────────────────────

test("loadAllSkills loads multiple skills from a directory", async () => {
  const tmpDir = makeTempDir();
  try {
    // Create two skill directories
    const skill1Dir = path.join(tmpDir, "skill-alpha");
    const skill2Dir = path.join(tmpDir, "skill-beta");
    fsSync.mkdirSync(skill1Dir);
    fsSync.mkdirSync(skill2Dir);

    fsSync.writeFileSync(path.join(skill1Dir, "skill.yaml"), [
      "type: declarative",
      "id: alpha",
      "name: Alpha Skill",
      "description: First skill",
      "schedule: '*/5 * * * *'",
      "uses_llm: false",
      "model_preference: local-qwen",
      "data_queries:",
      "  - id: echo",
      "    type: shell",
      "    command: echo alpha",
      "prompt_template: '{{data}}'",
      "output_format: text",
      "report_to: review_channel",
    ].join("\n"));

    fsSync.writeFileSync(path.join(skill2Dir, "skill.yaml"), [
      "type: declarative",
      "id: beta",
      "name: Beta Skill",
      "description: Second skill",
      "schedule: '0 9 * * *'",
      "uses_llm: true",
      "model_preference: local-qwen",
      "data_queries: []",
      "prompt_template: '{{data}}'",
      "output_format: text",
      "report_to: review_channel",
    ].join("\n"));

    const skills = await loadAllSkills(tmpDir);
    assert.equal(skills.size, 2);
    assert.ok(skills.has("alpha"));
    assert.ok(skills.has("beta"));
    assert.equal(skills.get("alpha")!.name, "Alpha Skill");
    assert.equal(skills.get("beta")!.name, "Beta Skill");
  } finally {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadAllSkills returns empty map for nonexistent directory", async () => {
  const skills = await loadAllSkills("/tmp/nonexistent-skills-dir-" + Date.now());
  assert.equal(skills.size, 0);
});

test("loadAllSkills skips non-skill entries gracefully", async () => {
  const tmpDir = makeTempDir();
  try {
    // Valid skill
    const skillDir = path.join(tmpDir, "good-skill");
    fsSync.mkdirSync(skillDir);
    fsSync.writeFileSync(path.join(skillDir, "skill.yaml"), [
      "type: declarative",
      "id: good",
      "name: Good Skill",
      "description: Valid",
      "schedule: '*/10 * * * *'",
      "uses_llm: false",
      "model_preference: local-qwen",
      "data_queries: []",
      "prompt_template: '{{data}}'",
      "output_format: text",
      "report_to: review_channel",
    ].join("\n"));

    // Not a skill directory — just a file
    fsSync.writeFileSync(path.join(tmpDir, "README.md"), "Not a skill");

    // Directory without skill.yaml
    fsSync.mkdirSync(path.join(tmpDir, "empty-dir"));

    const skills = await loadAllSkills(tmpDir);
    assert.equal(skills.size, 1);
    assert.ok(skills.has("good"));
  } finally {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadAllSkills loads script-type skills with _skillDir", async () => {
  const tmpDir = makeTempDir();
  try {
    const skillDir = path.join(tmpDir, "my-script");
    fsSync.mkdirSync(skillDir);
    fsSync.writeFileSync(path.join(skillDir, "skill.yaml"), [
      "type: script",
      "id: my-script",
      "name: My Script",
      "description: A script skill",
      "schedule: '0 12 * * *'",
      "interpreter: bash",
      "entrypoint: run.sh",
      "timeout: 30000",
      "report_to: review_channel",
    ].join("\n"));

    const skills = await loadAllSkills(tmpDir);
    assert.equal(skills.size, 1);
    const skill = skills.get("my-script")!;
    assert.equal(skill.type, "script");
    if (skill.type === "script") {
      assert.equal(skill._skillDir, skillDir);
      assert.equal(skill.interpreter, "bash");
      assert.equal(skill.entrypoint, "run.sh");
      assert.equal(skill.timeout, 30000);
    }
  } finally {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── loadSkillManifest: script _skillDir resolution ──────────────────────────

test("loadSkillManifest sets default timeout for script skills", async () => {
  const tmpDir = makeTempDir();
  const skillDir = path.join(tmpDir, "no-timeout");
  fsSync.mkdirSync(skillDir);
  fsSync.writeFileSync(path.join(skillDir, "skill.yaml"), [
    "type: script",
    "id: no-timeout",
    "name: No Timeout Script",
    "description: Script without explicit timeout",
    "schedule: ''",
    "interpreter: python3",
    "entrypoint: main.py",
    "report_to: review_channel",
  ].join("\n"));

  try {
    const skill = await loadSkillManifest(skillDir);
    assert.equal(skill.type, "script");
    if (skill.type === "script") {
      assert.equal(skill.timeout, 120_000, "default timeout should be 120000ms");
      assert.equal(skill._skillDir, skillDir);
    }
  } finally {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadSkillManifest defaults to declarative when type field is missing", async () => {
  const tmpDir = makeTempDir();
  const skillDir = path.join(tmpDir, "no-type");
  fsSync.mkdirSync(skillDir);
  fsSync.writeFileSync(path.join(skillDir, "skill.yaml"), [
    "id: no-type",
    "name: No Type Skill",
    "description: Missing type field",
    "schedule: '*/15 * * * *'",
    "uses_llm: false",
    "model_preference: local-qwen",
    "data_queries: []",
    "prompt_template: '{{data}}'",
    "output_format: text",
    "report_to: review_channel",
  ].join("\n"));

  try {
    const skill = await loadSkillManifest(skillDir);
    assert.equal(skill.type, "declarative");
  } finally {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── shouldRunNow edge cases ─────────────────────────────────────────────────

test("shouldRunNow returns false for invalid schedule format", () => {
  assert.equal(shouldRunNow("bad schedule", null), false, "invalid cron should never run");
  assert.equal(shouldRunNow("bad schedule", new Date().toISOString()), false, "bad format with lastRun returns false");
});

test("shouldRunNow returns false for 3-part schedule", () => {
  const lastRun = new Date(Date.now() - 60 * 60_000).toISOString();
  assert.equal(shouldRunNow("*/5 * *", lastRun), false, "wrong number of parts");
});

test("shouldRunNow handles minute interval edge case at exactly the interval", () => {
  // Exactly 30 minutes ago — should return true (>= check)
  const exactly30MinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
  assert.equal(shouldRunNow("*/30 * * * *", exactly30MinAgo), true);
});

test("shouldRunNow handles small minute intervals", () => {
  const now = new Date(2026, 3, 5, 10, 2, 0, 0);
  const twoMinAgo = new Date(now.getTime() - 2 * 60_000).toISOString();
  assert.equal(shouldRunNow("*/1 * * * *", twoMinAgo, now), true);
  assert.equal(shouldRunNow("*/3 * * * *", twoMinAgo, now), false);
});

test("shouldRunNow with day-of-week handles comma-separated days", () => {
  const yesterday = new Date(Date.now() - 25 * 3600_000).toISOString();
  const now = new Date();
  const todayDow = now.getDay();

  // Schedule that includes today's DOW in a comma list
  const dowList = [todayDow, (todayDow + 2) % 7].join(",");
  // If hour >= 9, should run
  if (now.getHours() >= 9) {
    assert.equal(shouldRunNow("0 9 * * " + dowList, yesterday), true);
  }
});

test("shouldRunNow returns false for fixed time schedule when too recent", () => {
  const now = new Date(2026, 3, 5, 12, 30, 0, 0);
  const alreadyRanThisSlot = new Date(2026, 3, 5, 10, 30, 0, 0).toISOString();
  assert.equal(shouldRunNow("0 9 * * *", alreadyRanThisSlot, now), false);
});

test("shouldRunNow returns false when current time is before the next target slot", () => {
  const now = new Date(2026, 3, 5, 22, 30, 0, 0);
  const lastRunAt = new Date(2026, 3, 4, 23, 59, 0, 0).toISOString();
  assert.equal(shouldRunNow("59 23 * * *", lastRunAt, now), false);
});

test("shouldRunNow handles wildcard minute with fixed hour using cron semantics", () => {
  const duringTargetHour = new Date(2026, 3, 5, 9, 15, 0, 0);
  const beforeTargetHour = new Date(2026, 3, 5, 8, 45, 0, 0);
  const lastRunAt = new Date(2026, 3, 4, 9, 59, 0, 0).toISOString();

  assert.equal(shouldRunNow("* 9 * * *", lastRunAt, duringTargetHour), true);
  assert.equal(shouldRunNow("* 9 * * *", lastRunAt, beforeTargetHour), false);
});
