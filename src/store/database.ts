import Database from "better-sqlite3";
import type {
  DiscordEventRecord,
  DraftUsage,
  DraftUsageRecord,
  HistoricalSupportRecord,
  QaEntry,
  QueryTraceEntry,
  ReviewDecision,
  TriageDecision,
  WorkflowQueueJob,
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowStepRecord,
} from "../types.js";

type SupportRow = {
  id: number | string;
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
  id: number | string;
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
  received_at: string;
  outcome: string;
  triage_json: string | null;
  review_json: string | null;
  reply_text: string | null;
  error_text: string | null;
  total_duration_ms: number | string;
  qwen_model: string;
  gpt_model: string;
  created_at: string;
};

type WorkflowStepRow = {
  id: number | string;
  run_id: number | string;
  step_index: number | string;
  phase: string;
  label: string;
  status: string;
  started_at: string;
  completed_at: string;
  duration_ms: number | string;
  model_label: string | null;
  model_name: string | null;
  model_base_url: string | null;
  input_text: string | null;
  output_text: string | null;
  request_json: string | null;
  response_json: string | null;
  metadata_json: string | null;
};

type WorkflowQueueRow = {
  id: number | string;
  route_id: string;
  event_json: string;
  status: string;
  attempts: number | string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  available_at: string;
  run_id: number | string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type ListWorkflowRunsOptions = {
  page: number;
  pageSize: number;
  routeId?: string;
  outcome?: string;
  threadKey?: string;
  query?: string;
};

type ListWorkflowRunsResult = {
  total: number;
  page: number;
  pageSize: number;
  items: WorkflowRunSummary[];
};

function mapSupportRow(row: SupportRow): HistoricalSupportRecord {
  return {
    id: Number(row.id),
    routeId: String(row.route_id),
    productId: String(row.product_id),
    sourceThreadRef: String(row.source_thread_ref),
    dateStart: String(row.date_start),
    dateEnd: String(row.date_end),
    questionSummary: String(row.question_summary),
    answerSummary: String(row.answer_summary),
    statusFlags: JSON.parse(String(row.status_flags)) as string[],
  };
}

function parseJson<T>(raw: string | null | undefined): T | undefined {
  if (!raw) {
    return undefined;
  }
  return JSON.parse(raw) as T;
}

function buildSafeFtsQuery(query: string): string {
  const tokens = query.match(/[A-Za-z0-9_-]{2,}/g) ?? [];
  const uniqueTokens = [...new Set(tokens.map((token) => token.toLowerCase()))].slice(0, 12);
  return uniqueTokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

function mapWorkflowRunRow(row: WorkflowRunRow): WorkflowRunSummary {
  return {
    id: Number(row.id),
    routeId: row.route_id,
    threadKey: row.thread_key,
    messageId: row.message_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    threadId: row.thread_id ?? undefined,
    authorId: row.author_id,
    authorName: row.author_name,
    sourceUrl: row.source_url,
    messageContent: row.message_content,
    discordCreatedAt: row.discord_created_at,
    receivedAt: row.received_at,
    outcome: row.outcome,
    triage: parseJson<TriageDecision>(row.triage_json),
    review: parseJson<ReviewDecision>(row.review_json),
    replyText: row.reply_text ?? undefined,
    errorText: row.error_text ?? undefined,
    totalDurationMs: Number(row.total_duration_ms),
    qwenModel: row.qwen_model,
    gptModel: row.gpt_model,
    createdAt: row.created_at,
  };
}

function mapWorkflowStepRow(row: WorkflowStepRow): WorkflowStepRecord {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    stepIndex: Number(row.step_index),
    phase: row.phase,
    label: row.label,
    status: row.status === "error" ? "error" : "ok",
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: Number(row.duration_ms),
    modelLabel: row.model_label ?? undefined,
    modelName: row.model_name ?? undefined,
    modelBaseUrl: row.model_base_url ?? undefined,
    inputText: row.input_text ?? undefined,
    outputText: row.output_text ?? undefined,
    requestJson: parseJson<unknown>(row.request_json),
    responseJson: parseJson<unknown>(row.response_json),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json),
  };
}

