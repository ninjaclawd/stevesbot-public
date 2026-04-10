import test from "node:test";
import assert from "node:assert/strict";
import { routeMatchesMessage } from "../src/discord/bot.js";
import type { RouteConfig } from "../src/types.js";

const threadRoute: RouteConfig = {
  id: "vdo-ninja-support",
  guildId: "guild-1",
  channelId: "forum-1",
  mode: "thread",
  instructionRef: "/tmp/instruction.md",
  repoScopes: ["vdo-ninja"],
  enabled: true,
};

test("thread routes match the parent support channel instead of the thread id", () => {
  assert.equal(
    routeMatchesMessage(threadRoute, {
      guildId: "guild-1",
      channelId: "thread-123",
      isThread: true,
      parentChannelId: "forum-1",
    }),
    true,
  );

  assert.equal(
    routeMatchesMessage(threadRoute, {
      guildId: "guild-1",
      channelId: "thread-123",
      isThread: true,
      parentChannelId: "other-forum",
    }),
    false,
  );
});

test("channel routes do not match thread traffic", () => {
  const channelRoute: RouteConfig = {
    ...threadRoute,
    id: "social-stream-feed",
    channelId: "channel-1",
    mode: "channel",
  };

  assert.equal(
    routeMatchesMessage(channelRoute, {
      guildId: "guild-1",
      channelId: "channel-1",
      isThread: false,
    }),
    true,
  );

  assert.equal(
    routeMatchesMessage(channelRoute, {
      guildId: "guild-1",
      channelId: "thread-123",
      isThread: true,
      parentChannelId: "channel-1",
    }),
    false,
  );
});