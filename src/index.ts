import "./logger.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadAppConfig } from "./config.js";
import { DiscordBot } from "./discord/bot.js";
import { sendApprovedDraftFromRun } from "./discord/review-actions.js";
import type { TriageFlowState } from "./discord/interactive-triage.js";
import { ensureLayout } from "./fs-layout.js";
import { OpenAiCompatJsonClient } from "./models/openai-compat.js";
import { buildOpenCodeFallbackProviders, buildPreferredLocalQwenClientOptions } from "./models/provider-fallbacks.js";
import { SupportPipeline } from "./pipeline/support-pipeline.js";
import { DiscordReviewPublisher } from "./review-publisher.js";
import { AppDatabase } from "./store/database.js";
import { startObservabilityServer } from "./web/server.js";
import { initScoring } from "./scoring.js";
import { buildTfidfIndex } from "./tfidf-search.js";
import { WorkflowQueueWorker } from "./worker.js";
import { createStevesP2PBridge, broadcastPipelineEvent } from "./p2p/integration.js";
import type { VDOBridge } from "./p2p/vdo-bridge.js";

type RuntimeRole = "intake" | "worker" | "web" | "p2p";

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
    const value = rest.join("=");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function parseRuntimeRoles(raw: string | undefined): Set<RuntimeRole> {
  const normalized = (raw ?? "all").trim().toLowerCase();
  if (normalized === "all") {
    return new Set<RuntimeRole>(["intake", "worker", "web", "p2p"]);
  }

  const roles = normalized
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is RuntimeRole => value === "intake" || value === "worker" || value === "web" || value === "p2p");

  if (roles.length === 0) {
    throw new Error(`Invalid STEVESBOT_ROLE value: ${raw}`);
  }

  return new Set(roles);
}

function requireDiscordToken(): string {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required for intake/worker roles.");
  }
  return token;
}

