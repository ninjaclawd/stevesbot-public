import test from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "../src/config.js";
import { DiscordBot } from "../src/discord/bot.js";

function makeConfig(): AppConfig {
  return {
    rootDir: "/tmp/test",
    manifestsDir: "/tmp/test/resources/manifests",
    instructionsDir: "/tmp/test/resources/instructions",
    transcriptsDir: "/tmp/test/data/transcripts",
    sqlitePath: "/tmp/test/stevesbot.sqlite",
    logsDir: "/tmp/test/logs",
    repos: [],
    routes: [],
    reviewChannel: { guildId: "guild-1", channelId: "review-chan", enabled: true },
    resourceMap: [],
  };
}

test("Send as-is button waits for source send and updates the label", async () => {
  const updates: Array<Record<string, unknown>> = [];

  const bot = new DiscordBot(
    makeConfig(),
    { enqueue: async () => {} },
    {
      recordUsage: async () => ({
        sentToSource: true,
        sourceChannelId: "thread-1",
        sourceMessageId: "source-msg-1",
      }),
    },
  );

  await (bot as unknown as { onInteraction(interaction: unknown): Promise<void> }).onInteraction({
    isButton: () => true,
    customId: "draft_used:42",
    message: { id: "review-msg-1" },
    user: { id: "steve-id", username: "steve" },
    update: async (payload: Record<string, unknown>) => { updates.push(payload); },
    reply: async () => {},
    replied: false,
    deferred: false,
  });

  const components = updates[0]?.components as Array<{ components: Array<{ label: string }> }> | undefined;
  assert.equal(components?.[0]?.components[0]?.label, "Sent as-is (by steve)");
});
