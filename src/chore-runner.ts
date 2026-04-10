import { readFile, readdir } from "node:fs/promises";
import { execSync, spawn } from "node:child_process";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import Database from "better-sqlite3";
import { callLocalChatWithFallback } from "./models/local-model-fallback.js";
import { getPreferredLocalQwenProvider } from "./models/provider-fallbacks.js";
import { AppDatabase } from "./store/database.js";

// ── Types ──

type DataQuery = {
  id: string;
  type: "shell" | "sql";
  command?: string;
  db?: string;
  query?: string;
};

type SkillBase = {
  id: string;
  name: string;
  description: string;
  schedule: string;
  report_to: string;
};

type DeclarativeSkill = SkillBase & {
  type: "declarative";
  uses_llm: boolean;
  model_preference: string;
  data_queries: DataQuery[];
  prompt_template: string;
  output_format: string;
};

type ScriptSkill = SkillBase & {
  type: "script";
  interpreter: string;
  entrypoint: string;
  args?: string[];
  env?: Record<string, string>;
  timeout: number;
  /** Resolved at load time — absolute path to the skill directory */
  _skillDir: string;
};

export type SkillManifest = DeclarativeSkill | ScriptSkill;

function dedupePathEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  const normalized = entries
    .flatMap((entry) => entry.split(path.delimiter))
    .map((entry) => entry.trim())
    .filter(Boolean);
  const result: string[] = [];
  for (const entry of normalized) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

export function buildScriptSkillEnv(rootDir: string, skillEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const nodeBinDir = path.dirname(process.execPath);
  const nodeModulesBin = path.join(rootDir, "node_modules", ".bin");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...skillEnv,
    STEVESBOT_ROOT: rootDir,
    STEVESBOT_NODE: process.execPath,
    STEVESBOT_TSX_LOADER: path.join(rootDir, "node_modules", "tsx", "dist", "loader.mjs"),
  };

  env.PATH = dedupePathEntries([
    nodeModulesBin,
    nodeBinDir,
    env.PATH ?? "",
  ]).join(path.delimiter);

  return env;
}

// ── Skill loader ──
// Reads skills/<name>/skill.yaml from each subdirectory

export async function loadSkillManifest(skillDir: string): Promise<SkillManifest> {
  const yamlPath = path.join(skillDir, "skill.yaml");
  const raw = await readFile(yamlPath, "utf8");
  const parsed = parseYaml(raw) as Record<string, unknown>;

  if (parsed.type === "script") {
    return {
      ...(parsed as Omit<ScriptSkill, "_skillDir">),
      timeout: (parsed as { timeout?: number }).timeout ?? 120_000,
      _skillDir: skillDir,
    } as ScriptSkill;
  }

  // Default to declarative (backward compat with YAML that lacks type field)
  return { ...parsed, type: "declarative" } as DeclarativeSkill;
}

export async function loadAllSkills(skillsDir: string): Promise<Map<string, SkillManifest>> {
  const skills = new Map<string, SkillManifest>();
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return skills;
  }
  for (const entry of entries) {
    const skillDir = path.join(skillsDir, entry);
    try {
      const skill = await loadSkillManifest(skillDir);
      skills.set(skill.id, skill);
    } catch {
      // Not a skill directory (e.g. README.md) — skip
    }
  }
  return skills;
}

// ── Unified executor ──

export async function executeSkill(params: {
  skill: SkillManifest;
  rootDir: string;
  db: AppDatabase;
  choreId: string;
  opsKnowledge?: string;
  extraArgs?: string[];
}): Promise<{ status: string; result: string; durationMs: number }> {
  if (params.skill.type === "script") {
    return executeScriptSkill(params.skill, params);
  }
  return executeDeclarativeSkill(params.skill, params);
}

// ── Declarative skill executor ──

async function executeDeclarativeSkill(
  skill: DeclarativeSkill,
  params: { rootDir: string; db: AppDatabase; choreId: string; opsKnowledge?: string },
): Promise<{ status: string; result: string; durationMs: number }> {
  const startMs = Date.now();

  try {
    // 1. Gather data
    const data = gatherData(skill.data_queries, params.rootDir);

    // 2. Build prompt
    const prompt = buildChorePrompt(skill, data, params.opsKnowledge);

    // 3. Call LLM if needed
    let result: string;
    const shortCircuit = maybeShortCircuitSkillResult(skill.id, data);
    if (shortCircuit) {
      result = shortCircuit;
    } else if (skill.uses_llm) {
      result = await callLocalQwen(prompt);
    } else {
      result = Object.entries(data).map(([k, v]) => k + ": " + v).join("\n");
    }

    const durationMs = Date.now() - startMs;

    params.db.recordChoreRun({
      choreId: params.choreId,
      skillId: skill.id,
      status: "ok",
      result,
      dataSnapshot: JSON.stringify(data),
      durationMs,
      modelUsed: skill.uses_llm ? "local-qwen" : undefined,
    });

    return { status: "ok", result, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);

    params.db.recordChoreRun({
      choreId: params.choreId,
      skillId: skill.id,
      status: "error",
      result: errMsg.slice(0, 2000),
      durationMs,
    });

    return { status: "error", result: errMsg, durationMs };
  }
}

