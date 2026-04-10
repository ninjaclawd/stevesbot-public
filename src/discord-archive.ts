/**
 * Discord Message Archive — searchable historical message store.
 *
 * Fetches messages from monitored Discord channels/threads and stores them
 * in a SQLite FTS5 table for fast relevance-ranked search with recency boost.
 *
 * Usage:
 *   tsx src/discord-archive.ts backfill [--months N] [--limit N]   # one-time historical fetch
 *   tsx src/discord-archive.ts incremental                         # fetch since last run
 *
 * The archive is also updated live by the bot when new messages arrive.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";

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

// ─── Schema ──────────────────────────────────────────────────────────────────

function initArchiveDb(dbPath: string): InstanceType<typeof Database> {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS archived_messages (
      message_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      thread_id TEXT,
      thread_name TEXT,
      guild_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      source_url TEXT NOT NULL,
      route_id TEXT,
      indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_archived_channel ON archived_messages(channel_id);
    CREATE INDEX IF NOT EXISTS idx_archived_thread ON archived_messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_archived_author ON archived_messages(author_name);
    CREATE INDEX IF NOT EXISTS idx_archived_created ON archived_messages(created_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS archived_messages_fts USING fts5(
      content,
      author_name,
      thread_name,
      content='archived_messages',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS archived_messages_ai AFTER INSERT ON archived_messages BEGIN
      INSERT INTO archived_messages_fts(rowid, content, author_name, thread_name)
      VALUES (new.rowid, new.content, new.author_name, COALESCE(new.thread_name, ''));
    END;

    CREATE TABLE IF NOT EXISTS archive_sync_state (
      channel_id TEXT PRIMARY KEY,
      last_message_id TEXT,
      last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}

// ─── Search ──────────────────────────────────────────────────────────────────

export type ArchiveSearchResult = {
  messageId: string;
  channelId: string;
  threadId?: string;
  threadName?: string;
  authorName: string;
  content: string;
  createdAt: string;
  sourceUrl: string;
  routeId?: string;
  relevanceScore: number;
};

/**
 * Search the archive with FTS5 relevance ranking and a recency boost.
 * Newer messages score higher. Results are capped at `limit`.
 */
