import test from "node:test";
import assert from "node:assert/strict";
import { sendApprovedDraftFromRun } from "../src/discord/review-actions.js";

test("sendApprovedDraftFromRun posts an approved draft to the source thread", async () => {
  let capturedUrl: string | undefined;
  let capturedBody: Record<string, unknown> | undefined;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "source-msg-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = await sendApprovedDraftFromRun(
      {
        getWorkflowRun: () => ({
          outcome: "approved",
          channelId: "channel-1",
          threadId: "thread-1",
          replyText: "Approved answer",
        }),
      },
      "bot-token",
      42,
    );

    assert.equal(result.channelId, "thread-1");
    assert.equal(result.messageId, "source-msg-1");
    assert.ok(capturedUrl?.includes("/channels/thread-1/messages"));
    assert.equal(capturedBody?.content, "Approved answer");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendApprovedDraftFromRun rejects non-approved runs", async () => {
  await assert.rejects(
    () => sendApprovedDraftFromRun(
      {
        getWorkflowRun: () => ({
          outcome: "hold",
          channelId: "channel-1",
          threadId: undefined,
          replyText: "Should not send",
        }),
      },
      "bot-token",
      99,
    ),
    /not approved/,
  );
});

test("sendApprovedDraftFromRun rejects Discord delivery failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "forbidden" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });

  try {
    await assert.rejects(
      () => sendApprovedDraftFromRun(
        {
          getWorkflowRun: () => ({
            outcome: "approved",
            channelId: "channel-1",
            threadId: undefined,
            replyText: "Approved answer",
          }),
        },
        "bot-token",
        100,
      ),
      /source delivery failed.*403/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
