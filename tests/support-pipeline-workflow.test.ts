import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type { AppConfig } from "../src/config.js";
import { initKnowledgeDb } from "../src/knowledge-base.js";
import type { AgentAction, IterativeModelClient } from "../src/models/agent-loop.js";
import { SupportPipeline } from "../src/pipeline/support-pipeline.js";
import { AppDatabase } from "../src/store/database.js";
import type { DiscordAttachmentRecord, DiscordEventRecord, QueryTraceEntry, ReviewDecision, RouteConfig, TriageDecision } from "../src/types.js";

type JsonCall = {
  systemPrompt: string;
  userPrompt: string;
  imageDataUrl?: string;
};

class RecordingQwenClient {
  public readonly calls: JsonCall[] = [];

  public constructor(private readonly handler: (input: JsonCall) => TriageDecision | ReviewDecision | Record<string, unknown>) {}

  public describe() {
    return { clientLabel: "qwen-test", model: "qwen-test", baseUrl: "http://qwen.local/v1" };
  }

  public async generateJson<T>(input: JsonCall): Promise<T> {
    this.calls.push(input);
    return this.handler(input) as T;
  }

  public async generateJsonWithImage<T>(input: JsonCall): Promise<T> {
    this.calls.push(input);
    return this.handler(input) as T;
  }
}

class RecordingAgentClient implements IterativeModelClient {
  public readonly calls: Array<{
    systemPrompt: string;
    conversation: string;
    toolTrace: QueryTraceEntry[];
    toolCatalog: string[];
  }> = [];

  public constructor(private readonly actions: AgentAction[]) {}

  public describe() {
    return { clientLabel: "gpt-test", model: "gpt-test", baseUrl: "https://api.opencode.ai/v1" };
  }

  public async nextAction(input: {
    systemPrompt: string;
    conversation: string;
    toolTrace: QueryTraceEntry[];
    toolCatalog: string[];
    traceRecorder?: (trace: unknown) => void;
  }): Promise<AgentAction> {
    this.calls.push({
      systemPrompt: input.systemPrompt,
      conversation: input.conversation,
      toolTrace: [...input.toolTrace],
      toolCatalog: [...input.toolCatalog],
    });
    const action = this.actions.shift();
    if (!action) {
      throw new Error("No agent action queued.");
    }
    return action;
  }
}

function makeTriageDecision(
  action: TriageDecision["action"],
  overrides: Partial<Omit<TriageDecision, "action" | "botShouldSpeakNow">> = {},
): TriageDecision {
  return {
    action,
    botShouldSpeakNow: action === "reply",
    confidence: overrides.confidence ?? (action === "reply" ? 0.9 : 0.8),
    category: overrides.category ?? (action === "reply" ? "support-needed" : action === "hold" ? "hold" : "ignore"),
    rationale: overrides.rationale ?? (action === "reply" ? "Direct unresolved support ask." : "No public reply needed right now."),
    problemOpen: overrides.problemOpen ?? action !== "ignore",
    humanAlreadyHandling: overrides.humanAlreadyHandling ?? action === "hold",
    directAsk: overrides.directAsk ?? action === "reply",
    newTechnicalEvidence: overrides.newTechnicalEvidence ?? action === "reply",
    novelty: overrides.novelty ?? (action === "reply" ? 0.82 : 0.28),
    urgency: overrides.urgency ?? "medium",
  };
}

function writeInstruction(rootDir: string, fileName: string, body: string): string {
  const instructionsDir = path.join(rootDir, "resources", "instructions");
  mkdirSync(instructionsDir, { recursive: true });
  const fullPath = path.join(instructionsDir, fileName);
  writeFileSync(fullPath, body, "utf8");
  return fullPath;
}

function makeAppConfig(rootDir: string, routes: RouteConfig[]): AppConfig {
  const transcriptsDir = path.join(rootDir, "data", "transcripts");
  const sqliteDir = path.join(rootDir, "data", "sqlite");
  const manifestsDir = path.join(rootDir, "resources", "manifests");
  mkdirSync(transcriptsDir, { recursive: true });
  mkdirSync(sqliteDir, { recursive: true });
  mkdirSync(manifestsDir, { recursive: true });
  mkdirSync(path.join(rootDir, "logs"), { recursive: true });

  const repoFixtures = [
    { id: "vdo-ninja", localDir: path.join(rootDir, "repos", "vdo-ninja"), readme: "VDO docs" },
    { id: "social-stream", localDir: path.join(rootDir, "repos", "social_stream"), readme: "Social Stream docs" },
    { id: "raspberry-ninja", localDir: path.join(rootDir, "repos", "raspberry_ninja"), readme: "Raspberry Ninja docs" },
  ];

  for (const repo of repoFixtures) {
    mkdirSync(path.join(repo.localDir, "docs"), { recursive: true });
    writeFileSync(path.join(repo.localDir, "README.md"), repo.readme, "utf8");
  }

  return {
    rootDir,
    manifestsDir,
    instructionsDir: path.join(rootDir, "resources", "instructions"),
    transcriptsDir,
    sqlitePath: path.join(sqliteDir, "stevesbot.sqlite"),
    logsDir: path.join(rootDir, "logs"),
    repos: [
      {
        id: "vdo-ninja",
        owner: "maintainer-user",
        repo: "vdo.ninja",
        localPath: path.join(rootDir, "repos", "vdo-ninja"),
        summary: "VDO.Ninja repo",
        allowedPaths: ["docs", "README.md"],
      },
      {
        id: "social-stream",
        owner: "maintainer-user",
        repo: "social_stream",
        localPath: path.join(rootDir, "repos", "social_stream"),
        summary: "Social Stream repo",
        allowedPaths: ["docs", "README.md"],
      },
      {
        id: "raspberry-ninja",
        owner: "maintainer-user",
        repo: "raspberry_ninja",
        localPath: path.join(rootDir, "repos", "raspberry_ninja"),
        summary: "Raspberry Ninja repo",
        allowedPaths: ["docs", "README.md"],
      },
    ],
    routes,
    reviewChannel: { guildId: "222222222222222222", channelId: "333333333333333333", enabled: true },
    resourceMap: [
      {
        id: "learnings",
        label: "Learnings",
        purpose: "Curated support material",
        readableScopes: [path.join(rootDir, "resources", "learnings")],
        typicalContent: "Support notes",
        usageGuidance: "Use for prior fixes",
      },
    ],
  };
}

function readCounts(sqlitePath: string): Record<string, number> {
  const db = new Database(sqlitePath, { readonly: true });
  const counts: Record<string, number> = {};
  for (const table of ["transcripts", "decision_log", "qa_entries"]) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    counts[table] = row.count;
  }
  return counts;
}

function makeEvent(route: RouteConfig, overrides: Partial<DiscordEventRecord> = {}): DiscordEventRecord {
  return {
    guildId: route.guildId,
    channelId: route.channelId,
    messageId: overrides.messageId ?? "msg-1",
    authorId: overrides.authorId ?? "user-1",
    authorName: overrides.authorName ?? "alice",
    content: overrides.content ?? "Need help.",
    createdAt: overrides.createdAt ?? "2026-03-12T09:00:00.000Z",
    threadId: overrides.threadId,
    sourceUrl: overrides.sourceUrl,
    attachments: overrides.attachments,
    userRequestedBotHelp: overrides.userRequestedBotHelp,
    triageMessageId: overrides.triageMessageId,
  };
}

function seedSupportRecord(db: AppDatabase, route: RouteConfig, questionSummary: string, answerSummary: string): void {
  db.upsertHistoricalRecord({
    routeId: route.id,
    productId: route.id,
    sourceThreadRef: `${route.id}-seed-1`,
    dateStart: "2026-03-01T00:00:00.000Z",
    dateEnd: "2026-03-01T00:00:00.000Z",
    questionSummary,
    answerSummary,
    statusFlags: ["durable"],
  });
}

