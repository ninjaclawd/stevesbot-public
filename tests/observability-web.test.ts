import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/store/database.js";
import { startObservabilityServer } from "../src/web/server.js";

function makeTriage(outcome: string) {
  const action: "reply" | "hold" = outcome === "approved" ? "reply" : outcome === "no-reply" ? "hold" : "reply";
  return {
    action,
    botShouldSpeakNow: action === "reply",
    confidence: 0.9,
    category: outcome === "error" ? "bug-report" : "support-needed",
    rationale: outcome === "no-reply" ? "Peer chatter is continuing without a fresh unresolved ask." : "Test rationale.",
    problemOpen: outcome !== "no-reply",
    humanAlreadyHandling: outcome === "no-reply",
    directAsk: outcome !== "no-reply",
    newTechnicalEvidence: outcome !== "no-reply",
    novelty: outcome === "no-reply" ? 0.2 : 0.9,
    urgency: "medium" as const,
  };
}

test("observability server renders paged run lists and detailed workflow pages", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-web-"));
  const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));

  try {
    for (let i = 1; i <= 3; i += 1) {
      db.storeWorkflowRun({
        routeId: i === 3 ? "vdo-ninja-bug-report" : "vdo-ninja-misc",
        threadKey: i === 3 ? "bug:777777777777777777" : "misc:999999999999999999",
        event: {
          guildId: "444444444444444444",
          channelId: i === 3 ? "777777777777777777" : "999999999999999999",
          messageId: `msg-${i}`,
          authorId: `user-${i}`,
          authorName: `user${i}`,
          content: i === 3 ? "Bug report from Safari" : `Misc message ${i}`,
          createdAt: `2026-03-12T12:00:0${i}.000Z`,
          sourceUrl: `https://discord.com/channels/444444444444444444/chan/msg-${i}`,
        },
        receivedAt: `2026-03-12T12:00:1${i}.000Z`,
        outcome: i === 2 ? "no-reply" : i === 3 ? "error" : "approved",
        triage: makeTriage(i === 2 ? "no-reply" : i === 3 ? "error" : "approved"),
        review:
          i !== 1
            ? undefined
            : {
                approved: true,
                confidence: 0.91,
                issues: [],
                policyFlags: [],
                finalBody: `Approved reply ${i}`,
              },
        replyText: i === 1 ? `Approved reply ${i}` : undefined,
        errorText: i === 3 ? "Unknown repo: undefined" : undefined,
        totalDurationMs: 100 + i,
        qwenModel: "qwen-test",
        gptModel: "gpt-test",
        steps: [
          {
            stepIndex: 0,
            phase: "triage",
            label: "qwen model call",
            status: "ok",
            startedAt: `2026-03-12T12:00:1${i}.000Z`,
            completedAt: `2026-03-12T12:00:1${i}.100Z`,
            durationMs: 100,
            modelLabel: "qwen-router-validator",
            modelName: "qwen-test",
            modelBaseUrl: "http://qwen.local/v1",
            inputText: "SYSTEM:\ntriage prompt",
            outputText: '{"action":"reply"}',
            requestJson: { model: "qwen-test", temperature: 0.1 },
            responseJson: { choices: [{ message: { content: '{"action":"reply"}' } }] },
            metadata: { statusCode: 200 },
          },
          {
            stepIndex: 1,
            phase: "draft-model",
            label: "gpt-drafter model call",
            status: "ok",
            startedAt: `2026-03-12T12:00:1${i}.101Z`,
            completedAt: `2026-03-12T12:00:1${i}.200Z`,
            durationMs: 99,
            modelLabel: "gpt-drafter",
            modelName: "gpt-test",
            modelBaseUrl: "https://api.opencode.ai/v1",
            inputText: "SYSTEM:\nYou are GPT-5.4 acting as a repo-aware support answer drafter with read-only tools.",
            outputText: '{"kind":"final","draft":"Approved reply"}',
            requestJson: { model: "gpt-test", response_format: { type: "json_object" } },
            responseJson: { choices: [{ message: { content: '{"kind":"final"}' } }] },
            metadata: { statusCode: 200 },
          },
        ],
      });
    }

    const server = await startObservabilityServer(db, { host: "127.0.0.1", port: 0 });
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const listResponse = await fetch(`${baseUrl}/?page=1&pageSize=2`);
      const listHtml = await listResponse.text();
      assert.equal(listResponse.status, 200);
      assert.match(listHtml, /StevesBot Workflow Inspector/);
      assert.match(listHtml, /Bug report from Safari/);
      assert.match(listHtml, /Misc message 2/);
      assert.match(listHtml, /Peer chatter is continuing without a fresh unresolved ask/);
      assert.match(listHtml, /Unknown repo: undefined/);
      assert.match(listHtml, /Inspect/);
      assert.doesNotMatch(listHtml, /Misc message 1/);

      const detailResponse = await fetch(`${baseUrl}/runs/3`);
      const detailHtml = await detailResponse.text();
      assert.equal(detailResponse.status, 200);
      assert.match(detailHtml, /Unknown repo: undefined/);
      assert.match(detailHtml, /gpt-test/);
      assert.match(detailHtml, /qwen-router-validator/);
      assert.match(detailHtml, /SYSTEM:/);
      assert.match(detailHtml, /Request JSON/);

      const threadResponse = await fetch(`${baseUrl}/threads/${encodeURIComponent("misc:999999999999999999")}`);
      const threadHtml = await threadResponse.text();
      assert.equal(threadResponse.status, 200);
      assert.match(threadHtml, /Misc message 1/);
      assert.match(threadHtml, /Misc message 2/);

      const apiResponse = await fetch(`${baseUrl}/api/runs/3`);
      const apiJson = (await apiResponse.json()) as { id: number; steps: Array<{ modelName?: string }> };
      assert.equal(apiResponse.status, 200);
      assert.equal(apiJson.id, 3);
      assert.equal(apiJson.steps[1]?.modelName, "gpt-test");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});


