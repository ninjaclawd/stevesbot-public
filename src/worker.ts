import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig } from "./config.js";
import type { SupportPipeline } from "./pipeline/support-pipeline.js";
import { AppDatabase } from "./store/database.js";
import type { DiscordEventRecord, ReviewDeliveryResult, RouteConfig } from "./types.js";

export interface ReviewDraftPublisher {
  publish(route: RouteConfig, event: DiscordEventRecord, reply: string, runId?: number, draftType?: "standard" | "clarify" | "no_answer"): Promise<ReviewDeliveryResult>;
}

type WorkerOptions = {
  workerId?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  dryRun?: boolean;
  onPipelineResult?: (routeId: string, outcome: string, threadKey: string, category?: string, confidence?: number) => void;
  onStatusChange?: (status: string, detail?: string) => void;
};

export class WorkflowQueueWorker {
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly dryRun: boolean;
  private readonly onPipelineResult?: (routeId: string, outcome: string, threadKey: string, category?: string, confidence?: number) => void;
  private readonly onStatusChange?: (status: string, detail?: string) => void;
  private running = false;
  private loopPromise?: Promise<void>;

  public constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly pipeline: SupportPipeline,
    private readonly publisher: ReviewDraftPublisher,
    options: WorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `worker-${process.pid}`;
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 15_000;
    this.dryRun = options.dryRun ?? false;
    this.onPipelineResult = options.onPipelineResult;
    this.onStatusChange = options.onStatusChange;
  }

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loopPromise = this.runLoop();
    void this.loopPromise.catch((error) => {
      this.running = false;
      console.error("Workflow queue worker crashed.", error);
    });
  }

  public async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
  }

  public async processNextJob(): Promise<boolean> {
    // Reclaim any jobs whose leases expired (e.g. worker crash/restart)
    this.db.reclaimExpiredLeases();

    const job = this.db.claimNextWorkflowJob(this.workerId, this.leaseDurationMs);
    if (!job) {
      return false;
    }

    const renewIntervalMs = Math.max(1_000, Math.floor(this.leaseDurationMs / 2));
    const leaseTimer = setInterval(() => {
      try {
        const renewed = this.db.renewWorkflowJobLease(job.id, this.workerId, this.leaseDurationMs);
        if (!renewed) {
          console.error(`Failed to renew lease for workflow job ${job.id}.`);
        }
      } catch (error) {
        console.error(`Lease renewal failed for workflow job ${job.id}.`, error);
      }
    }, renewIntervalMs);
    leaseTimer.unref?.();

    let runId: number | undefined;
    const botToken = process.env.DISCORD_BOT_TOKEN ?? "";
    const channelId = job.event.threadId ?? job.event.channelId;
    const triageMessageId = job.event.triageMessageId;
    try {
      const route = this.resolveRoute(job.routeId);
      if (!route) {
        throw new Error(`Route ${job.routeId} is not configured or enabled.`);
      }

      try { this.onStatusChange?.("busy", `Processing ${route.id} thread ${job.event.threadId ?? job.event.channelId}`); } catch {}

      // Progress indicators while processing
      let typingInterval: ReturnType<typeof setInterval> | undefined;
      const progressEmojis = ["\uD83D\uDD0D", "\uD83D\uDCDA", "\uD83D\uDCAD"]; // 🔍 📚 💭
      let emojiIndex = 0;
      if (botToken && job.event.userRequestedBotHelp) {
        // Send typing indicator and refresh every 8s (Discord typing lasts 10s)
        const sendTyping = () => {
          fetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
            method: "POST", headers: { Authorization: `Bot ${botToken}` },
          }).catch(() => {});
        };
        const cycleEmoji = () => {
          if (!triageMessageId) return;
          // Remove previous emoji
          const prev = encodeURIComponent(progressEmojis[(emojiIndex - 1 + progressEmojis.length) % progressEmojis.length]);
          fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${triageMessageId}/reactions/${prev}/@me`, {
            method: "DELETE", headers: { Authorization: `Bot ${botToken}` },
          }).catch(() => {});
          // Add next emoji
          const next = encodeURIComponent(progressEmojis[emojiIndex % progressEmojis.length]);
          fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${triageMessageId}/reactions/${next}/@me`, {
            method: "PUT", headers: { Authorization: `Bot ${botToken}` },
          }).catch(() => {});
          emojiIndex++;
        };
        sendTyping();
        cycleEmoji();
        typingInterval = setInterval(() => { sendTyping(); cycleEmoji(); }, 8000);
        typingInterval.unref?.();
      }

      let result;
      try {
        result = await this.pipeline.handleEvent(route, job.event);
      } finally {
        if (typingInterval) clearInterval(typingInterval);
        // Remove any leftover progress emoji
        if (botToken && triageMessageId) {
          for (const emoji of progressEmojis) {
            fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${triageMessageId}/reactions/${encodeURIComponent(emoji)}/@me`, {
              method: "DELETE", headers: { Authorization: `Bot ${botToken}` },
            }).catch(() => {});
          }
        }
      }
      runId = result.runId;

      // Broadcast pipeline result to P2P network
      try {
        const outcome = result.posted ? "approved" : result.triage?.botShouldSpeakNow === false ? "no-reply" : "rejected";
        this.onPipelineResult?.(route.id, outcome, job.event.threadId ?? job.event.channelId, result.triage?.category, result.review?.confidence);
      } catch { /* non-fatal */ }

      if (result.posted && result.reply) {
        if (this.dryRun) {
          console.log(`[DRY-RUN] Would publish to ${route.id}: ${result.reply.substring(0, 200)}${result.reply.length > 200 ? "..." : ""}`);
          this.db.completeWorkflowJob(job.id, runId);
          return true;
        }

        if (job.event.userRequestedBotHelp && botToken) {
          // User clicked "Ask the Bot" — post directly to the thread, skip review channel
          const postResp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ content: result.reply }),
          });
          if (!postResp.ok) {
            console.error(`[WORKER] Failed to post reply to thread: ${postResp.status}`);
          }
          this.pipeline.recordDelivery(result.runId, {
            status: postResp.ok ? "ok" : "error",
            reviewChannelId: channelId,
            body: result.reply,
            durationMs: 0,
          });
        } else {
          // Normal flow — send to the review channel for a maintainer to approve.
          const startedAt = Date.now();
          try {
            const delivery = await this.publisher.publish(route, job.event, result.reply, result.runId, result.draftType);
            this.pipeline.recordDelivery(result.runId, {
              status: "ok",
              reviewChannelId: delivery.channelId,
              reviewMessageId: delivery.messageId,
              body: result.reply,
              durationMs: Date.now() - startedAt,
            });
          } catch (error) {
            this.pipeline.recordDelivery(result.runId, {
              status: "error",
              reviewChannelId: this.config.reviewChannel?.channelId ?? "unknown",
              body: result.reply,
              errorText: error instanceof Error ? error.message : String(error),
              durationMs: Date.now() - startedAt,
            });
            throw error;
          }
        }
      }

      // Clean up triage message and send fallback if needed for user-requested help
      if (job.event.userRequestedBotHelp && botToken && triageMessageId) {
        fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${triageMessageId}`, {
          method: "DELETE", headers: { Authorization: `Bot ${botToken}` },
        }).catch(() => {});

        if (!result.posted) {
          const qualityKeywords = /choppy|laggy|quality|bitrate|fps|frame|drops|buffer|packet|relay|slow|freeze|black screen|croppy|cropped|stuttering|jitter|pixelated|blurry|low quality/i;
          const msgContent = job.event.content ?? "";
          const fallbackContent = qualityKeywords.test(msgContent)
            ? "I wasn't able to draft a full answer, but here are some diagnostic steps that usually help:\n\n1. Run https://vdo.ninja/speedtest — this tests packet loss (the #1 cause of quality issues), not bandwidth.\n2. Are you on WiFi or wired? WiFi is the most common cause of intermittent quality drops.\n3. CTRL+click (cmd+click on Mac) on the video in VDO.Ninja to see live stats — check packet loss % and whether the candidate type shows \"relay\".\n\nA human will follow up with more specific help."
            : "I wasn't able to find a confident answer for this. A human will follow up when available.";
          fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ content: fallbackContent }),
          }).catch((err) => console.error("[WORKER] Failed to send fallback message:", err));
        }
      }

      this.db.completeWorkflowJob(job.id, runId);
      return true;
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);

      // On final failure for user-requested help, notify in Discord
      if (job.event.userRequestedBotHelp && botToken && (job.attempts >= this.maxAttempts || runId !== undefined)) {
        if (triageMessageId) {
          fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${triageMessageId}`, {
            method: "DELETE", headers: { Authorization: `Bot ${botToken}` },
          }).catch(() => {});
        }
        fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ content: "An error occurred while searching. A human will follow up when available." }),
        }).catch(() => {});
      }

      const existingRunId = runId ?? this.db.getWorkflowRunIdByMessageId(job.event.messageId);
      if (existingRunId !== undefined) {
        this.db.failWorkflowJob(job.id, errorText, existingRunId);
        return true;
      }
      if (job.attempts >= this.maxAttempts) {
        this.db.failWorkflowJob(job.id, errorText);
        return true;
      }
      this.db.requeueWorkflowJob(job.id, errorText, this.retryDelayMs);
      return true;
    } finally {
      try { this.onStatusChange?.("idle"); } catch {}
      clearInterval(leaseTimer);
    }
  }

  private async runLoop(): Promise<void> {
    if (this.concurrency <= 1) {
      while (this.running) {
        const processed = await this.processNextJob();
        if (!processed) {
          await delay(this.pollIntervalMs);
        }
      }
      return;
    }

    // Run N concurrent workers that each claim and process jobs independently.
    const lanes = Array.from({ length: this.concurrency }, (_, index) =>
      this.runLane(index),
    );
    await Promise.all(lanes);
  }

  private async runLane(laneIndex: number): Promise<void> {
    while (this.running) {
      try {
        const processed = await this.processNextJob();
        if (!processed) {
          await delay(this.pollIntervalMs);
        }
      } catch (error) {
        console.error(`Worker lane ${laneIndex} encountered an error.`, error);
        await delay(this.pollIntervalMs);
      }
    }
  }

  private resolveRoute(routeId: string): RouteConfig | undefined {
    return this.config.routes.find((route) => route.enabled && route.id === routeId);
  }
}
