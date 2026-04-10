/**
 * Mine historical Discord threads into structured JSON knowledge base.
 *
 * Fetches threads from monitored support channels, sends each conversation
 * to Qwen for summarization and keyword extraction, and writes results to
 * a JSONL file that can be searched by future AI lookups.
 *
 * Usage:
 *   tsx src/mine-discord-threads.ts [--months N] [--dry-run] [--limit N]
 *
 * Output: data/mined-threads/threads-TIMESTAMP.jsonl
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { callLocalChatWithFallback } from "./models/local-model-fallback.js";
import { getPreferredLocalQwenProvider } from "./models/provider-fallbacks.js";

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

type MinedMessage = {
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  hasAttachments: boolean;
  attachmentCount: number;
};

type MinedThread = {
  threadId: string;
  threadName: string;
  channelId: string;
  channelName: string;
  guildId: string;
  sourceUrl: string;
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
  participantCount: number;
  participants: string[];
  messages: MinedMessage[];
  // Qwen-generated fields
  summary?: string;
  problemStatement?: string;
  solution?: string;
  resolved?: boolean;
  keywords?: string[];
  products?: string[];
  platforms?: string[];
  errorSignals?: string[];
  category?: string;
  qwenProcessed?: boolean;
  qwenError?: string;
};

async function fetchAllThreadMessages(thread: ThreadChannel): Promise<Message[]> {
  const messages: Message[] = [];
  let before: string | undefined;

  while (true) {
    const batch = await thread.messages.fetch({ limit: 100, before });
    if (batch.size === 0) {
      break;
    }
    for (const msg of batch.values()) {
      messages.push(msg);
    }
    before = batch.last()?.id;
    // Small delay to avoid rate limits
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return messages.reverse(); // oldest first
}

function buildConversationText(messages: MinedMessage[]): string {
  return messages
    .map((m) => {
      const attach = m.hasAttachments ? ` [${m.attachmentCount} attachment(s)]` : "";
      return `[${m.createdAt}] ${m.authorName}: ${m.content}${attach}`;
    })
    .join("\n");
}

async function qwenSummarize(
  conversationText: string,
  threadName: string,
  timeoutMs: number,
): Promise<{
  summary: string;
  problemStatement: string;
  solution: string;
  resolved: boolean;
  keywords: string[];
  products: string[];
  platforms: string[];
  errorSignals: string[];
  category: string;
}> {
  const systemPrompt =
    "You are a support knowledge extractor. Analyze Discord support conversations and extract structured metadata. Return JSON only.";

  const userPrompt = [
    "Analyze this Discord support thread and extract structured knowledge.",
    "",
    `Thread title: ${threadName}`,
    "",
    "Conversation:",
    conversationText.slice(0, 12000), // Cap at ~12K chars to stay within context
    "",
    "Return JSON with these fields:",
    '- "summary": 1-3 sentence summary of the entire conversation',
    '- "problemStatement": The core problem/question in 1-2 sentences. Empty string if no clear problem.',
    '- "solution": The solution or answer if one was found. Empty string if unresolved.',
    '- "resolved": boolean, whether the problem was resolved in this thread',
    '- "keywords": array of 5-15 searchable keywords/phrases relevant to this conversation (include technical terms, feature names, error messages, URL parameters, settings names)',
    '- "products": array of product names mentioned (e.g. "VDO.Ninja", "Social Stream Ninja", "SSN Desktop App", "Electron Capture", "Raspberry Ninja", "Caption Ninja", "Meshcast", "OBS")',
    '- "platforms": array of platforms/services mentioned (e.g. "TikTok", "YouTube", "Twitch", "Kick", "Discord", "Chrome", "Firefox", "Safari", "iOS", "Android", "Windows", "Linux", "Raspberry Pi")',
    '- "errorSignals": array of any error messages, symptoms, or failure descriptions mentioned',
    '- "category": one of: "bug-report", "how-to", "feature-request", "troubleshooting", "configuration", "compatibility", "performance", "general-discussion", "other"',
  ].join("\n");

  const content = await callLocalChatWithFallback({
    env: process.env,
    clientLabel: "thread-miner:qwen",
    timeoutMs,
    temperature: 0.1,
    errorLabel: "Local model",
    extraBody: {
      response_format: { type: "json_object" },
      reasoning_budget: 1024,
    },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  // Extract JSON from content (may have markdown fences)
  const cleaned = content
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();

  let start = cleaned.indexOf("{");
  let end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("No JSON object found in local model response.");
  }
  const parsed = JSON.parse(cleaned.slice(start, end + 1));

  return {
    summary: String(parsed.summary ?? ""),
    problemStatement: String(parsed.problemStatement ?? parsed.problem_statement ?? ""),
    solution: String(parsed.solution ?? ""),
    resolved: Boolean(parsed.resolved),
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [],
    products: Array.isArray(parsed.products) ? parsed.products.map(String) : [],
    platforms: Array.isArray(parsed.platforms) ? parsed.platforms.map(String) : [],
    errorSignals: Array.isArray(parsed.errorSignals ?? parsed.error_signals)
      ? (parsed.errorSignals ?? parsed.error_signals).map(String)
      : [],
    category: String(parsed.category ?? "other"),
  };
}

function parseArgs(): { months: number; dryRun: boolean; limit: number } {
  const args = process.argv.slice(2);
  let months = 6;
  let dryRun = false;
  let limit = Infinity;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--months" && args[i + 1]) {
      months = Number(args[i + 1]) || 6;
      i++;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--limit" && args[i + 1]) {
      limit = Number(args[i + 1]) || Infinity;
      i++;
    }
  }

  return { months, dryRun, limit };
}

async function main(): Promise<void> {
  loadDotEnv();
  const { months, dryRun, limit } = parseArgs();

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required.");
  }

  const preferredQwenProvider = getPreferredLocalQwenProvider(process.env, "thread-miner:qwen");
  const qwenBaseUrl = preferredQwenProvider.baseUrl;
  const qwenModel = preferredQwenProvider.model;
  const qwenTimeoutMs = preferredQwenProvider.requestTimeoutMs ?? 120_000;

  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);
  const cutoffMs = cutoffDate.getTime();

  // Target channels (thread-mode support channels)
  const targetChannels = [
    { channelId: "555555555555555555", name: "vdo-ninja-support" },
    { channelId: "666666666666666666", name: "social-stream-support" },
  ];

  const outputDir = path.resolve("data/mined-threads");
  await mkdir(outputDir, { recursive: true });
  const timestamp = Date.now();
  const outputPath = path.join(outputDir, `threads-${timestamp}.jsonl`);
  const progressPath = path.join(outputDir, `progress-${timestamp}.json`);

  console.log(`Mining threads from last ${months} months (cutoff: ${cutoffDate.toISOString()})`);
  console.log(`Output: ${outputPath}`);
  console.log(`Qwen: ${qwenBaseUrl} / ${qwenModel}`);
  if (dryRun) {
    console.log("DRY RUN — no Qwen calls will be made.");
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message],
  });

  await client.login(token);
  console.log(`Logged in as ${client.user?.tag}\n`);

  let totalThreads = 0;
  let processedThreads = 0;
  let skippedThreads = 0;
  let qwenErrors = 0;
  const allThreadIds: string[] = [];

  for (const target of targetChannels) {
    console.log(`\n=== Channel: ${target.name} (${target.channelId}) ===`);

    const guild = await client.guilds.fetch("444444444444444444");
    const channel = (await guild.channels.fetch(target.channelId)) as TextChannel;
    if (!channel || channel.type !== ChannelType.GuildText) {
      console.log(`  Channel not found or wrong type, skipping.`);
      continue;
    }

    // Fetch active and archived threads
    const activeResult = await channel.threads.fetchActive().catch(() => ({ threads: new Map() }));
    const activeThreads = [...activeResult.threads.values()];

    // Fetch archived threads in batches (Discord limits to 100 per call)
    const archivedThreads: ThreadChannel[] = [];
    let hasMore = true;
    let archiveBefore: Date | undefined;

    while (hasMore) {
      const batch = await channel.threads
        .fetchArchived({ limit: 100, before: archiveBefore })
        .catch(() => ({ threads: new Map(), hasMore: false }));

      const threads = [...batch.threads.values()];
      if (threads.length === 0) {
        break;
      }

      // Check if we've gone past our cutoff
      const oldestInBatch = threads[threads.length - 1];
      if (oldestInBatch && oldestInBatch.createdTimestamp && oldestInBatch.createdTimestamp < cutoffMs) {
        // Include threads in range, stop after
        for (const t of threads) {
          if (t.createdTimestamp && t.createdTimestamp >= cutoffMs) {
            archivedThreads.push(t);
          }
        }
        hasMore = false;
      } else {
        archivedThreads.push(...threads);
        hasMore = (batch as { hasMore?: boolean }).hasMore !== false && threads.length >= 100;
        archiveBefore = oldestInBatch?.createdAt ?? undefined;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Filter active threads by cutoff too
    const filteredActive = activeThreads.filter(
      (t) => !t.createdTimestamp || t.createdTimestamp >= cutoffMs,
    );

    // Deduplicate
    const threadMap = new Map<string, ThreadChannel>();
    for (const t of [...filteredActive, ...archivedThreads]) {
      threadMap.set(t.id, t);
    }
    const threads = [...threadMap.values()].sort(
      (a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0),
    );

    console.log(`  Found ${threads.length} threads in date range (${filteredActive.length} active, ${archivedThreads.length} archived)`);
    totalThreads += threads.length;

    for (const thread of threads) {
      if (processedThreads >= limit) {
        console.log(`  Reached limit of ${limit} threads, stopping.`);
        break;
      }

      // Fetch all messages
      let messages: Message[];
      try {
        messages = await fetchAllThreadMessages(thread);
      } catch (error) {
        console.log(`  [skip] ${thread.name}: failed to fetch messages (${error})`);
        skippedThreads++;
        continue;
      }

      // Filter out bot messages for the conversation, but keep count
      const humanMessages = messages.filter((m) => !m.author.bot);
      if (humanMessages.length < 2) {
        skippedThreads++;
        continue;
      }

      const minedMessages: MinedMessage[] = humanMessages.map((m) => ({
        messageId: m.id,
        authorId: m.author.id,
        authorName: m.author.username,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
        hasAttachments: m.attachments.size > 0,
        attachmentCount: m.attachments.size,
      }));

      const participants = [...new Set(minedMessages.map((m) => m.authorName))];
      const firstMsg = minedMessages[0]!;
      const lastMsg = minedMessages[minedMessages.length - 1]!;

      const minedThread: MinedThread = {
        threadId: thread.id,
        threadName: thread.name ?? "unnamed",
        channelId: target.channelId,
        channelName: target.name,
        guildId: "444444444444444444",
        sourceUrl: `https://discord.com/channels/444444444444444444/${thread.id}`,
        createdAt: firstMsg.createdAt,
        lastMessageAt: lastMsg.createdAt,
        messageCount: minedMessages.length,
        participantCount: participants.length,
        participants,
        messages: minedMessages,
      };

      // Send to Qwen for summarization
      if (!dryRun) {
        const conversationText = buildConversationText(minedMessages);
        try {
          const result = await qwenSummarize(
            conversationText,
            thread.name ?? "unnamed",
            qwenTimeoutMs,
          );
          minedThread.summary = result.summary;
          minedThread.problemStatement = result.problemStatement;
          minedThread.solution = result.solution;
          minedThread.resolved = result.resolved;
          minedThread.keywords = result.keywords;
          minedThread.products = result.products;
          minedThread.platforms = result.platforms;
          minedThread.errorSignals = result.errorSignals;
          minedThread.category = result.category;
          minedThread.qwenProcessed = true;
        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          minedThread.qwenError = errorText;
          minedThread.qwenProcessed = false;
          qwenErrors++;
          console.log(`  [qwen-error] ${thread.name}: ${errorText.slice(0, 100)}`);
        }
      } else {
        minedThread.qwenProcessed = false;
      }

      // Append to JSONL
      appendFileSync(outputPath, JSON.stringify(minedThread) + "\n", "utf8");
      allThreadIds.push(thread.id);
      processedThreads++;

      const status = minedThread.qwenProcessed
        ? `${minedThread.category} | ${(minedThread.keywords ?? []).slice(0, 5).join(", ")}`
        : dryRun
          ? "dry-run"
          : "qwen-error";
      console.log(
        `  [${processedThreads}/${totalThreads}] ${thread.name?.slice(0, 50)} (${minedMessages.length} msgs, ${participants.length} users) — ${status}`,
      );

      // Save progress periodically
      if (processedThreads % 10 === 0) {
        writeFileSync(
          progressPath,
          JSON.stringify({
            outputPath,
            totalThreads,
            processedThreads,
            skippedThreads,
            qwenErrors,
            lastUpdated: new Date().toISOString(),
          }),
          "utf8",
        );
      }
    }
  }

  client.destroy();

  // Final progress
  writeFileSync(
    progressPath,
    JSON.stringify({
      outputPath,
      totalThreads,
      processedThreads,
      skippedThreads,
      qwenErrors,
      completed: true,
      completedAt: new Date().toISOString(),
    },
    null,
    2),
    "utf8",
  );

  console.log(`\n=== Done ===`);
  console.log(`Total threads found: ${totalThreads}`);
  console.log(`Processed: ${processedThreads}`);
  console.log(`Skipped (< 2 messages or fetch errors): ${skippedThreads}`);
  console.log(`Qwen errors: ${qwenErrors}`);
  console.log(`Output: ${outputPath}`);
  console.log(`Progress: ${progressPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