test("analytics page renders with triage stats and outcome distribution", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-analytics-"));
  const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));

  try {
    // Insert a mix of outcomes
    for (const outcome of ["approved", "rejected", "no-reply", "hold", "no-reply"] as const) {
      db.storeWorkflowRun({
        routeId: "vdo-ninja-misc",
        threadKey: "misc:test",
        event: {
          guildId: "g", channelId: "c", messageId: "m-" + outcome + "-" + Math.random().toString(36).slice(2, 8),
          authorId: "u1", authorName: "user1", content: "test " + outcome,
          createdAt: "2026-03-16T00:00:00Z", sourceUrl: "https://discord.com/test",
        },
        receivedAt: "2026-03-16T00:00:01Z",
        outcome,
        triage: makeTriage(outcome),
        review: outcome === "approved" ? { approved: true, confidence: 0.9, issues: [], policyFlags: [], finalBody: "reply" } : undefined,
        replyText: outcome === "approved" ? "reply" : undefined,
        totalDurationMs: 100,
        qwenModel: "qwen-test",
        gptModel: "gpt-test",
        steps: [],
      });
    }

    const server = await startObservabilityServer(db, { host: "127.0.0.1", port: 0 });
    try {
      const addr = server.address() as import("node:net").AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;

      const res = await fetch(`${base}/analytics`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /Analytics/);
      assert.match(html, /Triage Distribution/);
      assert.match(html, /no-reply/);
      assert.match(html, /approved/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("health API returns JSON with run totals and queue status", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-health-"));
  const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));

  try {
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
      triage: makeTriage("approved"),
      review: { approved: true, confidence: 0.9, issues: [], policyFlags: [], finalBody: "reply" },
      replyText: "reply",
      totalDurationMs: 150,
      qwenModel: "qwen-test",
      gptModel: "gpt-test",
      steps: [],
    });

    const server = await startObservabilityServer(db, { host: "127.0.0.1", port: 0 });
    try {
      const addr = server.address() as import("node:net").AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;

      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200);
      const json = await res.json() as { status: string; runs: { total: number }; queue: unknown };
      assert.equal(json.status, "ok");
      assert.equal(json.runs.total, 1);
      assert.ok(json.queue !== undefined);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("feedback API stores and retrieves run feedback", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-feedback-"));
  const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));

  try {
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
      triage: makeTriage("approved"),
      review: { approved: true, confidence: 0.9, issues: [], policyFlags: [], finalBody: "reply" },
      replyText: "reply",
      totalDurationMs: 150,
      qwenModel: "qwen-test",
      gptModel: "gpt-test",
      steps: [],
    });

    const server = await startObservabilityServer(db, { host: "127.0.0.1", port: 0 });
    try {
      const addr = server.address() as import("node:net").AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;

      // Post feedback
      const postRes = await fetch(`${base}/api/feedback/1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: "good", note: "Helpful answer" }),
      });
      assert.equal(postRes.status, 200);
      const postJson = await postRes.json() as { ok: boolean };
      assert.equal(postJson.ok, true);

      // Verify feedback appears on run detail page
      const detailRes = await fetch(`${base}/runs/1`);
      const detailHtml = await detailRes.text();
      assert.match(detailHtml, /good/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("chores dashboard exposes admin controls and chore APIs update runtime state", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-chores-web-"));
  const previousRoot = process.env.STEVESBOT_ROOT;
  process.env.STEVESBOT_ROOT = tempDir;
  const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));

  try {
    mkdirSync(path.join(tempDir, "skills", "test-script"), { recursive: true });
    mkdirSync(path.join(tempDir, "resources", "ops"), { recursive: true });
    writeFileSync(path.join(tempDir, "resources", "ops", "infrastructure.md"), "test ops context\n", "utf8");
    writeFileSync(path.join(tempDir, "skills", "test-script", "skill.yaml"), [
      "type: script",
      "id: test-script",
      "name: Test Script",
      "description: Dashboard run-now test",
      "schedule: '0 9 * * *'",
      "interpreter: /bin/bash",
      "entrypoint: run.sh",
      "timeout: 10000",
      "report_to: review_channel",
    ].join("\n"), "utf8");
    writeFileSync(path.join(tempDir, "skills", "test-script", "run.sh"), "#!/bin/bash\necho 'test-script ran'\n", "utf8");
    db.upsertChore({ id: "test-script", skillId: "test-script", name: "Test Script", schedule: "0 9 * * *", enabled: true });

    const server = await startObservabilityServer(db, { host: "127.0.0.1", port: 0 });
    try {
      const addr = server.address() as import("node:net").AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;

      const pageRes = await fetch(`${base}/chores`);
      const pageHtml = await pageRes.text();
      assert.equal(pageRes.status, 200);
      assert.match(pageHtml, /Run now/);
      assert.match(pageHtml, /Save/);

      const disableRes = await fetch(`${base}/api/chores/test-script/enabled`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(disableRes.status, 200);
      assert.equal(db.getChore("test-script")?.enabled, false);

      const scheduleRes = await fetch(`${base}/api/chores/test-script/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedule: "0 18 * * 0" }),
      });
      assert.equal(scheduleRes.status, 200);
      assert.equal(db.getChore("test-script")?.schedule, "0 18 * * 0");

      const runRes = await fetch(`${base}/api/chores/test-script/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(runRes.status, 200);
      const runJson = await runRes.json() as { status: string; result: string };
      assert.equal(runJson.status, "ok");
      assert.match(runJson.result, /test-script ran/);
      assert.equal(db.getRecentChoreLogs("test-script", 1)[0]?.status, "ok");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    if (previousRoot === undefined) {
      delete process.env.STEVESBOT_ROOT;
    } else {
      process.env.STEVESBOT_ROOT = previousRoot;
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("404 page returns for unknown paths", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-404-"));
  const db = new AppDatabase(path.join(tempDir, "stevesbot.sqlite"));

  try {
    const server = await startObservabilityServer(db, { host: "127.0.0.1", port: 0 });
    try {
      const addr = server.address() as import("node:net").AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;

      const res = await fetch(`${base}/nonexistent`);
      assert.equal(res.status, 404);
      const html = await res.text();
      assert.match(html, /Not Found/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
