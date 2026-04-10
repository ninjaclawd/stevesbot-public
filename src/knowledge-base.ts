/**
 * Knowledge Base — searchable mined thread summaries.
 *
 * Loads Qwen-processed thread summaries from JSONL into a SQLite FTS5 table
 * for fast keyword + relevance search. Used by the drafter to find condensed
 * solutions to similar past problems.
 *
 * Usage:
 *   tsx src/knowledge-base.ts load                # load/reload from JSONL
 *   tsx src/knowledge-base.ts search <query>      # test search
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

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

type MinedThreadRecord = {
  threadId: string;
  threadName: string;
  channelName: string;
  sourceUrl: string;
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
  participantCount: number;
  participants: string[];
  summary: string;
  problemStatement: string;
  solution: string;
  resolved: boolean;
  keywords: string[];
  products: string[];
  platforms: string[];
  errorSignals: string[];
  category: string;
};

export type KnowledgeSearchResult = {
  threadId: string;
  threadName: string;
  channelName: string;
  sourceUrl: string;
  createdAt: string;
  summary: string;
  problemStatement: string;
  solution: string;
  resolved: boolean;
  keywords: string[];
  products: string[];
  category: string;
  relevanceScore: number;
};

export function initKnowledgeDb(dbPath: string): InstanceType<typeof Database> {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS mined_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT UNIQUE NOT NULL,
      thread_name TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_message_at TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      participant_count INTEGER NOT NULL,
      participants_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      problem_statement TEXT NOT NULL,
      solution TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      keywords_json TEXT NOT NULL,
      products_json TEXT NOT NULL,
      platforms_json TEXT NOT NULL,
      error_signals_json TEXT NOT NULL,
      category TEXT NOT NULL,
      searchable_text TEXT NOT NULL,
      indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS mined_threads_fts USING fts5(
      summary,
      problem_statement,
      solution,
      keywords_text,
      products_text,
      error_signals_text
    );
  `);

  ensureFtsSync(db);

  return db;
}


/**
 * Ensure FTS index is in sync with mined_threads table.
 * Rebuilds FTS if row counts differ — handles threads inserted
 * by mining scripts that bypass the JSONL→FTS reload path.
 */
