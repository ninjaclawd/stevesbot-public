import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { loadAppConfig, type AppConfig } from "./config.js";
import { ensureLayout } from "./fs-layout.js";
import { OpenAiCompatJsonClient } from "./models/openai-compat.js";
import { buildOpenCodeFallbackProviders, buildPreferredLocalQwenClientOptions } from "./models/provider-fallbacks.js";
import { SupportPipeline } from "./pipeline/support-pipeline.js";
import { AppDatabase } from "./store/database.js";
import { WorkflowQueueWorker } from "./worker.js";
import type { DiscordEventRecord, ReviewDeliveryResult } from "./types.js";

type HistoricalSupportRow = {
  route_id: string;
  product_id: string;
  source_thread_ref: string;
  date_start: string;
  date_end: string;
  question_summary: string;
  answer_summary: string;
  status_flags: string;
};

type WorkflowRunRow = {
  id: number;
  route_id: string;
  thread_key: string;
  message_id: string;
  guild_id: string;
  channel_id: string;
  thread_id: string | null;
  author_id: string;
  author_name: string;
  source_url: string;
  message_content: string;
  discord_created_at: string;
  outcome: string;
  error_text: string | null;
};

type ReplayResult = {
  historicalRunId: number;
  routeId: string;
  threadKey: string;
  messageId: string;
  authorName: string;
  content: string;
  oldOutcome: string;
  oldErrorText?: string;
  newOutcome: string;
  newErrorText?: string;
  newRunId?: number;
  queueStatus?: string;
  changed: boolean;
};

function loadDotEnv(): void {
  const envPath = path.resolve(".env");
  if (!existsSync(envPath)) {
    return;
  }
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const [key, ...rest] = line.split("=");
    if (!key) {
      continue;
    }
    if (!(key in process.env)) {
      process.env[key] = rest.join("=");
    }
  }
}

function parseArgs(): { ids?: Set<number>; limit?: number } {
  const args = process.argv.slice(2);
  const result: { ids?: Set<number>; limit?: number } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--ids") {
      const raw = args[index + 1] ?? "";
      result.ids = new Set(
        raw
          .split(",")
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isInteger(value)),
      );
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(args[index + 1] ?? "");
      if (Number.isInteger(value) && value > 0) {
        result.limit = value;
      }
      index += 1;
    }
  }
  return result;
}

function createReplayConfig(appConfig: AppConfig, replayDir: string): AppConfig {
  return {
    ...appConfig,
    transcriptsDir: path.join(replayDir, "transcripts"),
    sqlitePath: path.join(replayDir, "sqlite", "replay.sqlite"),
    logsDir: path.join(replayDir, "logs"),
  };
}

function toEvent(row: WorkflowRunRow): DiscordEventRecord {
  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    threadId: row.thread_id ?? undefined,
    messageId: row.message_id,
    authorId: row.author_id,
    authorName: row.author_name,
    content: row.message_content,
    createdAt: row.discord_created_at,
    sourceUrl: row.source_url,
  };
}

