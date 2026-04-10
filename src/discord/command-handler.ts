import type { Message } from "discord.js";
import type { AppDatabase } from "../store/database.js";
import { readFile, readdir } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { invokeP2PTool, getP2PToolCatalog } from "../tools/p2p-tools.js";
import type { VDOBridge } from "../p2p/vdo-bridge.js";
import Database from "better-sqlite3";
import { loadAllSkills, executeSkill } from "../chore-runner.js";
import { callLocalChatWithFallback } from "../models/local-model-fallback.js";
import { getPreferredLocalQwenProvider } from "../models/provider-fallbacks.js";
import { searchSimilar, getTfidfStats } from "../tfidf-search.js";
import { scoreCommandReply, scoreToolUse, getScoreContext } from "../scoring.js";

function parseMaintainerIds(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

const MAINTAINER_IDS = parseMaintainerIds(process.env.STEVESBOT_MAINTAINER_USER_IDS ?? "111111111111111111");

// Conversation memory: last N message/reply pairs for multi-turn context
type ConversationTurn = { role: "user" | "assistant"; content: string; timestamp: number };
const conversationBuffer: ConversationTurn[] = [];
const MAX_CONVERSATION_TURNS = 12; // 6 exchanges
const CONVERSATION_TTL_MS = 30 * 60_000; // Forget after 30 min of silence

function addToConversation(role: "user" | "assistant", content: string): void {
  // Trim old turns
  const cutoff = Date.now() - CONVERSATION_TTL_MS;
  while (conversationBuffer.length > 0 && conversationBuffer[0].timestamp < cutoff) {
    conversationBuffer.shift();
  }
  conversationBuffer.push({ role, content: content.slice(0, 500), timestamp: Date.now() });
  // Cap size
  while (conversationBuffer.length > MAX_CONVERSATION_TURNS) {
    conversationBuffer.shift();
  }
}

function getConversationHistory(): Array<{ role: string; content: string }> {
  const cutoff = Date.now() - CONVERSATION_TTL_MS;
  return conversationBuffer
    .filter(t => t.timestamp >= cutoff)
    .map(t => ({ role: t.role, content: t.content }));
}
const REACT_RECEIVED = "\u{1F440}";

function logCommand(direction: "in" | "out" | "tool", content: string): void {
  const rootDir = process.env.STEVESBOT_ROOT ?? process.cwd();
  const logPath = path.join(rootDir, "logs", "command-channel.log");
  const line = "[" + new Date().toISOString() + "] [" + direction + "] " + content.slice(0, 500) + "\n";
  try { appendFileSync(logPath, line); } catch { /* best effort */ }
}
const REACT_THINKING = "\u{1F914}";
const REACT_DONE = "\u2705";
const REACT_ERROR = "\u274C";

export type CommandHandlerDeps = {
  db: AppDatabase;
  rootDir: string;
  p2pBridge?: VDOBridge;
};

function isMaintainer(authorId: string): boolean {
  return MAINTAINER_IDS.has(authorId);
}

// ── Tool definitions ──

type ToolResult = { output: string };

const TOOL_DESCRIPTIONS = [
  "queryDb(sql, db?) — Run a read-only SQL query. db: stevesbot (default), knowledge, archive. Key tables: workflow_runs (id, route_id, thread_key, author_name, message_content, outcome [approved/rejected/hold/no-reply/error], reply_text, total_duration_ms, created_at), user_memory (author_id, author_name, interaction_count, products_json), chore_log (chore_id, status, result, duration_ms, created_at), run_feedback (run_id, rating, note). Knowledge DB: mined_threads (thread_name, summary, solution, category, resolved).",
  "runShell(command) — Run a shell command on the Pi. Returns stdout. Use for diagnostics only.",
  "searchKnowledgeBase(query) — FTS search the mined knowledge base. Returns top matches.",
  "searchRepo(repoId, query) — Grep a repo for a string. repoId: vdo-ninja, social-stream, etc.",
  "runSkill(skillId) — Execute a skill (system-health-check, issue-trend-monitor, daily-digest). Returns the result.",
  "listSkills() — List all available skills.",
  "listChores() — List all scheduled chores and their status.",
  "getUserMemory(authorId) — Get memory for a specific Discord user.",
  "readFile(filePath) — Read a file relative to the project root. For learnings, instructions, ops docs.",
  "p2pPeers() — List all peers connected to the P2P WebRTC network.",
  "p2pSend(message, target?) — Send a chat message over P2P. Omit target to broadcast.",
  "p2pHistory(count?) — Get recent P2P message history.",
  "p2pStatus() — Get P2P bridge connection status, peer count, subscriptions.",
  "similarSearch(query) — Semantic similarity search across the KB. Finds related threads even with different wording. Complements searchKnowledgeBase.",
];

async function executeTool(name: string, args: Record<string, string>, deps: CommandHandlerDeps): Promise<ToolResult> {
  const rootDir = deps.rootDir;

  switch (name) {
    case "queryDb": {
      const dbName = args.db ?? "stevesbot";
      const sql = args.sql ?? args.query ?? "";
      if (!sql) return { output: "Error: sql parameter required" };
      // Safety: only allow SELECT
      if (!/^\s*SELECT/i.test(sql)) return { output: "Error: only SELECT queries allowed" };
      const dbPaths: Record<string, string> = {
        stevesbot: path.join(rootDir, "data", "sqlite", "stevesbot.sqlite"),
        knowledge: path.join(rootDir, "data", "sqlite", "knowledge.sqlite"),
        archive: path.join(rootDir, "data", "sqlite", "archive.sqlite"),
      };
      const dbPath = dbPaths[dbName];
      if (!dbPath) return { output: "Error: unknown db " + dbName + ". Use: stevesbot, knowledge, archive" };
      try {
        const db = new Database(dbPath, { readonly: true });
        const rows = db.prepare(sql).all();
        db.close();
        const json = JSON.stringify(rows, null, 2);
        return { output: json.length > 3000 ? json.slice(0, 3000) + "\n...(truncated)" : json };
      } catch (e) {
        return { output: "SQL error: " + (e instanceof Error ? e.message : String(e)) };
      }
    }

    case "runShell": {
      const command = args.command ?? "";
      if (!command) return { output: "Error: command parameter required" };
      try {
        const out = execSync(command, { cwd: rootDir, timeout: 15_000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
        return { output: out.length > 3000 ? out.slice(0, 3000) + "\n...(truncated)" : out };
      } catch (e) {
        return { output: "Shell error: " + (e instanceof Error ? e.message : String(e)).slice(0, 500) };
      }
    }

    case "searchKnowledgeBase": {
      const query = args.query ?? "";
      if (!query) return { output: "Error: query parameter required" };
      try {
        const kbPath = path.join(rootDir, "data", "sqlite", "knowledge.sqlite");
        const db = new Database(kbPath, { readonly: true });
        const terms = query.split(/\s+/).filter(Boolean).join(" OR ");
        const rows = db.prepare(
          "SELECT thread_name, channel_name, summary, solution, category, resolved FROM mined_threads_fts JOIN mined_threads ON mined_threads.rowid = mined_threads_fts.rowid WHERE mined_threads_fts MATCH ? ORDER BY rank LIMIT 5"
        ).all(terms) as Array<Record<string, unknown>>;
        db.close();
        return { output: rows.length > 0 ? JSON.stringify(rows, null, 2) : "No results for: " + query };
      } catch (e) {
        return { output: "KB search error: " + (e instanceof Error ? e.message : String(e)) };
      }
    }

    case "searchRepo": {
      const repoId = args.repoId ?? args.repo ?? "";
      const query = args.query ?? "";
      if (!repoId || !query) return { output: "Error: repoId and query required" };
      try {
        const repoPath = path.join(rootDir, "repos", repoId);
        const out = execSync("grep -rn --include='*.js' --include='*.ts' --include='*.html' --include='*.md' -i " + JSON.stringify(query) + " . | head -20", {
          cwd: repoPath, timeout: 10_000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        return { output: out || "No matches in " + repoId };
      } catch {
        return { output: "No matches in " + repoId + " (or repo not found)" };
      }
    }

    case "runSkill": {
      const skillId = args.skillId ?? args.skill ?? "";
      if (!skillId) return { output: "Error: skillId required" };
      try {
        const skills = await loadAllSkills(path.join(rootDir, "skills"));
        const skill = skills.get(skillId);
        if (!skill) return { output: "Unknown skill: " + skillId + ". Available: " + [...skills.keys()].join(", ") };
        let opsKnowledge = "";
        try { opsKnowledge = await readFile(path.join(rootDir, "resources", "ops", "infrastructure.md"), "utf8"); } catch { /* ok */ }
        const result = await executeSkill({ skill, rootDir, db: deps.db, choreId: "cmd-" + skillId, opsKnowledge });
        return { output: "[" + result.status + " " + result.durationMs + "ms]\n" + result.result.slice(0, 3000) };
      } catch (e) {
        return { output: "Skill error: " + (e instanceof Error ? e.message : String(e)) };
      }
    }

    case "listSkills": {
      try {
        const skills = await loadAllSkills(path.join(rootDir, "skills"));
        const lines = [...skills.values()].map(s => "- **" + s.id + "**: " + s.name + " (" + s.schedule + ")");
        return { output: lines.join("\n") };
      } catch (e) {
        return { output: "Error: " + (e instanceof Error ? e.message : String(e)) };
      }
    }

    case "listChores": {
      const chores = deps.db.listChores();
      const lines = chores.map(c => "- **" + c.id + "** (" + c.skillId + "): " + (c.enabled ? "enabled" : "disabled") +
        ", runs: " + c.runCount + ", last: " + (c.lastStatus ?? "never") + " at " + (c.lastRunAt?.slice(0, 16) ?? "n/a"));
      return { output: lines.join("\n") || "No chores registered" };
    }

    case "getUserMemory": {
      const authorId = args.authorId ?? args.userId ?? "";
      if (!authorId) return { output: "Error: authorId required" };
      const ctx = deps.db.formatUserMemoryContext(authorId);
      return { output: ctx || "No memory for user " + authorId };
    }

    case "readFile": {
      const filePath = args.filePath ?? args.path ?? "";
      if (!filePath) return { output: "Error: filePath required" };
      // Prevent path traversal
      const resolved = path.resolve(rootDir, filePath);
      if (!resolved.startsWith(rootDir)) return { output: "Error: path outside project root" };
      try {
        const content = await readFile(resolved, "utf8");
        return { output: content.length > 4000 ? content.slice(0, 4000) + "\n...(truncated)" : content };
      } catch {
        return { output: "File not found: " + filePath };
      }
    }

    case "p2pPeers":
    case "p2pSend":
    case "p2pHistory":
    case "p2pStatus": {
      const result = invokeP2PTool(deps.p2pBridge, name, args);
      return { output: JSON.stringify(result.data ?? { error: result.error }, null, 2) };
    }

    case "similarSearch": {
      const query = args.query ?? "";
      if (!query) return { output: "Error: query parameter required" };
      const results = searchSimilar(query, 5);
      if (results.length === 0) return { output: "No similar threads found for: " + query };
      const stats = getTfidfStats();
      return { output: "TF-IDF search (" + stats.documents + " docs, " + stats.terms + " terms):\n" + results.map(r => "- [" + r.category + "] " + r.name + " (score: " + r.score.toFixed(3) + ")").join("\n") };
    }

        default:
      return { output: "Unknown tool: " + name + ". Available: " + TOOL_DESCRIPTIONS.map(d => d.split("(")[0]).join(", ") };
  }
}

// ── Tool call parser (forgiving — works with small models) ──

type ParsedToolCall = { tool: string; args: Record<string, string> };

function parseToolCall(text: string): ParsedToolCall | null {
  // Try JSON: {"tool":"name","args":{...}}
  try {
    const jsonMatch = text.match(/\{[\s\S]*"tool"\s*:\s*"[\w]+"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.tool && typeof parsed.tool === "string") {
        return { tool: parsed.tool, args: parsed.args ?? {} };
      }
    }
  } catch { /* not JSON */ }

  // Try simple format: TOOL: name(arg1=val1, arg2=val2)
  const simpleMatch = text.match(/TOOL:\s*(\w+)\(([^)]*)\)/);
  if (simpleMatch) {
    const tool = simpleMatch[1];
    const argsStr = simpleMatch[2];
    const args: Record<string, string> = {};
    for (const pair of argsStr.split(",")) {
      const [k, ...v] = pair.split("=");
      if (k?.trim()) args[k.trim()] = v.join("=").trim().replace(/^["']|["']$/g, "");
    }
    return { tool, args };
  }

  return null;
}

// ── Local model caller ──

async function callQwen(
  messages: Array<{ role: string; content: string }>,
  opts: { timeout: number; maxTokens?: number },
): Promise<string> {
  return callLocalChatWithFallback({
    env: process.env,
    clientLabel: "command-handler:qwen",
    timeoutMs: opts.timeout,
    temperature: 0.3,
    maxTokens: opts.maxTokens ?? 1500,
    errorLabel: "Local model",
    messages,
  });
}

// ── Build system context (lightweight, not dumped to user) ──

function buildSystemContext(db: AppDatabase, rootDir: string): string {
  const rawDb = (db as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown } } }).db;

  const outcomes = rawDb.prepare(
    "SELECT outcome, COUNT(*) as cnt FROM workflow_runs WHERE created_at >= datetime('now', '-24 hours') GROUP BY outcome"
  ).all() as Array<{ outcome: string; cnt: number }>;
  const pipelineStats = outcomes.map(o => o.outcome + ": " + o.cnt).join(", ") || "no runs in 24h";

  const queue = rawDb.prepare(
    "SELECT status, COUNT(*) as cnt FROM workflow_queue GROUP BY status"
  ).all() as Array<{ status: string; cnt: number }>;
  const queueStats = queue.map(q => q.status + ": " + q.cnt).join(", ") || "empty";

  const userCount = (rawDb.prepare("SELECT COUNT(*) as cnt FROM user_memory").get() as { cnt: number })?.cnt ?? 0;

  let kbCount = 0;
  try {
    const kbDb = new Database(path.join(rootDir, "data", "sqlite", "knowledge.sqlite"), { readonly: true });
    kbCount = (kbDb.prepare("SELECT COUNT(*) as cnt FROM mined_threads").get() as { cnt: number })?.cnt ?? 0;
    kbDb.close();
  } catch { /* ok */ }

  const scoreCtx = getScoreContext();
  return [
    "System snapshot: pipeline(24h)=" + pipelineStats + " | queue=" + queueStats + " | users=" + userCount + " | kb=" + kbCount + " threads",
  ].join("\n");
}

// ── Main handler ──

const MAX_TOOL_ROUNDS = 4;

export async function handleCommandMessage(message: Message, deps: CommandHandlerDeps): Promise<void> {
  if (!isMaintainer(message.author.id)) return;

  try { await message.react(REACT_RECEIVED); } catch { /* ok */ }
    logCommand("in", message.author.username + ": " + message.content);

  const preferredQwenProvider = getPreferredLocalQwenProvider(process.env, "command-handler:qwen");
  const qwenOpts = {
    timeout: Math.min(preferredQwenProvider.requestTimeoutMs ?? 120_000, 175_000),
  };

  // Overall handler timeout — if the local model hangs, show an error after 3 minutes
  const HANDLER_TIMEOUT = 180_000;
  const handlerTimer = setTimeout(async () => {
    try { await message.reactions.cache.get(REACT_THINKING)?.users.remove(); } catch { /* ok */ }
    try { await message.react(REACT_ERROR); } catch { /* ok */ }
    try { await message.reply({ content: "Timed out waiting for the local model (3min). It may be overloaded.", allowedMentions: { repliedUser: false } }); } catch { /* ok */ }
  }, HANDLER_TIMEOUT);

  try {
    try { await message.react(REACT_THINKING); } catch { /* ok */ }

    const systemContext = buildSystemContext(deps.db, deps.rootDir);

    const systemPrompt = [
      "You are StevesBot, the maintainer's ops assistant for this repository.",
      "",
      "Style: concise, conversational, and practical. No unsolicited status dumps. Under 200 words unless more is needed.",
      "",
      "You have tools available. To use a tool, respond with a tool_call block:",
      '<tool_call>{"name":"toolName","arguments":{"param":"value"}}</tool_call>',
      "You can also use JSON format: " + '{"tool":"toolName","args":{"param":"value"}}',
      "",
      "Available tools:",
      ...TOOL_DESCRIPTIONS,
      "",
      "If you need information, use a tool FIRST, then answer based on the result. Don't guess when you can look it up.",
      "When you have enough information to answer, respond with plain text (no JSON). This is your final answer.",
      "",
      systemContext,
    ].join("\n");

    // Build messages with conversation history for multi-turn context
    addToConversation("user", message.content);
    const history = getConversationHistory();
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
      // Prior conversation turns (excluding the current message which is last in history)
      ...history.slice(0, -1),
      { role: "user", content: message.content },
    ];

    let finalResponse = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await callQwen(messages, qwenOpts);

      // Check if response is a tool call
      const toolCall = parseToolCall(response);
      if (toolCall) {
        console.log("[COMMAND] Tool call: " + toolCall.tool + "(" + JSON.stringify(toolCall.args) + ")");
        logCommand("tool", toolCall.tool + "(" + JSON.stringify(toolCall.args) + ")");
        scoreToolUse(toolCall.tool);
        const result = await executeTool(toolCall.tool, toolCall.args, deps);
        console.log("[COMMAND] Tool result (" + toolCall.tool + "): " + result.output.slice(0, 200));

        // Add assistant message and tool result to conversation
        messages.push({ role: "assistant", content: response });
        messages.push({ role: "user", content: "Tool result (" + toolCall.tool + "):\n" + result.output });
        continue;
      }

      // Not a tool call — this is the final answer
      finalResponse = response;
      break;
    }

    if (!finalResponse) {
      finalResponse = "I used all my tool rounds without producing a final answer. Try asking more specifically.";
    }

    try { await message.reactions.cache.get(REACT_THINKING)?.users.remove(); } catch { /* ok */ }
    try { await message.react(REACT_DONE); } catch { /* ok */ }

    clearTimeout(handlerTimer);

        // Save bot response to conversation buffer
    addToConversation("assistant", finalResponse);
    logCommand("out", "bot: " + finalResponse);
    scoreCommandReply(message.content);

    const chunks = splitMessage(finalResponse, 1900);
    for (const chunk of chunks) {
      await message.reply({ content: chunk, allowedMentions: { repliedUser: false } });
    }
  } catch (err) {
    try { await message.reactions.cache.get(REACT_THINKING)?.users.remove(); } catch { /* ok */ }
    try { await message.react(REACT_ERROR); } catch { /* ok */ }

    clearTimeout(handlerTimer);
        const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[COMMAND] Error:", errMsg);
    try {
      await message.reply({ content: "Error: " + errMsg.slice(0, 500), allowedMentions: { repliedUser: false } });
    } catch { /* ok */ }
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}
