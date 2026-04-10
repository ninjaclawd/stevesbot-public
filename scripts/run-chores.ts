#!/usr/bin/env tsx
/**
 * Chore runner entry point — called by cron.
 * Checks all enabled chores, runs any that are due, logs results.
 * Uses a locally configured model provider when available.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { appendFileSync, statSync, unlinkSync, writeFileSync as writeFileSyncFs } from "node:fs";
import { extractSystemHealthStatus, shouldPostSystemHealthAlert } from "../src/chore-alerts.js";
import { AppDatabase } from "../src/store/database.js";
import { loadAllSkills, executeSkill, shouldRunNow, postChoreResultToDiscord } from "../src/chore-runner.js";
import { initScoring, scoreChoreCompleted } from "../src/scoring.js";
import { buildTfidfIndex } from "../src/tfidf-search.js";
import { registerMissingDefaultChores } from "../src/chore-definitions.js";

const ROOT = path.resolve(process.env.STEVESBOT_ROOT ?? ".");
const LOG = path.join(ROOT, "logs", "chore-runner.log");

function log(msg: string): void {
  const line = "[" + new Date().toISOString() + "] " + msg;
  console.log(line);
  try { appendFileSync(LOG, line + "\n"); } catch { /* best effort */ }
}

async function main(): Promise<void> {
  // Prevent concurrent executions (cron can overlap if a run takes > 10min)
  const lockPath = path.join(ROOT, "logs", "chore-runner.lock");
  try {
    const lockStat = statSync(lockPath);
    const lockAge = Date.now() - lockStat.mtimeMs;
    if (lockAge < 10 * 60_000) {
      log("Another chore runner is active (lock age: " + Math.round(lockAge / 1000) + "s). Exiting.");
      return;
    }
    // Stale lock (> 10 min old), remove it
    unlinkSync(lockPath);
  } catch {
    // No lock file exists — proceed
  }
  writeFileSyncFs(lockPath, process.pid.toString());
  try {
    await runChores();
  } finally {
    try { unlinkSync(lockPath); } catch { /* ok */ }
  }
}

async function runChores(): Promise<void> {
  // Load .env for Discord token (cron doesn't inherit process env)
  try {
    const envPath = path.join(ROOT, ".env");
    const envContent = await readFile(envPath, "utf8");
    for (const line of envContent.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const [key, ...rest] = line.split("=");
      if (key && !(key in process.env)) process.env[key] = rest.join("=");
    }
  } catch { /* ok if no .env */ }

  const db = new AppDatabase(path.join(ROOT, "data", "sqlite", "stevesbot.sqlite"));
  initScoring(db);

  // Load all skills (declarative + script) from unified skills/ directory
  const skillsDir = path.join(ROOT, "skills");
  const skills = await loadAllSkills(skillsDir);
  log("Loaded " + skills.size + " skills");

  // Load ops knowledge
  let opsKnowledge = "";
  try {
    opsKnowledge = await readFile(path.join(ROOT, "resources", "ops", "infrastructure.md"), "utf8");
  } catch { /* ok if missing */ }

  // Inject current score into ops knowledge for chore prompts
  try {
    const score = db.getScoreSummary();
    opsKnowledge += "\n\nBot Score: today=" + score.today + " week=" + score.week + " total=" + score.total + " streak=" + score.streak + " days. Try to maximize your daily score through diverse, high-value actions.";
  } catch { /* ok */ }

  // Ensure default chores exist without overwriting admin-edited rows.
  for (const choreId of registerMissingDefaultChores(db)) {
    const chore = db.getChore(choreId);
    log("Registered chore: " + choreId + (chore?.enabled ? "" : " (disabled)"));
  }

  // Check which chores are due
  const chores = db.listChores();
  let ran = 0;

  for (const chore of chores) {
    if (!chore.enabled) {
      continue;
    }

    const skill = skills.get(chore.skillId);
    if (!skill) {
      log("WARN: Chore " + chore.id + " references unknown skill " + chore.skillId);
      continue;
    }

    if (!shouldRunNow(chore.schedule, chore.lastRunAt, new Date(), chore.createdAt)) {
      continue;
    }

    const previousChoreState = db.getChore(chore.id);
    log("Running chore: " + chore.id + " (skill: " + chore.skillId + ")");
    const result = await executeSkill({
      skill,
      rootDir: ROOT,
      db,
      choreId: chore.id,
      opsKnowledge,
    });
    log("Chore " + chore.id + " " + result.status + " (" + result.durationMs + "ms)");
    if (result.status === "ok") {
    scoreChoreCompleted(chore.id);
      // Rebuild TF-IDF index after any mining
      if (chore.id === "auto-mine" || chore.id === "weekly-kb-mining") {
        try {
          const kbPath = require("node:path").join(ROOT, "data", "sqlite", "knowledge.sqlite");
          buildTfidfIndex(kbPath);
        } catch { /* ok */ }
      }
    }
    // Post results to Discord review channel. System health alerts are deduped by issue signature.
    const token = process.env.DISCORD_BOT_TOKEN ?? "";
    const reviewChannelId = process.env.REVIEW_CHANNEL_ID ?? "";
    const shouldPost = result.status === "ok" && (
      chore.id !== "system-health" ||
      shouldPostSystemHealthAlert({
        currentResult: result.result,
        previousResult: previousChoreState?.lastResult,
        previousRunAt: previousChoreState?.lastRunAt,
      })
    );
    if (shouldPost && token && reviewChannelId) {
      // Prefix CRITICAL alerts with the optional maintainer mention target
      const isCritical = chore.id === "system-health" && extractSystemHealthStatus(result.result) === "CRITICAL";
      const alertMention = process.env.REVIEW_ALERT_MENTION?.trim() ?? "";
      const alertResult = isCritical
        ? (alertMention ? `${alertMention} ` : "") + "**ALERT**\n" + result.result
        : result.result;
      log("Posting " + chore.id + " result to Discord...");

      await postChoreResultToDiscord({
        choreId: chore.id,
        skillName: skill.name,
        result: alertResult,
        status: result.status,
        durationMs: result.durationMs,
        channelId: reviewChannelId,
        token,
      });
    } else if (result.status === "ok" && chore.id === "system-health" && extractSystemHealthStatus(result.result) !== "OK") {
      log("Suppressing duplicate system-health alert.");
    }
    if (result.status === "ok") {
      log("Result: " + result.result.slice(0, 500));
    } else {
      log("Error: " + result.result.slice(0, 500));
    }
    ran++;
  }

  if (ran === 0) {
    log("No chores due");
  }

  db.close();
}

main().catch((err) => {
  log("FATAL: " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
