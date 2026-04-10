import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/store/database.js";
import { initKnowledgeDb, ensureFtsSync } from "../src/knowledge-base.js";

test("AppDatabase returns historical support records by id within route scope", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-db-"));

  try {
    const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));
    db.upsertHistoricalRecord({
      routeId: "vdo-ninja-support",
      productId: "vdo-ninja",
      sourceThreadRef: "thread-1",
      dateStart: "2026-03-01T00:00:00.000Z",
      dateEnd: "2026-03-02T00:00:00.000Z",
      questionSummary: "Guest cannot hear remote audio",
      answerSummary: "Enable stereo output in the room settings",
      statusFlags: ["durable"],
    });

    const match = db.findHistoricalSupport("audio", "vdo-ninja-support", 1)[0];
    assert.ok(match);
    assert.equal(db.getHistoricalSupportById(match.id, "vdo-ninja-support")?.answerSummary, "Enable stereo output in the room settings");
    assert.equal(db.getHistoricalSupportById(match.id, "social-stream-support"), undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("AppDatabase tolerates punctuation-heavy historical support queries", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-db-"));

  try {
    const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));
    db.upsertHistoricalRecord({
      routeId: "vdo-ninja-support",
      productId: "vdo-ninja",
      sourceThreadRef: "thread-fts-1",
      dateStart: "2026-03-01T00:00:00.000Z",
      dateEnd: "2026-03-02T00:00:00.000Z",
      questionSummary: "dock.html?session=abc123 relay issue",
      answerSummary: "Use a second dock.html page with showtime and limit parameters.",
      statusFlags: ["durable"],
    });

    const results = db.findHistoricalSupport("dock.html?session=abc123&showtime=10000", "vdo-ninja-support", 5);
    assert.equal(results.length, 1);
    assert.match(results[0]?.answerSummary ?? "", /dock\.html/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("AppDatabase stores workflow runs with detailed steps and can page them", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-db-"));

  try {
    const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));
    const runId = db.storeWorkflowRun({
      routeId: "vdo-ninja-misc",
      threadKey: "vdo-ninja-misc:999999999999999999",
      event: {
        guildId: "444444444444444444",
        channelId: "999999999999999999",
        messageId: "msg-1",
        authorId: "user-1",
        authorName: "alice",
        content: "How do I stop relay mode?",
        createdAt: "2026-03-12T12:00:00.000Z",
        sourceUrl: "https://discord.com/channels/444444444444444444/999999999999999999/msg-1",
      },
      receivedAt: "2026-03-12T12:00:01.000Z",
      outcome: "approved",
      triage: {
        action: "reply",
        botShouldSpeakNow: true,
        confidence: 0.95,
        category: "support-needed",
        rationale: "Direct user question.",
        problemOpen: true,
        humanAlreadyHandling: false,
        directAsk: true,
        newTechnicalEvidence: true,
        novelty: 0.92,
        urgency: "medium",
      },
      review: {
        approved: true,
        confidence: 0.89,
        issues: [],
        policyFlags: [],
        finalBody: "Try meshcast first.",
      },
      replyText: "Try meshcast first.",
      totalDurationMs: 245,
      qwenModel: "qwen-test",
      gptModel: "gpt-test",
      steps: [
        {
          stepIndex: 0,
          phase: "triage",
          label: "qwen model call",
          status: "ok",
          startedAt: "2026-03-12T12:00:01.000Z",
          completedAt: "2026-03-12T12:00:01.100Z",
          durationMs: 100,
          modelLabel: "qwen-router-validator",
          modelName: "qwen-test",
          modelBaseUrl: "http://qwen.local/v1",
          inputText: "SYSTEM:\ntriage",
          outputText: '{"action":"reply"}',
          requestJson: { model: "qwen-test" },
          responseJson: { choices: [] },
          metadata: { statusCode: 200 },
        },
      ],
    });

    db.appendWorkflowStep(runId, {
      phase: "delivery",
      label: "Send review draft to private Discord channel",
      status: "ok",
      startedAt: "2026-03-12T12:00:01.200Z",
      completedAt: "2026-03-12T12:00:01.245Z",
      durationMs: 45,
      metadata: {
        reviewChannelId: "333333333333333333",
      },
    });

    const list = db.listWorkflowRuns({ page: 1, pageSize: 10 });
    assert.equal(list.total, 1);
    assert.equal(list.items[0]?.id, runId);
    assert.equal(list.items[0]?.replyText, "Try meshcast first.");

    const detail = db.getWorkflowRun(runId);
    assert.ok(detail);
    assert.equal(detail?.steps.length, 2);
    assert.equal(detail?.steps[0]?.modelName, "qwen-test");
    assert.equal(detail?.steps[1]?.phase, "delivery");

    const threadRuns = db.listWorkflowRunsForThread("vdo-ninja-misc:999999999999999999");
    assert.equal(threadRuns.length, 1);
    assert.equal(threadRuns[0]?.messageId, "msg-1");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("AppDatabase manages workflow queue lifecycle with dedupe, lease, retry, and completion", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-db-"));

  try {
    const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));
    const event = {
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      threadId: "thread-1",
      messageId: "queue-msg-1",
      authorId: "user-1",
      authorName: "alice",
      content: "Need help with relay mode",
      createdAt: "2026-03-13T04:00:00.000Z",
      sourceUrl: "https://discord.com/channels/guild/thread/msg",
    };

    const firstInsert = db.enqueueWorkflowJob("vdo-ninja-support", event);
    const duplicateInsert = db.enqueueWorkflowJob("vdo-ninja-support", event);
    assert.equal(firstInsert.inserted, true);
    assert.equal(duplicateInsert.inserted, false);

    const claimed = db.claimNextWorkflowJob("worker-a", 30_000);
    assert.ok(claimed);
    assert.equal(claimed?.status, "leased");
    assert.equal(claimed?.attempts, 1);
    assert.equal(claimed?.routeId, "vdo-ninja-support");
    assert.equal(db.claimNextWorkflowJob("worker-b", 30_000), undefined);

    const originalLeaseExpiry = claimed?.leaseExpiresAt;
    assert.equal(db.renewWorkflowJobLease(claimed!.id, "worker-a", 60_000), true);
    const renewed = db.getWorkflowJob(claimed!.id);
    assert.ok(renewed?.leaseExpiresAt);
    assert.notEqual(renewed?.leaseExpiresAt, originalLeaseExpiry);
    assert.equal(db.renewWorkflowJobLease(claimed!.id, "worker-b", 60_000), false);

    db.requeueWorkflowJob(claimed!.id, "transient failure", 0);
    const retried = db.claimNextWorkflowJob("worker-b", 30_000);
    assert.ok(retried);
    assert.equal(retried?.attempts, 2);
    assert.equal(retried?.leaseOwner, "worker-b");

    db.completeWorkflowJob(retried!.id, 42);
    const completed = db.getWorkflowJob(retried!.id);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.runId, 42);

    const failedInsert = db.enqueueWorkflowJob("vdo-ninja-support", {
      ...event,
      messageId: "queue-msg-2",
    });
    const failedJob = db.claimNextWorkflowJob("worker-c", 30_000);
    assert.equal(failedJob?.id, failedInsert.jobId);
    db.failWorkflowJob(failedJob!.id, "permanent failure", 88);
    const failed = db.getWorkflowJob(failedJob!.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.runId, 88);
    assert.equal(db.listWorkflowQueue().length, 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});