async function main(): Promise<void> {
  loadDotEnv();
  const roles = parseRuntimeRoles(process.env.STEVESBOT_ROLE);
  const appConfig = await loadAppConfig(process.env.STEVESBOT_ROOT);
  await ensureLayout(appConfig);

  const database = new AppDatabase(appConfig.sqlitePath);
  initScoring(database);

  // Build TF-IDF similarity index for semantic search
  try {
    const kbPath = path.join(appConfig.rootDir, "data", "sqlite", "knowledge.sqlite");
    buildTfidfIndex(kbPath);
  } catch (err) {
    console.error("[TFIDF] Failed to build index:", err instanceof Error ? err.message : err);
  }

  let webServer: import("node:http").Server | undefined;
  let worker: WorkflowQueueWorker | undefined;
  let bot: DiscordBot | undefined;
  let p2pBridge: VDOBridge | undefined;

  // Graceful shutdown handler
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${signal}] Shutting down gracefully...`);

    // Disconnect P2P bridge
    if (p2pBridge) {
      try { await p2pBridge.disconnect(); console.log("P2P bridge disconnected."); }
      catch (e) { console.error("P2P disconnect error:", e); }
    }

    // Stop accepting new work first
    if (worker) {
      try { await worker.stop(); console.log("Worker stopped."); }
      catch (e) { console.error("Worker stop error:", e); }
    }
    if (bot) {
      try { bot.destroy(); console.log("Discord client destroyed."); }
      catch (e) { console.error("Discord destroy error:", e); }
    }
    if (webServer) {
      try {
        await new Promise<void>((resolve, reject) => {
          webServer!.close((err) => err ? reject(err) : resolve());
        });
        console.log("Web server closed.");
      } catch (e) { console.error("Web server close error:", e); }
    }

    // Close database last (other components may still flush)
    try { database.close(); console.log("Database closed."); }
    catch (e) { console.error("Database close error:", e); }

    console.log("Shutdown complete.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  if (roles.has("web")) {
    const webHost = process.env.STEVESBOT_WEB_HOST ?? "0.0.0.0";
    const webPort = Number(process.env.STEVESBOT_WEB_PORT ?? "8787");
    webServer = await startObservabilityServer(database, { host: webHost, port: webPort, discordToken: process.env.DISCORD_BOT_TOKEN });
    console.log(`Observability UI listening on http://${webHost}:${webPort}`);
  }

  if (roles.has("p2p")) {
    try {
      p2pBridge = createStevesP2PBridge({ config: appConfig, database });
      await p2pBridge.connect();
      console.log("P2P bridge started.");
    } catch (e) {
      console.error("P2P bridge failed to start:", e);
    }
  }

  if (roles.has("worker")) {
    const token = requireDiscordToken();
    const qwenClient = new OpenAiCompatJsonClient({
      ...buildPreferredLocalQwenClientOptions(process.env, "qwen-router-validator"),
      systemRoleLabel: "You are the local support decision router and final validator.",
    });

    const openCodeClient = new OpenAiCompatJsonClient({
      baseUrl: process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/go/v1",
      apiKey: process.env.OPENCODE_API_KEY,
      model: process.env.OPENCODE_MODEL ?? "glm-5.2",
      systemRoleLabel: "You are the high-reasoning, repo-aware support answer drafter with read-only tools.",
      clientLabel: "support-drafter",
      requestTimeoutMs: Number(process.env.OPENCODE_TIMEOUT_MS ?? process.env.STEVESBOT_MODEL_TIMEOUT_MS ?? "180000"),
      fallbackProviders: buildOpenCodeFallbackProviders(process.env, "support-drafter"),
    });

    const pipeline = new SupportPipeline(appConfig, database, qwenClient, openCodeClient);
    const publisher = new DiscordReviewPublisher(appConfig, token);
    worker = new WorkflowQueueWorker(appConfig, database, pipeline, publisher, {
      workerId: process.env.STEVESBOT_WORKER_ID,
      concurrency: Number(process.env.STEVESBOT_WORKER_CONCURRENCY ?? "1"),
      pollIntervalMs: Number(process.env.STEVESBOT_QUEUE_POLL_MS ?? "1000"),
      leaseDurationMs: Number(process.env.STEVESBOT_QUEUE_LEASE_MS ?? "60000"),
      maxAttempts: Number(process.env.STEVESBOT_QUEUE_MAX_ATTEMPTS ?? "3"),
      retryDelayMs: Number(process.env.STEVESBOT_QUEUE_RETRY_MS ?? "15000"),
      dryRun: process.env.STEVESBOT_DRY_RUN === "true" || process.env.STEVESBOT_DRY_RUN === "1",
      onPipelineResult: p2pBridge ? (routeId, outcome, threadKey, category, confidence) => {
        broadcastPipelineEvent(p2pBridge!, {
          kind: "pipeline_run", route: routeId, outcome, threadKey, timestamp: Date.now(), category, confidence,
        });
      } : undefined,
    });
    await worker.start();
    const dryRunActive = process.env.STEVESBOT_DRY_RUN === "true" || process.env.STEVESBOT_DRY_RUN === "1";
    console.log(`Workflow worker started.${dryRunActive ? " [DRY-RUN MODE — no Discord posts]" : ""}`);
  }

  if (roles.has("intake")) {
    const token = requireDiscordToken();
    bot = new DiscordBot(
      appConfig,
      {
        enqueue: async (route, event) => {
          const result = database.enqueueWorkflowJob(route.id, event);
          if (!result.inserted) {
            console.log(`Skipped duplicate queued message ${event.messageId} for route ${route.id}.`);
          }
        },
      },
      {
        recordUsage: async (runId, reviewMessageId, usage, reactedBy) => {
          const existing = database.getDraftUsage(runId);
          if (existing) {
            throw new Error(`Draft for run #${runId} was already marked as "${existing.usage}".`);
          }

          let sent;
          if (usage === "used") {
            sent = await sendApprovedDraftFromRun(database, token, runId);
          }

          database.storeDraftUsage(runId, reviewMessageId, usage, reactedBy);
          console.log(`Draft usage recorded: run #${runId} marked as "${usage}" by ${reactedBy}`);

          return sent ? {
            sentToSource: true,
            sourceChannelId: sent.channelId,
            sourceMessageId: sent.messageId,
          } : undefined;
        },
      },
      (state: TriageFlowState) => {
        const productLabel = state.product === "vdo-ninja" ? "VDO.Ninja" : state.product === "social-stream" ? "Social Stream" : "Other";
        const platformLabel = state.platform === "browser" ? "Browser Extension" : state.platform === "desktop" ? "Desktop App" : state.platform === "mobile" ? "Mobile" : "Other";
        console.log(`[TRIAGE-FLOW] Search requested: product=${productLabel}, platform=${platformLabel}, channel=${state.channelId}, user=${state.userId}`);

        const botToken = process.env.DISCORD_BOT_TOKEN ?? "";
        if (!botToken) return;

        // Map product selection to route ID
        const productRouteMap: Record<string, string> = {
          "vdo-ninja": "vdo-ninja-support",
          "social-stream": "social-stream-support",
        };
        const routeId = productRouteMap[state.product ?? ""] ?? "vdo-ninja-support";
        const route = appConfig.routes.find((r) => r.id === routeId);
        if (!route) {
          console.error(`[TRIAGE-FLOW] No route found for product=${state.product} (routeId=${routeId})`);
          return;
        }

        // Fetch the original trigger message from Discord to build a proper event
        if (state.triggerMessageId.startsWith("test-")) {
          console.log("[TRIAGE-FLOW] Test trigger message — skipping pipeline enqueue.");
          return;
        }

        const fetchTriggerMessage = async (): Promise<Record<string, unknown> | null> => {
          // Try fetching by trigger message ID first
          const resp = await fetch(`https://discord.com/api/v10/channels/${state.channelId}/messages/${state.triggerMessageId}`, {
            headers: { Authorization: `Bot ${botToken}` },
          });
          if (resp.ok) {
            const m = await resp.json() as Record<string, unknown>;
            if (m.id && m.content) return m;
          }
          // Fallback: fetch recent messages and look for user content
          const fallback = await fetch(`https://discord.com/api/v10/channels/${state.channelId}/messages?limit=10`, {
            headers: { Authorization: `Bot ${botToken}` },
          });
          if (!fallback.ok) return null;
          const messages = await fallback.json() as Record<string, unknown>[];
          // First try: find a non-bot message
          const userMessages = messages
            .filter((m) => !(m.author as Record<string, unknown>)?.bot && m.content)
            .reverse();
          if (userMessages[0]) return userMessages[0];
          // Thread starter message lives in the parent channel — check referenced_message
          // on bot welcome messages (NinjaBot replies to the thread starter)
          for (const m of messages) {
            const ref = m.referenced_message as Record<string, unknown> | undefined;
            if (ref?.content && !(ref.author as Record<string, unknown>)?.bot) {
              return ref;
            }
          }
          return null;
        };

        fetchTriggerMessage()
          .then((m) => {
            if (!m) {
              console.error("[TRIAGE-FLOW] Could not fetch any user message in channel:", state.channelId);
              return;
            }

            const event = {
              guildId: (m.guild_id as string) ?? route.guildId,
              channelId: state.channelId,
              threadId: state.channelId !== route.channelId ? state.channelId : undefined,
              messageId: m.id as string,
              authorId: ((m.author as Record<string, string>)?.id) ?? state.userId,
              authorName: ((m.author as Record<string, string>)?.username) ?? "unknown",
              content: m.content as string,
              createdAt: (m.timestamp as string) ?? new Date().toISOString(),
              sourceUrl: `https://discord.com/channels/${route.guildId}/${state.channelId}/${m.id as string}`,
              triageProduct: state.product,
              triagePlatform: state.platform,
              userRequestedBotHelp: true,
              triageMessageId: state.triageMessageId,
            };
            const result = database.enqueueWorkflowJob(routeId, event as import("./types.js").DiscordEventRecord);
            if (result.inserted) {
              console.log(`[TRIAGE-FLOW] Enqueued job #${result.jobId} for route=${routeId} message=${event.messageId}`);
            } else {
              console.log(`[TRIAGE-FLOW] Message ${event.messageId} already queued (job #${result.jobId})`);
            }
          })
          .catch((err) => console.error("[TRIAGE-FLOW] Failed to fetch trigger message:", err));
      },
      (state: TriageFlowState, searchRequested: boolean) => {
        database.recordTriageEvent({
          channelId: state.channelId,
          userId: state.userId,
          product: state.product,
          platform: state.platform,
          searchRequested,
          preselectedProduct: state.product,
          triggerMessageId: state.triggerMessageId,
        });
        console.log(`[TRIAGE-EVENT] Recorded: channel=${state.channelId} product=${state.product ?? "?"} platform=${state.platform ?? "?"} searched=${searchRequested}`);
      },
      // Command channel dependencies allow the maintainer to interact with the bot directly.
      { db: database, rootDir: appConfig.rootDir, p2pBridge },
    );
    // Retry login with exponential backoff (VPN/network may be temporarily down)
    // Retries indefinitely for network errors (VPN outages can last hours/days)
    for (let attempt = 1; ; attempt++) {
      try {
        await bot.start(token);
        console.log("Discord intake started.");

        // Hourly heartbeat log
        setInterval(() => {
          const uptime = Math.round(process.uptime() / 3600);
          const mem = Math.round(process.memoryUsage.rss() / 1024 / 1024);
          console.log("[HEARTBEAT] uptime=" + uptime + "h rss=" + mem + "MB");
        }, 3600_000);
        break;
      } catch (err) {
        const isNetworkError = err instanceof Error && (
          err.message.includes("ENOTFOUND") ||
          err.message.includes("ETIMEDOUT") ||
          err.message.includes("EAI_AGAIN") ||
          err.message.includes("ECONNREFUSED")
        );
        if (!isNetworkError) {
          throw err;
        }
        const delayMs = Math.min(30_000 * Math.pow(2, Math.min(attempt - 1, 4)), 300_000); // 30s -> 5min cap
        console.log(`[INTAKE] Discord login failed (attempt ${attempt}): ${(err as Error).message}. Retrying in ${Math.round(delayMs / 1000)}s...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
