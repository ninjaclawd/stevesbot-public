import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { DiscordEventRecord, RouteConfig, ThreadContext } from "../types.js";

export function buildThreadKey(route: RouteConfig, event: DiscordEventRecord): string {
  return route.mode === "thread" ? `${route.id}:${event.threadId ?? "unthreaded"}` : `${route.id}:${route.channelId}`;
}

function resolveTranscriptFile(config: AppConfig, route: RouteConfig, event: DiscordEventRecord): string {
  const guildDir = path.join(config.transcriptsDir, route.guildId);
  if (route.mode === "thread") {
    const threadId = event.threadId ?? "unthreaded";
    return path.join(guildDir, route.channelId, "threads", `${threadId}.jsonl`);
  }
  return path.join(guildDir, `${route.channelId}.jsonl`);
}

export class TranscriptStore {
  public constructor(private readonly config: AppConfig) {}

  public async append(route: RouteConfig, event: DiscordEventRecord): Promise<{ filePath: string; threadKey: string }> {
    const filePath = resolveTranscriptFile(this.config, route, event);
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
    return { filePath, threadKey: buildThreadKey(route, event) };
  }

  public async getContext(route: RouteConfig, current: DiscordEventRecord): Promise<ThreadContext> {
    const filePath = resolveTranscriptFile(this.config, route, current);
    let messages: DiscordEventRecord[] = [];
    try {
      const raw = await readFile(filePath, "utf8");
      messages = raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as DiscordEventRecord);
    } catch {
      messages = [];
    }

    const firstMessage = route.mode === "thread" ? messages[0] : undefined;
    const recentMessages = messages.slice(-10);

    return {
      route,
      firstMessage,
      recentMessages,
      currentMessage: current,
    };
  }
}