export function searchArchive(
  db: InstanceType<typeof Database>,
  query: string,
  options: {
    limit?: number;
    routeId?: string;
    authorName?: string;
    maxAgeDays?: number;
  } = {},
): ArchiveSearchResult[] {
  const limit = options.limit ?? 10;
  const safeFtsQuery = buildSafeFtsQuery(query);
  if (!safeFtsQuery) {
    return [];
  }

  const conditions: string[] = [];
  const params: unknown[] = [safeFtsQuery];

  if (options.routeId) {
    conditions.push("AND m.route_id = ?");
    params.push(options.routeId);
  }
  if (options.authorName) {
    conditions.push("AND m.author_name = ?");
    params.push(options.authorName);
  }
  if (options.maxAgeDays) {
    conditions.push("AND m.created_at >= datetime('now', ?)");
    params.push(`-${options.maxAgeDays} days`);
  }

  params.push(limit);

  const sql = `
    SELECT
      m.message_id,
      m.channel_id,
      m.thread_id,
      m.thread_name,
      m.author_name,
      m.content,
      m.created_at,
      m.source_url,
      m.route_id,
      (
        rank * -1.0
        + (julianday('now') - julianday(m.created_at)) * -0.01
      ) AS relevance_score
    FROM archived_messages_fts fts
    JOIN archived_messages m ON m.rowid = fts.rowid
    WHERE fts.archived_messages_fts MATCH ?
    ${conditions.join("\n")}
    ORDER BY relevance_score DESC
    LIMIT ?
  `;

  try {
    const rows = db.prepare(sql).all(...params) as Array<{
      message_id: string;
      channel_id: string;
      thread_id: string | null;
      thread_name: string | null;
      author_name: string;
      content: string;
      created_at: string;
      source_url: string;
      route_id: string | null;
      relevance_score: number;
    }>;

    return rows.map((row) => ({
      messageId: row.message_id,
      channelId: row.channel_id,
      threadId: row.thread_id ?? undefined,
      threadName: row.thread_name ?? undefined,
      authorName: row.author_name,
      content: row.content,
      createdAt: row.created_at,
      sourceUrl: row.source_url,
      routeId: row.route_id ?? undefined,
      relevanceScore: row.relevance_score,
    }));
  } catch {
    // FTS query syntax error — fall back to LIKE
    const fallbackSql = `
      SELECT message_id, channel_id, thread_id, thread_name, author_name, content, created_at, source_url, route_id,
        0.0 AS relevance_score
      FROM archived_messages
      WHERE content LIKE ?
      ${conditions.map((c) => c.replace("m.", "")).join("\n")}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    params[0] = `%${query}%`;
    const rows = db.prepare(fallbackSql).all(...params) as Array<{
      message_id: string;
      channel_id: string;
      thread_id: string | null;
      thread_name: string | null;
      author_name: string;
      content: string;
      created_at: string;
      source_url: string;
      route_id: string | null;
      relevance_score: number;
    }>;
    return rows.map((row) => ({
      messageId: row.message_id,
      channelId: row.channel_id,
      threadId: row.thread_id ?? undefined,
      threadName: row.thread_name ?? undefined,
      authorName: row.author_name,
      content: row.content,
      createdAt: row.created_at,
      sourceUrl: row.source_url,
      routeId: row.route_id ?? undefined,
      relevanceScore: row.relevance_score,
    }));
  }
}

/**
 * Search for threads matching a query, returning grouped thread summaries.
 */
export function searchArchiveThreads(
  db: InstanceType<typeof Database>,
  query: string,
  options: { limit?: number; routeId?: string; maxAgeDays?: number } = {},
): Array<{
  threadId: string;
  threadName: string;
  channelId: string;
  messageCount: number;
  participants: string[];
  firstMessageAt: string;
  lastMessageAt: string;
  sourceUrl: string;
  routeId?: string;
  previewMessages: Array<{ authorName: string; content: string; createdAt: string }>;
}> {
  const msgResults = searchArchive(db, query, { ...options, limit: (options.limit ?? 5) * 10 });

  // Group by thread
  const threadMap = new Map<string, typeof msgResults>();
  for (const msg of msgResults) {
    const key = msg.threadId ?? msg.messageId;
    const group = threadMap.get(key) ?? [];
    group.push(msg);
    threadMap.set(key, group);
  }

  const threads = [...threadMap.entries()]
    .map(([threadId, messages]) => {
      // Get all messages in this thread for context
      const allThreadMsgs = db
        .prepare(
          `SELECT author_name, content, created_at FROM archived_messages
           WHERE thread_id = ? ORDER BY created_at ASC LIMIT 20`,
        )
        .all(threadId) as Array<{ author_name: string; content: string; created_at: string }>;

      const participants = [...new Set(allThreadMsgs.map((m) => m.author_name))];
      const first = allThreadMsgs[0];
      const last = allThreadMsgs[allThreadMsgs.length - 1];

      return {
        threadId,
        threadName: messages[0]?.threadName ?? "unnamed",
        channelId: messages[0]?.channelId ?? "",
        messageCount: allThreadMsgs.length,
        participants,
        firstMessageAt: first?.created_at ?? "",
        lastMessageAt: last?.created_at ?? "",
        sourceUrl: `https://discord.com/channels/444444444444444444/${threadId}`,
        routeId: messages[0]?.routeId,
        previewMessages: allThreadMsgs.slice(0, 5).map((m) => ({
          authorName: m.author_name,
          content: m.content.slice(0, 300),
          createdAt: m.created_at,
        })),
      };
    })
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    .slice(0, options.limit ?? 5);

  return threads;
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

function upsertMessage(
  db: InstanceType<typeof Database>,
  msg: {
    messageId: string;
    channelId: string;
    threadId?: string;
    threadName?: string;
    guildId: string;
    authorId: string;
    authorName: string;
    content: string;
    hasAttachments: boolean;
    attachmentCount: number;
    createdAt: string;
    sourceUrl: string;
    routeId?: string;
  },
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO archived_messages
       (message_id, channel_id, thread_id, thread_name, guild_id, author_id, author_name, content,
        has_attachments, attachment_count, created_at, source_url, route_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      msg.messageId,
      msg.channelId,
      msg.threadId ?? null,
      msg.threadName ?? null,
      msg.guildId,
      msg.authorId,
      msg.authorName,
      msg.content,
      msg.hasAttachments ? 1 : 0,
      msg.attachmentCount,
      msg.createdAt,
      msg.sourceUrl,
      msg.routeId ?? null,
    );
  return result.changes > 0;
}