async function main(): Promise<void> {
  loadDotEnv();
  const options = parseArgs();
  const appConfig = await loadAppConfig(process.env.STEVESBOT_ROOT);
  const liveDb = new Database(appConfig.sqlitePath, { readonly: true });

  const selectedRuns = (
    liveDb
      .prepare(`
        SELECT id, route_id, thread_key, message_id, guild_id, channel_id, thread_id, author_id, author_name,
               source_url, message_content, discord_created_at, outcome, error_text
        FROM workflow_runs
        ORDER BY id ASC
      `)
      .all() as WorkflowRunRow[]
  ).filter((row) => (options.ids ? options.ids.has(row.id) : true));

  const runsToReplay = options.limit ? selectedRuns.slice(0, options.limit) : selectedRuns;
  if (runsToReplay.length === 0) {
    throw new Error("No recorded workflow runs matched the replay selection.");
  }

  const replayDir = path.join(appConfig.rootDir, "data", "replays", `recorded-${Date.now()}`);
  const replayConfig = createReplayConfig(appConfig, replayDir);
  await ensureLayout(replayConfig);
  await mkdir(path.dirname(replayConfig.sqlitePath), { recursive: true });
  await mkdir(replayConfig.logsDir, { recursive: true });

  const replayDb = new AppDatabase(replayConfig.sqlitePath);
  const supportRows = liveDb
    .prepare(`
      SELECT route_id, product_id, source_thread_ref, date_start, date_end, question_summary, answer_summary, status_flags
      FROM support_records
      ORDER BY id ASC
    `)
    .all() as HistoricalSupportRow[];
  for (const row of supportRows) {
    replayDb.upsertHistoricalRecord({
      routeId: row.route_id,
      productId: row.product_id,
      sourceThreadRef: row.source_thread_ref,
      dateStart: row.date_start,
      dateEnd: row.date_end,
      questionSummary: row.question_summary,
      answerSummary: row.answer_summary,
      statusFlags: JSON.parse(row.status_flags) as string[],
    });
  }

  const qwenClient = new OpenAiCompatJsonClient({
    ...buildPreferredLocalQwenClientOptions(process.env, "qwen-router-validator"),
    systemRoleLabel: "You are the local support decision router and final validator.",
  });

  const openCodeClient = new OpenAiCompatJsonClient({
    baseUrl: process.env.OPENCODE_BASE_URL ?? "https://api.opencode.ai/v1",
    apiKey: process.env.OPENCODE_API_KEY,
    model: process.env.OPENCODE_MODEL ?? "gpt-5.4-pro",
    systemRoleLabel: "You are GPT-5.4 acting as a repo-aware support answer drafter with read-only tools.",
    clientLabel: "gpt-drafter",
    requestTimeoutMs: Number(process.env.OPENCODE_TIMEOUT_MS ?? process.env.STEVESBOT_MODEL_TIMEOUT_MS ?? "180000"),
    fallbackProviders: buildOpenCodeFallbackProviders(process.env, "gpt-drafter"),
  });

  const pipeline = new SupportPipeline(replayConfig, replayDb, qwenClient, openCodeClient);
  const deliveries: Array<{ routeId: string; messageId: string; reply: string; delivery: ReviewDeliveryResult }> = [];
  const worker = new WorkflowQueueWorker(
    replayConfig,
    replayDb,
    pipeline,
    {
      publish: async (route, event, reply) => {
        const delivery = {
          channelId: replayConfig.reviewChannel?.channelId ?? "review-channel",
          messageId: `replay-${deliveries.length + 1}`,
        };
        deliveries.push({ routeId: route.id, messageId: event.messageId, reply, delivery });
        return delivery;
      },
    },
    {
      workerId: "recorded-replay-worker",
      retryDelayMs: 0,
      maxAttempts: 1,
    },
  );

  for (const row of runsToReplay) {
    const route = appConfig.routes.find((entry) => entry.id === row.route_id);
    if (!route) {
      console.log(`Skipping run #${row.id}; route ${row.route_id} no longer exists.`);
      continue;
    }
    replayDb.enqueueWorkflowJob(route.id, toEvent(row));
  }

  let safety = runsToReplay.length * 3 + 10;
  while (safety > 0) {
    const processed = await worker.processNextJob();
    if (!processed) {
      break;
    }
    safety -= 1;
  }
  if (safety <= 0) {
    throw new Error("Replay loop hit safety limit before the queue drained.");
  }

  const replayRuns = replayDb.listWorkflowRuns({ page: 1, pageSize: Math.max(100, runsToReplay.length + 10) }).items;
  const replayJobs = replayDb.listWorkflowQueue(Math.max(100, runsToReplay.length + 10));
  const replayRunByMessageId = new Map(replayRuns.map((run) => [run.messageId, run]));
  const replayJobByMessageId = new Map(replayJobs.map((job) => [job.event.messageId, job]));

  const results: ReplayResult[] = runsToReplay.map((row) => {
    const replayRun = replayRunByMessageId.get(row.message_id);
    const replayJob = replayJobByMessageId.get(row.message_id);
    const newOutcome = replayRun ? replayRun.outcome : replayJob?.status ?? "missing";
    return {
      historicalRunId: row.id,
      routeId: row.route_id,
      threadKey: row.thread_key,
      messageId: row.message_id,
      authorName: row.author_name,
      content: row.message_content,
      oldOutcome: row.outcome,
      oldErrorText: row.error_text ?? undefined,
      newOutcome,
      newErrorText: replayRun?.errorText ?? replayJob?.lastError,
      newRunId: replayRun?.id,
      queueStatus: replayJob?.status,
      changed: row.outcome !== newOutcome,
    };
  });

  const oldCounts = new Map<string, number>();
  const newCounts = new Map<string, number>();
  for (const result of results) {
    oldCounts.set(result.oldOutcome, (oldCounts.get(result.oldOutcome) ?? 0) + 1);
    newCounts.set(result.newOutcome, (newCounts.get(result.newOutcome) ?? 0) + 1);
  }

  const summary = {
    replayDir,
    sourceDb: appConfig.sqlitePath,
    totalReplayed: results.length,
    supportRecordsCopied: supportRows.length,
    deliveries: deliveries.length,
    oldOutcomeCounts: Object.fromEntries(oldCounts),
    newOutcomeCounts: Object.fromEntries(newCounts),
    changedMessages: results.filter((result) => result.changed).length,
    results,
  };

  const summaryPath = path.join(replayDir, "summary.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  console.log(`Replay directory: ${replayDir}`);
  console.log(`Summary file: ${summaryPath}`);
  console.log(`Replayed messages: ${results.length}`);
  console.log(`Deliveries captured: ${deliveries.length}`);
  console.log(`Old outcomes: ${JSON.stringify(summary.oldOutcomeCounts)}`);
  console.log(`New outcomes: ${JSON.stringify(summary.newOutcomeCounts)}`);
  console.log(`Changed messages: ${summary.changedMessages}`);
  for (const result of results.filter((entry) => entry.changed).slice(0, 15)) {
    console.log(
      `#${result.historicalRunId} ${result.routeId} ${result.authorName}: ${result.oldOutcome} -> ${result.newOutcome}` +
        (result.newErrorText ? ` | ${result.newErrorText}` : ""),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