// ── Script skill executor ──

async function executeScriptSkill(
  skill: ScriptSkill,
  params: { rootDir: string; db: AppDatabase; choreId: string; extraArgs?: string[] },
): Promise<{ status: string; result: string; durationMs: number }> {
  const startMs = Date.now();

  try {
    const entrypoint = path.resolve(skill._skillDir, skill.entrypoint);
    const args = [...(skill.args ?? []), ...(params.extraArgs ?? [])];
    const env = buildScriptSkillEnv(params.rootDir, skill.env);

    const result = await new Promise<string>((resolve, reject) => {
      const proc = spawn(skill.interpreter, [entrypoint, ...args], {
        cwd: skill._skillDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: skill.timeout,
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(
            "Skill " + skill.id + " exited with code " + code +
            (stderr ? "\nstderr: " + stderr.slice(0, 500) : "")
          ));
        }
      });

      proc.on("error", (err) => reject(err));
    });

    const durationMs = Date.now() - startMs;

    params.db.recordChoreRun({
      choreId: params.choreId,
      skillId: skill.id,
      status: "ok",
      result,
      durationMs,
    });

    return { status: "ok", result, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);

    params.db.recordChoreRun({
      choreId: params.choreId,
      skillId: skill.id,
      status: "error",
      result: errMsg.slice(0, 2000),
      durationMs,
    });

    return { status: "error", result: errMsg, durationMs };
  }
}

// ── Data gatherer ──