/**
 * Ingest a single Discord event into the archive. Called by the live bot.
 */
export function archiveDiscordEvent(
  db: InstanceType<typeof Database>,
  event: {
    messageId: string;
    channelId: string;
    threadId?: string;
    guildId: string;
    authorId: string;
    authorName: string;
    content: string;
    createdAt: string;
    sourceUrl?: string;
    attachments?: Array<{ id: string }>;
  },
  routeId?: string,
  threadName?: string,
): void {
  upsertMessage(db, {
    messageId: event.messageId,
    channelId: event.channelId,
    threadId: event.threadId,
    threadName,
    guildId: event.guildId,
    authorId: event.authorId,
    authorName: event.authorName,
    content: event.content,
    hasAttachments: (event.attachments?.length ?? 0) > 0,
    attachmentCount: event.attachments?.length ?? 0,
    createdAt: event.createdAt,
    sourceUrl:
      event.sourceUrl ??
      `https://discord.com/channels/${event.guildId}/${event.threadId ?? event.channelId}/${event.messageId}`,
    routeId,
  });
}

// ─── FTS helpers ─────────────────────────────────────────────────────────────

function buildSafeFtsQuery(query: string): string | undefined {
  const tokens = query
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) {
    return undefined;
  }
  return tokens.map((t) => `"${t}"`).join(" ");
}

// ─── Backfill CLI ────────────────────────────────────────────────────────────

const ROUTE_MAP: Record<string, string> = {
  "555555555555555555": "vdo-ninja-support",
  "666666666666666666": "social-stream-support",
  "777777777777777777": "vdo-ninja-bug-report",
  "888888888888888888": "raspberry-ninja-channel",
  "999999999999999999": "vdo-ninja-misc",
};

async function fetchThreadMessages(thread: ThreadChannel): Promise<Message[]> {
  const messages: Message[] = [];
  let before: string | undefined;
  while (true) {
    const batch = await thread.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    for (const msg of batch.values()) messages.push(msg);
    before = batch.last()?.id;
    await new Promise((r) => setTimeout(r, 200));
  }
  return messages.reverse();
}

async function fetchChannelMessages(channel: TextChannel, limit: number): Promise<Message[]> {
  const messages: Message[] = [];
  let before: string | undefined;
  while (messages.length < limit) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, limit - messages.length), before });
    if (batch.size === 0) break;
    for (const msg of batch.values()) messages.push(msg);
    before = batch.last()?.id;
    await new Promise((r) => setTimeout(r, 200));
  }
  return messages.reverse();
}

