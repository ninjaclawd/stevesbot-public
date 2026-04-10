import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadAllSkills } from "../src/chore-runner.js";
import { validateSkill } from "../src/skill-validation.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pythonSkillDepsReady = spawnSync("python3", ["-c", "import requests; from PIL import Image"], { encoding: "utf8" }).status === 0;

async function getSkill(skillId: string) {
  const skills = await loadAllSkills(path.join(rootDir, "skills"));
  const skill = skills.get(skillId);
  assert.ok(skill, "expected skill " + skillId);
  return skill;
}

test("validateSkill runs auto-mine-threads in dry-run mode", async () => {
  const skill = await getSkill("auto-mine-threads");
  const result = await validateSkill(rootDir, skill);

  assert.equal(result.ok, true);
  assert.equal(result.mode, "data");
  assert.ok(result.checks.some((check) => check.name === "dry-run:safe-launch" && check.ok));
  assert.ok(result.checks.some((check) => check.name === "sql:mined_count:json" && check.ok));
});

test("validateSkill adds semantic checks for representative declarative skills", async () => {
  const kbQuality = await validateSkill(rootDir, await getSkill("kb-quality-monitor"));
  assert.equal(kbQuality.ok, true);
  assert.ok(kbQuality.checks.some((check) => check.name === "semantic:kb-totals" && check.ok));
  assert.ok(kbQuality.checks.some((check) => check.name === "semantic:kb-category-rates" && check.ok));

  const issueTrends = await validateSkill(rootDir, await getSkill("issue-trend-monitor"));
  assert.equal(issueTrends.ok, true);
  assert.ok(issueTrends.checks.some((check) => check.name === "semantic:repeat-asker-counts" && check.ok));
});

test("validateSkill dry-runs weekly and monthly OpenCode skills", async () => {
  for (const skillId of ["weekly-kb-mining", "monthly-kb-refresh"]) {
    const skill = await getSkill(skillId);
    const result = await validateSkill(rootDir, skill);
    assert.equal(result.ok, true, skillId + " should validate cleanly");
    assert.equal(result.mode, "dry-run");
    assert.ok(result.checks.some((check) => check.name === "output:dry-run" && check.ok), skillId + " should emit dry-run output");
  }
});

test("validateSkill exercises vision-analyzer against a mock endpoint", { skip: !pythonSkillDepsReady }, async () => {
  const skill = await getSkill("vision-analyzer");
  const result = await validateSkill(rootDir, skill);

  assert.equal(result.ok, true);
  assert.equal(result.mode, "mock-e2e");
  assert.ok(result.checks.some((check) => check.name === "output:coords" && check.ok));
  assert.ok(result.checks.some((check) => check.name === "request:image" && check.ok));
});

test("validateSkill exercises captcha-bypass against a mock endpoint", { skip: !pythonSkillDepsReady }, async () => {
  const skill = await getSkill("captcha-bypass");
  const result = await validateSkill(rootDir, skill);

  assert.equal(result.ok, true);
  assert.equal(result.mode, "mock-e2e");
  assert.ok(result.checks.some((check) => check.name === "output:dry-run" && check.ok));
  assert.ok(result.checks.some((check) => check.name === "output:coords" && check.ok));
});
