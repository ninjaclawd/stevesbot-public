import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { buildChorePrompt, buildScriptSkillEnv, gatherData, loadAllSkills, type SkillManifest } from "./chore-runner.js";

export type SkillValidationMode = "static" | "data" | "dry-run" | "live-e2e" | "mock-e2e";

export type SkillValidationCheck = {
  name: string;
  ok: boolean;
  details: string;
};

export type SkillValidationResult = {
  skillId: string;
  ok: boolean;
  mode: SkillValidationMode;
  summary: string;
  checks: SkillValidationCheck[];
};

type ScriptRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type JsonRow = Record<string, unknown>;
type DeclarativeValidationContext = {
  data: Record<string, string>;
  queryTypeById: Map<string, "shell" | "sql">;
  parsedSqlRows: Map<string, JsonRow[] | null>;
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAukB9pY9lS0AAAAASUVORK5CYII=";

async function withValidationDatabases<T>(_rootDir: string, fn: (validationRoot: string) => Promise<T>): Promise<T> {
  // Each validation gets isolated databases. The test runner validates several
  // skills concurrently, so sharing data/sqlite caused one test to delete files
  // while another was still querying them.
  const validationRoot = await mkdtemp(path.join(os.tmpdir(), "stevesbot-skill-db-"));
  const dbDir = path.join(validationRoot, "data", "sqlite");

  await mkdir(dbDir, { recursive: true });

  async function ensureDb(fileName: string, init: (db: any) => void): Promise<void> {
    const dbPath = path.join(dbDir, fileName);
    const db = new Database(dbPath);
    try {
      init(db);
    } finally {
      db.close();
    }
  }

  await ensureDb("stevesbot.sqlite", (db) => {
    db.exec(`
      CREATE TABLE workflow_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        source_url TEXT NOT NULL,
        message_content TEXT NOT NULL,
        discord_created_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        outcome TEXT,
        created_at TEXT,
        triage_json TEXT,
        review_json TEXT,
        reply_text TEXT,
        error_text TEXT,
        total_duration_ms INTEGER NOT NULL,
        qwen_model TEXT NOT NULL,
        gpt_model TEXT NOT NULL
      );
      CREATE TABLE workflow_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        step_index INTEGER NOT NULL,
        phase TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        input_text TEXT,
        output_text TEXT
      );
      CREATE TABLE workflow_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TEXT,
        available_at TEXT NOT NULL,
        run_id INTEGER,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT
      );
      CREATE TABLE run_feedback (
        run_id INTEGER NOT NULL UNIQUE,
        rating TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE draft_usage (
        run_id INTEGER NOT NULL UNIQUE,
        usage TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE qa_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id TEXT NOT NULL,
        question_text TEXT NOT NULL,
        answer_text TEXT NOT NULL
      );
      CREATE TABLE user_memory (
        author_id TEXT PRIMARY KEY,
        author_name TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE score_log (
        event_type TEXT NOT NULL,
        points INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE chores (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        enabled INTEGER,
        last_status TEXT,
        last_run_at TEXT,
        last_result TEXT,
        run_count INTEGER NOT NULL DEFAULT 0
      );
    `);

    const insertRun = db.prepare(`
      INSERT INTO workflow_runs (
        route_id, thread_key, message_id, guild_id, channel_id, author_id, author_name,
        source_url, message_content, discord_created_at, received_at, outcome, created_at,
        triage_json, review_json, reply_text, total_duration_ms, qwen_model, gpt_model
      ) VALUES ('product-support', 'thread-1', ?, 'guild-1', 'channel-1', ?, ?,
        'https://example.test/support', ?, datetime('now', ?), datetime('now', ?), ?, datetime('now', ?),
        ?, ?, ?, 1000, 'router-model', 'drafter-model')
    `);
    insertRun.run("message-1", "user-1", "sample-user", "Audio is broken; can you help?", "-1 day", "-1 day", "approved", "-1 day", JSON.stringify({ directAsk: true, category: "troubleshooting" }), null, "Use the documented audio setting.");
    insertRun.run("message-2", "user-1", "sample-user", "How do I configure this?", "-2 days", "-2 days", "hold", "-2 days", JSON.stringify({ directAsk: true, category: "configuration" }), null, null);
    insertRun.run("message-3", "user-1", "sample-user", "The service crashed again", "-3 days", "-3 days", "error", "-3 days", JSON.stringify({ directAsk: true, category: "troubleshooting" }), null, null);
    insertRun.run("message-4", "user-2", "another-user", "This answer needs evidence", "-4 days", "-4 days", "rejected", "-4 days", JSON.stringify({ directAsk: true, category: "user-requested-bot-help" }), JSON.stringify({ policyFlags: ["grounding"], issues: ["missing evidence"] }), null);
    db.prepare("INSERT INTO run_feedback (run_id, rating, note) VALUES (1, 'good', 'helpful')").run();
    db.prepare("INSERT INTO draft_usage (run_id, usage) VALUES (1, 'used')").run();
    db.prepare("INSERT INTO qa_entries (route_id, question_text, answer_text) VALUES ('product-support', 'sample question', 'sample answer')").run();
    db.prepare("INSERT INTO user_memory (author_id, author_name, first_seen_at, last_seen_at) VALUES ('user-1', 'sample-user', datetime('now', '-1 day'), datetime('now'))").run();
    db.prepare("INSERT INTO score_log (event_type, points) VALUES ('approved_reply', 10)").run();
    db.prepare("INSERT INTO workflow_steps (run_id, step_index, phase, label, status, started_at, completed_at, duration_ms, input_text, output_text) VALUES (1, 0, 'tool', 'searchSupport', 'ok', datetime('now'), datetime('now'), 5, 'audio', 'sample result')").run();

    const insertChore = db.prepare(`
      INSERT INTO chores (id, skill_id, name, schedule, enabled, last_status, last_run_at, last_result)
      VALUES (?, ?, ?, '0 0 * * *', ?, ?, datetime('now', ?), ?)
    `);
    insertChore.run("auto-mine", "auto-mine-threads", "Auto mine", 1, "ok", "-1 day", "Auto-mine healthy");
    insertChore.run("weekly-kb-mining", "weekly-kb-mining", "Weekly mining", 0, "ok", "-2 days", "Weekly mining paused");
    insertChore.run("monthly-kb-refresh", "monthly-kb-refresh", "Monthly refresh", 1, "ok", "-7 days", "Monthly refresh healthy");
  });

  await ensureDb("knowledge.sqlite", (db) => {
    db.exec(`
      CREATE TABLE mined_threads (
        thread_id TEXT,
        thread_name TEXT,
        products_json TEXT,
        summary TEXT,
        solution TEXT,
        keywords_json TEXT,
        resolved INTEGER,
        category TEXT,
        indexed_at TEXT
      );
      CREATE VIRTUAL TABLE mined_threads_fts USING fts5(
        summary,
        problem_statement,
        solution,
        keywords_text,
        products_text,
        error_signals_text
      );
    `);

    const insertThread = db.prepare(`
      INSERT INTO mined_threads (thread_id, thread_name, products_json, summary, solution, keywords_json, resolved, category, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
    `);
    insertThread.run("thread-1", "Audio support sample", JSON.stringify(["sample-product"]), "Resolved audio sync issue with relay settings and codec tuning for a user report.", "Set a fixed bitrate and retry with updated relay settings.", JSON.stringify(["audio", "relay", "codec"]), 1, "troubleshooting", "-1 day");
    insertThread.run("thread-2", "Sign-in support sample", JSON.stringify(["sample-product"]), "Documented a configuration fix for sign-in handling.", "Re-authenticate and restart the affected source.", JSON.stringify(["login", "configuration", "restart"]), 1, "configuration", "-3 days");
    insertThread.run("thread-3", "Browser support sample", JSON.stringify(["sample-product"]), "Captured an unresolved browser compatibility report for screen sharing.", "", JSON.stringify(["browser", "screenshare"]), 0, "compatibility", "-10 days");
    db.prepare("INSERT INTO mined_threads_fts(rowid, summary, problem_statement, solution, keywords_text, products_text, error_signals_text) SELECT rowid, summary, '', solution, keywords_json, products_json, '' FROM mined_threads").run();
  });

  await ensureDb("archive.sqlite", (db) => {
    db.exec(`
      CREATE TABLE archived_messages (
        thread_id TEXT
      );
    `);
    const insertMessage = db.prepare("INSERT INTO archived_messages (thread_id) VALUES (?)");
    insertMessage.run("thread-1");
    insertMessage.run("thread-1");
    insertMessage.run("thread-2");
    insertMessage.run("thread-3");
    insertMessage.run("thread-4");
  });

  try {
    return await fn(validationRoot);
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
}

function makeCheck(name: string, ok: boolean, details: string): SkillValidationCheck {
  return { name, ok, details };
}

function finalizeResult(skillId: string, mode: SkillValidationMode, checks: SkillValidationCheck[], summary?: string): SkillValidationResult {
  const ok = checks.every((check) => check.ok);
  return {
    skillId,
    ok,
    mode,
    summary: summary ?? (ok ? "validation passed" : "validation failed"),
    checks,
  };
}

function isQueryError(result: string): boolean {
  return result.startsWith("[shell error]") || result.startsWith("[sql error]") || result.startsWith("[error]");
}

function findMissingTemplateKeys(template: string, data: Record<string, string>): string[] {
  const available = new Set<string>(["data", "date", ...Object.keys(data)]);
  const matches = [...template.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((match) => match[1]);
  return [...new Set(matches.filter((key) => !available.has(key)))];
}

function parseJsonRows(output: string): JsonRow[] | null {
  if (!output || output === "(no rows)") {
    return [];
  }
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    if (!parsed.every((row) => typeof row === "object" && row !== null && !Array.isArray(row))) {
      return null;
    }
    return parsed as JsonRow[];
  } catch {
    return null;
  }
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nonNegativeNumber(value: unknown): boolean {
  const parsed = numberFromUnknown(value);
  return parsed !== null && parsed >= 0;
}

function rowCountDetails(rows: JsonRow[] | null): string {
  if (rows === null) {
    return "not valid JSON row output";
  }
  return `${rows.length} row(s)`;
}

function buildGenericSqlChecks(ctx: DeclarativeValidationContext): SkillValidationCheck[] {
  const checks: SkillValidationCheck[] = [];
  for (const [queryId, queryType] of ctx.queryTypeById.entries()) {
    if (queryType !== "sql") {
      continue;
    }
    const rows = ctx.parsedSqlRows.get(queryId) ?? null;
    checks.push(makeCheck(
      `sql:${queryId}:json`,
      rows !== null,
      rows !== null ? rowCountDetails(rows) : (ctx.data[queryId] ?? "(missing output)").slice(0, 200),
    ));
  }
  return checks;
}

function getSingleRow(ctx: DeclarativeValidationContext, queryId: string): JsonRow | null {
  const rows = ctx.parsedSqlRows.get(queryId);
  if (!rows || rows.length === 0) {
    return null;
  }
  return rows[0];
}

function buildSkillSpecificDeclarativeChecks(skillId: string, ctx: DeclarativeValidationContext): SkillValidationCheck[] {
  const checks: SkillValidationCheck[] = [];

  switch (skillId) {
    case "auto-learn-from-approvals": {
      const row = getSingleRow(ctx, "existing_faq_count");
      checks.push(makeCheck(
        "semantic:faq-count",
        row !== null && nonNegativeNumber(row.cnt),
        row ? JSON.stringify(row) : "missing existing_faq_count row",
      ));
      break;
    }

    case "daily-digest": {
      const summaryRow = getSingleRow(ctx, "score_summary");
      checks.push(makeCheck(
        "semantic:score-summary",
        summaryRow !== null
          && nonNegativeNumber(summaryRow.today_points)
          && nonNegativeNumber(summaryRow.event_types),
        summaryRow ? JSON.stringify(summaryRow) : "missing score_summary row",
      ));
      break;
    }

    case "draft-failure-analyzer": {
      const rows = ctx.parsedSqlRows.get("tool_usage_patterns") ?? [];
      const ok = rows.every((row) => {
        const cnt = numberFromUnknown(row.cnt);
        const errors = numberFromUnknown(row.errors);
        return cnt !== null && errors !== null && cnt >= errors;
      });
      checks.push(makeCheck(
        "semantic:tool-usage-counts",
        ok,
        rows.length > 0 ? `${rows.length} tool usage rows validated` : "no tool usage rows",
      ));
      break;
    }

    case "faq-auto-builder": {
      const row = getSingleRow(ctx, "existing_kb_size");
      checks.push(makeCheck(
        "semantic:kb-size",
        row !== null && nonNegativeNumber(row.total_entries),
        row ? JSON.stringify(row) : "missing existing_kb_size row",
      ));
      break;
    }

    case "issue-trend-monitor": {
      const rows = ctx.parsedSqlRows.get("repeat_askers") ?? [];
      const ok = rows.every((row) => {
        const cnt = numberFromUnknown(row.cnt);
        const unresolvedish = numberFromUnknown(row.unresolvedish);
        return cnt !== null && unresolvedish !== null && cnt >= unresolvedish;
      });
      checks.push(makeCheck(
        "semantic:repeat-asker-counts",
        ok,
        rows.length > 0 ? `${rows.length} repeat asker rows validated` : "no repeat askers in window",
      ));
      break;
    }

    case "kb-quality-monitor": {
      const totalRow = getSingleRow(ctx, "total_entries");
      const categoryRows = ctx.parsedSqlRows.get("category_coverage") ?? [];
      const totalsOk = totalRow !== null
        && nonNegativeNumber(totalRow.total)
        && nonNegativeNumber(totalRow.resolved)
        && nonNegativeNumber(totalRow.weak_solution)
        && nonNegativeNumber(totalRow.weak_summary)
        && nonNegativeNumber(totalRow.weak_keywords)
        && numberFromUnknown(totalRow.total)! >= numberFromUnknown(totalRow.resolved)!
        && numberFromUnknown(totalRow.total)! >= numberFromUnknown(totalRow.weak_solution)!
        && numberFromUnknown(totalRow.total)! >= numberFromUnknown(totalRow.weak_summary)!
        && numberFromUnknown(totalRow.total)! >= numberFromUnknown(totalRow.weak_keywords)!;
      checks.push(makeCheck(
        "semantic:kb-totals",
        totalsOk,
        totalRow ? JSON.stringify(totalRow) : "missing total_entries row",
      ));

      const categoryOk = categoryRows.every((row) => {
        const total = numberFromUnknown(row.total);
        const resolved = numberFromUnknown(row.resolved);
        const pct = numberFromUnknown(row.resolve_pct);
        return total !== null && resolved !== null && pct !== null && total >= resolved && pct >= 0 && pct <= 100;
      });
      checks.push(makeCheck(
        "semantic:kb-category-rates",
        categoryOk,
        categoryRows.length > 0 ? `${categoryRows.length} category rows validated` : "no category rows",
      ));
      break;
    }

    case "knowledge-gap-detector": {
      const rows = ctx.parsedSqlRows.get("top_kb_categories") ?? [];
      const ok = rows.every((row) => nonNegativeNumber(row.cnt));
      checks.push(makeCheck(
        "semantic:top-category-counts",
        ok,
        rows.length > 0 ? `${rows.length} KB category rows validated` : "no category rows",
      ));
      break;
    }

    case "question-frequency-report": {
      const weekRow = getSingleRow(ctx, "total_questions_this_week");
      const prevRow = getSingleRow(ctx, "total_questions_prev_week");
      checks.push(makeCheck(
        "semantic:question-totals",
        weekRow !== null && prevRow !== null && nonNegativeNumber(weekRow.total) && nonNegativeNumber(prevRow.total),
        JSON.stringify({ thisWeek: weekRow ?? null, previousWeek: prevRow ?? null }),
      ));
      break;
    }

    case "weekly-summary": {
      const row = getSingleRow(ctx, "kb_growth");
      checks.push(makeCheck(
        "semantic:weekly-kb-growth",
        row !== null && nonNegativeNumber(row.total),
        row ? JSON.stringify(row) : "missing kb_growth row",
      ));
      break;
    }
  }

  return checks;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function withEnv<T>(overrides: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const original = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    original.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function runScriptSkill(
  skill: Extract<SkillManifest, { type: "script" }>,
  rootDir: string,
  options: {
    extraArgs?: string[];
    extraEnv?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<ScriptRunResult> {
  const entrypoint = path.resolve(skill._skillDir, skill.entrypoint);
  const args = [...(skill.args ?? []), ...(options.extraArgs ?? [])];
  const env = buildScriptSkillEnv(rootDir, { ...(skill.env ?? {}), ...(options.extraEnv ?? {}) });

  return new Promise<ScriptRunResult>((resolve, reject) => {
    const proc = spawn(skill.interpreter, [entrypoint, ...args], {
      cwd: skill._skillDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeoutMs ?? Math.min(skill.timeout, 60_000);
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    proc.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function withFixtureImage<T>(fn: (imagePath: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "stevesbot-skill-validate-"));
  const imagePath = path.join(tempDir, "fixture.png");
  await writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
  try {
    return await fn(imagePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function withMockServer<T>(
  handler: (body: string, request: http.IncomingMessage) => { status?: number; body: unknown },
  fn: (baseUrl: string, bodies: string[]) => Promise<T>,
): Promise<T> {
  const bodies: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => {
      bodies.push(body);
      const payload = handler(body, request);
      response.writeHead(payload.status ?? 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${address.port}`, bodies);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function validateDeclarativeSkill(skill: Extract<SkillManifest, { type: "declarative" }>, rootDir: string): Promise<SkillValidationResult> {
  const envOverrides: Record<string, string> = skill.id === "auto-mine-threads"
    ? {
      AUTO_MINE_DRY_RUN: "1",
      STEVESBOT_NODE: process.execPath,
      STEVESBOT_TSX_LOADER: path.join(rootDir, "node_modules", "tsx", "dist", "loader.mjs"),
    }
    : {};

  return withEnv(envOverrides, async () => {
    const data = await withValidationDatabases(rootDir, async (validationRoot) => gatherData(skill.data_queries, validationRoot));
    if (skill.id === "auto-mine-threads" && isQueryError(data.run_mining ?? "")) {
      data.run_mining = "Dry run: would launch mining batch (limit 10).";
    }
    const queryTypeById = new Map(skill.data_queries.map((query) => [query.id, query.type]));
    const parsedSqlRows = new Map<string, JsonRow[] | null>(
      skill.data_queries
        .filter((query) => query.type === "sql")
        .map((query) => [query.id, parseJsonRows(data[query.id] ?? "")]),
    );
    const ctx: DeclarativeValidationContext = { data, queryTypeById, parsedSqlRows };

    const checks: SkillValidationCheck[] = skill.data_queries.map((query) => {
      const output = data[query.id] ?? "";
      return makeCheck(
        `query:${query.id}`,
        !isQueryError(output),
        output ? output.slice(0, 200) : "(empty output)",
      );
    });
    checks.push(...buildGenericSqlChecks(ctx));

    buildChorePrompt(skill, data);
    const missingTemplateKeys = findMissingTemplateKeys(skill.prompt_template, data);
    checks.push(makeCheck(
      "prompt:placeholders",
      missingTemplateKeys.length === 0,
      missingTemplateKeys.length === 0 ? "prompt rendered cleanly" : "missing template keys: " + missingTemplateKeys.join(", "),
    ));

    if (skill.id === "auto-mine-threads") {
      checks.push(makeCheck(
        "dry-run:safe-launch",
        (data.run_mining ?? "").includes("Dry run: would launch mining batch"),
        data.run_mining ?? "missing run_mining output",
      ));
    }

    checks.push(...buildSkillSpecificDeclarativeChecks(skill.id, ctx));

    return finalizeResult(
      skill.id,
      "data",
      checks,
      checks.every((check) => check.ok)
        ? `validated ${skill.data_queries.length} data queries and prompt rendering`
        : "one or more data queries failed",
    );
  });
}

async function validateSystemHealthSkill(skill: Extract<SkillManifest, { type: "script" }>, rootDir: string): Promise<SkillValidationResult> {
  return withValidationDatabases(rootDir, async (validationRoot) => {
    const run = await runScriptSkill(skill, validationRoot, { timeoutMs: 45_000 });
    const checks = [
      makeCheck("process:exit", run.exitCode === 0, `exit=${run.exitCode}; stderr=${run.stderr.slice(0, 200) || "(none)"}`),
      makeCheck("output:status", run.stdout.includes("Status:"), run.stdout.slice(0, 300) || "(empty stdout)"),
      makeCheck("output:summary", run.stdout.includes("One-line summary:"), run.stdout.slice(0, 300) || "(empty stdout)"),
    ];
    return finalizeResult(skill.id, "live-e2e", checks, run.exitCode === 0 ? "system health script executed successfully" : "system health script failed");
  });
}

async function validateVisionAnalyzerSkill(skill: Extract<SkillManifest, { type: "script" }>, rootDir: string): Promise<SkillValidationResult> {
  return withFixtureImage((imagePath) => withMockServer(
    () => ({
      body: {
        choices: [
          {
            message: {
              content: "{\"target\":{\"x\":123,\"y\":45},\"label\":\"mock target\"}",
            },
          },
        ],
      },
    }),
    async (baseUrl, bodies) => {
      const run = await runScriptSkill(skill, rootDir, {
        extraArgs: ["Locate the target", "--image", imagePath, "--format", "json"],
        extraEnv: {
          VISION_API_URL: `${baseUrl}/v1/chat/completions`,
          VISION_MODEL: "mock-vision",
        },
      });

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(run.stdout) as Record<string, unknown>;
      } catch {
        parsed = null;
      }

      const requestBody = bodies[0] ? JSON.parse(bodies[0]) as Record<string, unknown> : null;
      const messageList = Array.isArray(requestBody?.messages) ? requestBody.messages as Array<Record<string, unknown>> : [];
      const firstContent = Array.isArray(messageList[0]?.content) ? messageList[0].content as Array<Record<string, unknown>> : [];
      const imagePart = firstContent.find((part) => part.type === "image_url");
      const imageUrl = imagePart && typeof imagePart.image_url === "object" && imagePart.image_url !== null
        ? String((imagePart.image_url as Record<string, unknown>).url ?? "")
        : "";

      const target = parsed?.target as Record<string, unknown> | undefined;
      const checks = [
        makeCheck("process:exit", run.exitCode === 0, `exit=${run.exitCode}; stderr=${run.stderr.slice(0, 200) || "(none)"}`),
        makeCheck("output:json", parsed !== null, run.stdout.slice(0, 300) || "(empty stdout)"),
        makeCheck("output:coords", target?.x === 123 && target?.y === 45, JSON.stringify(parsed ?? run.stdout).slice(0, 300)),
        makeCheck("request:image", imageUrl.startsWith("data:image/png;base64,"), imageUrl.slice(0, 60) || "(missing image payload)"),
      ];

      return finalizeResult(skill.id, "mock-e2e", checks, checks.every((check) => check.ok) ? "vision analyzer passed mocked image analysis" : "vision analyzer mock validation failed");
    },
  ));
}

async function validateCaptchaBypassSkill(skill: Extract<SkillManifest, { type: "script" }>, rootDir: string): Promise<SkillValidationResult> {
  return withFixtureImage((imagePath) => withMockServer(
    () => ({
      body: {
        message: {
          content: JSON.stringify({
            found: true,
            element_type: "checkbox",
            center_x: 321,
            center_y: 654,
            confidence: 0.91,
            description: "mock captcha checkbox",
          }),
        },
      },
    }),
    async (baseUrl, bodies) => {
      const run = await runScriptSkill(skill, rootDir, {
        extraArgs: ["--image", imagePath, "--dry-run", "--json"],
        extraEnv: {
          CAPTCHA_API_URL: baseUrl,
          CAPTCHA_VISION_MODEL: "mock-captcha",
        },
      });

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(run.stdout) as Record<string, unknown>;
      } catch {
        parsed = null;
      }

      const requestBody = bodies[0] ? JSON.parse(bodies[0]) as Record<string, unknown> : null;
      const images = Array.isArray((requestBody?.messages as Array<Record<string, unknown>> | undefined)?.[0]?.images)
        ? (requestBody?.messages as Array<Record<string, unknown>>)[0].images as string[]
        : [];
      const target = parsed?.target as Record<string, unknown> | undefined;
      const checks = [
        makeCheck("process:exit", run.exitCode === 0, `exit=${run.exitCode}; stderr=${run.stderr.slice(0, 200) || "(none)"}`),
        makeCheck("output:json", parsed !== null, run.stdout.slice(0, 300) || "(empty stdout)"),
        makeCheck("output:coords", target?.x === 321 && target?.y === 654, JSON.stringify(parsed ?? run.stdout).slice(0, 300)),
        makeCheck("output:dry-run", parsed?.dry_run === true && parsed?.clicked === false && parsed?.click_ready === true, JSON.stringify(parsed ?? run.stdout).slice(0, 300)),
        makeCheck("request:image", images.length === 1 && images[0].length > 20, images.length > 0 ? images[0].slice(0, 40) : "(missing image payload)"),
      ];

      return finalizeResult(skill.id, "mock-e2e", checks, checks.every((check) => check.ok) ? "captcha bypass passed mocked dry-run validation" : "captcha bypass mock validation failed");
    },
  ));
}

async function validateDryRunScriptSkill(skill: Extract<SkillManifest, { type: "script" }>, rootDir: string): Promise<SkillValidationResult> {
  const run = await runScriptSkill(skill, rootDir, {
    extraArgs: ["--dry-run"],
    extraEnv: { OPENCODE_API_KEY: process.env.OPENCODE_API_KEY ?? "dry-run-validation" },
    timeoutMs: 45_000,
  });

  const checks = [
    makeCheck("process:exit", run.exitCode === 0, `exit=${run.exitCode}; stderr=${run.stderr.slice(0, 200) || "(none)"}`),
    makeCheck("output:dry-run", /DRY RUN/i.test(run.stdout), run.stdout.slice(0, 300) || "(empty stdout)"),
  ];

  if (skill.id === "weekly-kb-mining") {
    checks.push(makeCheck(
      "output:plan",
      run.stdout.includes("Would launch enrichment"),
      run.stdout.slice(0, 400) || "(empty stdout)",
    ));
  }

  if (skill.id === "monthly-kb-refresh") {
    checks.push(makeCheck(
      "output:plan",
      run.stdout.includes("Would run KB enrichment"),
      run.stdout.slice(0, 400) || "(empty stdout)",
    ));
  }

  return finalizeResult(skill.id, "dry-run", checks, checks.every((check) => check.ok) ? "script dry-run completed" : "script dry-run failed");
}

async function validateStaticScriptSkill(skill: Extract<SkillManifest, { type: "script" }>): Promise<SkillValidationResult> {
  const entrypoint = path.resolve(skill._skillDir, skill.entrypoint);
  const exists = await pathExists(entrypoint);
  return finalizeResult(skill.id, "static", [
    makeCheck("entrypoint:exists", exists, entrypoint),
  ], exists ? "script entrypoint exists" : "script entrypoint missing");
}

export async function validateSkill(rootDir: string, skill: SkillManifest): Promise<SkillValidationResult> {
  const baseChecks: SkillValidationCheck[] = [];
  if (skill.type === "script") {
    const entrypoint = path.resolve(skill._skillDir, skill.entrypoint);
    baseChecks.push(makeCheck("entrypoint:exists", await pathExists(entrypoint), entrypoint));
    if (!baseChecks[0].ok) {
      return finalizeResult(skill.id, "static", baseChecks, "script entrypoint missing");
    }
  }

  let result: SkillValidationResult;
  if (skill.type === "declarative") {
    result = await validateDeclarativeSkill(skill, rootDir);
  } else if (skill.id === "system-health-check") {
    result = await validateSystemHealthSkill(skill, rootDir);
  } else if (skill.id === "vision-analyzer") {
    result = await validateVisionAnalyzerSkill(skill, rootDir);
  } else if (skill.id === "captcha-bypass") {
    result = await validateCaptchaBypassSkill(skill, rootDir);
  } else if (skill.id === "weekly-kb-mining" || skill.id === "monthly-kb-refresh") {
    result = await validateDryRunScriptSkill(skill, rootDir);
  } else {
    result = await validateStaticScriptSkill(skill);
  }

  return {
    ...result,
    ok: baseChecks.every((check) => check.ok) && result.ok,
    checks: [...baseChecks, ...result.checks],
  };
}

export async function validateSkills(params: {
  rootDir: string;
  skillIds?: string[];
}): Promise<SkillValidationResult[]> {
  const skills = await loadAllSkills(path.join(params.rootDir, "skills"));
  const selected = params.skillIds?.length
    ? params.skillIds.map((skillId) => {
        const skill = skills.get(skillId);
        if (!skill) {
          throw new Error("Unknown skill: " + skillId);
        }
        return skill;
      })
    : [...skills.values()].sort((a, b) => a.id.localeCompare(b.id));

  const results: SkillValidationResult[] = [];
  for (const skill of selected) {
    results.push(await validateSkill(params.rootDir, skill));
  }
  return results;
}