async function backfill(dbPath: string, months: number, msgLimit: number): Promise<void> {
  loadDotEnv();
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN required");

  const db = initArchiveDb(dbPath);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffMs = cutoff.getTime();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message],
  });
  await client.login(token);
  console.log(`Logged in as ${client.user?.tag}`);

  const guild = await client.guilds.fetch("444444444444444444");
  let totalInserted = 0;
  let totalSkipped = 0;

  for (const [channelId, routeId] of Object.entries(ROUTE_MAP)) {
    const channel = (await guild.channels.fetch(channelId).catch(() => null)) as TextChannel | null;
    if (!channel) continue;

    console.log(`\n=== ${routeId} (${channelId}) ===`);

    if (channel.type === ChannelType.GuildText) {
      // Fetch threads
      const active = await channel.threads.fetchActive().catch(() => ({ threads: new Map() }));
      const archived: ThreadChannel[] = [];
      let hasMore = true;
      let archBefore: Date | undefined;
      while (hasMore) {
        const batch = await channel.threads.fetchArchived({ limit: 100, before: archBefore }).catch(() => ({ threads: new Map(), hasMore: false }));
        const threads = [...batch.threads.values()];
        if (threads.length === 0) break;
        const oldest = threads[threads.length - 1];
        if (oldest?.createdTimestamp && oldest.createdTimestamp < cutoffMs) {
          archived.push(...threads.filter((t) => !t.createdTimestamp || t.createdTimestamp >= cutoffMs));
          hasMore = false;
        } else {
          archived.push(...threads);
          hasMore = (batch as { hasMore?: boolean }).hasMore !== false && threads.length >= 100;
          archBefore = oldest?.createdAt ?? undefined;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      const allThreads = new Map<string, ThreadChannel>();
      for (const t of [...active.threads.values(), ...archived]) allThreads.set(t.id, t);
      console.log(`  ${allThreads.size} threads`);

      for (const thread of allThreads.values()) {
        const messages = await fetchThreadMessages(thread);
        let ins = 0;
        for (const msg of messages) {
          if (msg.author.bot) continue;
          const inserted = upsertMessage(db, {
            messageId: msg.id,
            channelId,
            threadId: thread.id,
            threadName: thread.name ?? undefined,
            guildId: "444444444444444444",
            authorId: msg.author.id,
            authorName: msg.author.username,
            content: msg.content,
            hasAttachments: msg.attachments.size > 0,
            attachmentCount: msg.attachments.size,
            createdAt: msg.createdAt.toISOString(),
            sourceUrl: `https://discord.com/channels/444444444444444444/${thread.id}/${msg.id}`,
            routeId,
          });
          if (inserted) ins++;
          else totalSkipped++;
        }
        totalInserted += ins;
        if (ins > 0) process.stdout.write(".");
      }

      // Also fetch channel-level messages
      const channelMsgs = await fetchChannelMessages(channel, msgLimit);
      for (const msg of channelMsgs) {
        if (msg.author.bot) continue;
        const inserted = upsertMessage(db, {
          messageId: msg.id,
          channelId,
          guildId: "444444444444444444",
          authorId: msg.author.id,
          authorName: msg.author.username,
          content: msg.content,
          hasAttachments: msg.attachments.size > 0,
          attachmentCount: msg.attachments.size,
          createdAt: msg.createdAt.toISOString(),
          sourceUrl: `https://discord.com/channels/444444444444444444/${channelId}/${msg.id}`,
          routeId,
        });
        if (inserted) totalInserted++;
        else totalSkipped++;
      }
    }

    console.log(`\n  Inserted: ${totalInserted}, Skipped (dupes): ${totalSkipped}`);
  }

  client.destroy();
  const total = (db.prepare("SELECT COUNT(*) as c FROM archived_messages").get() as { c: number }).c;
  console.log(`\nDone. Total archive: ${total} messages`);
  db.close();
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "backfill";
  const rootDir = process.env.STEVESBOT_ROOT ?? path.resolve(".");
  const dbPath = path.join(rootDir, "data", "sqlite", "archive.sqlite");

  if (command === "backfill") {
    const monthsIdx = args.indexOf("--months");
    const months = monthsIdx >= 0 ? Number(args[monthsIdx + 1]) || 12 : 12;
    const limitIdx = args.indexOf("--limit");
    const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 500 : 500;
    console.log(`Backfilling ${months} months, channel msg limit ${limit}`);
    console.log(`Archive DB: ${dbPath}`);
    await backfill(dbPath, months, limit);
  } else if (command === "search") {
    const query = args.slice(1).join(" ");
    if (!query) {
      console.log("Usage: discord-archive.ts search <query>");
      return;
    }
    const db = initArchiveDb(dbPath);
    const results = searchArchive(db, query, { limit: 10 });
    for (const r of results) {
      console.log(`[${r.createdAt}] ${r.authorName} (${r.routeId ?? "?"}): ${r.content.slice(0, 120)}`);
      console.log(`  ${r.sourceUrl}\n`);
    }
    db.close();
  } else if (command === "threads") {
    const query = args.slice(1).join(" ");
    if (!query) {
      console.log("Usage: discord-archive.ts threads <query>");
      return;
    }
    const db = initArchiveDb(dbPath);
    const results = searchArchiveThreads(db, query, { limit: 5 });
    for (const t of results) {
      console.log(`Thread: ${t.threadName} (${t.messageCount} msgs, ${t.participants.join(", ")})`);
      console.log(`  ${t.sourceUrl}`);
      for (const m of t.previewMessages) {
        console.log(`  [${m.createdAt}] ${m.authorName}: ${m.content.slice(0, 80)}`);
      }
      console.log();
    }
    db.close();
  }
}

export { initArchiveDb };

// Only run main() when executed directly, not when imported as a module
const isMainModule = import.meta.url === new URL("file://" + process.argv[1]).href
  || process.argv[1]?.endsWith("discord-archive.ts");
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