test("AppDatabase keeps newer messages in the same conversation behind older queued or leased work", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-db-"));

  try {
    const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));
    db.enqueueWorkflowJob("vdo-ninja-support", {
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      threadId: "thread-a",
      messageId: "queue-order-1",
      authorId: "user-1",
      authorName: "alice",
      content: "first question",
      createdAt: "2026-03-13T04:00:00.000Z",
      sourceUrl: "https://discord.com/channels/guild/thread/msg-1",
    });
    db.enqueueWorkflowJob("vdo-ninja-support", {
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      threadId: "thread-a",
      messageId: "queue-order-2",
      authorId: "user-1",
      authorName: "alice",
      content: "newer follow-up in same thread",
      createdAt: "2026-03-13T04:01:00.000Z",
      sourceUrl: "https://discord.com/channels/guild/thread/msg-2",
    });
    db.enqueueWorkflowJob("vdo-ninja-support", {
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      threadId: "thread-b",
      messageId: "queue-order-3",
      authorId: "user-2",
      authorName: "bob",
      content: "independent thread",
      createdAt: "2026-03-13T04:02:00.000Z",
      sourceUrl: "https://discord.com/channels/guild/thread/msg-3",
    });

    const first = db.claimNextWorkflowJob("worker-a", 30_000);
    assert.equal(first?.event.messageId, "queue-order-1");

    const second = db.claimNextWorkflowJob("worker-b", 30_000);
    assert.equal(second?.event.messageId, "queue-order-3");

    db.completeWorkflowJob(first!.id, 1);
    const third = db.claimNextWorkflowJob("worker-c", 30_000);
    assert.equal(third?.event.messageId, "queue-order-2");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ensureFtsSync auto-repairs when mined_threads and FTS row counts differ", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-fts-"));
  const kbPath = path.join(tempDir, "knowledge.sqlite");

  try {
    const db = initKnowledgeDb(kbPath);

    // Insert mined threads directly (simulating mining script)
    const insert = db.prepare(`
      INSERT INTO mined_threads
      (thread_id, thread_name, channel_name, source_url, created_at, last_message_at,
       message_count, participant_count, participants_json, summary, problem_statement,
       solution, resolved, keywords_json, products_json, platforms_json,
       error_signals_json, category, searchable_text, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 1; i <= 3; i++) {
      insert.run(
        `thread-${i}`, `Thread ${i}`, "test-channel", `https://example.com/${i}`,
        "2026-01-01", "2026-01-02", 5, 2, "[]",
        `Summary for thread ${i}`, "Problem statement", "Solution text",
        1, JSON.stringify(["keyword" + i]), JSON.stringify(["VDO.Ninja"]),
        "[]", "[]", "troubleshooting", "searchable text", new Date().toISOString()
      );
    }

    // FTS should be 0 (initKnowledgeDb saw 0/0 at init, then we inserted 3 rows)
    const tableCount = (db.prepare("SELECT COUNT(*) as c FROM mined_threads").get() as { c: number }).c;
    assert.equal(tableCount, 3);
    const ftsCount = (db.prepare("SELECT COUNT(*) as c FROM mined_threads_fts").get() as { c: number }).c;
    assert.equal(ftsCount, 0);

    // ensureFtsSync should detect 3 vs 0 and rebuild
    ensureFtsSync(db);
    const ftsAfterSync = (db.prepare("SELECT COUNT(*) as c FROM mined_threads_fts").get() as { c: number }).c;
    assert.equal(ftsAfterSync, 3);

    // Verify FTS search actually works
    const results = db.prepare(
      "SELECT rowid FROM mined_threads_fts WHERE mined_threads_fts MATCH ?"
    ).all('"keyword2"');
    assert.equal(results.length, 1);

    // Delete some FTS rows to simulate desync
    db.exec("DELETE FROM mined_threads_fts WHERE rowid = 1");
    const ftsAfterDelete = (db.prepare("SELECT COUNT(*) as c FROM mined_threads_fts").get() as { c: number }).c;
    assert.equal(ftsAfterDelete, 2);

    // ensureFtsSync should detect and fix
    ensureFtsSync(db);
    const ftsAfterRepair = (db.prepare("SELECT COUNT(*) as c FROM mined_threads_fts").get() as { c: number }).c;
    assert.equal(ftsAfterRepair, 3);

    // When counts match, no rebuild (idempotent)
    ensureFtsSync(db);
    const ftsStable = (db.prepare("SELECT COUNT(*) as c FROM mined_threads_fts").get() as { c: number }).c;
    assert.equal(ftsStable, 3);

    db.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});


