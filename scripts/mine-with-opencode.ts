#!/usr/bin/env tsx
/**
 * Mine unmined threads using OpenCode GPT-5.4 instead of local Qwen.
 * Higher quality summaries, burns OpenCode credits.
 *
 * Usage: npx tsx scripts/mine-with-opencode.ts [--limit N] [--dry-run]
 */
import { existsSync, readFileSync, appendFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const ROOT = path.resolve(process.env.STEVESBOT_ROOT ?? ".");
const LOG = path.join(ROOT, "logs", "mine-opencode.log");

function loadEnv(): void {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const [key, ...rest] = line.split("=");
    if (key && !(key in process.env)) process.env[key] = rest.join("=");
  }
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG, line + "\n"); } catch {}
}

type ArchiveMessage = {
  message_id: string;
  author_id: string;
  author_name: string;
  content: string;
  created_at: string;
  thread_id: string;
  thread_name: string;
  channel_id: string;
  guild_id: string;
};

type MinedResult = {
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

type ThreadStat = {
  thread_id: string;
  message_count: number;
};

async function callOpenCode(
  conversationText: string,
  threadName: string,
  channelContext: string,
  repoContext: string,
  similarKB: string,
  learningsContext: string,
): Promise<MinedResult> {
  const baseUrl = process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/v1";
  const apiKey = process.env.OPENCODE_API_KEY ?? "";
  const model = process.env.MINE_MODEL ?? "gpt-5.4";

  const systemPrompt = `You are a senior support knowledge engineer for Steve Seguin's open-source streaming tools ecosystem.

## Products you know about:
- **VDO.Ninja** (vdo.ninja) — Free browser-based WebRTC tool for live video production. Lets you bring remote cameras, screenshares, and audio into OBS or other software. Key features: &push/&view URL parameters, rooms, directors, relay servers, TURN/STUN, Meshcast for scaling, &codec, &bitrate, &quality controls.
- **Social Stream Ninja** (SSN) — Browser extension + desktop app that aggregates live chat from YouTube, Twitch, Kick, TikTok, Facebook, and 30+ platforms into a single overlay for OBS. Has dock mode, featured-chat mode, custom CSS, auto-responder, and API.
- **Electron Capture** — Desktop app to capture browser sources cleanly for OBS (transparent backgrounds, window capture without chrome).
- **Raspberry Ninja** — Python tool to turn a Raspberry Pi (or Jetson, Intel NUC) into a headless WebRTC camera using hardware encoding. Uses GStreamer + publish.py.
- **Caption Ninja** — Real-time captioning/transcription tool using browser speech recognition.
- **Comms.cam** — Simplified VDO.Ninja wrapper for team communication.
- **Invite.cam** — Guest invite flow for VDO.Ninja.

## What you're doing:
Reading a real Discord support conversation and extracting structured, searchable knowledge from it. Your output will be stored in a database that a support bot searches when users ask questions. The better your keywords, summary, and solution extraction, the more accurately the bot can find and cite this thread as a reference.

## Quality guidelines:
- Keywords should be specific and searchable: include URL parameters (like &push, &bitrate=2000), error messages, setting names, browser names, OS versions — anything someone might search for.
- The summary should be useful standalone — someone reading just the summary should understand what happened.
- The solution should be copy-pasteable advice if possible.
- If the thread is just chit-chat or off-topic, say so in the summary and mark category as "general-discussion".`;

  const userPrompt = `Analyze this Discord support thread and extract structured, searchable knowledge.

Thread title: ${threadName}
Channel context: ${channelContext}

== PRODUCT DOCUMENTATION (from the actual source repo) ==
${repoContext.slice(0, 15000)}

== EXISTING KNOWLEDGE BASE ENTRIES ON SIMILAR TOPICS ==
${similarKB || "(none found)"}

== EXISTING LEARNINGS / KNOWN SOLUTIONS ==
${learningsContext.slice(0, 5000)}

== CONVERSATION START ==
${conversationText.slice(0, 30000)}
== CONVERSATION END ==

Return a JSON object with these fields:

- "summary": 2-4 sentence summary. Be specific — mention the product, the problem, and what happened. Someone should be able to read this and know if this thread is relevant to their question.
- "problemStatement": The core problem/question in 1-3 sentences. What was the user trying to do, and what went wrong? Empty string if no clear problem.
- "solution": The solution, workaround, or answer that was given. Include specific steps, URL parameters, settings, or commands if mentioned. Empty string if unresolved.
- "resolved": true if the user confirmed it worked or expressed thanks/success. false if the thread ended without resolution or the user stopped responding.
- "keywords": array of 10-25 highly specific searchable terms. Include: product names, URL parameters (e.g. "&push", "&relay", "&codec=h264"), setting names, error messages, browser names, OS names, hardware mentioned, feature names, API endpoints. These are what people will search for.
- "products": array of products from this list: "VDO.Ninja", "Social Stream Ninja", "SSN Desktop App", "Electron Capture", "Raspberry Ninja", "Caption Ninja", "Comms.cam", "Invite.cam", "Meshcast", "OBS"
- "platforms": array of platforms/services/browsers/OS mentioned: "YouTube", "Twitch", "Kick", "TikTok", "Facebook", "Discord", "Chrome", "Firefox", "Safari", "Edge", "OBS", "iOS", "Android", "Windows", "macOS", "Linux", "Raspberry Pi"
- "errorSignals": array of specific error messages, symptoms, or failure descriptions. Quote them exactly when possible.
- "category": exactly one of: "bug-report", "how-to", "feature-request", "troubleshooting", "configuration", "compatibility", "performance", "general-discussion", "other"

Return ONLY the JSON object, no markdown fences.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min for PRO

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 4096,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenCode ${response.status}: ${text.slice(0, 300)}`);
    }

    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenCode returned no content");

    const cleaned = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON in response");

    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return {
      summary: String(parsed.summary ?? ""),
      problemStatement: String(parsed.problemStatement ?? parsed.problem_statement ?? ""),
      solution: String(parsed.solution ?? ""),
      resolved: Boolean(parsed.resolved),
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [],
      products: Array.isArray(parsed.products) ? parsed.products.map(String) : [],
      platforms: Array.isArray(parsed.platforms) ? parsed.platforms.map(String) : [],
      errorSignals: Array.isArray(parsed.errorSignals ?? parsed.error_signals) ? (parsed.errorSignals ?? parsed.error_signals).map(String) : [],
      category: String(parsed.category ?? "other"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Context loaders ──

function loadRepoReadme(channelId: string, threadName: string): string {
  // Map channels to repos, also sniff thread name for product mentions
  const text = (threadName + " " + channelId).toLowerCase();
  const readmes: string[] = [];

  const tryLoad = (repoDir: string) => {
    const p = path.join(ROOT, "repos", repoDir, "README.md");
    try { readmes.push(`[${repoDir} README]\n` + readFileSync(p, "utf8").slice(0, 8000)); } catch {}
  };

  // Channel-based
  if (channelId === "555555555555555555") tryLoad("vdo-ninja");
  else if (channelId === "666666666666666666") tryLoad("social_stream");
  else if (channelId === "888888888888888888") tryLoad("raspberry_ninja");

  // Name-based fallback
  if (text.includes("vdo") || text.includes("ninja") && !text.includes("social") && !text.includes("raspberry")) tryLoad("vdo-ninja");
  if (text.includes("social stream") || text.includes("ssn") || text.includes("chat overlay")) tryLoad("social_stream");
  if (text.includes("raspberry") || text.includes("publish.py") || text.includes("gstreamer")) tryLoad("raspberry_ninja");
  if (text.includes("electron capture")) tryLoad("electroncapture");
  if (text.includes("caption")) tryLoad("captionninja");

  // Dedupe
  return [...new Set(readmes)].join("\n\n---\n\n").slice(0, 15000);
}

function searchSimilarKB(kbDb: Database.Database, threadName: string, conversationSnippet: string): string {
  // Extract keywords from thread name + first few messages
  const words = (threadName + " " + conversationSnippet.slice(0, 500))
    .toLowerCase()
    .replace(/[^a-z0-9\s&=]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 10);

  if (words.length === 0) return "";

  // FTS5 search
  try {
    const ftsQuery = words.join(" OR ");
    const results = kbDb.prepare(
      "SELECT thread_name, summary, solution, keywords_json FROM mined_threads WHERE mined_threads MATCH ? LIMIT 5"
    ).all(ftsQuery) as Array<{ thread_name: string; summary: string; solution: string; keywords_json: string }>;

    if (results.length === 0) return "";
    return results.map((r, i) =>
      `${i+1}. [${r.thread_name}] ${r.summary}\n   Solution: ${r.solution}\n   Keywords: ${r.keywords_json}`
    ).join("\n\n");
  } catch {
    // FTS might not be set up on mined_threads, fall back to LIKE
    try {
      const likeWord = "%" + words[0] + "%";
      const results = kbDb.prepare(
        "SELECT thread_name, summary, solution, keywords_json FROM mined_threads WHERE searchable_text LIKE ? LIMIT 5"
      ).all(likeWord) as Array<{ thread_name: string; summary: string; solution: string; keywords_json: string }>;
      if (results.length === 0) return "";
      return results.map((r, i) =>
        `${i+1}. [${r.thread_name}] ${r.summary}\n   Solution: ${r.solution}`
      ).join("\n\n");
    } catch { return ""; }
  }
}

function loadLearnings(channelId: string): string {
  const learningsDir = path.join(ROOT, "resources", "learnings");
  const parts: string[] = [];

  // Load support-qa files
  const qaDir = path.join(learningsDir, "support-qa");
  try {
    for (const f of readdirSync(qaDir)) {
      if (f.endsWith(".md")) {
        parts.push(readFileSync(path.join(qaDir, f), "utf8").slice(0, 3000));
      }
    }
  } catch {}

  // Load product-specific top-issues if they exist
  for (const f of ["vdo-ninja-top-issues.md", "social-stream-ninja-top-issues.md", "raspberry-ninja-top-issues.md",
                     "vdo-ninja-comprehensive-reference.md", "ssn-comprehensive-reference.md"]) {
    const p = path.join(learningsDir, f);
    try { parts.push(readFileSync(p, "utf8").slice(0, 3000)); } catch {}
  }

  // Load route instruction for this channel
  const instrMap: Record<string, string> = {
    "555555555555555555": "vdo-ninja-support.md",
    "666666666666666666": "social-stream-support.md",
    "888888888888888888": "raspberry-ninja-support.md",
    "777777777777777777": "vdo-ninja-bug-report.md",
  };
  const instrFile = instrMap[channelId];
  if (instrFile) {
    try { parts.push("[ROUTE INSTRUCTIONS]\n" + readFileSync(path.join(ROOT, "resources", "instructions", instrFile), "utf8").slice(0, 2000)); } catch {}
  }

  return parts.join("\n\n---\n\n").slice(0, 8000);
}

async function main(): Promise<void> {
  loadEnv();

  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : 100;
  const dryRun = args.includes("--dry-run");

  const archiveDb = new Database(path.join(ROOT, "data", "sqlite", "archive.sqlite"), { readonly: true });
  const kbDb = new Database(path.join(ROOT, "data", "sqlite", "knowledge.sqlite"));

  // Find unmined thread IDs, but pre-filter to threads that have enough context to mine.
  const threadStats = archiveDb.prepare(`
    SELECT thread_id, COUNT(*) as message_count
    FROM archived_messages
    WHERE thread_id IS NOT NULL
    GROUP BY thread_id
    ORDER BY thread_id
  `).all() as ThreadStat[];

  const minedThreadIds = new Set(
    (kbDb.prepare("SELECT thread_id FROM mined_threads").all() as Array<{ thread_id: string }>)
      .map(r => r.thread_id)
  );

  const unmined = threadStats.filter((r) => !minedThreadIds.has(r.thread_id));
  const eligibleUnmined = unmined.filter((r) => r.message_count >= 2);
  const skippedSingleMessage = unmined.length - eligibleUnmined.length;
  const minedInArchive = threadStats.length - unmined.length;
  const orphanedKbEntries = minedThreadIds.size - minedInArchive;

  log(
    `Total threads: ${threadStats.length}, Mined in archive: ${minedInArchive}, KB entries: ${minedThreadIds.size}, ` +
    `Orphaned KB entries: ${orphanedKbEntries}, Unmined: ${unmined.length}, Eligible: ${eligibleUnmined.length}, ` +
    `Single-message skipped: ${skippedSingleMessage}`,
  );
  log(`Processing up to ${limit} eligible threads with OpenCode ${process.env.MINE_MODEL ?? "gpt-5.4"}`);

  if (dryRun) {
    log("DRY RUN — no API calls");
    return;
  }

  if (!process.env.OPENCODE_API_KEY) {
    log("ERROR: OPENCODE_API_KEY not set");
    process.exit(1);
  }

  const insertStmt = kbDb.prepare(`
    INSERT OR REPLACE INTO mined_threads
    (thread_id, thread_name, channel_name, source_url, created_at, last_message_at,
     message_count, participant_count, participants_json, summary, problem_statement, solution,
     resolved, keywords_json, products_json, platforms_json, error_signals_json, category,
     searchable_text, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  let processed = 0;
  let errors = 0;

  for (const { thread_id } of eligibleUnmined.slice(0, limit)) {
    // Fetch messages for this thread
    const messages = archiveDb.prepare(
      "SELECT * FROM archived_messages WHERE thread_id = ? ORDER BY created_at ASC"
    ).all(thread_id) as ArchiveMessage[];

    if (messages.length < 2) {
      log(`  Skip ${thread_id}: only ${messages.length} messages`);
      continue;
    }

    const threadName = messages[0].thread_name || thread_id;

    // Build rich conversation text with timestamps
    const conversationText = messages
      .map(m => `[${m.created_at}] ${m.author_name}: ${m.content}`)
      .join("\n");

    // Figure out channel context for better understanding
    const channelId = messages[0].channel_id ?? "";
    const channelContextMap: Record<string, string> = {
      "555555555555555555": "VDO.Ninja support (WebRTC, video, audio, OBS integration)",
      "666666666666666666": "Social Stream Ninja support (chat overlays, extensions, platform integrations)",
      "888888888888888888": "Raspberry Ninja support (hardware encoding, GStreamer, Pi/Jetson)",
      "777777777777777777": "Bug reports (all products)",
      "999999999999999999": "General/misc discussion",
    };
    const channelContext = channelContextMap[channelId] ?? "General support";

    const participants = [...new Set(messages.map(m => m.author_name))];

    // Load rich context
    const repoContext = loadRepoReadme(channelId, threadName);
    const similarKB = searchSimilarKB(kbDb, threadName, conversationText);
    const learningsContext = loadLearnings(channelId);

    try {
      log(`  Mining: ${threadName} (${messages.length} msgs, ${channelContext}, repo:${repoContext.length > 0 ? "yes" : "no"}, similar:${similarKB ? "yes" : "no"})`);
      const result = await callOpenCode(conversationText, threadName, channelContext, repoContext, similarKB, learningsContext);

      const lastMsg = messages[messages.length - 1];
      const searchableText = [threadName, result.summary, result.problemStatement, result.solution, ...result.keywords].join(" ");

      insertStmt.run(
        thread_id,
        threadName,
        messages[0].channel_id ?? "",
        `https://discord.com/channels/${messages[0].guild_id}/${thread_id}`,
        messages[0].created_at,
        lastMsg.created_at,
        messages.length,
        participants.length,
        JSON.stringify(participants),
        result.summary,
        result.problemStatement,
        result.solution,
        result.resolved ? 1 : 0,
        JSON.stringify(result.keywords),
        JSON.stringify(result.products),
        JSON.stringify(result.platforms),
        JSON.stringify(result.errorSignals),
        result.category,
        searchableText
      );

      processed++;
      log(`  OK: ${threadName} — ${result.category}, ${result.resolved ? "resolved" : "unresolved"}`);

      // Small delay to be polite to the API
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ERROR: ${threadName}: ${msg.slice(0, 200)}`);

      // If subscription quota exceeded, stop entirely — credits are maxed
      if (msg.includes("SubscriptionUsageLimitError") || msg.includes("quota exceeded")) {
        log("  QUOTA MAXED — stopping. " + msg.slice(0, 100));
        break;
      }
      // Transient rate limit — back off and retry
      if (msg.includes("429") || msg.includes("rate")) {
        log("  Rate limited, waiting 30s...");
        await new Promise(r => setTimeout(r, 30_000));
      }
    }
  }

  archiveDb.close();
  kbDb.close();

  log(`Done. Processed: ${processed}, Errors: ${errors}`);
}

main().catch(err => {
  log(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
