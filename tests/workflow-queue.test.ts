import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/store/database.js";
import type { DiscordEventRecord, RouteConfig } from "../src/types.js";
import { WorkflowQueueWorker, type ReviewDraftPublisher } from "../src/worker.js";

const route: RouteConfig = {
  id: "vdo-ninja-support",
  guildId: "444444444444444444",
  channelId: "555555555555555555",
  mode: "thread",
  instructionRef: "/tmp/instruction.md",
  repoScopes: ["vdo-ninja"],
  enabled: true,
};

function makeConfig(rootDir: string): AppConfig {
  return {
    rootDir,
    manifestsDir: path.join(rootDir, "resources", "manifests"),
    instructionsDir: path.join(rootDir, "resources", "instructions"),
    transcriptsDir: path.join(rootDir, "data", "transcripts"),
    sqlitePath: path.join(rootDir, "stevesbot.sqlite"),
    logsDir: path.join(rootDir, "logs"),
    repos: [],
    routes: [route],
    reviewChannel: {
      guildId: "222222222222222222",
      channelId: "333333333333333333",
      enabled: true,
    },
    resourceMap: [],
  };
}

function makeEvent(messageId: string): DiscordEventRecord {
  return {
    guildId: route.guildId,
    channelId: route.channelId,
    threadId: "thread-1",
    messageId,
    authorId: "user-1",
    authorName: "alice",
    content: "Need help",
    createdAt: "2026-03-13T04:00:00.000Z",
    sourceUrl: "https://discord.com/channels/guild/thread/msg",
  };
}