test("AppDatabase stores and retrieves run feedback", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-db-"));
  try {
    const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));
    db.storeWorkflowRun({
      routeId: "vdo-ninja-misc",
      threadKey: "misc:test",
      event: {
        guildId: "g", channelId: "c", messageId: "m1",
        authorId: "u1", authorName: "user1", content: "test",
        createdAt: "2026-03-16T00:00:00Z", sourceUrl: "https://discord.com/test",
      },
      receivedAt: "2026-03-16T00:00:01Z",
      outcome: "approved",
      triage: { action: "reply" as const, botShouldSpeakNow: true, confidence: 0.9, category: "test", rationale: "test", problemOpen: true, humanAlreadyHandling: false, directAsk: true, newTechnicalEvidence: true, novelty: 0.9, urgency: "medium" as const },
      totalDurationMs: 100,
      qwenModel: "qwen-test",
      gptModel: "gpt-test",
      steps: [],
    });

    // No feedback initially
    assert.equal(db.getRunFeedback(1), undefined);

    // Store feedback
    db.setRunFeedback(1, "good", "Helpful answer");
    const feedback = db.getRunFeedback(1);
    assert.ok(feedback);
    assert.equal(feedback.rating, "good");
    assert.equal(feedback.note, "Helpful answer");

    // Update feedback
    db.setRunFeedback(1, "bad", "Wrong info");
    const updated = db.getRunFeedback(1);
    assert.ok(updated);
    assert.equal(updated.rating, "bad");

    // List feedback
    const all = db.listFeedback();
    assert.equal(all.length, 1);

    // Summary
    const summary = db.getFeedbackSummary();
    assert.equal(summary.bad, 1);
    assert.equal(summary.good, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("AppDatabase tracks draft usage and conversion rates", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-db-"));
  try {
    const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));
    const triage = { action: "reply" as const, botShouldSpeakNow: true, confidence: 0.9, category: "test", rationale: "test", problemOpen: true, humanAlreadyHandling: false, directAsk: true, newTechnicalEvidence: true, novelty: 0.9, urgency: "medium" as const };

    // Insert 3 approved runs
    for (let i = 1; i <= 3; i++) {
      db.storeWorkflowRun({
        routeId: "vdo-ninja-misc",
        threadKey: "misc:test",
        event: {
          guildId: "g", channelId: "c", messageId: "m" + i,
          authorId: "u1", authorName: "user1", content: "test " + i,
          createdAt: "2026-03-16T00:00:0" + i + "Z", sourceUrl: "https://discord.com/test",
        },
        receivedAt: "2026-03-16T00:00:01Z",
        outcome: "approved",
        triage,
        replyText: "reply " + i,
        totalDurationMs: 100,
        qwenModel: "qwen-test",
        gptModel: "gpt-test",
        steps: [],
      });
    }

    // Record usage for each
    db.storeDraftUsage(1, "review-msg-1", "used", "steve");
    db.storeDraftUsage(2, "review-msg-2", "modified", "steve");
    db.storeDraftUsage(3, "review-msg-3", "skipped", "steve");

    // Check individual
    const usage1 = db.getDraftUsage(1);
    assert.ok(usage1);
    assert.equal(usage1.usage, "used");

    // Conversion rate
    const conv = db.getDraftConversionRate();
    assert.equal(conv.total, 3);
    assert.equal(conv.used, 1);
    assert.equal(conv.modified, 1);
    assert.equal(conv.skipped, 1);
    assert.equal(conv.unreviewed, 0);

    // By route stats
    const stats = db.getDraftUsageStats();
    assert.ok(stats.length >= 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("AppDatabase records triage events and returns stats", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-db-"));
  try {
    const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));

    db.recordTriageEvent({
      channelId: "c1", userId: "u1", product: "vdo-ninja",
      platform: "browser", searchRequested: true,
      preselectedProduct: "vdo-ninja", triggerMessageId: "t1",
    });
    db.recordTriageEvent({
      channelId: "c2", userId: "u2", product: "social-stream",
      platform: "extension", searchRequested: false,
      preselectedProduct: "social-stream", triggerMessageId: "t2",
    });
    db.recordTriageEvent({
      channelId: "c3", userId: "u3", product: "vdo-ninja",
      platform: "mobile", searchRequested: true,
      preselectedProduct: "vdo-ninja", triggerMessageId: "t3",
    });

    const stats = db.getTriageStats();
    assert.equal(stats.total, 3);
    assert.equal(stats.searched, 2);
    assert.equal(stats.waited, 1);
    assert.equal(stats.byProduct["vdo-ninja"], 2);
    assert.equal(stats.byProduct["social-stream"], 1);
    assert.equal(stats.byPlatform["browser"], 1);
    assert.equal(stats.byPlatform["mobile"], 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("AppDatabase returns outcome distribution and queue health", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-db-"));
  try {
    const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));
    const triage = { action: "reply" as const, botShouldSpeakNow: true, confidence: 0.9, category: "test", rationale: "test", problemOpen: true, humanAlreadyHandling: false, directAsk: true, newTechnicalEvidence: true, novelty: 0.9, urgency: "medium" as const };

    const outcomes = ["approved", "rejected", "no-reply", "no-reply", "hold"];
    for (let i = 0; i < outcomes.length; i++) {
      db.storeWorkflowRun({
        routeId: "vdo-ninja-misc",
        threadKey: "misc:test",
        event: {
          guildId: "g", channelId: "c", messageId: "m" + i,
          authorId: "u1", authorName: "user1", content: "test",
          createdAt: "2026-03-16T00:00:0" + i + "Z", sourceUrl: "https://discord.com/test",
        },
        receivedAt: "2026-03-16T00:00:01Z",
        outcome: outcomes[i],
        triage,
        totalDurationMs: 100 + i * 50,
        qwenModel: "qwen-test",
        gptModel: "gpt-test",
        steps: [],
      });
    }

    // Outcome distribution
    const dist = db.getOutcomeDistribution();
    const map = Object.fromEntries(dist.map((o: { outcome: string; count: number }) => [o.outcome, o.count]));
    assert.equal(map["no-reply"], 2);
    assert.equal(map["approved"], 1);
    assert.equal(map["rejected"], 1);
    assert.equal(map["hold"], 1);

    // Avg durations
    const durations = db.getAvgDurations();
    assert.ok(durations.length > 0);

    // Queue health (empty queue)
    const health = db.getQueueHealth();
    assert.equal(health.queued, 0);
    assert.equal(health.leased, 0);

    // Recent activity
    const activity = db.getRecentActivity(7);
    assert.ok(activity.length > 0);
    assert.equal(activity[0].count, 5);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("AppDatabase reclaims expired leases", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-db-"));
  try {
    const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));
    const event = {
      guildId: "g", channelId: "c", messageId: "m-lease-test",
      authorId: "u1", authorName: "user1", content: "lease test",
      createdAt: "2026-03-16T00:00:00Z", sourceUrl: "https://discord.com/test",
    };

    // Enqueue and claim with a very short lease (1ms)
    db.enqueueWorkflowJob("vdo-ninja-misc", event);
    const job = db.claimNextWorkflowJob("worker-1", 1);
    assert.ok(job);

    // Wait for lease to expire
    const start = Date.now();
    while (Date.now() - start < 10) { /* spin */ }

    // Reclaim should find 1 expired lease
    const reclaimed = db.reclaimExpiredLeases();
    assert.equal(reclaimed, 1);

    // Job should be claimable again
    const reclaimed2 = db.claimNextWorkflowJob("worker-2", 60000);
    assert.ok(reclaimed2);
    assert.equal(reclaimed2.leaseOwner, "worker-2");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("getGuardrailStats returns step counts grouped by label", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-db-"));
  try {
    const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));
    const now = new Date().toISOString();
    const makeEvt = (msgId: string, author: string) => ({
      guildId: "g", channelId: "c", messageId: msgId,
      authorId: author, authorName: author, content: "test",
      createdAt: now, sourceUrl: "https://discord.com/test",
    });

    db.storeWorkflowRun({
      routeId: "vdo-ninja-support",
      threadKey: "vdo-ninja-support:t1",
      event: makeEvt("guardrail-1", "alice"),
      receivedAt: now, outcome: "no-reply", totalDurationMs: 100,
      qwenModel: "qwen-test", gptModel: "gpt-test",
      steps: [{
        stepIndex: 0, phase: "triage", label: "Maintainer fast-path (model call skipped)",
        status: "ok", startedAt: now, completedAt: now, durationMs: 0,
      }],
    });

    db.storeWorkflowRun({
      routeId: "vdo-ninja-support",
      threadKey: "vdo-ninja-support:t2",
      event: makeEvt("guardrail-2", "bob"),
      receivedAt: now, outcome: "no-reply", totalDurationMs: 100,
      qwenModel: "qwen-test", gptModel: "gpt-test",
      steps: [
        { stepIndex: 0, phase: "triage", label: "Maintainer fast-path (model call skipped)",
          status: "ok", startedAt: now, completedAt: now, durationMs: 0 },
        { stepIndex: 1, phase: "triage", label: "Apply deterministic triage guardrails",
          status: "ok", startedAt: now, completedAt: now, durationMs: 0 },
      ],
    });

    const stats = db.getGuardrailStats();
    assert.ok(stats.length >= 2, "Should have at least 2 distinct guardrail types");

    const fastPath = stats.find(s => s.label.includes("fast-path"));
    assert.ok(fastPath, "Should find fast-path entries");
    assert.equal(fastPath.count, 2, "Should count 2 fast-path steps");

    const guardrail = stats.find(s => s.label.includes("guardrails"));
    assert.ok(guardrail, "Should find guardrail entries");
    assert.equal(guardrail.count, 1, "Should count 1 guardrail step");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

