/**
 * Backfill historical Discord thread messages into the workflow queue.
 *
 * Usage:
 *   tsx src/backfill-discord-threads.ts [--limit N] [--dry-run]
 *
 * Fetches recent threads from the monitored support channels and queues any
 * messages that don't already have a workflow_run. This expands the sample pool
 * for replay-based calibration without affecting live traffic.
 */

import { existsSync, readFileSync } from "node:fs";
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
import { loadAppConfig } from "./config.js";
import { AppDatabase } from "./store/database.js";
import type { DiscordEventRecord, RouteConfig } from "./types.js";

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

function toEvent(message: Message, route: RouteConfig): DiscordEventRecord {
  const attachments = message.attachments.map((a) => ({
    id: a.id,
    fileName: a.name ?? `attachment-${a.id}`,
    url: a.url,
    proxyUrl: a.proxyURL,
    contentType: a.contentType ?? undefined,
    sizeBytes: a.size,
    width: a.width ?? undefined,
    height: a.height ?? undefined,
    kind: (a.contentType?.startsWith("image/") || a.width || a.height ? "image" : "other") as "image" | "other",
  }));
  return {
    guildId: message.guildId ?? route.guildId,
    channelId: message.channel.isThread() ? (message.channel.parentId ?? route.channelId) : message.channelId,
    threadId: message.channel.isThread() ? message.channel.id : undefined,
    messageId: message.id,
    authorId: message.author.id,
    authorName: message.author.username,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    sourceUrl: `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

async function fetchThreadMessages(thread: ThreadChannel, limit: number): Promise<Message[]> {
  const messages: Message[] = [];
  let before: string | undefined;

  while (messages.length < limit) {
    const batch = await thread.messages.fetch({ limit: Math.min(100, limit - messages.length), before });
    if (batch.size === 0) {
      break;
    }
    for (const msg of batch.values()) {
      messages.push(msg);
    }
    before = batch.last()?.id;
  }

  // Return oldest-first
  return messages.reverse();
}

async function fetchChannelMessages(channel: TextChannel, limit: number): Promise<Message[]> {
  const messages: Message[] = [];
  let before: string | undefined;

  while (messages.length < limit) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, limit - messages.length), before });
    if (batch.size === 0) {
      break;
    }
    for (const msg of batch.values()) {
      messages.push(msg);
    }
    before = batch.last()?.id;
  }

  return messages.reverse();
}

async function main(): Promise<void> {
  loadDotEnv();

  const dryRun = process.argv.includes("--dry-run");
  const limitArgIndex = process.argv.indexOf("--limit");
  const messageLimit = limitArgIndex >= 0 ? Number(process.argv[limitArgIndex + 1]) || 200 : 200;

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required.");
  }

  const appConfig = await loadAppConfig(process.env.STEVESBOT_ROOT);
  const db = new AppDatabase(appConfig.sqlitePath);

  // Get existing message IDs to avoid duplicates
  const existingMessageIds = new Set(
    db.listWorkflowRuns({ page: 1, pageSize: 10000 }).items.map((r) => r.messageId),
  );

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message],
  });

  await client.login(token);
  console.log(`Logged in as ${client.user?.tag}`);

  let totalQueued = 0;
  let totalSkipped = 0;
  let totalBots = 0;

  for (const route of appConfig.routes) {
    if (!route.enabled) {
      continue;
    }

    const guild = await client.guilds.fetch(route.guildId).catch(() => null);
    if (!guild) {
      console.log(`  Skipping route ${route.id}: guild ${route.guildId} not accessible`);
      continue;
    }

    const channel = await guild.channels.fetch(route.channelId).catch(() => null);
    if (!channel) {
      console.log(`  Skipping route ${route.id}: channel ${route.channelId} not accessible`);
      continue;
    }

    console.log(`\nRoute: ${route.id} (mode=${route.mode})`);

    if (route.mode === "thread" && channel.type === ChannelType.GuildText) {
      // Fetch archived + active threads
      const textChannel = channel as TextChannel;
      const activeThreads = await textChannel.threads.fetchActive().catch(() => ({ threads: new Map() }));
      const archivedThreads = await textChannel.threads.fetchArchived({ limit: 50 }).catch(() => ({ threads: new Map() }));

      const threads = [...activeThreads.threads.values(), ...archivedThreads.threads.values()];
      console.log(`  Found ${threads.length} threads`);

      for (const thread of threads) {
        const messages = await fetchThreadMessages(thread, messageLimit);
        for (const msg of messages) {
          if (msg.author.bot) {
            totalBots += 1;
            continue;
          }
          if (existingMessageIds.has(msg.id)) {
            totalSkipped += 1;
            continue;
          }
          const event = toEvent(msg, route);
          if (dryRun) {
            console.log(`  [dry-run] Would queue: ${route.id} ${msg.author.username}: ${msg.content.slice(0, 60)}`);
          } else {
            db.enqueueWorkflowJob(route.id, event);
          }
          existingMessageIds.add(msg.id);
          totalQueued += 1;
        }
      }
    } else if (route.mode === "channel" && channel.type === ChannelType.GuildText) {
      const textChannel = channel as TextChannel;
      const messages = await fetchChannelMessages(textChannel, messageLimit);

      for (const msg of messages) {
        if (msg.author.bot) {
          totalBots += 1;
          continue;
        }
        if (existingMessageIds.has(msg.id)) {
          totalSkipped += 1;
          continue;
        }
        const event = toEvent(msg, route);
        if (dryRun) {
          console.log(`  [dry-run] Would queue: ${route.id} ${msg.author.username}: ${msg.content.slice(0, 60)}`);
        } else {
          db.enqueueWorkflowJob(route.id, event);
        }
        existingMessageIds.add(msg.id);
        totalQueued += 1;
      }
    }
  }

  client.destroy();
  console.log(`\nDone. Queued: ${totalQueued}, Skipped (existing): ${totalSkipped}, Bots: ${totalBots}`);
  if (dryRun) {
    console.log("(dry-run mode — nothing was actually queued)");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