export function ensureFtsSync(db: InstanceType<typeof Database>): void {
  const tableCount = (db.prepare("SELECT COUNT(*) as c FROM mined_threads").get() as { c: number }).c;
  const ftsCount = (db.prepare("SELECT COUNT(*) as c FROM mined_threads_fts").get() as { c: number }).c;

  if (tableCount === ftsCount) {
    return;
  }

  console.log(`[KB] FTS desync detected: ${ftsCount} FTS rows vs ${tableCount} mined threads. Rebuilding...`);

  db.exec("DELETE FROM mined_threads_fts");

  const rows = db.prepare(`
    SELECT id, summary, problem_statement, solution, keywords_json, products_json, error_signals_json
    FROM mined_threads
  `).all() as Array<{
    id: number;
    summary: string;
    problem_statement: string;
    solution: string;
    keywords_json: string;
    products_json: string;
    error_signals_json: string;
  }>;

  const insertFts = db.prepare(`
    INSERT INTO mined_threads_fts(rowid, summary, problem_statement, solution, keywords_text, products_text, error_signals_text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const row of rows) {
      const keywords = JSON.parse(row.keywords_json || "[]").join(" ");
      const products = JSON.parse(row.products_json || "[]").join(" ");
      const errors = JSON.parse(row.error_signals_json || "[]").join(" ");
      insertFts.run(row.id, row.summary, row.problem_statement, row.solution, keywords, products, errors);
    }
  });
  tx();

  console.log(`[KB] FTS rebuilt: ${rows.length} rows indexed.`);
}

function buildSearchableText(t: MinedThreadRecord): string {
  return [
    t.summary,
    t.problemStatement,
    t.solution,
    t.keywords.join(" "),
    t.products.join(" "),
    t.platforms.join(" "),
    t.errorSignals.join(" "),
    t.threadName,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildSafeFtsQuery(query: string, orMode = false): string | undefined {
  const tokens = query
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) {
    return undefined;
  }
  return tokens.map((t) => `"${t}"`).join(orMode ? " OR " : " ");
}

export function loadMinedThreads(db: InstanceType<typeof Database>, jsonlPath: string): number {
  const raw = readFileSync(jsonlPath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO mined_threads
    (thread_id, thread_name, channel_name, source_url, created_at, last_message_at,
     message_count, participant_count, participants_json, summary, problem_statement,
     solution, resolved, keywords_json, products_json, platforms_json, error_signals_json,
     category, searchable_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertFts = db.prepare(`
    INSERT INTO mined_threads_fts(rowid, summary, problem_statement, solution, keywords_text, products_text, error_signals_text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Clear and rebuild FTS
  db.exec("DELETE FROM mined_threads_fts");

  let loaded = 0;
  const tx = db.transaction(() => {
    for (const line of lines) {
      const t = JSON.parse(line) as Record<string, unknown>;
      if (!t.qwenProcessed || !t.summary) {
        continue;
      }

      const result = insert.run(
        String(t.threadId ?? ""),
        String(t.threadName ?? "unnamed"),
        String(t.channelName ?? ""),
        String(t.sourceUrl ?? ""),
        String(t.createdAt ?? ""),
        String(t.lastMessageAt ?? ""),
        Number(t.messageCount ?? 0),
        Number(t.participantCount ?? 0),
        JSON.stringify(t.participants ?? []),
        String(t.summary ?? ""),
        String(t.problemStatement ?? ""),
        String(t.solution ?? ""),
        t.resolved ? 1 : 0,
        JSON.stringify(t.keywords ?? []),
        JSON.stringify(t.products ?? []),
        JSON.stringify(t.platforms ?? []),
        JSON.stringify(t.errorSignals ?? []),
        String(t.category ?? "other"),
        buildSearchableText(t as unknown as MinedThreadRecord),
      );

      const rowid = result.lastInsertRowid;
      insertFts.run(
        rowid,
        String(t.summary ?? ""),
        String(t.problemStatement ?? ""),
        String(t.solution ?? ""),
        (t.keywords as string[] ?? []).join(", "),
        (t.products as string[] ?? []).join(", "),
        (t.errorSignals as string[] ?? []).join(", "),
      );

      loaded++;
    }
  });

  tx();
  return loaded;
}

export function searchKnowledgeBase(
  db: InstanceType<typeof Database>,
  query: string,
  options: { limit?: number; category?: string; resolvedOnly?: boolean; orMode?: boolean } = {},
): KnowledgeSearchResult[] {
  const limit = Math.min(options.limit ?? 8, 15);
  const safeFtsQuery = buildSafeFtsQuery(query, options.orMode);
  if (!safeFtsQuery) {
    return [];
  }

  const conditions: string[] = [];
  const params: unknown[] = [safeFtsQuery];

  if (options.category) {
    conditions.push("AND m.category = ?");
    params.push(options.category);
  }
  if (options.resolvedOnly) {
    conditions.push("AND m.resolved = 1");
  }

  params.push(limit);

  const sql = `
    SELECT
      m.thread_id, m.thread_name, m.channel_name, m.source_url, m.created_at,
      m.summary, m.problem_statement, m.solution, m.resolved,
      m.keywords_json, m.products_json, m.category,
      (rank * -1.0 + (julianday('now') - julianday(m.created_at)) * -0.005) AS relevance_score
    FROM mined_threads_fts fts
    JOIN mined_threads m ON m.id = fts.rowid
    WHERE mined_threads_fts MATCH ?
    ${conditions.join("\n")}
    ORDER BY relevance_score DESC
    LIMIT ?
  `;

  try {
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      threadId: String(row.thread_id),
      threadName: String(row.thread_name),
      channelName: String(row.channel_name),
      sourceUrl: String(row.source_url),
      createdAt: String(row.created_at),
      summary: String(row.summary),
      problemStatement: String(row.problem_statement),
      solution: String(row.solution),
      resolved: Boolean(row.resolved),
      keywords: JSON.parse(String(row.keywords_json)) as string[],
      products: JSON.parse(String(row.products_json)) as string[],
      category: String(row.category),
      relevanceScore: Number(row.relevance_score),
    }));
  } catch {
    return [];
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2);
  const command = args[0] ?? "load";
  const rootDir = process.env.STEVESBOT_ROOT ?? path.resolve(".");
  const dbPath = path.join(rootDir, "data", "sqlite", "knowledge.sqlite");

  if (command === "load") {
    const jsonlDir = path.join(rootDir, "data", "mined-threads");
    const db = initKnowledgeDb(dbPath);

    // Find all JSONL files and load them
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(jsonlDir).filter((f) => f.endsWith(".jsonl"));
    let total = 0;
    for (const file of files) {
      const filePath = path.join(jsonlDir, file);
      const count = loadMinedThreads(db, filePath);
      console.log(`Loaded ${count} threads from ${file}`);
      total += count;
    }

    const dbCount = (db.prepare("SELECT COUNT(*) as c FROM mined_threads").get() as { c: number }).c;
    console.log(`Total in knowledge base: ${dbCount} threads`);
    db.close();
  } else if (command === "search") {
    const query = args.slice(1).join(" ");
    if (!query) {
      console.log("Usage: knowledge-base.ts search <query>");
      return;
    }
    const db = initKnowledgeDb(dbPath);
    const results = searchKnowledgeBase(db, query, { limit: 5 });
    for (const r of results) {
      console.log(`[${r.category}] ${r.threadName} (${r.channelName})`);
      console.log(`  Problem: ${r.problemStatement.slice(0, 120)}`);
      console.log(`  Solution: ${r.solution.slice(0, 150)}`);
      console.log(`  Keywords: ${r.keywords.slice(0, 6).join(", ")}`);
      console.log(`  Resolved: ${r.resolved} | ${r.sourceUrl}`);
      console.log();
    }
    db.close();
  }
}

// Only run main() when executed directly, not when imported as a module
const isMainModule = import.meta.url === new URL("file://" + process.argv[1]).href
  || process.argv[1]?.endsWith("knowledge-base.ts");
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
