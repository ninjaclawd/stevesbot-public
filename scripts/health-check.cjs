const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");
const Database = require("better-sqlite3");

const ROOT = path.resolve(process.env.STEVESBOT_ROOT || ".");
const CHORE_REPORT = process.argv.includes("--chore-report");

function runCommand(command, timeout = 4000) {
  try {
    return execSync(command, {
      cwd: ROOT,
      timeout,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function parsePercent(value) {
  if (!value) return null;
  const match = String(value).match(/(\d+)%/);
  return match ? Number(match[1]) : null;
}

function getDiskPercent() {
  return parsePercent(runCommand("df -P / | tail -1 | awk '{print $5}'"));
}

function getDiskLine() {
  return runCommand("df -h / | tail -1");
}

function getMemoryLine() {
  return runCommand("free -m | awk '/Mem:/{printf \"%d/%dMB (%.0f%%)\", $3, $2, $3/$2*100}'");
}

function getServiceStatus() {
  return runCommand("XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active stevesbot 2>/dev/null || echo unknown") || "unknown";
}

function getVpnStatus() {
  return runCommand("ping -c 1 -W 3 discord.com >/dev/null 2>&1 && echo ok || echo down", 5000) || "down";
}

function getConfiguredLocalModelUrls() {
  return {
    primaryUrl: process.env.LOCAL_QWEN_BASE_URL || "http://127.0.0.1:8000/v1",
    legacyUrl: process.env.LOCAL_QWEN_FALLBACK_BASE_URL || "http://127.0.0.1:11434/v1",
  };
}

function getUrlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

function probeHttpStatus(url) {
  try {
    return execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "4", url], {
      cwd: ROOT,
      timeout: 5000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "unreachable";
  } catch (error) {
    const stdout = typeof error?.stdout === "string"
      ? error.stdout.trim()
      : Buffer.isBuffer(error?.stdout)
        ? error.stdout.toString("utf8").trim()
        : "";
    if (stdout && stdout !== "000") {
      return stdout;
    }
    return "unreachable";
  }
}

function getQwenStatus() {
  const { primaryUrl, legacyUrl } = getConfiguredLocalModelUrls();
  const primary = probeHttpStatus(primaryUrl.replace(/\/$/, "") + "/models");
  if (primary === "200") {
    return `200 primary (${getUrlHost(primaryUrl)})`;
  }
  const legacy = probeHttpStatus(legacyUrl.replace(/\/$/, "") + "/models");
  if (legacy === "200") {
    return `200 legacy (${getUrlHost(legacyUrl)}); primary ${primary}`;
  }
  return `${primary} primary / ${legacy} legacy`;
}

function getDbFileSizeMb(filePath) {
  try {
    return Math.round((fs.statSync(filePath).size / 1024 / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}

function mapCounts(rows, keyField = "outcome") {
  const result = Object.create(null);
  for (const row of rows) {
    result[row[keyField]] = Number(row.cnt);
  }
  return result;
}

function collectMetrics() {
  const sqlitePath = path.join(ROOT, "data/sqlite/stevesbot.sqlite");
  const kbPath = path.join(ROOT, "data/sqlite/knowledge.sqlite");
  const db = new Database(sqlitePath, { readonly: true });

  const outcomeRows = db.prepare(`
    SELECT outcome, COUNT(*) AS cnt, ROUND(AVG(total_duration_ms) / 1000.0, 1) AS avg_s
    FROM workflow_runs
    WHERE created_at > datetime('now', '-24 hours')
    GROUP BY outcome
    ORDER BY cnt DESC
  `).all();
  const outcomes = mapCounts(outcomeRows);

  const recentNoReplyCategories = db.prepare(`
    SELECT COALESCE(json_extract(triage_json, '$.category'), '[none]') AS category, COUNT(*) AS cnt
    FROM workflow_runs
    WHERE created_at > datetime('now', '-24 hours')
      AND outcome = 'no-reply'
    GROUP BY category
    ORDER BY cnt DESC
  `).all();

  const fastPathRows = db.prepare(`
    SELECT label, COUNT(*) AS cnt
    FROM workflow_steps
    WHERE label IN ('Maintainer fast-path (model call skipped)', 'Active helper fast-path (model call skipped)')
      AND run_id IN (SELECT id FROM workflow_runs WHERE created_at > datetime('now', '-24 hours'))
    GROUP BY label
    ORDER BY cnt DESC
  `).all();
  const fastPathCounts = mapCounts(fastPathRows, "label");

  const queueRows = db.prepare(`
    SELECT status, COUNT(*) AS cnt
    FROM workflow_queue
    GROUP BY status
    ORDER BY cnt DESC
  `).all();
  const queueCounts = mapCounts(queueRows, "status");
  const pendingQueue = db.prepare(`
    SELECT
      COUNT(*) AS cnt,
      MIN(updated_at) AS oldest_updated_at
    FROM workflow_queue
    WHERE status IN ('queued', 'leased')
  `).get();

  const kbCounts = (() => {
    try {
      const kdb = new Database(kbPath, { readonly: true });
      const mined = Number(kdb.prepare("SELECT COUNT(*) AS c FROM mined_threads").get().c);
      const fts = Number(kdb.prepare("SELECT COUNT(*) AS c FROM mined_threads_fts").get().c);
      const resolved = Number(kdb.prepare("SELECT COUNT(*) AS c FROM mined_threads WHERE resolved = 1").get().c);
      kdb.close();
      return { mined, fts, resolved };
    } catch (error) {
      return {
        mined: 0,
        fts: 0,
        resolved: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })();

  const pageCount = db.prepare("PRAGMA page_count").get();
  const pageSize = db.prepare("PRAGMA page_size").get();
  const stevesbotSizeMb = Math.round((pageCount.page_count * pageSize.page_size / 1024 / 1024) * 10) / 10;
  db.close();

  return {
    serviceStatus: getServiceStatus(),
    vpnStatus: getVpnStatus(),
    qwenStatus: getQwenStatus(),
    diskPercent: getDiskPercent(),
    diskLine: getDiskLine(),
    memoryLine: getMemoryLine(),
    uptime: runCommand("uptime -p"),
    outcomes,
    outcomeRows,
    recentNoReplyCategories,
    fastPathCounts,
    queueCounts,
    pendingQueue: {
      count: Number(pendingQueue.cnt || 0),
      oldestUpdatedAt: pendingQueue.oldest_updated_at || null,
    },
    kbCounts,
    stevesbotSizeMb,
    knowledgeSizeMb: getDbFileSizeMb(kbPath),
  };
}

function buildChoreReport(metrics) {
  const issues = [];
  const actions = [];
  const summaryParts = [];
  let status = "OK";

  const setStatus = (next) => {
    if (status === "CRITICAL") return;
    if (next === "CRITICAL") {
      status = "CRITICAL";
      return;
    }
    if (next === "WARNING" && status === "OK") {
      status = "WARNING";
    }
  };

  const pendingQueueAgeMinutes = (() => {
    if (!metrics.pendingQueue.oldestUpdatedAt) return 0;
    const ageMs = Date.now() - Date.parse(metrics.pendingQueue.oldestUpdatedAt);
    if (!Number.isFinite(ageMs) || ageMs < 0) return 0;
    return Math.round(ageMs / 60000);
  })();

  if (metrics.serviceStatus !== "active") {
    setStatus("CRITICAL");
    issues.push(`Bot service is not active (\`${metrics.serviceStatus}\`).`);
    actions.push("Restart or inspect the user service: `systemctl --user status stevesbot`.");
  }

  if (metrics.vpnStatus !== "ok") {
    setStatus("WARNING");
    issues.push("Discord connectivity check failed; VPN or outbound network may be down.");
    actions.push("Check the VPN tunnel and confirm Discord reachability before trusting support traffic metrics.");
  }

  if (String(metrics.qwenStatus).startsWith("200 legacy")) {
    summaryParts.push(`local model is running on the legacy fallback while the preferred host is unavailable (${metrics.qwenStatus})`);
  } else if (!String(metrics.qwenStatus).startsWith("200")) {
    const { primaryUrl, legacyUrl } = getConfiguredLocalModelUrls();
    setStatus("WARNING");
    issues.push(`Preferred local model endpoint is not healthy (\`${metrics.qwenStatus}\`).`);
    actions.push(`Check the preferred local model host at \`${getUrlHost(primaryUrl)}\` and the legacy fallback at \`${getUrlHost(legacyUrl)}\` if chore summaries start failing.`);
  }

  if (typeof metrics.diskPercent === "number") {
    if (metrics.diskPercent >= 90) {
      setStatus("CRITICAL");
      issues.push(`Disk usage is ${metrics.diskPercent}%, above the 90% critical threshold.`);
      actions.push("Free disk space immediately by rotating logs or pruning old local data.");
    } else if (metrics.diskPercent >= 80) {
      setStatus("WARNING");
      issues.push(`Disk usage is ${metrics.diskPercent}%, above the 80% warning threshold.`);
      actions.push("Rotate large logs and keep an eye on database growth before disk pressure becomes critical.");
    }
  }

  if (metrics.kbCounts.error) {
    setStatus("WARNING");
    issues.push(`Knowledge base check failed: ${metrics.kbCounts.error}`);
    actions.push("Verify `data/sqlite/knowledge.sqlite` is readable.");
  } else if (metrics.kbCounts.mined !== metrics.kbCounts.fts) {
    setStatus("WARNING");
    issues.push(`Knowledge base FTS index is out of sync (${metrics.kbCounts.fts}/${metrics.kbCounts.mined}).`);
    actions.push("Rebuild the knowledge-base index before relying on KB retrieval quality.");
  }

  const totalRuns = Object.values(metrics.outcomes).reduce((sum, value) => sum + Number(value || 0), 0);
  const noReply = Number(metrics.outcomes["no-reply"] || 0);
  const approved = Number(metrics.outcomes.approved || 0);
  const errors = Number(metrics.outcomes.error || 0);
  const rejected = Number(metrics.outcomes.rejected || 0);
  const expectedNoReplyCategories = new Set([
    "maintainer-message",
    "human-handling-no-ask",
    "acknowledgement",
    "resolution_acknowledgement",
    "empty_message",
  ]);
  const expectedNoReply = metrics.recentNoReplyCategories
    .filter((row) => expectedNoReplyCategories.has(row.category))
    .reduce((sum, row) => sum + Number(row.cnt), 0);
  const suspiciousNoReply = Math.max(0, noReply - expectedNoReply);
  const noReplyLooksExpected =
    noReply === 0 ||
    expectedNoReply >= Math.round(noReply * 0.6) ||
    (Number(metrics.fastPathCounts["Maintainer fast-path (model call skipped)"] || 0) +
      Number(metrics.fastPathCounts["Active helper fast-path (model call skipped)"] || 0)) >= Math.round(noReply * 0.6);

  if (errors >= 3 || (totalRuns > 0 && errors / totalRuns >= 0.1)) {
    setStatus("WARNING");
    issues.push(`Recent workflow errors are elevated (${errors}/${totalRuns || 1}).`);
    actions.push("Review recent runtime errors to catch provider or routing regressions.");
  } else if (errors > 0) {
    summaryParts.push(`${errors} recent workflow error${errors === 1 ? "" : "s"} but not above the warning threshold`);
  }

  if (!noReplyLooksExpected && noReply >= 25 && suspiciousNoReply >= Math.max(10, approved * 4)) {
    setStatus("WARNING");
    issues.push(`No-reply volume looks unusually high beyond expected fast-path traffic (${suspiciousNoReply} suspicious of ${noReply}).`);
    actions.push("Review recent no-reply runs for missed direct asks or over-aggressive guardrails.");
  } else if (noReply > 0) {
    summaryParts.push(`recent no-reply volume looks normal (${expectedNoReply}/${noReply} in expected skip categories)`);
  }

  if (metrics.pendingQueue.count >= 5 || pendingQueueAgeMinutes >= 10) {
    setStatus("WARNING");
    issues.push(
      `Workflow queue has stale pending items (queued=${metrics.queueCounts.queued || 0}, leased=${metrics.queueCounts.leased || 0}, oldest=${pendingQueueAgeMinutes}m).`,
    );
    actions.push("Check the worker if queued or leased items stop draining.");
  }

  if (status === "OK") {
    summaryParts.unshift("Service, storage, and queue health look normal");
  } else if (status === "WARNING") {
    summaryParts.unshift("System is operational with issues that should be monitored");
  } else {
    summaryParts.unshift("System health needs immediate attention");
  }

  if (typeof metrics.diskPercent === "number" && metrics.diskPercent < 80) {
    summaryParts.push(`disk is ${metrics.diskPercent}% and still below the warning threshold`);
  }

  const lines = [
    `Status: ${status}`,
    `One-line summary: ${summaryParts.join("; ")}.`,
  ];

  if (issues.length > 0) {
    lines.push("Issues found:");
    for (const issue of issues) {
      lines.push(`- ${issue}`);
    }
  }

  if (actions.length > 0) {
    lines.push("Recommended actions:");
    for (const action of actions) {
      lines.push(`- ${action}`);
    }
  }

  return lines.join("\n");
}

function printDetailedReport(metrics) {
  const now = new Date();
  console.log(`=== StevesBot Health Check — ${now.toISOString()} ===\n`);

  console.log("--- System ---");
  console.log(`  Service: ${metrics.serviceStatus}`);
  console.log(`  VPN/Discord: ${metrics.vpnStatus}`);
  console.log(`  Local Qwen: ${metrics.qwenStatus}`);
  console.log(`  Disk: ${metrics.diskLine || "unknown"}`);
  console.log(`  Memory: ${metrics.memoryLine || "unknown"}`);
  console.log(`  Uptime: ${metrics.uptime || "unknown"}`);

  let total24 = 0;
  console.log("\n--- Pipeline (24h) ---");
  for (const row of metrics.outcomeRows) {
    total24 += Number(row.cnt);
    console.log(`  ${row.outcome}: ${row.cnt} (avg ${row.avg_s}s)`);
  }
  console.log(`  TOTAL: ${total24}`);

  console.log("\n--- No-reply categories (24h) ---");
  if (metrics.recentNoReplyCategories.length === 0) {
    console.log("  None");
  } else {
    for (const row of metrics.recentNoReplyCategories.slice(0, 8)) {
      console.log(`  ${row.category}: ${row.cnt}`);
    }
  }

  console.log("\n--- Fast-paths (24h) ---");
  const fastPathEntries = Object.entries(metrics.fastPathCounts);
  if (fastPathEntries.length === 0) {
    console.log("  None");
  } else {
    for (const [label, count] of fastPathEntries) {
      console.log(`  ${label}: ${count}`);
    }
  }

  console.log("\n--- Queue ---");
  const queueEntries = Object.entries(metrics.queueCounts);
  if (queueEntries.length === 0) {
    console.log("  No rows");
  } else {
    for (const [state, count] of queueEntries) {
      console.log(`  ${state}: ${count}`);
    }
    if (metrics.pendingQueue.count > 0) {
      const oldest = metrics.pendingQueue.oldestUpdatedAt
        ? `${Math.round((Date.now() - Date.parse(metrics.pendingQueue.oldestUpdatedAt)) / 60000)}m`
        : "unknown";
      console.log(`  Oldest pending age: ${oldest}`);
    }
  }

  console.log("\n--- Knowledge Base ---");
  if (metrics.kbCounts.error) {
    console.log(`  Error: ${metrics.kbCounts.error}`);
  } else {
    console.log(`  Mined threads: ${metrics.kbCounts.mined}`);
    console.log(`  FTS index: ${metrics.kbCounts.fts}${metrics.kbCounts.mined === metrics.kbCounts.fts ? " (in sync)" : " ⚠️ DESYNC"}`);
    console.log(`  Resolved: ${metrics.kbCounts.resolved}`);
  }

  console.log("\n--- Storage ---");
  console.log(`  stevesbot.sqlite: ${metrics.stevesbotSizeMb} MB`);
  console.log(`  knowledge.sqlite: ${metrics.knowledgeSizeMb} MB`);

  console.log("\n--- Chore Report ---");
  console.log(buildChoreReport(metrics));
  console.log("\n=== Done ===");
}

const metrics = collectMetrics();
if (CHORE_REPORT) {
  process.stdout.write(buildChoreReport(metrics));
} else {
  printDetailedReport(metrics);
}