function seedKnowledgeMatch(rootDir: string, params: {
  threadId: string;
  threadName: string;
  summary: string;
  problemStatement: string;
  solution: string;
  keywords: string[];
  category: string;
}): void {
  const kbPath = path.join(rootDir, "data", "sqlite", "knowledge.sqlite");
  const kb = initKnowledgeDb(kbPath);
  const insert = kb.prepare(`
    INSERT INTO mined_threads
    (thread_id, thread_name, channel_name, source_url, created_at, last_message_at,
     message_count, participant_count, participants_json, summary, problem_statement,
     solution, resolved, keywords_json, products_json, platforms_json, error_signals_json,
     category, searchable_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = insert.run(
    params.threadId,
    params.threadName,
    "support",
    `https://discord.com/channels/test/${params.threadId}`,
    "2026-03-20T00:00:00.000Z",
    "2026-03-20T00:00:00.000Z",
    6,
    2,
    JSON.stringify(["alice", "maintainer-user"]),
    params.summary,
    params.problemStatement,
    params.solution,
    1,
    JSON.stringify(params.keywords),
    JSON.stringify(["social-stream"]),
    JSON.stringify(["youtube"]),
    JSON.stringify([]),
    params.category,
    [params.summary, params.problemStatement, params.solution, params.keywords.join(" ")].join(" "),
  );
  kb.prepare(`
    INSERT INTO mined_threads_fts(rowid, summary, problem_statement, solution, keywords_text, products_text, error_signals_text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.lastInsertRowid,
    params.summary,
    params.problemStatement,
    params.solution,
    params.keywords.join(" "),
    "social-stream",
    "",
  );
  kb.close();
}

test("miscellaneous first message runs full workflow with route-aware context and evidence", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-misc",
      guildId: "444444444444444444",
      channelId: "999999999999999999",
      mode: "channel",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-misc.md",
        [
          "# VDO Misc",
          "",
          "- Be conservative in miscellaneous.",
          "- Reply only when the latest message contains a clear unresolved support ask.",
          "- Do not interrupt peer chatter or solved conversations.",
        ].join("\n"),
      ),
      repoScopes: ["vdo-ninja", "raspberry-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    seedSupportRecord(db, route, "How do I reduce relay issues?", "Try meshcast or fix the guest firewall.");

    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("reply", {
          confidence: 0.93,
          category: "support-needed",
          rationale: "Clear troubleshooting ask in a general channel.",
          problemOpen: true,
          humanAlreadyHandling: false,
          directAsk: true,
          newTechnicalEvidence: true,
          novelty: 0.88,
        });
      }
      return {
        approved: true,
        confidence: 0.88,
        issues: [],
        policyFlags: [],
        finalBody: "Try `&meshcast` first, then verify whether the guest is stuck on relay/TURN.",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([
      { kind: "tool", tool: "searchSupport", args: { query: "relay issues", limit: 5 } },
      {
        kind: "final",
        draft: "Try `&meshcast` first, then verify whether the guest is stuck on relay/TURN.",
        supportRecordIds: [1],
        repoRefs: ["vdo-ninja:README.md"],
      },
    ]);

    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);
    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, { content: "My guest keeps ending up on relay. What should I try first?" }),
    );

    assert.equal(result.posted, true);
    assert.equal(result.reply, "Try `&meshcast` first, then verify whether the guest is stuck on relay/TURN.");

    assert.equal(qwen.calls.length, 2);
    assert.match(qwen.calls[0].userPrompt, /Action rules:/);
    assert.match(qwen.calls[0].userPrompt, /Deterministic thread-state signals:/);
    assert.match(qwen.calls[0].userPrompt, /id: vdo-ninja-misc/);
    assert.match(qwen.calls[0].userPrompt, /Be conservative in miscellaneous/);
    assert.match(qwen.calls[0].userPrompt, /Current message:/);
    assert.match(qwen.calls[0].userPrompt, /relay/);
    assert.match(qwen.calls[0].userPrompt, /novelty:/);
    assert.match(qwen.calls[1].userPrompt, /Cited supportRecordIds: 1/);
    assert.match(qwen.calls[1].userPrompt, /Repo refs: \[none\]/);
    assert.match(qwen.calls[1].userPrompt, /Removed unverified repo refs: vdo-ninja:README\.md/);
    assert.match(qwen.calls[1].userPrompt, /Query trace:/);

    assert.equal(agent.calls.length, 2);
    assert.match(agent.calls[0].systemPrompt, /Route: vdo-ninja-misc/);
    assert.match(agent.calls[0].conversation, /Conversation snapshot:/);
    assert.match(agent.calls[0].conversation, /Do not interrupt peer chatter/);
    assert.match(agent.calls[0].conversation, /My guest keeps ending up on relay/);
    assert.match(agent.calls[0].conversation, /Tool contract:/);
    assert.match(agent.calls[0].conversation, /Allowed repoIds for this route: vdo-ninja, raspberry-ninja/);
    assert.ok(agent.calls[0].toolCatalog.includes("searchRepoRegex"));
    assert.ok(agent.calls[0].toolCatalog.includes("searchRepoSymbols"));
    assert.ok(agent.calls[0].toolCatalog.includes("exploreRepo"));
    assert.match(agent.calls[0].conversation, /searchRepoRegex \{"repoId":"vdo-ninja","pattern":"relay\|turn","pathScope":"\.","fileGlob":"\*\.md","limit":20\}/);
    assert.match(agent.calls[0].conversation, /searchRepoSymbols \{"repoId":"vdo-ninja","symbol":"meshcast","pathScope":"\.","limit":10\}/);
    assert.match(agent.calls[0].conversation, /searchRepo \{"repoId":"vdo-ninja","query":"meshcast","pathScope":"\.","limit":20\}/);
    assert.match(agent.calls[0].conversation, /searchAllRepos \{"query":"meshcast","repoIds":\["vdo-ninja","raspberry-ninja"\],"limit":20\}/);
    assert.match(agent.calls[0].conversation, /exploreRepo \{"question":"Where is meshcast documented and what does it do\?","repoId":"vdo-ninja","pathScope":"docs"\}/);
    assert.equal(agent.calls[1].toolTrace.length, 1);
    assert.equal(agent.calls[1].toolTrace[0]?.toolName, "searchSupport");
    assert.match(agent.calls[1].conversation, /Tool result \(searchSupport\):/);

    const transcriptFile = path.join(config.transcriptsDir, route.guildId, `${route.channelId}.jsonl`);
    const transcriptText = await readFile(transcriptFile, "utf8");
    assert.match(transcriptText, /msg-1/);
    assert.deepEqual(readCounts(config.sqlitePath), { transcripts: 1, decision_log: 1, qa_entries: 1 });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("first unresolved asker statement stays as hold when no helper is active (guardrail removed)", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-support",
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      mode: "thread",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-support.md",
        [
          "# VDO Support",
          "",
          "- Help with direct unresolved support problems.",
          "- Stay concise and actionable.",
        ].join("\n"),
      ),
      repoScopes: ["vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("hold", {
          confidence: 0.72,
          category: "support-triage",
          rationale: "This is a problem statement but not phrased as a direct question.",
          problemOpen: true,
          humanAlreadyHandling: false,
          directAsk: false,
          newTechnicalEvidence: false,
          novelty: 0.2,
        });
      }
      return {
        approved: true,
        confidence: 0.89,
        issues: [],
        policyFlags: [],
        finalBody: "If the viewer link works for you but not your friend, first test `&relay` and then confirm whether their browser is blocking the peer connection.",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([
      {
        kind: "final",
        draft: "If the viewer link works for you but not your friend, first test `&relay` and then confirm whether their browser is blocking the peer connection.",
        supportRecordIds: [],
        repoRefs: ["vdo-ninja:README.md"],
      },
    ]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        threadId: "thread-1",
        content: "When I share the view link to my friend, it shows nothing for them but it works for me.",
      }),
    );

    // Hold→reply guardrail was removed (3% approval rate, wasted pipeline time).
    // Hold decisions now stay as hold — no draft is generated.
    assert.equal(result.posted, false);
    assert.match(qwen.calls[0].userPrompt, /participantCount: 1/);
    assert.match(qwen.calls[0].userPrompt, /currentAuthorIsOriginalAsker: true/);
    const run = db.getWorkflowRun(result.runId);
    assert.equal(run?.outcome, "hold");
    assert.equal(run?.triage?.action, "hold");
    // No guardrail step expected — hold→reply upgrade was removed and no other guardrail fires
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("miscellaneous follow-up chatter stays out when there is no fresh ask", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-misc",
      guildId: "444444444444444444",
      channelId: "999999999999999999",
      mode: "channel",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-misc.md",
        [
          "# VDO Misc",
          "",
          "- Be conservative in miscellaneous.",
          "- Reply only when the latest message contains a clear unresolved support ask.",
          "- Do not interrupt peer chatter or solved conversations.",
        ].join("\n"),
      ),
      repoScopes: ["vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    const triageDecisions: TriageDecision[] = [
      makeTriageDecision("reply", {
        confidence: 0.9,
        category: "support-needed",
        rationale: "Initial direct question.",
        problemOpen: true,
        directAsk: true,
        newTechnicalEvidence: true,
        novelty: 0.84,
      }),
      makeTriageDecision("hold", {
        confidence: 0.86,
        category: "ongoing-conversation",
        rationale: "Peer discussion is continuing without a fresh ask.",
        problemOpen: true,
        humanAlreadyHandling: true,
        directAsk: false,
        newTechnicalEvidence: false,
        novelty: 0.24,
      }),
    ];

    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        const next = triageDecisions.shift();
        if (!next) {
          throw new Error("Missing triage decision.");
        }
        return next;
      }
      return {
        approved: true,
        confidence: 0.91,
        issues: [],
        policyFlags: [],
        finalBody: "A first-pass answer.",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([{ kind: "final", draft: "A first-pass answer.", supportRecordIds: [], repoRefs: [] }]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    await pipeline.handleEvent(
      route,
      makeEvent(route, {
        messageId: "msg-1",
        content: "How do I stop relay mode for one guest?",
      }),
    );

    const second = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        messageId: "msg-2",
        authorId: "user-2",
        authorName: "bob",
        content: "That makes sense, I think the firewall is the culprit.",
        createdAt: "2026-03-12T09:01:00.000Z",
      }),
    );

    // Bob's follow-up triggers active-helper fast-path (alice recently active,
    // no question mark, no direct ask) — model call skipped entirely.
    assert.equal(second.posted, false);
    assert.equal(agent.calls.length, 1);
    assert.equal(qwen.calls.length, 2); // triage + review for msg-1 only; msg-2 fast-pathed
    const heldRun = db.getWorkflowRun(second.runId);
    assert.equal(heldRun?.outcome, "no-reply");
    assert.equal(heldRun?.triage?.action, "ignore");
    assert.ok(heldRun?.steps.some((step) => step.label === "Active helper fast-path (model call skipped)"));
    assert.deepEqual(readCounts(config.sqlitePath), { transcripts: 2, decision_log: 2, qa_entries: 1 });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("maintainer-authored messages are ignored instead of sitting in hold", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "social-stream-support",
      guildId: "444444444444444444",
      channelId: "666666666666666666",
      mode: "thread",
      instructionRef: writeInstruction(
        tempDir,
        "social-support.md",
        [
          "# Social Stream Support",
          "",
          "- Help users with unresolved chat integration issues.",
          "- Do not interrupt maintainer-led troubleshooting.",
        ].join("\n"),
      ),
      repoScopes: ["social-stream"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("hold", {
          confidence: 0.8,
          category: "maintainer-update",
          rationale: "The thread is active and the message looks like a troubleshooting update.",
          problemOpen: true,
          humanAlreadyHandling: true,
          directAsk: false,
          newTechnicalEvidence: false,
          novelty: 0.4,
        });
      }
      throw new Error("Review should not run for maintainer message.");
    });
    const agent = new RecordingAgentClient([]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        threadId: "thread-2",
        authorId: "3402",
        authorName: "maintainer-user",
        content: "I will have an update in 10 minutes for you to try",
      }),
    );

    assert.equal(result.posted, false);
    assert.equal(agent.calls.length, 0);
    assert.equal(qwen.calls.length, 0, "Maintainer fast-path should skip the Qwen call entirely");
    const run = db.getWorkflowRun(result.runId);
    assert.equal(run?.outcome, "no-reply");
    assert.equal(run?.triage?.action, "ignore");
    assert.ok(run?.steps.some((step) => step.label === "Maintainer fast-path (model call skipped)"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bug-report channel escalates a reproducible report and keeps the answer concrete", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-bug-report",
      guildId: "444444444444444444",
      channelId: "777777777777777777",
      mode: "channel",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-bug-report.md",
        [
          "# VDO Bug Reports",
          "",
          "- Prioritize reproduction details, browser/version, logs, and regression checks.",
          "- Ask for the smallest next troubleshooting step that will confirm the bug.",
          "- Do not over-answer if the report is still missing basic environment details.",
        ].join("\n"),
      ),
      repoScopes: ["vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    seedSupportRecord(db, route, "Safari autoplay regression", "Clear site permissions and retest with a hard reload.");

    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("reply", {
          confidence: 0.94,
          category: "bug-report",
          rationale: "Repro steps and environment are present.",
          problemOpen: true,
          humanAlreadyHandling: false,
          directAsk: true,
          newTechnicalEvidence: true,
          novelty: 0.91,
          urgency: "high",
        });
      }
      return {
        approved: true,
        confidence: 0.9,
        issues: [],
        policyFlags: [],
        finalBody: "That looks like the known Safari autoplay path. Test with fresh permissions, then force a full reload and retest with the latest build.",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([
      { kind: "tool", tool: "searchSupport", args: { query: "Safari autoplay regression", limit: 3 } },
      {
        kind: "final",
        draft: "That looks like the known Safari autoplay path. Test with fresh permissions, then force a full reload and retest with the latest build.",
        supportRecordIds: [1],
        repoRefs: ["vdo-ninja:README.md"],
      },
    ]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        content: "Bug: Safari 17 on macOS stops autoplay after I reconnect. Repro is load page, allow camera, disconnect, reconnect, and remote audio never resumes.",
      }),
    );

    assert.equal(result.posted, true);
    assert.equal(
      result.reply,
      "That looks like the known Safari autoplay path. Test with fresh permissions, then force a full reload and retest with the latest build.",
    );
    assert.match(qwen.calls[0].userPrompt, /Prioritize reproduction details, browser\/version, logs, and regression checks/);
    assert.match(qwen.calls[0].userPrompt, /Safari 17 on macOS/);
    assert.match(agent.calls[0].systemPrompt, /Route: vdo-ninja-bug-report/);
    assert.match(qwen.calls[1].userPrompt, /supportRecordIds: 1/i);
    assert.deepEqual(readCounts(config.sqlitePath), { transcripts: 1, decision_log: 1, qa_entries: 1 });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("raspberry-ninja channel carries Pi-specific context into triage and answer generation", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "raspberry-ninja-channel",
      guildId: "444444444444444444",
      channelId: "888888888888888888",
      mode: "channel",
      instructionRef: writeInstruction(
        tempDir,
        "raspberry-ninja-support.md",
        [
          "# Raspberry Ninja Support",
          "",
          "- Focus on Raspberry Pi hardware limits, browser packaging, GPU/video decode, and OS image freshness.",
          "- Prefer short, hardware-aware next steps over generic VDO advice.",
          "- Do not force a reply if the user is only sharing status.",
        ].join("\n"),
      ),
      repoScopes: ["raspberry-ninja", "vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("reply", {
          confidence: 0.92,
          category: "raspberry-support",
          rationale: "The user is asking for the next diagnostic step on Pi hardware.",
          problemOpen: true,
          humanAlreadyHandling: false,
          directAsk: true,
          newTechnicalEvidence: true,
          novelty: 0.87,
        });
      }
      return {
        approved: true,
        confidence: 0.9,
        issues: [],
        policyFlags: [],
        finalBody: "On Raspberry Pi, first confirm hardware video decode and test the latest Chromium package; the black screen usually points to an outdated browser or GPU stack.",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([
      {
        kind: "final",
        draft: "On Raspberry Pi, first confirm hardware video decode and test the latest Chromium package; the black screen usually points to an outdated browser or GPU stack.",
        supportRecordIds: [],
        repoRefs: ["raspberry-ninja:README.md"],
      },
    ]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        content: "My Pi Zero 2 shows a black video tile after the latest image update. What should I check first?",
      }),
    );

    assert.equal(result.posted, true);
    assert.equal(
      result.reply,
      "On Raspberry Pi, first confirm hardware video decode and test the latest Chromium package; the black screen usually points to an outdated browser or GPU stack.",
    );
    assert.match(qwen.calls[0].userPrompt, /Raspberry Pi hardware limits, browser packaging, GPU\/video decode/);
    assert.match(agent.calls[0].systemPrompt, /Route: raspberry-ninja-channel/);
    assert.match(agent.calls[0].conversation, /My Pi Zero 2 shows a black video tile/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("thread support route stays out of follow-up chatter without a fresh ask", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-support",
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      mode: "thread",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-support.md",
        [
          "# VDO Support",
          "",
          "- Prioritize actionable troubleshooting steps.",
          "- If the thread is moving forward without a fresh ask, do not force a reply.",
        ].join("\n"),
      ),
      repoScopes: ["vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("hold", {
          confidence: 0.84,
          category: "handled",
          rationale: "The thread is progressing without a new direct ask.",
          problemOpen: true,
          humanAlreadyHandling: true,
          directAsk: false,
          newTechnicalEvidence: false,
          novelty: 0.19,
        });
      }
      throw new Error("Review step should not be reached.");
    });
    const agent = new RecordingAgentClient([]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    for (let i = 0; i < 12; i += 1) {
      await pipeline.handleEvent(
        route,
        makeEvent(route, {
          threadId: "thread-1",
          messageId: `msg-${i + 1}`,
          authorId: `user-${i % 2}`,
          authorName: i % 2 === 0 ? "alice" : "bob",
          content: i === 0 ? "Initial thread question about browser permissions." : `follow-up ${i}`,
          createdAt: `2026-03-12T09:${String(i).padStart(2, "0")}:00.000Z`,
        }),
      );
    }

    // With active-helper fast-path, only msg-1 (no prior other participant)
    // calls the triage model. All subsequent alternating messages have
    // "other participant recently active" and no question → fast-pathed.
    assert.equal(qwen.calls.length, 1);
    const firstPrompt = qwen.calls[0].userPrompt;
    assert.match(firstPrompt, /If the thread is moving forward without a fresh ask, do not force a reply/);
    assert.match(firstPrompt, /Initial thread question about browser permissions/);
    assert.match(firstPrompt, /First message in conversation:/);
    assert.deepEqual(readCounts(config.sqlitePath), { transcripts: 12, decision_log: 12, qa_entries: 0 });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("thread support route answers a fresh follow-up ask and passes evidence into review", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-support",
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      mode: "thread",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-support.md",
        [
          "# VDO Support",
          "",
          "- Prioritize actionable troubleshooting steps.",
          "- Use the first message and latest ask together before replying.",
          "- Ignore peer chatter that does not change the user's unresolved issue.",
        ].join("\n"),
      ),
      repoScopes: ["vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    seedSupportRecord(db, route, "Firefox camera permissions", "Clear cached permissions and retest camera access.");
    // msg-2 (bob) is fast-pathed (alice recently active, no question).
    // Only msg-1 and msg-3 (has question mark) call the triage model.
    const triageDecisions: TriageDecision[] = [
      makeTriageDecision("hold", {
        confidence: 0.85,
        category: "initial-thread",
        rationale: "Initial question was already being handled by peers.",
        problemOpen: true,
        humanAlreadyHandling: true,
        directAsk: false,
        newTechnicalEvidence: false,
        novelty: 0.31,
      }),
      makeTriageDecision("reply", {
        confidence: 0.95,
        category: "new-follow-up-ask",
        rationale: "The original user asked for the next step after trying Chrome.",
        problemOpen: true,
        humanAlreadyHandling: false,
        directAsk: true,
        newTechnicalEvidence: true,
        novelty: 0.93,
      }),
    ];

    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        const next = triageDecisions.shift();
        if (!next) {
          throw new Error("Missing triage decision.");
        }
        return next;
      }
      return {
        approved: true,
        confidence: 0.93,
        issues: [],
        policyFlags: [],
        finalBody: "If the invite works in Chrome but not Firefox, clear cached permissions and verify whether camera access is blocked at the browser level.",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([
      { kind: "tool", tool: "searchSupport", args: { query: "Firefox camera permissions", limit: 5 } },
      {
        kind: "final",
        draft: "If the invite works in Chrome but not Firefox, clear cached permissions and verify whether camera access is blocked at the browser level.",
        supportRecordIds: [1],
        repoRefs: ["vdo-ninja:README.md"],
      },
    ]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    await pipeline.handleEvent(
      route,
      makeEvent(route, {
        threadId: "thread-2",
        messageId: "msg-1",
        content: "Firefox will not grant my camera in this room.",
      }),
    );
    await pipeline.handleEvent(
      route,
      makeEvent(route, {
        threadId: "thread-2",
        messageId: "msg-2",
        authorId: "user-2",
        authorName: "bob",
        content: "Chrome works here for me, so it might be a browser-specific permission issue.",
        createdAt: "2026-03-12T09:01:00.000Z",
      }),
    );
    const third = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        threadId: "thread-2",
        messageId: "msg-3",
        content: "Chrome works for me too. What should I check next in Firefox?",
        createdAt: "2026-03-12T09:02:00.000Z",
      }),
    );

    assert.equal(third.posted, true);
    assert.equal(
      third.reply,
      "If the invite works in Chrome but not Firefox, clear cached permissions and verify whether camera access is blocked at the browser level.",
    );
    // msg-3 triage is at calls[1] (msg-2 fast-pathed), review at calls[2]
    assert.match(qwen.calls[1].userPrompt, /Use the first message and latest ask together before replying/);
    assert.match(qwen.calls[1].userPrompt, /Firefox will not grant my camera in this room/);
    assert.match(qwen.calls[1].userPrompt, /Chrome works for me too. What should I check next in Firefox/);
    assert.equal(agent.calls.length, 2);
    assert.equal(agent.calls[1].toolTrace[0]?.toolName, "searchSupport");
    assert.match(qwen.calls[2].userPrompt, /Query trace:/);
    assert.match(qwen.calls[2].userPrompt, /searchSupport/);
    assert.deepEqual(readCounts(config.sqlitePath), { transcripts: 3, decision_log: 3, qa_entries: 1 });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bad repo tool arguments stay in the trace and do not collapse the workflow", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-support",
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      mode: "thread",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-support.md",
        [
          "# VDO Support",
          "",
          "- Prioritize actionable troubleshooting steps.",
          "- Use repo evidence when needed, but do not invent tool arguments.",
        ].join("\n"),
      ),
      repoScopes: ["vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("reply", {
          confidence: 0.91,
          category: "support-needed",
          rationale: "Direct unresolved question.",
          problemOpen: true,
          humanAlreadyHandling: false,
          directAsk: true,
          newTechnicalEvidence: true,
          novelty: 0.9,
        });
      }
      return {
        approved: true,
        confidence: 0.87,
        issues: [],
        policyFlags: [],
        finalBody: "Start with the README guidance, then narrow the dock/share setup step by step.",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([
      {
        kind: "tool",
        tool: "searchRepo",
        args: {
          area: "repos",
          scope: "stevesbot/repos",
          query: "dock.html session limit showtime",
        },
      },
      {
        kind: "final",
        draft: "Start with the README guidance, then narrow the dock/share setup step by step.",
        supportRecordIds: [],
        repoRefs: ["vdo-ninja:README.md"],
      },
    ]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        threadId: "thread-3",
        content: "Can you dumb it down for me step by step? I got lost at the second dock.",
      }),
    );

    assert.equal(result.posted, true);
    assert.equal(result.reply, "Start with the README guidance, then narrow the dock/share setup step by step.");
    assert.equal(agent.calls.length, 2);
    assert.equal(agent.calls[1].toolTrace.length, 1);
    assert.equal(agent.calls[1].toolTrace[0]?.toolName, "searchRepo");
    assert.match(agent.calls[1].toolTrace[0]?.resultSummary ?? "", /Tool error: Missing required string arg "repoId"/);
    assert.match(agent.calls[1].conversation, /Tool result \(searchRepo\):/);
    assert.match(agent.calls[1].conversation, /"ok": false/);
    assert.match(agent.calls[1].conversation, /"expectedArgs":/);
    assert.match(qwen.calls[1].userPrompt, /Repo refs: \[none\]/);
    assert.match(qwen.calls[1].userPrompt, /Removed unverified repo refs: vdo-ninja:README\.md/);
    assert.deepEqual(readCounts(config.sqlitePath), { transcripts: 1, decision_log: 1, qa_entries: 1 });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("searchAllRepos can gather evidence across route-scoped repos before drafting", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-misc",
      guildId: "444444444444444444",
      channelId: "999999999999999999",
      mode: "channel",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-misc.md",
        [
          "# VDO Misc",
          "",
          "- Search repo evidence before giving configuration advice.",
        ].join("\n"),
      ),
      repoScopes: ["vdo-ninja", "raspberry-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("reply", {
          confidence: 0.92,
          category: "support-needed",
          rationale: "Repo-backed configuration guidance is needed.",
          problemOpen: true,
          humanAlreadyHandling: false,
          directAsk: true,
          newTechnicalEvidence: true,
          novelty: 0.86,
        });
      }
      return {
        approved: true,
        confidence: 0.9,
        issues: [],
        policyFlags: [],
        finalBody: "Check the VDO and Raspberry docs first, then simplify the dock setup one setting at a time.",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([
      {
        kind: "tool",
        tool: "searchAllRepos",
        args: {
          query: "docs",
          repoIds: ["vdo-ninja", "raspberry-ninja"],
          limit: 5,
        },
      },
      {
        kind: "final",
        draft: "Check the VDO and Raspberry docs first, then simplify the dock setup one setting at a time.",
        supportRecordIds: [],
        repoRefs: ["vdo-ninja:README.md", "raspberry-ninja:README.md"],
      },
    ]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        content: "What docs should I read first before I change more dock settings?",
      }),
    );

    assert.equal(result.posted, true);
    assert.equal(
      result.reply,
      "Check the VDO and Raspberry docs first, then simplify the dock setup one setting at a time.",
    );
    assert.equal(agent.calls.length, 2);
    assert.ok(agent.calls[1].toolTrace.some((entry) => entry.toolName === "searchAllRepos"));
    assert.match(agent.calls[1].conversation, /Tool result \(searchAllRepos\):/);
    assert.match(qwen.calls[1].userPrompt, /raspberry-ninja:README.md/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("exploreRepo runs a constrained repo-only subagent and keeps evidence visible to the parent draft", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-support",
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      mode: "thread",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-support.md",
        [
          "# VDO Support",
          "",
          "- Use repo evidence when the user asks for exact documentation or file-backed behavior.",
          "- Keep replies short and specific.",
        ].join("\n"),
      ),
      repoScopes: ["vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    writeFileSync(
      path.join(tempDir, "repos", "vdo-ninja", "docs", "meshcast.md"),
      [
        "Meshcast reduces direct relay usage for viewers.",
        "Use it when you want to reduce sender bandwidth and relay dependence.",
      ].join("\n"),
      "utf8",
    );
    const db = new AppDatabase(config.sqlitePath);
    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("reply", {
          confidence: 0.93,
          category: "repo-backed-support",
          rationale: "The user asked for exact documentation details.",
          problemOpen: true,
          humanAlreadyHandling: false,
          directAsk: true,
          newTechnicalEvidence: true,
          novelty: 0.9,
        });
      }
      return {
        approved: true,
        confidence: 0.92,
        issues: [],
        policyFlags: [],
        finalBody: "Meshcast is documented in `docs/meshcast.md`. It reduces direct relay usage for viewers and helps reduce bandwidth pressure.",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([
      {
        kind: "tool",
        tool: "exploreRepo",
        args: {
          question: "Where is meshcast documented and what does it do?",
          repoId: "vdo-ninja",
          pathScope: "docs",
        },
      },
      {
        kind: "tool",
        tool: "searchRepoRegex",
        args: {
          repoId: "vdo-ninja",
          pattern: "meshcast",
          pathScope: "docs",
          fileGlob: "*.md",
          limit: 5,
        },
      },
      {
        kind: "tool",
        tool: "openRepoFile",
        args: {
          repoId: "vdo-ninja",
          filePath: "docs/meshcast.md",
          startLine: 1,
          endLine: 40,
        },
      },
      {
        kind: "final",
        draft: "Meshcast is documented in docs/meshcast.md. It reduces direct relay usage for viewers and helps reduce bandwidth pressure.",
        supportRecordIds: [],
        repoRefs: ["vdo-ninja:docs/meshcast.md"],
      },
      {
        kind: "final",
        draft: "Meshcast is documented in `docs/meshcast.md`. It reduces direct relay usage for viewers and helps reduce bandwidth pressure.",
        supportRecordIds: [],
        repoRefs: ["vdo-ninja:docs/meshcast.md"],
      },
    ]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        threadId: "thread-explore",
        content: "Where is meshcast documented and what does it do?",
      }),
    );

    assert.equal(result.posted, true);
    assert.equal(
      result.reply,
      "Meshcast is documented in `docs/meshcast.md`. It reduces direct relay usage for viewers and helps reduce bandwidth pressure.",
    );
    assert.equal(agent.calls.length, 5);
    assert.ok(agent.calls[1]?.toolCatalog.includes("searchRepoRegex"));
    assert.ok(agent.calls[1]?.toolCatalog.includes("openRepoFile"));
    assert.ok(!agent.calls[1]?.toolCatalog.includes("searchSupport"));
    assert.ok(!agent.calls[1]?.toolCatalog.includes("webSearch"));
    assert.ok(!agent.calls[1]?.toolCatalog.includes("clarify"));
    assert.match(agent.calls[1]?.conversation ?? "", /Allowed repoIds for this subtask: vdo-ninja/);
    assert.match(agent.calls[1]?.conversation ?? "", /Default pathScope: docs/);
    assert.match(agent.calls[1]?.conversation ?? "", /Repository question: Where is meshcast documented and what does it do\?/);
    assert.match(agent.calls[4]?.conversation ?? "", /Tool result \(exploreRepo\):/);
    assert.match(agent.calls[4]?.conversation ?? "", /"repoRefs": \[/);
    assert.match(agent.calls[4]?.conversation ?? "", /vdo-ninja:docs\/meshcast\.md/);
    assert.ok(agent.calls[4]?.toolTrace.some((entry) => entry.toolName === "searchRepoRegex"));
    assert.ok(agent.calls[4]?.toolTrace.some((entry) => entry.toolName === "openRepoFile"));
    assert.ok(agent.calls[4]?.toolTrace.some((entry) => entry.toolName === "exploreRepo"));
    assert.match(qwen.calls[1]?.userPrompt ?? "", /Verified repo refs: vdo-ninja:docs\/meshcast\.md/);
    assert.match(qwen.calls[1]?.userPrompt ?? "", /Removed unverified repo refs: \[none\]/);

    const run = db.getWorkflowRun(result.runId);
    assert.ok(run?.steps.some((step) => step.label === "Run exploreRepo subagent"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});




test("image attachments are OCRed before triage and passed into GPT context", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-bug-report",
      guildId: "444444444444444444",
      channelId: "777777777777777777",
      mode: "channel",
      instructionRef: writeInstruction(
        tempDir,
        "bug-report.md",
        [
          "# Bug Report",
          "",
          "- Use screenshots when they provide direct evidence.",
          "- Ask for the next missing detail only when the screenshot still leaves ambiguity.",
        ].join("\n"),
      ),
      repoScopes: ["vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);

    const qwen = new RecordingQwenClient((input) => {
      if (input.imageDataUrl) {
        return {
          summary: "Chrome shows a camera permission error dialog.",
          extractedText: "NotReadableError Permission denied",
          signals: ["Chrome", "NotReadableError", "Permission denied"],
          confidence: 0.92,
        };
      }
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("reply", {
          confidence: 0.95,
          category: "image-evidence-support",
          rationale: "The screenshot plus the current message show a clear unresolved browser permission issue.",
          problemOpen: true,
          humanAlreadyHandling: false,
          directAsk: true,
          newTechnicalEvidence: true,
          novelty: 0.96,
          urgency: "high",
        });
      }
      return {
        approved: true,
        confidence: 0.9,
        issues: [],
        policyFlags: [],
        finalBody: "The screenshot points to a browser camera-permission issue. Clear camera permissions for vdo.ninja in Chrome, reload, and re-allow access.",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([
      {
        kind: "final",
        draft: "The screenshot points to a browser camera-permission issue. Clear camera permissions for vdo.ninja in Chrome, reload, and re-allow access.",
        supportRecordIds: [],
        repoRefs: ["vdo-ninja:README.md"],
      },
    ]);
    const fakeImageProcessor = {
      prepareAttachment: async (_event: DiscordEventRecord, attachment: DiscordAttachmentRecord) => ({
        attachment: {
          ...attachment,
          storedPath: "/tmp/mock-error.png",
          storedContentType: "image/png",
          storedWidth: 1920,
          storedHeight: 1080,
        },
        imageDataUrl: "data:image/png;base64,AAAA",
      }),
    };

    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never, fakeImageProcessor as never);
    const result = await pipeline.handleEvent(route, {
      guildId: route.guildId,
      channelId: route.channelId,
      messageId: "img-msg-1",
      authorId: "user-1",
      authorName: "alice",
      content: "",
      createdAt: "2026-03-12T10:00:00.000Z",
      attachments: [
        {
          id: "att-1",
          fileName: "error.png",
          url: "https://example.invalid/error.png",
          contentType: "image/png",
          sizeBytes: 123456,
          width: 2560,
          height: 1440,
          kind: "image",
        },
      ],
    });

    assert.equal(result.posted, true);
    assert.equal(
      result.reply,
      "The screenshot points to a browser camera-permission issue. Clear camera permissions for vdo.ninja in Chrome, reload, and re-allow access.",
    );
    assert.equal(qwen.calls[0]?.imageDataUrl, "data:image/png;base64,AAAA");
    assert.match(agent.calls[0]?.conversation ?? "", /Chrome shows a camera permission error dialog/);
    assert.match(agent.calls[0]?.conversation ?? "", /NotReadableError Permission denied/);
    assert.match(agent.calls[0]?.conversation ?? "", /storedPath: \/tmp\/mock-error\.png/);

    const transcriptPath = path.join(config.transcriptsDir, route.guildId, `${route.channelId}.jsonl`);
    const transcriptRaw = await readFile(transcriptPath, "utf8");
    const transcriptEvent = JSON.parse(transcriptRaw.trim()) as DiscordEventRecord;
    assert.equal(transcriptEvent.attachments?.[0]?.storedWidth, 1920);
    assert.equal(transcriptEvent.attachments?.[0]?.storedHeight, 1080);
    assert.equal(transcriptEvent.attachments?.[0]?.extractedText, "NotReadableError Permission denied");
    assert.deepEqual(readCounts(config.sqlitePath), { transcripts: 1, decision_log: 1, qa_entries: 1 });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});


test("reply→hold guardrail downgrades when model says reply but message has no direct ask", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-support",
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      mode: "thread",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-support.md",
        "# VDO Support\n\n- Help with direct unresolved support problems.",
      ),
      repoScopes: ["vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);

    // First message establishes the thread
    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        // Model incorrectly says "reply" but sets directAsk=false
        // This simulates the pattern we saw in 6/10 recent rejections
        return makeTriageDecision("reply", {
          confidence: 0.75,
          category: "support-needed",
          rationale: "User has an open problem.",
          problemOpen: true,
          humanAlreadyHandling: false,
          directAsk: false,        // Model correctly identifies no direct ask
          newTechnicalEvidence: true, // Model unreliably set to true (90% of messages)
          novelty: 0.6,
        });
      }
      // Review (should not be reached — guardrail should downgrade to hold)
      return {
        approved: true,
        confidence: 0.9,
        issues: [],
        policyFlags: [],
        finalBody: "Some reply",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([
      {
        kind: "final",
        draft: "Some reply that should never be generated",
        supportRecordIds: [],
        repoRefs: [],
      },
    ]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    // Message with no question mark, no direct ask phrase, no attachments
    // This is a status update that should be held, not replied to
    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        threadId: "thread-reply-hold",
        content: "I tried clearing the cache and restarting OBS",
      }),
    );

    assert.equal(result.posted, false, "Should not generate a draft");
    const run = db.getWorkflowRun(result.runId);
    assert.equal(run?.outcome, "hold", "Should be held, not replied");
    assert.equal(run?.triage?.action, "hold", "Triage action should be downgraded to hold");

    // Verify the guardrail step was recorded
    assert.ok(
      run?.steps.some((step) => step.label === "Apply deterministic triage guardrails"),
      "Should have a guardrail step",
    );

    // Only 1 Qwen call (triage) — no draft/review since held
    assert.equal(qwen.calls.length, 1, "Only triage model call should happen");
    assert.equal(agent.calls.length, 0, "Agent should not be called for held messages");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reply→hold guardrail does NOT fire when message has a question mark", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-support",
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      mode: "thread",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-support.md",
        "# VDO Support\n\n- Help with direct unresolved support problems.",
      ),
      repoScopes: ["vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("reply", {
          confidence: 0.85,
          category: "support-needed",
          rationale: "User asks a direct question.",
          problemOpen: true,
          humanAlreadyHandling: false,
          directAsk: false,   // Even if model says false...
          newTechnicalEvidence: true,
          novelty: 0.7,
        });
      }
      return {
        approved: true,
        confidence: 0.92,
        issues: [],
        policyFlags: [],
        finalBody: "Try adding &proaudio to your URL.",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([
      {
        kind: "final",
        draft: "Try adding &proaudio to your URL.",
        supportRecordIds: [],
        repoRefs: [],
      },
    ]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    // Message WITH a question mark — guardrail should NOT fire
    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        threadId: "thread-reply-question",
        content: "I tried clearing the cache but audio still doesn't work, what should I do next?",
      }),
    );

    // Should proceed to draft and review (question mark present)
    assert.equal(result.posted, true, "Should generate a draft since there's a question");
    const run = db.getWorkflowRun(result.runId);
    assert.equal(run?.outcome, "approved");
    // Agent and review should have been called
    assert.ok(agent.calls.length > 0, "Agent should be called for messages with questions");
    assert.ok(qwen.calls.length >= 2, "Should have triage + review calls");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("grounding validation replaces fabricated draft when all searches return empty", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-support",
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      mode: "thread",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-support.md",
        "# VDO Support\n\nProvide grounded answers only.",
      ),
      repoScopes: ["vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("reply", {
          confidence: 0.88,
          category: "support-needed",
          rationale: "User asks a question.",
          problemOpen: true,
          humanAlreadyHandling: false,
          directAsk: true,
          newTechnicalEvidence: true,
          novelty: 0.85,
        });
      }
      // Reviewer approves the grounding-replaced draft
      return {
        approved: true,
        confidence: 0.95,
        issues: [],
        policyFlags: [],
        finalBody: input.userPrompt.includes("I searched the documentation")
          ? "I searched the documentation and support history but couldn't find specific information about this. I searched for: \"meshcast relay config\". I'd suggest waiting for the maintainer to respond, or checking the official docs/wiki directly. Sorry I couldn't be more helpful on this one!"
          : "The meshcast relay setting is at &meshcast=1.",
      } satisfies ReviewDecision;
    });
    // Agent searches but finds nothing, then fabricates an answer
    const agent = new RecordingAgentClient([
      {
        kind: "tool",
        tool: "searchSupport",
        args: { query: "meshcast relay config", limit: 5 },
      },
      {
        kind: "tool",
        tool: "searchKnowledgeBase",
        args: { query: "meshcast relay config", limit: 5 },
      },
      {
        kind: "final",
        draft: "The meshcast relay setting is at &meshcast=1. You can enable it by adding this parameter to your URL.",
        supportRecordIds: [],
        repoRefs: [],
      },
    ]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        threadId: "thread-grounding",
        content: "How do I configure meshcast relay?",
      }),
    );

    assert.equal(result.posted, true);
    // The fabricated draft should have been replaced by the grounding validator
    assert.ok(
      result.reply?.includes("I searched the documentation"),
      "Expected grounding replacement, got: " + (result.reply ?? "").substring(0, 100),
    );
    assert.ok(
      !result.reply?.includes("&meshcast=1"),
      "Fabricated parameter should not survive grounding validation",
    );

    // Verify the run was stored
    const runs = db.listWorkflowRuns({ routeId: route.id, page: 1, pageSize: 1 });
    assert.equal(runs.items.length, 1);
    assert.equal(runs.items[0]?.outcome, "approved");

    // Verify the grounding step appears in the steps
    const detail = db.getWorkflowRun(runs.items[0]!.id);
    const groundingStep = detail?.steps.find(
      (s) => s.label.includes("Grounding validation"),
    );
    assert.ok(groundingStep, "Should have a grounding validation step");
    assert.ok(
      groundingStep?.outputText?.includes("Original draft (replaced)"),
      "Step should show original fabricated draft",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("explicit Ask the Bot requests retry drafts that wrongly defer to human handling", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-support",
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      mode: "thread",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-support.md",
        "# VDO Support\n\nAnswer direct support asks.",
      ),
      repoScopes: ["vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("hold", {
          confidence: 0.82,
          category: "peer-handling",
          rationale: "A human appears to be active in the thread.",
          problemOpen: true,
          humanAlreadyHandling: true,
          directAsk: false,
          newTechnicalEvidence: false,
          novelty: 0.22,
        });
      }
      return {
        approved: true,
        confidence: 0.94,
        issues: [],
        policyFlags: [],
        finalBody: "Use the Windows 3.1 theme from the theme list, then activate it on the featured overlay.",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([
      {
        kind: "final",
        draft: "maintainer is already handling this thread, so no public reply is needed.",
        supportRecordIds: [],
        repoRefs: [],
      },
      {
        kind: "final",
        draft: "Use the Windows 3.1 theme from the theme list, then activate it on the featured overlay.",
        supportRecordIds: [],
        repoRefs: [],
      },
    ]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        threadId: "thread-ask-bot",
        content: "Can you show me how to enable the Windows 3.1 style?",
        userRequestedBotHelp: true,
      }),
    );

    assert.equal(result.posted, true);
    assert.equal(result.reply, "Use the Windows 3.1 theme from the theme list, then activate it on the featured overlay.");
    assert.equal(agent.calls.length, 2, "The drafter should retry once after a deferral draft.");
    assert.match(agent.calls[0].conversation, /IMPORTANT OVERRIDE: The user explicitly clicked 'Ask the Bot'/);
    assert.match(agent.calls[1].conversation, /RETRY INSTRUCTION:/);
    const run = db.getWorkflowRun(result.runId);
    assert.ok(run?.steps.some((step) => step.label === "Retry draft after explicit bot-help deferral"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("explicit Ask the Bot re-focuses on the user's unresolved ask when the latest message is from maintainer", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-support",
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      mode: "thread",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-support.md",
        "# VDO Support\n\nAnswer the user's unresolved ask.",
      ),
      repoScopes: ["vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("hold", {
          confidence: 0.74,
          category: "peer-handling",
          rationale: "maintainer is active in the thread.",
          problemOpen: true,
          humanAlreadyHandling: true,
          directAsk: false,
          newTechnicalEvidence: false,
          novelty: 0.2,
        });
      }
      return {
        approved: true,
        confidence: 0.93,
        issues: [],
        policyFlags: [],
        finalBody: "I couldn't find a documented Windows 3.1 theme option in VDO.Ninja. If you mean Social Stream styling, paste the exact page and I can narrow that down.",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([
      {
        kind: "final",
        draft: "I couldn't find a documented Windows 3.1 theme option in VDO.Ninja. If you mean Social Stream styling, paste the exact page and I can narrow that down.",
        supportRecordIds: [],
        repoRefs: [],
      },
    ]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    await pipeline.handleEvent(
      route,
      makeEvent(route, {
        messageId: "msg-user-ask",
        threadId: "thread-refocus",
        content: "also @steve i want to use windows 3.1 style can u show me how to add that after",
      }),
    );

    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        messageId: "msg-steve-followup",
        threadId: "thread-refocus",
        authorId: "steve-1",
        authorName: "maintainer-user",
        content: "sign in",
        userRequestedBotHelp: true,
      }),
    );

    assert.equal(result.posted, true);
    assert.match(agent.calls[0].conversation, /Current message:\nmessageId: msg-user-ask/);
    assert.match(agent.calls[0].conversation, /windows 3\.1 style/);
    assert.doesNotMatch(agent.calls[0].conversation, /Current message:\nmessageId: msg-steve-followup[\s\S]*content: sign in/);
    const run = db.getWorkflowRun(result.runId);
    assert.ok(run?.steps.some((step) => step.label === "Normalize explicit bot-help focus message"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("review receives verified injected knowledge-base evidence", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "social-stream-support",
      guildId: "444444444444444444",
      channelId: "666666666666666666",
      mode: "thread",
      instructionRef: writeInstruction(
        tempDir,
        "social-stream.md",
        "# Social Stream Support\n\nUse trusted KB evidence when it matches the user's issue.",
      ),
      repoScopes: ["social-stream"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    seedKnowledgeMatch(tempDir, {
      threadId: "kb-tts-1",
      threadName: "TTS command-only setup",
      summary: "Command-only TTS setup for Social Stream Ninja.",
      problemStatement: "The user wants TTS to trigger only on specific commands instead of reading every incoming YouTube message.",
      solution: "Turn OFF the top option 'text to speech incoming messages' and leave the lower TTS options enabled. That keeps TTS command-based instead of reading every message.",
      keywords: ["tts", "youtube", "speech", "incoming", "messages"],
      category: "bug-report",
    });
    const db = new AppDatabase(config.sqlitePath);
    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("reply", {
          confidence: 0.91,
          category: "youtube-tts-configuration",
          rationale: "Direct configuration question.",
          problemOpen: true,
          humanAlreadyHandling: false,
          directAsk: true,
          newTechnicalEvidence: true,
          novelty: 0.88,
        });
      }
      assert.match(input.userPrompt, /Verified knowledge matches:/);
      assert.match(input.userPrompt, /TTS command-only setup/);
      assert.match(input.userPrompt, /text to speech incoming messages/);
      return {
        approved: true,
        confidence: 0.94,
        issues: [],
        policyFlags: [],
        finalBody: "Turn off the top 'text to speech incoming messages' option and leave the lower TTS options enabled. That keeps TTS command-based instead of reading every incoming YouTube message.",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([
      {
        kind: "final",
        draft: "Turn off the top 'text to speech incoming messages' option and leave the lower TTS options enabled. That keeps TTS command-based instead of reading every incoming YouTube message.",
        supportRecordIds: [],
        repoRefs: [],
      },
    ]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        threadId: "thread-kb-review",
        content: "How can I stop YouTube TTS from reading commands and only read chat participants?",
      }),
    );

    assert.equal(result.posted, true);
    const run = db.getWorkflowRun(result.runId);
    assert.ok(run?.steps.some((step) => step.label === "Auto-inject knowledge base context"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("review sees unverified repo refs and support ids removed from the draft", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-support",
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      mode: "thread",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-support.md",
        "# VDO Support\n\nOnly cite verified evidence.",
      ),
      repoScopes: ["vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    const qwen = new RecordingQwenClient((input) => {
      if (input.systemPrompt.includes("front-gate")) {
        return makeTriageDecision("reply", {
          confidence: 0.9,
          category: "support-needed",
          rationale: "Direct ask.",
          problemOpen: true,
          humanAlreadyHandling: false,
          directAsk: true,
          newTechnicalEvidence: true,
          novelty: 0.9,
        });
      }
      assert.match(input.userPrompt, /Repo refs: \[none\]/);
      assert.match(input.userPrompt, /Removed unverified repo refs: vdo-ninja:README\.md/);
      assert.match(input.userPrompt, /Removed unverified supportRecordIds: 99/);
      return {
        approved: true,
        confidence: 0.93,
        issues: [],
        policyFlags: [],
        finalBody: "Try opening the view link in a normal browser first so we can narrow down whether OBS is the issue.",
      } satisfies ReviewDecision;
    });
    const agent = new RecordingAgentClient([
      {
        kind: "final",
        draft: "The README confirms this behavior.",
        supportRecordIds: [99],
        repoRefs: ["vdo-ninja:README.md"],
      },
    ]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        threadId: "thread-sanitize",
        content: "Why is my OBS source blank?",
      }),
    );

    assert.equal(result.posted, true);
    const run = db.getWorkflowRun(result.runId);
    assert.ok(run?.steps.some((step) => step.label === "Sanitize cited evidence against tool results"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reply-hold guardrail fires for short status update without question mark", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-pipeline-"));

  try {
    const route: RouteConfig = {
      id: "vdo-ninja-support",
      guildId: "444444444444444444",
      channelId: "555555555555555555",
      mode: "thread",
      instructionRef: writeInstruction(
        tempDir,
        "vdo-support.md",
        "# VDO Support\n\nHelp users with VDO.Ninja issues.",
      ),
      repoScopes: ["vdo-ninja"],
      enabled: true,
    };
    const config = makeAppConfig(tempDir, [route]);
    const db = new AppDatabase(config.sqlitePath);
    const qwen = new RecordingQwenClient((input) => {
      // Triage says reply but with directAsk=false (a status update)
      return makeTriageDecision("reply", {
        confidence: 0.85,
        category: "support-triage",
        rationale: "User sent a status update.",
        problemOpen: true,
        humanAlreadyHandling: false,
        directAsk: false,
        newTechnicalEvidence: true,
        novelty: 0.6,
      });
    });
    const agent = new RecordingAgentClient([
      {
        kind: "final",
        draft: "This should never be reached.",
        supportRecordIds: [],
        repoRefs: [],
      },
    ]);
    const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

    // Short status update (22 chars, no question mark, no direct ask phrase)
    const result = await pipeline.handleEvent(
      route,
      makeEvent(route, {
        threadId: "thread-status",
        content: "its the standalone app",
      }),
    );

    // Enhanced guardrail should downgrade to hold since content < 60 chars, no question, no direct ask
    assert.equal(result.posted, false, "Should not post for short status update");
    assert.equal(result.triage?.action, "hold", "Should be downgraded to hold by enhanced guardrail");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("acknowledgement messages like 'thanks' do not trigger reply", async () => {
  // This tests the acknowledgement guardrail: if Qwen says "reply" for an ack message,
  // the deterministic guardrail should downgrade it to "ignore"
  const tmpDir = mkdtempSync(path.join(tmpdir(), "stevesbot-guardrail-"));
  const sqlitePath = path.join(tmpDir, "test.sqlite");
  const instrDir = path.join(tmpDir, "instructions");
  const transcriptsDir = path.join(tmpDir, "transcripts");
  mkdirSync(instrDir, { recursive: true });
  mkdirSync(transcriptsDir, { recursive: true });
  writeFileSync(path.join(instrDir, "test.md"), "Test route instruction");

  const route: RouteConfig = {
    id: "test-route",
    guildId: "guild-1",
    channelId: "channel-1",
    mode: "thread",
    instructionRef: path.join(instrDir, "test.md"),
    repoScopes: ["vdo-ninja"],
    enabled: true,
  };

  const config: AppConfig = {
    rootDir: tmpDir,
    manifestsDir: tmpDir,
    instructionsDir: instrDir,
    transcriptsDir,
    sqlitePath,
    logsDir: tmpDir,
    repos: [],
    routes: [route],
    resourceMap: [],
  };

  const db = new AppDatabase(sqlitePath);

  // Qwen mock: always says reply (the guardrail should override)
  const qwen = new RecordingQwenClient(() => ({
    action: "reply" as const,
    botShouldSpeakNow: true,
    confidence: 0.7,
    category: "thanks",
    rationale: "User said thanks",
    problemOpen: false,
    humanAlreadyHandling: false,
    directAsk: false,
    newTechnicalEvidence: false,
    novelty: 0.1,
    urgency: "low" as const,
  }));

  const agent = new RecordingAgentClient([]);
  const pipeline = new SupportPipeline(config, db, qwen as never, agent as never);

  const event: DiscordEventRecord = {
    guildId: "guild-1",
    channelId: "channel-1",
    threadId: "thread-ack-1",
    messageId: "msg-ack-test",
    authorId: "user-ack",
    authorName: "gratefulUser",
    content: "thanks!",
    createdAt: new Date().toISOString(),
  };
  db.enqueueWorkflowJob(route.id, event);

  const result = await pipeline.handleEvent(route, event);

  // The acknowledgement guardrail should prevent reply
  assert.notEqual(result.triage.action, "reply",
    "Bot should not reply to 'thanks!' — acknowledgement guardrail should fire");

  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});