test("WorkflowQueueWorker processes a queued event, sends review delivery, and completes the job", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-worker-"));
  try {
    const config = makeConfig(tempDir);
    const db = new AppDatabase(config.sqlitePath);
    const event = makeEvent("worker-msg-1");
    const enqueue = db.enqueueWorkflowJob(route.id, event);
    assert.equal(enqueue.inserted, true);

    const deliveries: Array<{ runId: number; status: string; reviewMessageId?: string }> = [];
    const pipeline = {
      handleEvent: async () => ({
        runId: 7,
        posted: true,
        reply: "Approved answer",
        triage: {
          needsReply: true,
          confidence: 0.95,
          category: "support",
          rationale: "Direct ask",
        },
      }),
      recordDelivery: (runId: number, params: { status: "ok" | "error"; reviewMessageId?: string }) => {
        deliveries.push({ runId, status: params.status, reviewMessageId: params.reviewMessageId });
      },
    };
    const publisher = {
      publish: async () => ({
        channelId: "333333333333333333",
        messageId: "review-1",
      }),
    };
    const worker = new WorkflowQueueWorker(config, db, pipeline as never, publisher, {
      workerId: "test-worker",
      retryDelayMs: 0,
    });

    const processed = await worker.processNextJob();
    assert.equal(processed, true);
    assert.deepEqual(deliveries, [{ runId: 7, status: "ok", reviewMessageId: "review-1" }]);
    const job = db.getWorkflowJob(enqueue.jobId!);
    assert.equal(job?.status, "completed");
    assert.equal(job?.runId, 7);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("WorkflowQueueWorker requeues transient failures before a workflow run exists", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-worker-"));
  const config = makeConfig(tempDir);
  const db = new AppDatabase(config.sqlitePath);
  const enqueue = db.enqueueWorkflowJob(route.id, makeEvent("worker-msg-2"));

  try {
    const pipeline = {
      handleEvent: async () => {
        throw new Error("upstream temporary failure");
      },
      recordDelivery: () => undefined,
    };
    const publisher = {
      publish: async () => {
        throw new Error("should not publish");
      },
    };
    const worker = new WorkflowQueueWorker(config, db, pipeline as never, publisher, {
      workerId: "test-worker",
      retryDelayMs: 0,
      maxAttempts: 3,
    });

    const processed = await worker.processNextJob();
    assert.equal(processed, true);
    const job = db.getWorkflowJob(enqueue.jobId!);
    assert.equal(job?.status, "queued");
    assert.equal(job?.attempts, 1);
    assert.match(job?.lastError ?? "", /temporary failure/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("WorkflowQueueWorker marks the job failed when a run already exists for the message", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-worker-"));
  const config = makeConfig(tempDir);
  const db = new AppDatabase(config.sqlitePath);
  const event = makeEvent("worker-msg-3");
  const enqueue = db.enqueueWorkflowJob(route.id, event);
  db.storeWorkflowRun({
    routeId: route.id,
    threadKey: `${route.id}:${event.threadId}`,
    event,
    receivedAt: "2026-03-13T04:00:01.000Z",
    outcome: "error",
    errorText: "prior pipeline crash",
    totalDurationMs: 10,
    qwenModel: "qwen-test",
    gptModel: "gpt-test",
    steps: [],
  });

  try {
    const pipeline = {
      handleEvent: async () => {
        throw new Error("pipeline still failing");
      },
      recordDelivery: () => undefined,
    };
    const publisher = {
      publish: async () => {
        throw new Error("should not publish");
      },
    };
    const worker = new WorkflowQueueWorker(config, db, pipeline as never, publisher, {
      workerId: "test-worker",
      retryDelayMs: 0,
      maxAttempts: 3,
    });

    const processed = await worker.processNextJob();
    assert.equal(processed, true);
    const job = db.getWorkflowJob(enqueue.jobId!);
    assert.equal(job?.status, "failed");
    assert.equal(job?.runId, 1);
    assert.match(job?.lastError ?? "", /pipeline still failing/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("WorkflowQueueWorker renews the job lease while a slow pipeline run is still in flight", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-worker-"));
  try {
    const config = makeConfig(tempDir);
    const db = new AppDatabase(config.sqlitePath);
    const event = makeEvent("worker-msg-lease");
    const enqueue = db.enqueueWorkflowJob(route.id, event);
    assert.equal(enqueue.inserted, true);

    const pipeline = {
      handleEvent: async () => {
        await new Promise((resolve) => setTimeout(resolve, 160));
        return {
          runId: 9,
          posted: false,
          reply: undefined,
          triage: {
            needsReply: false,
            confidence: 0.82,
            category: "watch-only",
            rationale: "No direct ask.",
          },
        };
      },
      recordDelivery: () => undefined,
    };
    const publisher = {
      publish: async () => ({
        channelId: "333333333333333333",
        messageId: "review-lease",
      }),
    };
    const worker = new WorkflowQueueWorker(config, db, pipeline as never, publisher, {
      workerId: "test-worker",
      retryDelayMs: 0,
      leaseDurationMs: 60,
    });

    const processing = worker.processNextJob();
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.equal(db.claimNextWorkflowJob("competing-worker", 60), undefined);
    await processing;

    const job = db.getWorkflowJob(enqueue.jobId!);
    assert.equal(job?.status, "completed");
    assert.equal(job?.runId, 9);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("WorkflowQueueWorker marks job failed after max attempts exhausted", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-worker-"));
  try {
    const config = makeConfig(tempDir);
    const db = new AppDatabase(config.sqlitePath);
    const event = makeEvent("worker-msg-exhaust");
    const enqueue = db.enqueueWorkflowJob(route.id, event);

    const pipeline = {
      handleEvent: async () => {
        throw new Error("persistent failure");
      },
      recordDelivery: () => undefined,
    };
    const publisher = {
      publish: async () => ({ channelId: "ch", messageId: "msg" }),
    };
    const worker = new WorkflowQueueWorker(config, db, pipeline as never, publisher, {
      workerId: "test-worker",
      retryDelayMs: 0,
      maxAttempts: 2,
    });

    // First attempt: requeued (attempts becomes 1, 1 < maxAttempts=2)
    await worker.processNextJob();
    let job = db.getWorkflowJob(enqueue.jobId!);
    assert.equal(job?.status, "queued");
    assert.equal(job?.attempts, 1);

    // Second attempt: failed (attempts becomes 2, 2 >= maxAttempts=2)
    await worker.processNextJob();
    job = db.getWorkflowJob(enqueue.jobId!);
    assert.equal(job?.status, "failed");
    assert.match(job?.lastError ?? "", /persistent failure/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("WorkflowQueueWorker records delivery error and requeues when publisher fails", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-worker-"));
  try {
    const config = makeConfig(tempDir);
    const db = new AppDatabase(config.sqlitePath);
    const event = makeEvent("worker-msg-pubfail");
    const enqueue = db.enqueueWorkflowJob(route.id, event);

    const deliveries: Array<{ runId: number; status: string }> = [];
    const pipeline = {
      handleEvent: async () => ({
        runId: 11,
        posted: true,
        reply: "Approved answer",
        triage: { needsReply: true, confidence: 0.9, category: "support", rationale: "Ask" },
      }),
      recordDelivery: (runId: number, params: { status: string }) => {
        deliveries.push({ runId, status: params.status });
      },
    };
    const publisher = {
      publish: async () => {
        throw new Error("Discord API unavailable");
      },
    };
    const worker = new WorkflowQueueWorker(config, db, pipeline as never, publisher, {
      workerId: "test-worker",
      retryDelayMs: 0,
      maxAttempts: 3,
    });

    await worker.processNextJob();

    // Delivery error should be recorded
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, "error");
    assert.equal(deliveries[0]?.runId, 11);

    // Job should be failed (run already exists via getWorkflowRunIdByMessageId)
    const job = db.getWorkflowJob(enqueue.jobId!);
    // Since pipeline.handleEvent ran and created a run, the error path finds the existing runId
    // and marks the job as failed (not requeued) since a run already exists
    assert.equal(job?.status, "failed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("WorkflowQueueWorker errors when route is disabled or missing", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-worker-"));
  try {
    const config = makeConfig(tempDir);
    // Override routes to empty so no route matches
    config.routes = [];
    const db = new AppDatabase(config.sqlitePath);
    const event = makeEvent("worker-msg-noroute");
    const enqueue = db.enqueueWorkflowJob("nonexistent-route", event);

    const pipeline = {
      handleEvent: async () => {
        throw new Error("should not be called");
      },
      recordDelivery: () => undefined,
    };
    const publisher = {
      publish: async () => ({ channelId: "ch", messageId: "msg" }),
    };
    const worker = new WorkflowQueueWorker(config, db, pipeline as never, publisher, {
      workerId: "test-worker",
      retryDelayMs: 0,
      maxAttempts: 3,
    });

    await worker.processNextJob();
    const job = db.getWorkflowJob(enqueue.jobId!);
    // First attempt fails with "Route nonexistent-route is not configured" and requeues
    assert.equal(job?.status, "queued");
    assert.match(job?.lastError ?? "", /not configured/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("WorkflowQueueWorker skips publishing in dry-run mode", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-wq-"));
  try {
    const config = makeConfig(tempDir);
    const db = new AppDatabase(config.sqlitePath);

    const event: DiscordEventRecord = {
      guildId: route.guildId,
      channelId: route.channelId,
      threadId: "thread-dry",
      messageId: "msg-dry-1",
      authorId: "user-1",
      authorName: "TestUser",
      content: "Is this a dry run?",
      createdAt: new Date().toISOString(),
      sourceUrl: "https://discord.com/test",
    };

    db.enqueueWorkflowJob(route.id, event);

    const publishCalls: string[] = [];
    const fakePublisher: ReviewDraftPublisher = {
      async publish(_route, _event, reply) {
        publishCalls.push(reply);
        return { channelId: "rev-ch", messageId: "rev-msg" };
      },
    };

    const fakePipeline = {
      handleEvent: async () => ({
        posted: true,
        reply: "This would be posted",
        runId: 999,
      }),
      recordDelivery: () => {},
    };

    const worker = new WorkflowQueueWorker(
      config,
      db,
      fakePipeline as never,
      fakePublisher,
      { dryRun: true },
    );

    const processed = await worker.processNextJob();
    assert.equal(processed, true, "Should have processed a job");
    assert.equal(publishCalls.length, 0, "Should NOT have called publisher in dry-run mode");

    // Verify job was completed (not left dangling)
    const jobs = db.listWorkflowQueue();
    const job = jobs.find((j) => j.event.messageId === "msg-dry-1");
    assert.ok(job, "Job should exist");
    assert.equal(job!.status, "completed", "Job should be completed even in dry-run");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("direct replies deduplicate and record a failed Discord delivery", async (t) => {
  const db = new AppDatabase(":memory:");
  const event: DiscordEventRecord = { ...makeEvent("direct-reply"), userRequestedBotHelp: true, botHelpRequestSource: "reply" };
  const queued = db.enqueueWorkflowJob(route.id, event);
  const statuses: string[] = [];
  const pipeline = {
    handleEvent: async () => ({ posted: true, reply: "Answer", runId: 7 }),
    recordDelivery: (_id: number, delivery: { status: string }) => statuses.push(delivery.status),
  };
  const savedToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = "test";
  t.after(() => {
    if (savedToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = savedToken;
  });
  const send = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 403 }));
  const worker = new WorkflowQueueWorker(makeConfig("."), db, pipeline as never, { publish: async () => assert.fail() });
  assert.equal(await worker.processNextJob(), true);
  assert.deepEqual(statuses, ["error"]);
  assert.equal(db.getWorkflowJob(queued.jobId!)?.status, "failed");
  assert.equal(db.enqueueWorkflowJob(route.id, event).inserted, false);

  const dryWorker = new WorkflowQueueWorker(makeConfig("."), db, pipeline as never, { publish: async () => assert.fail() }, { dryRun: true });
  db.enqueueWorkflowJob(route.id, { ...event, messageId: "dry-reply" });
  const before = send.mock.callCount();
  assert.equal(await dryWorker.processNextJob(), true);
  assert.equal(send.mock.callCount(), before);
});