function runShellQuery(command: string, rootDir: string): string {
  try {
    return execSync(command, {
      cwd: rootDir,
      timeout: 120_000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[shell error] " + msg.slice(0, 200);
  }
}

function runSqlQuery(dbName: string, query: string, rootDir: string): string {
  const dbPaths: Record<string, string> = {
    stevesbot: path.join(rootDir, "data", "sqlite", "stevesbot.sqlite"),
    knowledge: path.join(rootDir, "data", "sqlite", "knowledge.sqlite"),
    archive: path.join(rootDir, "data", "sqlite", "archive.sqlite"),
  };
  const dbPath = dbPaths[dbName];
  if (!dbPath) return "[error] Unknown db: " + dbName;

  try {
    const db = new Database(dbPath, { readonly: true });
    db.pragma("busy_timeout = 3000");
    const rows = db.prepare(query).all();
    db.close();
    if (rows.length === 0) return "(no rows)";
    return JSON.stringify(rows, null, 2);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[sql error] " + msg.slice(0, 200);
  }
}

export function gatherData(queries: DataQuery[], rootDir: string): Record<string, string> {
  const results: Record<string, string> = {};
  for (const q of queries) {
    if (q.type === "shell" && q.command) {
      results[q.id] = runShellQuery(q.command, rootDir);
    } else if (q.type === "sql" && q.db && q.query) {
      results[q.id] = runSqlQuery(q.db, q.query, rootDir);
    } else {
      results[q.id] = "[error] Invalid query definition";
    }
  }
  return results;
}

// ── Prompt builder ──

export function buildChorePrompt(skill: { prompt_template: string }, data: Record<string, string>, opsKnowledge?: string): string {
  const dataBlock = Object.entries(data)
    .map(([key, value]) => key + ":\n" + value)
    .join("\n\n");

  const replacements: Record<string, string> = {
    data: dataBlock,
    date: new Date().toISOString().slice(0, 10),
    ...data,
  };

  let prompt = skill.prompt_template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => (
    Object.prototype.hasOwnProperty.call(replacements, key)
      ? replacements[key]
      : "[missing:" + key + "]"
  ));

  if (opsKnowledge) {
    prompt += "\n\nOperational reference:\n" + opsKnowledge;
  }

  return prompt;
}

export function maybeShortCircuitSkillResult(skillId: string, data: Record<string, string>): string | null {
  if (skillId === "faq-auto-builder") {
    if (data.repeated_questions === "(no rows)") {
      return "No strong new FAQ candidates today.";
    }
    if (data.repeated_questions?.startsWith("[sql error]")) {
      return "FAQ auto-builder query failed; no FAQ candidates generated.";
    }
  }

  return null;
}

// ── LLM caller (local Qwen) ──

export async function callLocalQwen(prompt: string, opts?: { baseUrl?: string; model?: string; timeout?: number }): Promise<string> {
  const preferredProvider = getPreferredLocalQwenProvider(process.env, "chore-runner:qwen");
  const timeout = opts?.timeout ?? preferredProvider.requestTimeoutMs ?? 300_000;
  const providers = opts?.baseUrl
    ? [{
        baseUrl: opts.baseUrl,
        model: opts.model ?? preferredProvider.model,
        clientLabel: "chore-runner:qwen:override",
        requestTimeoutMs: timeout,
      }]
    : undefined;

  return callLocalChatWithFallback({
    env: process.env,
    clientLabel: "chore-runner:qwen",
    providers,
    timeoutMs: timeout,
    temperature: 0.3,
    maxTokens: 1024,
    errorLabel: "Local model",
    messages: [
      { role: "system", content: "You are StevesBot's operations assistant. Be concise and actionable." },
      { role: "user", content: prompt },
    ],
  });
}

// ── Discord posting ──

export async function postChoreResultToDiscord(params: {
  choreId: string;
  skillName: string;
  result: string;
  status: string;
  durationMs: number;
  channelId: string;
  token: string;
}): Promise<void> {
  // Only post meaningful results (not "no chores due" or errors over 1000 chars)
  if (params.status !== "ok") return;
  if (params.result.length < 20) return;

  // Truncate to Discord limit
  const maxLen = 1900;
  let content = "**" + params.skillName + "** (" + Math.round(params.durationMs / 1000) + "s)\n" + params.result;
  if (content.length > maxLen) {
    content = content.slice(0, maxLen - 20) + "\n...(truncated)";
  }

  try {
    const res = await fetch("https://discord.com/api/v10/channels/" + params.channelId + "/messages", {
      method: "POST",
      headers: {
        Authorization: "Bot " + params.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      console.error("[CHORE-POST] Discord " + res.status + ": " + await res.text().catch(() => ""));
    }
  } catch (err) {
    // Posting is best-effort — VPN may be down
    console.error("[CHORE-POST] Failed:", err instanceof Error ? err.message : String(err));
  }
}

// ── Schedule parser (cron-like, local time) ──

function normalizeDayOfWeek(value: number): number {
  return value === 7 ? 0 : value;
}

function matchesCronField(field: string, value: number, min: number, max: number, normalize?: (n: number) => number): boolean {
  const normalizedValue = normalize ? normalize(value) : value;
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }
    if (part === "*") {
      return true;
    }

    let step = 1;
    let base = part;
    if (part.includes("/")) {
      const [basePart, stepPart] = part.split("/");
      const parsedStep = Number.parseInt(stepPart, 10);
      if (!Number.isInteger(parsedStep) || parsedStep <= 0) {
        continue;
      }
      step = parsedStep;
      base = basePart;
    }

    let start = min;
    let end = max;

    if (base && base !== "*") {
      if (base.includes("-")) {
        const [startPart, endPart] = base.split("-");
        const parsedStart = Number.parseInt(startPart, 10);
        const parsedEnd = Number.parseInt(endPart, 10);
        if (!Number.isInteger(parsedStart) || !Number.isInteger(parsedEnd)) {
          continue;
        }
        start = normalize ? normalize(parsedStart) : parsedStart;
        end = normalize ? normalize(parsedEnd) : parsedEnd;
      } else {
        const parsed = Number.parseInt(base, 10);
        if (!Number.isInteger(parsed)) {
          continue;
        }
        start = normalize ? normalize(parsed) : parsed;
        end = start;
      }
    }

    if (start > end) {
      continue;
    }
    if (normalizedValue < start || normalizedValue > end) {
      continue;
    }
    if ((normalizedValue - start) % step === 0) {
      return true;
    }
  }
  return false;
}

export function matchesCronSchedule(schedule: string, date: Date): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }
  const [minPart, hourPart, dayOfMonthPart, monthPart, dayOfWeekPart] = parts;
  return (
    matchesCronField(minPart, date.getMinutes(), 0, 59) &&
    matchesCronField(hourPart, date.getHours(), 0, 23) &&
    matchesCronField(dayOfMonthPart, date.getDate(), 1, 31) &&
    matchesCronField(monthPart, date.getMonth() + 1, 1, 12) &&
    matchesCronField(dayOfWeekPart, date.getDay(), 0, 7, normalizeDayOfWeek)
  );
}

export function getMostRecentScheduledTime(schedule: string, now: Date, lookbackDays = 400): Date | null {
  const cursor = new Date(now);
  cursor.setSeconds(0, 0);
  const maxMinutes = lookbackDays * 24 * 60;
  for (let i = 0; i <= maxMinutes; i += 1) {
    if (matchesCronSchedule(schedule, cursor)) {
      return new Date(cursor);
    }
    cursor.setMinutes(cursor.getMinutes() - 1);
  }
  return null;
}

export function shouldRunNow(schedule: string, lastRunAt: string | null, now = new Date(), createdAt?: string | null): boolean {
  const slot = getMostRecentScheduledTime(schedule, now);
  if (!slot) {
    return false;
  }

  if (lastRunAt) {
    return new Date(lastRunAt).getTime() < slot.getTime();
  }

  if (createdAt) {
    return new Date(createdAt).getTime() <= slot.getTime();
  }

  return true;
}