function mapWorkflowQueueRow(row: WorkflowQueueRow): WorkflowQueueJob {
  return {
    id: Number(row.id),
    routeId: row.route_id,
    event: JSON.parse(row.event_json) as DiscordEventRecord,
    status:
      row.status === "leased" || row.status === "completed" || row.status === "failed"
        ? row.status
        : "queued",
    attempts: Number(row.attempts),
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    availableAt: row.available_at,
    runId: row.run_id === null ? undefined : Number(row.run_id),
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

export class AppDatabase {
  private readonly db: InstanceType<typeof Database>;

  public constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS support_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        source_thread_ref TEXT NOT NULL,
        date_start TEXT NOT NULL,
        date_end TEXT NOT NULL,
        question_summary TEXT NOT NULL,
        answer_summary TEXT NOT NULL,
        status_flags TEXT NOT NULL,
        searchable_text TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS support_records_fts USING fts5(
        question_summary,
        answer_summary,
        searchable_text,
        content='support_records',
        content_rowid='id'
      );

      CREATE TABLE IF NOT EXISTS qa_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        question_text TEXT NOT NULL,
        answer_text TEXT NOT NULL,
        support_refs TEXT NOT NULL,
        repo_refs TEXT NOT NULL,
        review_confidence REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS decision_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        triage_json TEXT NOT NULL,
        review_json TEXT,
        query_trace_json TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS workflow_runs (
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
        outcome TEXT NOT NULL,
        triage_json TEXT,
        review_json TEXT,
        reply_text TEXT,
        error_text TEXT,
        total_duration_ms INTEGER NOT NULL,
        qwen_model TEXT NOT NULL,
        gpt_model TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS workflow_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        step_index INTEGER NOT NULL,
        phase TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        model_label TEXT,
        model_name TEXT,
        model_base_url TEXT,
        input_text TEXT,
        output_text TEXT,
        request_json TEXT,
        response_json TEXT,
        metadata_json TEXT,
        FOREIGN KEY(run_id) REFERENCES workflow_runs(id)
      );

      CREATE TABLE IF NOT EXISTS workflow_queue (
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

      CREATE INDEX IF NOT EXISTS idx_workflow_runs_created_at ON workflow_runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_route_id ON workflow_runs(route_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_thread_key ON workflow_runs(thread_key);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_outcome ON workflow_runs(outcome);
      CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_id_step_index ON workflow_steps(run_id, step_index);
      CREATE INDEX IF NOT EXISTS idx_workflow_queue_status_available ON workflow_queue(status, available_at, id);

      CREATE TABLE IF NOT EXISTS run_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL UNIQUE,
        rating TEXT NOT NULL CHECK(rating IN ('good', 'bad')),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
      );

      CREATE TABLE IF NOT EXISTS draft_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL UNIQUE,
        review_message_id TEXT NOT NULL,
        usage TEXT NOT NULL CHECK(usage IN ('used', 'modified', 'skipped')),
        reacted_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_draft_usage_run_id ON draft_usage(run_id);

      CREATE TABLE IF NOT EXISTS triage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        product TEXT,
        platform TEXT,
        search_requested INTEGER NOT NULL DEFAULT 0,
        preselected_product TEXT,
        trigger_message_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_triage_events_created ON triage_events(created_at);

      CREATE TABLE IF NOT EXISTS user_memory (
        author_id TEXT PRIMARY KEY,
        author_name TEXT NOT NULL,
        interaction_count INTEGER NOT NULL DEFAULT 0,
        products_json TEXT NOT NULL DEFAULT '[]',
        recent_issues_json TEXT NOT NULL DEFAULT '[]',
        resolved_count INTEGER NOT NULL DEFAULT 0,
        unresolved_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_memory_last_seen ON user_memory(last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS chores (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        last_status TEXT,
        last_result TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chore_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chore_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        data_snapshot TEXT,
        duration_ms INTEGER NOT NULL,
        model_used TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(chore_id) REFERENCES chores(id)
      );
      CREATE INDEX IF NOT EXISTS idx_chore_log_chore_created ON chore_log(chore_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS score_rules (
        event_type TEXT PRIMARY KEY,
        points_per INTEGER NOT NULL,
        daily_cap INTEGER NOT NULL DEFAULT 0,
        description TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS score_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        points INTEGER NOT NULL,
        description TEXT,
        ref_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_score_log_created ON score_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_score_log_type_created ON score_log(event_type, created_at);

      -- Default scoring rules
      INSERT OR IGNORE INTO score_rules (event_type, points_per, daily_cap, description) VALUES
        ('approved_reply', 10, 50, 'Bot reply approved by reviewer'),
        ('auto_resolution', 5, 30, 'User confirmed bot reply helped (thanks/fixed)'),
        ('positive_feedback', 8, 20, 'Manual positive feedback on a run'),
        ('chore_completed', 3, 25, 'Scheduled chore completed successfully'),
        ('command_reply', 2, 15, 'Replied to a maintainer in the review channel'),
        ('tool_use', 1, 10, 'Used a tool in command channel'),
        ('kb_mined', 1, 30, 'Knowledge base thread mined'),
        ('guardrail_saved', 2, 20, 'Guardrail prevented a bad reply (saved drafting time)'),
        ('hold_correct', 1, 15, 'Correctly held instead of replying'),
        ('clarify_used', 4, 10, 'Asked user for clarification instead of guessing'),
        ('no_answer_honest', 3, 10, 'Honestly said I dont know instead of fabricating'),
        ('knowledge_gap_found', 2, 10, 'Identified a knowledge gap'),
        ('alert_sent', 3, 5, 'Critical alert sent to a maintainer');
    `);
  }

  public logTranscript(params: {
    routeId: string;
    threadKey: string;
    messageId: string;
    channelId: string;
    threadId?: string;
    authorId: string;
    authorName: string;
    content: string;
    createdAt: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO transcripts (
        route_id, thread_key, message_id, channel_id, thread_id, author_id, author_name, content, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      params.routeId,
      params.threadKey,
      params.messageId,
      params.channelId,
      params.threadId ?? null,
      params.authorId,
      params.authorName,
      params.content,
      params.createdAt,
    );
  }

  public logDecision(params: {
    routeId: string;
    threadKey: string;
    triage: TriageDecision;
    review?: ReviewDecision;
    trace: QueryTraceEntry[];
    outcome: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO decision_log (route_id, thread_key, triage_json, review_json, query_trace_json, outcome)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      params.routeId,
      params.threadKey,
      JSON.stringify(params.triage),
      params.review ? JSON.stringify(params.review) : null,
      JSON.stringify(params.trace),
      params.outcome,
    );
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

    public storeQaEntry(entry: QaEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO qa_entries (route_id, thread_key, question_text, answer_text, support_refs, repo_refs, review_confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.routeId,
      entry.threadKey,
      entry.questionText,
      entry.answerText,
      JSON.stringify(entry.supportRefs),
      JSON.stringify(entry.repoRefs),
      entry.reviewConfidence,
    );
  }

  public upsertHistoricalRecord(record: Omit<HistoricalSupportRecord, "id">): void {
    const searchableText = `${record.questionSummary}\n${record.answerSummary}\n${record.statusFlags.join(" ")}`;
    const insert = this.db.prepare(`
      INSERT INTO support_records (
        route_id, product_id, source_thread_ref, date_start, date_end, question_summary, answer_summary, status_flags, searchable_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = insert.run(
      record.routeId,
      record.productId,
      record.sourceThreadRef,
      record.dateStart,
      record.dateEnd,
      record.questionSummary,
      record.answerSummary,
      JSON.stringify(record.statusFlags),
      searchableText,
    );

    this.db
      .prepare(`
        INSERT INTO support_records_fts (rowid, question_summary, answer_summary, searchable_text)
        VALUES (?, ?, ?, ?)
      `)
      .run(result.lastInsertRowid, record.questionSummary, record.answerSummary, searchableText);
  }

  public findHistoricalSupport(query: string, routeId: string, limit = 10): HistoricalSupportRecord[] {
    const safeFtsQuery = buildSafeFtsQuery(query);
    if (!safeFtsQuery) {
      return [];
    }

    const stmt = this.db.prepare(`
      SELECT id, route_id, product_id, source_thread_ref, date_start, date_end, question_summary, answer_summary, status_flags
      FROM support_records
      WHERE route_id = ?
        AND id IN (
          SELECT rowid
          FROM support_records_fts
          WHERE support_records_fts MATCH ?
          LIMIT ?
        )
      ORDER BY date_end DESC
    `);
    try {
      return (stmt.all(routeId, safeFtsQuery, limit) as SupportRow[]).map(mapSupportRow);
    } catch {
      const fallback = this.db.prepare(`
        SELECT id, route_id, product_id, source_thread_ref, date_start, date_end, question_summary, answer_summary, status_flags
        FROM support_records
        WHERE route_id = ?
          AND searchable_text LIKE ?
        ORDER BY date_end DESC
        LIMIT ?
      `);
      return (fallback.all(routeId, `%${query}%`, limit) as SupportRow[]).map(mapSupportRow);
    }
  }

  public getHistoricalSupportById(id: number, routeId: string): HistoricalSupportRecord | undefined {
    const stmt = this.db.prepare(`
      SELECT id, route_id, product_id, source_thread_ref, date_start, date_end, question_summary, answer_summary, status_flags
      FROM support_records
      WHERE id = ? AND route_id = ?
      LIMIT 1
    `);

    const row = stmt.get(id, routeId) as SupportRow | undefined;
    return row ? mapSupportRow(row) : undefined;
  }

  public storeWorkflowRun(params: {
    routeId: string;
    threadKey: string;
    event: DiscordEventRecord;
    receivedAt: string;
    outcome: string;
    triage?: TriageDecision;
    review?: ReviewDecision;
    replyText?: string;
    errorText?: string;
    totalDurationMs: number;
    qwenModel: string;
    gptModel: string;
    steps: WorkflowStepRecord[];
  }): number {
    const insertRun = this.db.prepare(`
      INSERT INTO workflow_runs (
        route_id, thread_key, message_id, guild_id, channel_id, thread_id, author_id, author_name,
        source_url, message_content, discord_created_at, received_at, outcome, triage_json, review_json,
        reply_text, error_text, total_duration_ms, qwen_model, gpt_model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertStep = this.db.prepare(`
      INSERT INTO workflow_steps (
        run_id, step_index, phase, label, status, started_at, completed_at, duration_ms,
        model_label, model_name, model_base_url, input_text, output_text, request_json, response_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      const runResult = insertRun.run(
        params.routeId,
        params.threadKey,
        params.event.messageId,
        params.event.guildId,
        params.event.channelId,
        params.event.threadId ?? null,
        params.event.authorId,
        params.event.authorName,
        params.event.sourceUrl ?? this.buildSourceUrl(params.event),
        params.event.content,
        params.event.createdAt,
        params.receivedAt,
        params.outcome,
        params.triage ? JSON.stringify(params.triage) : null,
        params.review ? JSON.stringify(params.review) : null,
        params.replyText ?? null,
        params.errorText ?? null,
        params.totalDurationMs,
        params.qwenModel,
        params.gptModel,
      );

      const runId = Number(runResult.lastInsertRowid);
      for (const step of params.steps) {
        insertStep.run(
          runId,
          step.stepIndex,
          step.phase,
          step.label,
          step.status,
          step.startedAt,
          step.completedAt,
          step.durationMs,
          step.modelLabel ?? null,
          step.modelName ?? null,
          step.modelBaseUrl ?? null,
          step.inputText ?? null,
          step.outputText ?? null,
          step.requestJson === undefined ? null : JSON.stringify(step.requestJson),
          step.responseJson === undefined ? null : JSON.stringify(step.responseJson),
          step.metadata === undefined ? null : JSON.stringify(step.metadata),
        );
      }
      return runId;
    });

    return transaction() as number;
  }

  public enqueueWorkflowJob(routeId: string, event: DiscordEventRecord): { jobId?: number; inserted: boolean } {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO workflow_queue (
          route_id, message_id, event_json, status, attempts, available_at, last_error, updated_at
        ) VALUES (?, ?, ?, 'queued', 0, ?, NULL, ?)
      `)
      .run(routeId, event.messageId, JSON.stringify(event), now, now);

    if (result.changes > 0) {
      return {
        jobId: Number(result.lastInsertRowid),
        inserted: true,
      };
    }

    const existing = this.db
      .prepare(`SELECT id, status FROM workflow_queue WHERE message_id = ? LIMIT 1`)
      .get(event.messageId) as { id: number | string; status: string } | undefined;

    // If user clicked "Ask the Bot" but the job was already queued/completed by passive detection,
    // re-queue it with the userRequestedBotHelp flag so it actually responds.
    if (existing && event.userRequestedBotHelp && event.botHelpRequestSource !== "mention" && event.botHelpRequestSource !== "reply" && event.botHelpRequestSource !== "ask-button") {
      if (existing.status === "completed" || existing.status === "queued") {
        this.db.prepare(`
          UPDATE workflow_queue SET event_json = ?, status = 'queued', attempts = 0, available_at = ?, updated_at = ?, run_id = NULL, last_error = NULL
          WHERE id = ?
        `).run(JSON.stringify(event), now, now, existing.id);
        return { jobId: Number(existing.id), inserted: true };
      }
    }

    return {
      jobId: existing ? Number(existing.id) : undefined,
      inserted: false,
    };
  }

  public claimNextWorkflowJob(workerId: string, leaseDurationMs: number): WorkflowQueueJob | undefined {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare(`
          SELECT id, route_id, event_json, status, attempts, lease_owner, lease_expires_at, available_at, run_id, last_error, created_at, updated_at, completed_at
          FROM workflow_queue AS candidate
          WHERE status = 'queued'
            AND available_at <= ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            AND NOT EXISTS (
              SELECT 1
              FROM workflow_queue AS blocker
              WHERE blocker.route_id = candidate.route_id
                AND blocker.status IN ('queued', 'leased')
                AND COALESCE(json_extract(blocker.event_json, '$.threadId'), json_extract(blocker.event_json, '$.channelId')) =
                    COALESCE(json_extract(candidate.event_json, '$.threadId'), json_extract(candidate.event_json, '$.channelId'))
                AND (
                  json_extract(blocker.event_json, '$.createdAt') < json_extract(candidate.event_json, '$.createdAt')
                  OR (
                    json_extract(blocker.event_json, '$.createdAt') = json_extract(candidate.event_json, '$.createdAt')
                    AND blocker.id < candidate.id
                  )
                )
            )
          ORDER BY json_extract(event_json, '$.createdAt') ASC, id ASC
          LIMIT 1
        `)
        .get(nowIso, nowIso) as WorkflowQueueRow | undefined;

      if (!row) {
        return undefined;
      }

      this.db
        .prepare(`
          UPDATE workflow_queue
          SET status = 'leased',
              attempts = attempts + 1,
              lease_owner = ?,
              lease_expires_at = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(workerId, leaseExpiresAt, nowIso, row.id);

      const claimed = this.db
        .prepare(`
          SELECT id, route_id, event_json, status, attempts, lease_owner, lease_expires_at, available_at, run_id, last_error, created_at, updated_at, completed_at
          FROM workflow_queue
          WHERE id = ?
          LIMIT 1
        `)
        .get(row.id) as WorkflowQueueRow;
      return mapWorkflowQueueRow(claimed);
    });

    return transaction() as WorkflowQueueJob | undefined;
  }

  public renewWorkflowJobLease(jobId: number, workerId: string, leaseDurationMs: number): boolean {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    const result = this.db
      .prepare(`
        UPDATE workflow_queue
        SET lease_expires_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status = 'leased'
          AND lease_owner = ?
      `)
      .run(leaseExpiresAt, nowIso, jobId, workerId);
    return result.changes > 0;
  }

  public completeWorkflowJob(jobId: number, runId?: number): void {
    const nowIso = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE workflow_queue
        SET status = 'completed',
            run_id = COALESCE(?, run_id),
            last_error = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(runId ?? null, nowIso, nowIso, jobId);
  }

  public requeueWorkflowJob(jobId: number, errorText: string, retryDelayMs: number): void {
    const now = new Date();
    const nextAttemptAt = new Date(now.getTime() + retryDelayMs).toISOString();
    const nowIso = now.toISOString();
    this.db
      .prepare(`
        UPDATE workflow_queue
        SET status = 'queued',
            last_error = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            available_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(errorText, nextAttemptAt, nowIso, jobId);
  }

  public failWorkflowJob(jobId: number, errorText: string, runId?: number): void {
    const nowIso = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE workflow_queue
        SET status = 'failed',
            last_error = ?,
            run_id = COALESCE(?, run_id),
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE id = ?
      `)
      .run(errorText, runId ?? null, nowIso, jobId);
  }

  /** Reset leased jobs whose lease has expired back to queued so the worker can re-process them. */
  public reclaimExpiredLeases(): number {
    const nowIso = new Date().toISOString();
    const result = this.db
      .prepare(`
        UPDATE workflow_queue
        SET status = 'queued',
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE status = 'leased'
          AND lease_expires_at < ?
      `)
      .run(nowIso, nowIso);
    return result.changes;
  }

  public getWorkflowJob(jobId: number): WorkflowQueueJob | undefined {
    const row = this.db
      .prepare(`
        SELECT id, route_id, event_json, status, attempts, lease_owner, lease_expires_at, available_at, run_id, last_error, created_at, updated_at, completed_at
        FROM workflow_queue
        WHERE id = ?
        LIMIT 1
      `)
      .get(jobId) as WorkflowQueueRow | undefined;

    return row ? mapWorkflowQueueRow(row) : undefined;
  }

  public listWorkflowQueue(limit = 200): WorkflowQueueJob[] {
    const rows = this.db
      .prepare(`
        SELECT id, route_id, event_json, status, attempts, lease_owner, lease_expires_at, available_at, run_id, last_error, created_at, updated_at, completed_at
        FROM workflow_queue
        ORDER BY id ASC
        LIMIT ?
      `)
      .all(limit) as WorkflowQueueRow[];
    return rows.map(mapWorkflowQueueRow);
  }

  public getWorkflowRunIdByMessageId(messageId: string): number | undefined {
    const row = this.db
      .prepare(`SELECT id FROM workflow_runs WHERE message_id = ? LIMIT 1`)
      .get(messageId) as { id: number | string } | undefined;
    return row ? Number(row.id) : undefined;
  }

  public appendWorkflowStep(runId: number, step: Omit<WorkflowStepRecord, "runId" | "id" | "stepIndex"> & { stepIndex?: number }): void {
    const currentMax = this.db
      .prepare(`SELECT COALESCE(MAX(step_index), -1) AS max_step FROM workflow_steps WHERE run_id = ?`)
      .get(runId) as { max_step: number };
    const nextIndex = step.stepIndex ?? Number(currentMax.max_step) + 1;
    this.db
      .prepare(`
        INSERT INTO workflow_steps (
          run_id, step_index, phase, label, status, started_at, completed_at, duration_ms,
          model_label, model_name, model_base_url, input_text, output_text, request_json, response_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        runId,
        nextIndex,
        step.phase,
        step.label,
        step.status,
        step.startedAt,
        step.completedAt,
        step.durationMs,
        step.modelLabel ?? null,
        step.modelName ?? null,
        step.modelBaseUrl ?? null,
        step.inputText ?? null,
        step.outputText ?? null,
        step.requestJson === undefined ? null : JSON.stringify(step.requestJson),
        step.responseJson === undefined ? null : JSON.stringify(step.responseJson),
        step.metadata === undefined ? null : JSON.stringify(step.metadata),
      );
  }

  public listWorkflowRouteIds(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT route_id FROM workflow_runs ORDER BY route_id ASC`)
      .all() as Array<{ route_id: string }>;
    return rows.map((row) => row.route_id);
  }

  public listWorkflowRuns(options: ListWorkflowRunsOptions): ListWorkflowRunsResult {
    const page = Math.max(1, options.page);
    const pageSize = Math.max(1, Math.min(100, options.pageSize));
    const offset = (page - 1) * pageSize;
    const { whereSql, values } = this.buildWorkflowFilters(options);

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM workflow_runs ${whereSql}`)
      .get(...values) as { count: number | string };

    const rows = this.db
      .prepare(`
        SELECT id, route_id, thread_key, message_id, guild_id, channel_id, thread_id, author_id, author_name,
               source_url, message_content, discord_created_at, received_at, outcome, triage_json, review_json,
               reply_text, error_text, total_duration_ms, qwen_model, gpt_model, created_at
        FROM workflow_runs
        ${whereSql}
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `)
      .all(...values, pageSize, offset) as WorkflowRunRow[];

    return {
      total: Number(totalRow.count),
      page,
      pageSize,
      items: rows.map(mapWorkflowRunRow),
    };
  }

  public getWorkflowRun(id: number): WorkflowRunDetail | undefined {
    const row = this.db
      .prepare(`
        SELECT id, route_id, thread_key, message_id, guild_id, channel_id, thread_id, author_id, author_name,
               source_url, message_content, discord_created_at, received_at, outcome, triage_json, review_json,
               reply_text, error_text, total_duration_ms, qwen_model, gpt_model, created_at
        FROM workflow_runs
        WHERE id = ?
        LIMIT 1
      `)
      .get(id) as WorkflowRunRow | undefined;

    if (!row) {
      return undefined;
    }

    const steps = this.db
      .prepare(`
        SELECT id, run_id, step_index, phase, label, status, started_at, completed_at, duration_ms,
               model_label, model_name, model_base_url, input_text, output_text, request_json, response_json, metadata_json
        FROM workflow_steps
        WHERE run_id = ?
        ORDER BY step_index ASC, id ASC
      `)
      .all(id) as WorkflowStepRow[];

    return {
      ...mapWorkflowRunRow(row),
      steps: steps.map(mapWorkflowStepRow),
    };
  }

  public listWorkflowRunsForThread(threadKey: string, limit = 200): WorkflowRunSummary[] {
    const rows = this.db
      .prepare(`
        SELECT id, route_id, thread_key, message_id, guild_id, channel_id, thread_id, author_id, author_name,
               source_url, message_content, discord_created_at, received_at, outcome, triage_json, review_json,
               reply_text, error_text, total_duration_ms, qwen_model, gpt_model, created_at
        FROM workflow_runs
        WHERE thread_key = ?
        ORDER BY id ASC
        LIMIT ?
      `)
      .all(threadKey, limit) as WorkflowRunRow[];

    return rows.map(mapWorkflowRunRow);
  }

  private buildWorkflowFilters(options: Omit<ListWorkflowRunsOptions, "page" | "pageSize">): {
    whereSql: string;
    values: unknown[];
  } {
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (options.routeId) {
      clauses.push("route_id = ?");
      values.push(options.routeId);
    }
    if (options.outcome) {
      clauses.push("outcome = ?");
      values.push(options.outcome);
    }
    if (options.threadKey) {
      clauses.push("thread_key = ?");
      values.push(options.threadKey);
    }
    if (options.query) {
      clauses.push("(message_content LIKE ? OR reply_text LIKE ? OR error_text LIKE ?)");
      const likeValue = `%${options.query}%`;
      values.push(likeValue, likeValue, likeValue);
    }

    return {
      whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
      values,
    };
  }

  public setRunFeedback(runId: number, rating: "good" | "bad", note?: string): void {
    this.db
      .prepare(
        `INSERT INTO run_feedback (run_id, rating, note) VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET rating = excluded.rating, note = excluded.note, created_at = CURRENT_TIMESTAMP`,
      )
      .run(runId, rating, note ?? null);
  }

  public getRunFeedback(runId: number): { rating: string; note?: string; createdAt: string } | undefined {
    const row = this.db
      .prepare("SELECT rating, note, created_at FROM run_feedback WHERE run_id = ?")
      .get(runId) as { rating: string; note: string | null; created_at: string } | undefined;
    return row ? { rating: row.rating, note: row.note ?? undefined, createdAt: row.created_at } : undefined;
  }

  public listFeedback(limit = 50): Array<{ runId: number; rating: string; note?: string; createdAt: string }> {
    const rows = this.db
      .prepare("SELECT run_id, rating, note, created_at FROM run_feedback ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{ run_id: number; rating: string; note: string | null; created_at: string }>;
    return rows.map((r) => ({ runId: r.run_id, rating: r.rating, note: r.note ?? undefined, createdAt: r.created_at }));
  }

  public storeDraftUsage(runId: number, reviewMessageId: string, usage: DraftUsage, reactedBy: string): void {
    this.db
      .prepare(
        `INSERT INTO draft_usage (run_id, review_message_id, usage, reacted_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET usage = excluded.usage, reacted_by = excluded.reacted_by, created_at = CURRENT_TIMESTAMP`,
      )
      .run(runId, reviewMessageId, usage, reactedBy);
  }

  public getDraftUsage(runId: number): DraftUsageRecord | undefined {
    const row = this.db
      .prepare("SELECT run_id, review_message_id, usage, reacted_by, created_at FROM draft_usage WHERE run_id = ?")
      .get(runId) as { run_id: number; review_message_id: string; usage: string; reacted_by: string; created_at: string } | undefined;
    return row
      ? { runId: Number(row.run_id), reviewMessageId: row.review_message_id, usage: row.usage as DraftUsage, reactedBy: row.reacted_by, createdAt: row.created_at }
      : undefined;
  }

  public getDraftUsageStats(): Array<{ routeId: string; usage: string; count: number }> {
    const rows = this.db
      .prepare(`
        SELECT w.route_id, d.usage, COUNT(*) as cnt
        FROM draft_usage d
        JOIN workflow_runs w ON w.id = d.run_id
        GROUP BY w.route_id, d.usage
        ORDER BY w.route_id, d.usage
      `)
      .all() as Array<{ route_id: string; usage: string; cnt: number | string }>;
    return rows.map((r) => ({ routeId: r.route_id, usage: r.usage, count: Number(r.cnt) }));
  }

  public recordTriageEvent(params: {
    channelId: string;
    userId: string;
    product?: string;
    platform?: string;
    searchRequested: boolean;
    preselectedProduct?: string;
    triggerMessageId?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO triage_events (channel_id, user_id, product, platform, search_requested, preselected_product, trigger_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.channelId,
      params.userId,
      params.product ?? null,
      params.platform ?? null,
      params.searchRequested ? 1 : 0,
      params.preselectedProduct ?? null,
      params.triggerMessageId ?? null,
    );
  }

  /** Check if a channel had "Ask the Bot" triggered within the last N hours. */
  public channelHadBotHelpRequested(channelId: string, withinHours = 24): boolean {
    const cutoff = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString();
    const row = this.db.prepare(
      "SELECT 1 FROM triage_events WHERE channel_id = ? AND search_requested = 1 AND created_at >= ? LIMIT 1"
    ).get(channelId, cutoff);
    return !!row;
  }

  public getTriageStats(): { total: number; searched: number; waited: number; byProduct: Record<string, number>; byPlatform: Record<string, number> } {
    const total = (this.db.prepare("SELECT COUNT(*) as cnt FROM triage_events").get() as { cnt: number }).cnt;
    const searched = (this.db.prepare("SELECT COUNT(*) as cnt FROM triage_events WHERE search_requested = 1").get() as { cnt: number }).cnt;

    const productRows = this.db.prepare("SELECT product, COUNT(*) as cnt FROM triage_events WHERE product IS NOT NULL GROUP BY product ORDER BY cnt DESC").all() as { product: string; cnt: number }[];
    const byProduct: Record<string, number> = {};
    for (const r of productRows) byProduct[r.product] = r.cnt;

    const platformRows = this.db.prepare("SELECT platform, COUNT(*) as cnt FROM triage_events WHERE platform IS NOT NULL GROUP BY platform ORDER BY cnt DESC").all() as { platform: string; cnt: number }[];
    const byPlatform: Record<string, number> = {};
    for (const r of platformRows) byPlatform[r.platform] = r.cnt;

    return { total, searched, waited: total - searched, byProduct, byPlatform };
  }

  public getDraftConversionRate(): { total: number; used: number; modified: number; skipped: number; unreviewed: number } {
    const approved = this.db
      .prepare("SELECT COUNT(*) as cnt FROM workflow_runs WHERE outcome = 'approved'")
      .get() as { cnt: number | string };
    const usageRows = this.db
      .prepare("SELECT usage, COUNT(*) as cnt FROM draft_usage GROUP BY usage")
      .all() as Array<{ usage: string; cnt: number | string }>;

    const total = Number(approved.cnt);
    let used = 0;
    let modified = 0;
    let skipped = 0;
    for (const row of usageRows) {
      const count = Number(row.cnt);
      if (row.usage === "used") used = count;
      else if (row.usage === "modified") modified = count;
      else if (row.usage === "skipped") skipped = count;
    }
    return { total, used, modified, skipped, unreviewed: total - used - modified - skipped };
  }


  // ──── Analytics queries ────

  public getOutcomeDistribution(): Array<{ outcome: string; count: number }> {
    const rows = this.db
      .prepare("SELECT outcome, COUNT(*) as cnt FROM workflow_runs GROUP BY outcome ORDER BY cnt DESC")
      .all() as Array<{ outcome: string; cnt: number | string }>;
    return rows.map((r) => ({ outcome: r.outcome, count: Number(r.cnt) }));
  }

  public getOutcomeByRoute(): Array<{ routeId: string; outcome: string; count: number }> {
    const rows = this.db
      .prepare("SELECT route_id, outcome, COUNT(*) as cnt FROM workflow_runs GROUP BY route_id, outcome ORDER BY route_id, cnt DESC")
      .all() as Array<{ route_id: string; outcome: string; cnt: number | string }>;
    return rows.map((r) => ({ routeId: r.route_id, outcome: r.outcome, count: Number(r.cnt) }));
  }

  public getQueueHealth(): { queued: number; leased: number; completed: number; failed: number } {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) as cnt FROM workflow_queue GROUP BY status")
      .all() as Array<{ status: string; cnt: number | string }>;
    const result = { queued: 0, leased: 0, completed: 0, failed: 0 };
    for (const row of rows) {
      if (row.status === "queued" || row.status === "pending") result.queued += Number(row.cnt);
      else if (row.status === "leased") result.leased = Number(row.cnt);
      else if (row.status === "completed") result.completed = Number(row.cnt);
      else if (row.status === "failed") result.failed = Number(row.cnt);
    }
    return result;
  }

  public getRecentActivity(days: number = 7): Array<{ date: string; count: number }> {
    const rows = this.db
      .prepare(`
        SELECT DATE(created_at) as day, COUNT(*) as cnt
        FROM workflow_runs
        WHERE created_at >= DATE('now', '-' || ? || ' days')
        GROUP BY day
        ORDER BY day ASC
      `)
      .all(days) as Array<{ day: string; cnt: number | string }>;
    return rows.map((r) => ({ date: r.day, count: Number(r.cnt) }));
  }

  public getAvgDurations(): Array<{ outcome: string; avgMs: number; count: number }> {
    const rows = this.db
      .prepare(`
        SELECT outcome, ROUND(AVG(total_duration_ms)) as avg_ms, COUNT(*) as cnt
        FROM workflow_runs
        WHERE total_duration_ms > 0
        GROUP BY outcome
        ORDER BY avg_ms DESC
      `)
      .all() as Array<{ outcome: string; avg_ms: number | string; cnt: number | string }>;
    return rows.map((r) => ({ outcome: r.outcome, avgMs: Number(r.avg_ms), count: Number(r.cnt) }));
  }


  public getGuardrailStats(): Array<{ label: string; count: number }> {
    return this.db
      .prepare(
        `SELECT label, COUNT(*) as count FROM workflow_steps
         WHERE label LIKE '%fast-path%' OR label LIKE '%guardrail%' OR label LIKE '%Grounding validation%'
         GROUP BY label ORDER BY count DESC`,
      )
      .all() as Array<{ label: string; count: number }>;
  }

  public getFeedbackSummary(): { good: number; bad: number } {
    const rows = this.db
      .prepare("SELECT rating, COUNT(*) as cnt FROM run_feedback GROUP BY rating")
      .all() as Array<{ rating: string; cnt: number | string }>;
    const result = { good: 0, bad: 0 };
    for (const row of rows) {
      if (row.rating === "good") result.good = Number(row.cnt);
      else if (row.rating === "bad") result.bad = Number(row.cnt);
    }
    return result;
  }

  // ── Scoring ──

  public recordPoints(eventType: string, description?: string, refId?: string): number {
    // Look up the rule
    const rule = this.db.prepare("SELECT points_per, daily_cap FROM score_rules WHERE event_type = ?").get(eventType) as {
      points_per: number; daily_cap: number;
    } | undefined;
    if (!rule) return 0;

    // Check daily cap
    if (rule.daily_cap > 0) {
      const todayPoints = this.db.prepare(
        "SELECT COALESCE(SUM(points), 0) as total FROM score_log WHERE event_type = ? AND created_at >= datetime('now', 'start of day')"
      ).get(eventType) as { total: number };
      if (todayPoints.total >= rule.daily_cap) return 0; // Cap reached
    }

    // Record the points
    this.db.prepare(
      "INSERT INTO score_log (event_type, points, description, ref_id) VALUES (?, ?, ?, ?)"
    ).run(eventType, rule.points_per, description?.slice(0, 200) ?? null, refId ?? null);

    return rule.points_per;
  }

  public getScoreSummary(): { today: number; week: number; total: number; streak: number } {
    const today = (this.db.prepare(
      "SELECT COALESCE(SUM(points), 0) as s FROM score_log WHERE created_at >= datetime('now', 'start of day')"
    ).get() as { s: number }).s;

    const week = (this.db.prepare(
      "SELECT COALESCE(SUM(points), 0) as s FROM score_log WHERE created_at >= datetime('now', '-7 days')"
    ).get() as { s: number }).s;

    const total = (this.db.prepare(
      "SELECT COALESCE(SUM(points), 0) as s FROM score_log"
    ).get() as { s: number }).s;

    // Streak: consecutive days with > 0 points
    const days = this.db.prepare(
      "SELECT DISTINCT date(created_at) as d FROM score_log ORDER BY d DESC LIMIT 30"
    ).all() as Array<{ d: string }>;
    let streak = 0;
    const todayStr = new Date().toISOString().slice(0, 10);
    let checkDate = todayStr;
    for (const day of days) {
      if (day.d === checkDate) {
        streak++;
        const d = new Date(checkDate);
        d.setDate(d.getDate() - 1);
        checkDate = d.toISOString().slice(0, 10);
      } else {
        break;
      }
    }

    return { today, week, total, streak };
  }

  public getScoreBreakdown(): Array<{ eventType: string; points: number; count: number; dailyCap: number }> {
    const rows = this.db.prepare(`
      SELECT sl.event_type, SUM(sl.points) as points, COUNT(*) as count, sr.daily_cap
      FROM score_log sl
      JOIN score_rules sr ON sr.event_type = sl.event_type
      WHERE sl.created_at >= datetime('now', 'start of day')
      GROUP BY sl.event_type
      ORDER BY points DESC
    `).all() as Array<{ event_type: string; points: number; count: number; daily_cap: number }>;
    return rows.map(r => ({ eventType: r.event_type, points: r.points, count: r.count, dailyCap: r.daily_cap }));
  }

  public getScoreRules(): Array<{ eventType: string; pointsPer: number; dailyCap: number; description: string }> {
    return (this.db.prepare("SELECT * FROM score_rules ORDER BY points_per DESC").all() as Array<{
      event_type: string; points_per: number; daily_cap: number; description: string;
    }>).map(r => ({ eventType: r.event_type, pointsPer: r.points_per, dailyCap: r.daily_cap, description: r.description }));
  }

  public getRecentScoreLog(limit = 20): Array<{ id: number; eventType: string; points: number; description: string | null; createdAt: string }> {
    return (this.db.prepare(
      "SELECT id, event_type, points, description, created_at FROM score_log ORDER BY created_at DESC LIMIT ?"
    ).all(limit) as Array<{ id: number; event_type: string; points: number; description: string | null; created_at: string }>)
    .map(r => ({ id: r.id, eventType: r.event_type, points: r.points, description: r.description, createdAt: r.created_at }));
  }

  // ── Chores ──

  public getChore(choreId: string): { id: string; skillId: string; name: string; schedule: string; enabled: boolean; lastRunAt: string | null; lastStatus: string | null; lastResult: string | null; runCount: number; createdAt: string } | null {
    const row = this.db.prepare("SELECT * FROM chores WHERE id = ?").get(choreId) as {
      id: string; skill_id: string; name: string; schedule: string; enabled: number;
      last_run_at: string | null; last_status: string | null; last_result: string | null; run_count: number; created_at: string;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id, skillId: row.skill_id, name: row.name, schedule: row.schedule,
      enabled: row.enabled === 1, lastRunAt: row.last_run_at, lastStatus: row.last_status,
      lastResult: row.last_result, runCount: row.run_count, createdAt: row.created_at,
    };
  }

  public listChores(): Array<{ id: string; skillId: string; name: string; schedule: string; enabled: boolean; lastRunAt: string | null; lastStatus: string | null; runCount: number; createdAt: string }> {
    const rows = this.db.prepare("SELECT id, skill_id, name, schedule, enabled, last_run_at, last_status, run_count, created_at FROM chores ORDER BY id").all() as Array<{
      id: string; skill_id: string; name: string; schedule: string; enabled: number;
      last_run_at: string | null; last_status: string | null; run_count: number; created_at: string;
    }>;
    return rows.map(r => ({
      id: r.id, skillId: r.skill_id, name: r.name, schedule: r.schedule,
      enabled: r.enabled === 1, lastRunAt: r.last_run_at, lastStatus: r.last_status, runCount: r.run_count, createdAt: r.created_at,
    }));
  }

  public upsertChore(params: { id: string; skillId: string; name: string; schedule: string; enabled?: boolean }): void {
    this.db.prepare(`
      INSERT INTO chores (id, skill_id, name, schedule, enabled)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET skill_id = excluded.skill_id, name = excluded.name, schedule = excluded.schedule, enabled = excluded.enabled
    `).run(params.id, params.skillId, params.name, params.schedule, params.enabled !== false ? 1 : 0);
  }

  public setChoreEnabled(choreId: string, enabled: boolean): void {
    this.db.prepare("UPDATE chores SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, choreId);
  }

  public updateChoreSchedule(choreId: string, schedule: string): void {
    this.db.prepare("UPDATE chores SET schedule = ? WHERE id = ?").run(schedule, choreId);
  }

  public recordChoreRun(params: { choreId: string; skillId: string; status: string; result: string; dataSnapshot?: string; durationMs: number; modelUsed?: string }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO chore_log (chore_id, skill_id, status, result, data_snapshot, duration_ms, model_used)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(params.choreId, params.skillId, params.status, params.result, params.dataSnapshot ?? null, params.durationMs, params.modelUsed ?? null);
    this.db.prepare(`
      UPDATE chores SET last_run_at = ?, last_status = ?, last_result = ?, run_count = run_count + 1 WHERE id = ?
    `).run(now, params.status, params.result.slice(0, 2000), params.choreId);
  }

  public getRecentChoreLogs(choreId: string, limit = 5): Array<{ id: number; choreId: string; skillId: string; status: string; result: string; durationMs: number; createdAt: string }> {
    const rows = this.db.prepare(`
      SELECT id, chore_id, skill_id, status, result, duration_ms, created_at
      FROM chore_log WHERE chore_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(choreId, limit) as Array<{
      id: number; chore_id: string; skill_id: string; status: string; result: string; duration_ms: number; created_at: string;
    }>;
    return rows.map(r => ({
      id: r.id, choreId: r.chore_id, skillId: r.skill_id, status: r.status,
      result: r.result, durationMs: r.duration_ms, createdAt: r.created_at,
    }));
  }

  // ── User Memory ──

  public getUserMemory(authorId: string): {
    authorId: string;
    authorName: string;
    interactionCount: number;
    products: string[];
    recentIssues: Array<{ date: string; route: string; category: string; summary: string; resolved: boolean }>;
    resolvedCount: number;
    unresolvedCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
  } | null {
    const row = this.db
      .prepare("SELECT * FROM user_memory WHERE author_id = ?")
      .get(authorId) as {
        author_id: string;
        author_name: string;
        interaction_count: number;
        products_json: string;
        recent_issues_json: string;
        resolved_count: number;
        unresolved_count: number;
        first_seen_at: string;
        last_seen_at: string;
      } | undefined;
    if (!row) return null;
    return {
      authorId: row.author_id,
      authorName: row.author_name,
      interactionCount: row.interaction_count,
      products: JSON.parse(row.products_json),
      recentIssues: JSON.parse(row.recent_issues_json),
      resolvedCount: row.resolved_count,
      unresolvedCount: row.unresolved_count,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  public updateUserMemory(params: {
    authorId: string;
    authorName: string;
    routeId: string;
    category: string;
    rationale: string;
    resolved: boolean;
  }): void {
    const now = new Date().toISOString();
    const existing = this.getUserMemory(params.authorId);
    const MAX_RECENT_ISSUES = 5;
    const product = params.routeId.replace(/-support$/, "").replace(/-bug-report$/, "").replace(/-channel$/, "");

    const newIssue = {
      date: now.slice(0, 10),
      route: params.routeId,
      category: params.category,
      summary: params.rationale.slice(0, 200),
      resolved: params.resolved,
    };

    if (existing) {
      const products = new Set(existing.products);
      products.add(product);
      const recentIssues = [newIssue, ...existing.recentIssues].slice(0, MAX_RECENT_ISSUES);

      this.db.prepare(`
        UPDATE user_memory SET
          author_name = ?,
          interaction_count = interaction_count + 1,
          products_json = ?,
          recent_issues_json = ?,
          resolved_count = resolved_count + ?,
          unresolved_count = unresolved_count + ?,
          last_seen_at = ?,
          updated_at = ?
        WHERE author_id = ?
      `).run(
        params.authorName,
        JSON.stringify([...products]),
        JSON.stringify(recentIssues),
        params.resolved ? 1 : 0,
        params.resolved ? 0 : 1,
        now,
        now,
        params.authorId,
      );
    } else {
      this.db.prepare(`
        INSERT INTO user_memory (
          author_id, author_name, interaction_count, products_json,
          recent_issues_json, resolved_count, unresolved_count,
          first_seen_at, last_seen_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.authorId,
        params.authorName,
        JSON.stringify([product]),
        JSON.stringify([newIssue]),
        params.resolved ? 1 : 0,
        params.resolved ? 0 : 1,
        now, now, now,
      );
    }
  }

  public formatUserMemoryContext(authorId: string): string {
    const mem = this.getUserMemory(authorId);
    if (!mem || mem.interactionCount === 0) return "";

    const lines = [
      `User context for ${mem.authorName} (${mem.authorId}):`,
      `- Interactions: ${mem.interactionCount} (first: ${mem.firstSeenAt.slice(0, 10)}, last: ${mem.lastSeenAt.slice(0, 10)})`,
      `- Products: ${mem.products.join(", ") || "unknown"}`,
      `- Resolved: ${mem.resolvedCount} of ${mem.interactionCount}`,
    ];

    if (mem.recentIssues.length > 0) {
      lines.push("- Recent issues:");
      for (const issue of mem.recentIssues) {
        const status = issue.resolved ? "resolved" : "open";
        lines.push(`  [${issue.date}] ${issue.route} / ${issue.category}: "${issue.summary}" (${status})`);
      }
    }

    return lines.join("\n");
  }

  public getLastApprovedReply(threadKey: string): { replyText: string; createdAt: string } | null {
    const row = this.db.prepare(`
      SELECT reply_text, created_at FROM workflow_runs
      WHERE thread_key = ? AND outcome = 'approved' AND reply_text IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(threadKey) as { reply_text: string; created_at: string } | undefined;
    if (!row) return null;
    return { replyText: row.reply_text, createdAt: row.created_at };
  }

    public findPriorApprovedRun(threadKey: string, beforeMessageId: string): number | null {
    const row = this.db.prepare(`
      SELECT id FROM workflow_runs
      WHERE thread_key = ? AND outcome = 'approved' AND message_id != ?
      ORDER BY created_at DESC LIMIT 1
    `).get(threadKey, beforeMessageId) as { id: number } | undefined;
    return row?.id ?? null;
  }

    private buildSourceUrl(event: DiscordEventRecord): string {
    return `https://discord.com/channels/${event.guildId}/${event.threadId ?? event.channelId}/${event.messageId}`;
  }
}
